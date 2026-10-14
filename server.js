// server.js — the Process Log's little local server.
//
// It does three jobs:
//   1. every N minutes (and when the BIG button is pressed) it records a capture
//   2. it keeps the list of captures, captions and choices (store.js)
//   3. it serves the page in public/ and the video files
//
// It only listens on this computer (127.0.0.1); nothing is reachable from outside.
// Run it with the "Start Process Log.command" file, or `node server.js`.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createStore, makeId, MAX_CAPTION } from './store.js'
import { findDevices, realSources, recordRaw, probeSize, isBlack, renderFinal, makeJpeg, BLUR_SIGMA } from './capture.js'
import { renderStory } from './story.js'
import { importIntoPhotos } from './photos.js'
import { createQuiet } from './quiet.js'
import { listFolder, searchSounds, resolveInside, AUDIO_EXTENSIONS } from './sounds.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// What happened, with the time, printed in the Terminal window the server runs in.
const say = (message) => console.log(`${new Date().toLocaleTimeString('en-GB')}  ${message}`)
const TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.mp4': 'video/mp4', '.jpg': 'image/jpeg',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.aif': 'audio/aiff', '.aiff': 'audio/aiff', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
}

// ---------------------------------------------------------------- macOS helpers

function isScreenLocked() {
  return new Promise((resolve) => {
    execFile('ioreg', ['-n', 'Root', '-d1', '-a'], (err, out) => {
      resolve(!err && /CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(out))
    })
  })
}

// ---------------------------------------------------------------- the app

export function startServer({ rootDir = HERE, config, getSources, screenIsLocked = isScreenLocked, port, importer = importIntoPhotos, quiet = createQuiet(config, undefined, say) }) {
  const store = createStore(rootDir)
  const publicDir = path.join(rootDir, 'public')

  // What the page needs to know right now.
  const state = {
    logging: true,
    capturing: false,
    phase: null, // 'recording' | 'building' while a capture is running
    captureStartedAt: null,
    captureKind: null, // 'auto' or 'button' while a capture runs: an automatic one stays silent
    nextAt: null,
    error: null, // the last failure; stays until dismissed or a capture succeeds
    note: null, // a capture that was skipped on purpose (screen locked or off)
    saving: null, // while a clip is being saved into Photos: { id, step }
    saveError: null, // the last failed save; stays until dismissed or the next save
  }
  const rebuilding = new Set() // ids whose clip is being rebuilt right now
  let timer = null

  const sourcesNow = getSources || (async () => realSources(await findDevices(config.cameraName)))

  // ------------------------------------------------------------ saving the finished clip into Photos

  const soundsRoot = config.soundsFolder ? path.resolve(config.soundsFolder) : null

  // Checks the sound and caption picture that came with a "save to Photos" request.
  // The caption picture is kept next to the capture's videos as caption.png.
  function readClipOptions(entry, body) {
    let soundFile = null
    if (body.sound) {
      soundFile = soundsRoot && resolveInside(soundsRoot, String(body.sound))
      if (!soundFile || !AUDIO_EXTENSIONS.has(path.extname(soundFile).toLowerCase()) || !fs.existsSync(soundFile)) return { error: 'That sound could not be found' }
    }
    const captionFile = path.join(store.folderFor(entry.id), 'caption.png')
    let withCaption = false
    if (typeof body.captionImage === 'string' && body.captionImage.startsWith('data:image/png;base64,')) {
      const png = Buffer.from(body.captionImage.slice('data:image/png;base64,'.length), 'base64')
      if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) return { error: 'The caption picture is not a PNG' }
      fs.writeFileSync(captionFile, png)
      withCaption = true
    } else {
      fs.rmSync(captionFile, { force: true })
    }
    return { soundFile, withCaption }
  }

  // Makes the finished clip (caption and sound on it) and hands it to Photos.
  async function saveToPhotos(id, options) {
    try {
      state.saving.step = 'building'
      const { file } = await renderStory(store.folderFor(id), { withCaption: options.withCaption, soundFile: options.soundFile })
      state.saving.step = 'importing'
      await importer(file)
      store.update(id, { saved: { at: new Date().toISOString(), sound: options.soundName }, pending: false })
      say(`Saved ${id} into Photos (album "Process Log")`)
    } catch (e) {
      state.saveError = { id, time: Date.now(), message: e.message }
      say(`Saving to Photos failed: ${e.message}`)
    } finally {
      state.saving = null
    }
  }

  // ------------------------------------------------------------ capturing

  async function takeCapture(kind) {
    if (state.capturing) return false
    state.capturing = true
    state.phase = 'recording'
    state.captureStartedAt = Date.now()
    state.captureKind = kind
    const id = makeId()
    const dir = store.folderFor(id)
    try {
      const sources = await sourcesNow()
      fs.mkdirSync(dir, { recursive: true })
      // Do Not Disturb is on only while recording, so no banner lands in the clip. The first second
      // of every recording is thrown away anyway, which covers the moment it takes to switch on.
      const quietOn = await quiet.on().catch(() => false)
      let quietWarning = null // if "off" fails this must stay on the page even after a good capture
      let rec
      try {
        rec = await recordRaw(sources, dir, { seconds: config.seconds, warmupSeconds: config.warmupSeconds })
      } finally {
        if (quietOn) {
          await quiet.off().catch((e) => {
            quietWarning = { time: Date.now(), message: e.message }
            state.note = quietWarning
            say(`WARNING: ${e.message}`)
          })
        }
      }
      const missing = sources.filter((s) => !fs.existsSync(path.join(dir, `${s.name}.mp4`)))
      if (rec.code !== 0 || missing.length > 0) {
        throw new Error(
          rec.killed
            ? 'The recording never started. This usually means macOS has not allowed Terminal to use the camera or record the screen (System Settings, Privacy & Security).'
            : `The recording failed: ${rec.err.slice(-300) || 'no details'}`,
        )
      }

      state.phase = 'building'
      const screenSources = sources.filter((s) => s.kind === 'screen')
      const blackFlags = await Promise.all(screenSources.map((s) => isBlack(path.join(dir, `${s.name}.mp4`))))
      if (blackFlags.every(Boolean)) {
        fs.rmSync(dir, { recursive: true, force: true })
        state.note = quietWarning ?? { time: Date.now(), message: 'A capture was skipped because every screen was black (switched off or asleep).' }
        say('Capture skipped: every screen was black')
        return true
      }

      const screens = []
      for (const s of screenSources) screens.push({ number: s.number, name: s.name, ...(await probeSize(path.join(dir, `${s.name}.mp4`))) })
      const entry = { id, time: new Date().toISOString(), kind, caption: '', screens, panels: startingPanels(screens), blurs: [], renderedAt: Date.now(), cameraGrey: Boolean(config.cameraBlackAndWhite), cropTop: Number(config.screenCropTop) || 0, singleFit: 'fit', pending: true }
      await buildClip(dir, entry)
      for (const s of screens) await makeJpeg(path.join(dir, `${s.name}.mp4`), path.join(dir, `thumb-${s.name}.jpg`), 360)
      store.add(entry)
      say(`Captured ${id} (${kind})`)
      state.error = null
      state.note = quietWarning
      return true
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true })
      state.error = { time: Date.now(), message: e.message }
      say(`Capture failed: ${e.message}`)
      return true
    } finally {
      state.capturing = false
      state.phase = null
      state.captureKind = null
    }
  }

  // Builds (or rebuilds) final.mp4 for an entry from its current choices.
  async function buildClip(dir, entry) {
    await renderFinal(dir, { panels: entry.panels, blurs: entry.blurs, cameraGrey: entry.cameraGrey, cropTop: entry.cropTop ?? 0, singleFit: entry.singleFit ?? 'fit' })
  }

  // The panels a new capture starts with, from config.json's "defaultPanels". A name for a
  // screen that is not plugged in right now is swapped for the first screen that is.
  function startingPanels(screens) {
    const wanted = Array.isArray(config.defaultPanels) && [1, 2, 3].includes(config.defaultPanels.length) ? config.defaultPanels : ['screen1', 'camera']
    const available = new Set([...screens.map((s) => s.name), 'camera'])
    return wanted.map((name) => (available.has(name) ? name : screens[0].name))
  }

  function scheduleNext() {
    clearTimeout(timer)
    const ms = config.everyMinutes * 60 * 1000
    state.nextAt = Date.now() + ms
    timer = setTimeout(autoCapture, ms)
  }

  async function autoCapture() {
    if (!state.logging) return
    scheduleNext()
    if (state.capturing) return
    if (await screenIsLocked()) {
      state.note = { time: Date.now(), message: 'A capture was skipped because the screen was locked.' }
      say('Capture skipped: the screen was locked')
      return
    }
    await takeCapture('auto')
  }

  // ------------------------------------------------------------ web server

  const sendJson = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  function readJson(req, maxLength = 20000) {
    return new Promise((resolve, reject) => {
      let text = ''
      req.on('data', (d) => {
        text += d
        if (text.length > maxLength) { reject(new Error('Request too big')); req.destroy() }
      })
      req.on('end', () => {
        try { resolve(text ? JSON.parse(text) : {}) } catch { reject(new Error('Not valid JSON')) }
      })
    })
  }

  // Serves a file; videos need "range" support so the page can play and seek.
  function sendFile(req, res, file) {
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) { res.writeHead(404); res.end('Not found'); return }
      const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes' }
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
      if (range) {
        const start = range[1] ? Number(range[1]) : 0
        const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 })
        fs.createReadStream(file, { start, end }).pipe(res)
      } else {
        res.writeHead(200, { ...headers, 'Content-Length': stat.size })
        fs.createReadStream(file).pipe(res)
      }
    })
  }

  // A path inside `root`, or null if the address tries to climb out of it.
  function insideFolder(root, relative) {
    let decoded
    try { decoded = decodeURIComponent(relative) } catch { return null }
    const full = path.join(root, decoded)
    return full.startsWith(root + path.sep) ? full : null
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const route = `${req.method} ${url.pathname}`
    const captureRoute = /^\/api\/captures\/([^/]+)$/.exec(url.pathname)

    try {
      if (route === 'GET /api/state') {
        return sendJson(res, 200, { ...state, soundsAvailable: Boolean(soundsRoot && fs.existsSync(soundsRoot)), seconds: config.seconds, warmupSeconds: config.warmupSeconds, everyMinutes: config.everyMinutes, rebuilding: [...rebuilding], captures: store.list() })
      }
      if (route === 'POST /api/capture') {
        if (state.capturing) return sendJson(res, 409, { error: 'Already recording' })
        takeCapture('button') // runs in the background; the page watches /api/state
        return sendJson(res, 202, { ok: true })
      }
      if (route === 'POST /api/logging') {
        const body = await readJson(req)
        state.logging = Boolean(body.on)
        if (state.logging) scheduleNext()
        else { clearTimeout(timer); state.nextAt = null }
        return sendJson(res, 200, { logging: state.logging })
      }
      if (route === 'POST /api/dismiss') {
        state.error = null
        state.note = null
        state.saveError = null
        return sendJson(res, 200, { ok: true })
      }
      if (route === 'GET /api/sounds') {
        if (!soundsRoot || !fs.existsSync(soundsRoot)) return sendJson(res, 404, { error: 'The sounds folder was not found. Check "soundsFolder" in config.json.' })
        const query = (url.searchParams.get('q') ?? '').trim()
        return sendJson(res, 200, query ? { query, results: searchSounds(soundsRoot, query) } : listFolder(soundsRoot, url.searchParams.get('path') ?? ''))
      }
      if (req.method === 'GET' && url.pathname.startsWith('/sounds/')) {
        const file = soundsRoot && resolveInside(soundsRoot, decodeURIComponent(url.pathname.slice('/sounds/'.length)))
        if (!file || !AUDIO_EXTENSIONS.has(path.extname(file).toLowerCase())) { res.writeHead(404); return res.end('Not found') }
        return sendFile(req, res, file)
      }

      if (captureRoute && req.method === 'PATCH') {
        const entry = store.get(captureRoute[1])
        if (!entry) return sendJson(res, 404, { error: 'No such capture' })
        const body = await readJson(req)
        if (typeof body.caption === 'string') store.update(entry.id, { caption: body.caption.slice(0, MAX_CAPTION) })
        if (body.captionBox !== undefined) {
          const box = body.captionBox
          const fine = box && typeof box === 'object' && [box.x, box.y, box.size].every((n) => typeof n === 'number' && Number.isFinite(n)) && box.x >= 0 && box.x <= 1 && box.y >= 0 && box.y <= 1 && box.size >= 24 && box.size <= 96
          if (!fine) return sendJson(res, 400, { error: 'The caption position or size is not valid' })
          store.update(entry.id, { captionBox: { x: box.x, y: box.y, size: box.size } })
        }
        // An automatic capture waits with a reminder until it has a caption or you wave it away.
        if ((typeof body.caption === 'string' && body.caption.trim() !== '') || body.dismiss === true) store.update(entry.id, { pending: false })

        const newPanels = body.panels ?? entry.panels
        const choices = [...entry.screens.map((s) => s.name), 'camera']
        if (!Array.isArray(newPanels) || ![1, 2, 3].includes(newPanels.length) || !newPanels.every((name) => choices.includes(name))) {
          return sendJson(res, 400, { error: 'A clip needs one, two or three panels, each one a screen of this capture or the camera' })
        }
        // One blur setting per panel ("off", "soft", "heavy"), top to bottom. Missing ones mean "off".
        const newBlurs = newPanels.map((_, i) => (body.blurs ?? entry.blurs ?? [])[i] ?? 'off')
        if (body.blurs !== undefined && (!Array.isArray(body.blurs) || body.blurs.length > newPanels.length)) return sendJson(res, 400, { error: 'Blur needs one setting per panel' })
        if (!newBlurs.every((level) => level in BLUR_SIGMA)) return sendJson(res, 400, { error: 'Blur can be off, soft or heavy' })
        if (body.cropTop !== undefined && !(typeof body.cropTop === 'number' && body.cropTop >= 0 && body.cropTop <= 0.4)) return sendJson(res, 400, { error: 'The trim must be between 0 and 40 percent' })
        const newCrop = body.cropTop ?? entry.cropTop ?? 0
        if (body.singleFit !== undefined && !['fit', 'fill'].includes(body.singleFit)) return sendJson(res, 400, { error: 'A single screen can be shown as fit or fill' })
        const newFit = body.singleFit ?? entry.singleFit ?? 'fit'
        const newGrey = typeof body.cameraGrey === 'boolean' ? body.cameraGrey : entry.cameraGrey
        if (newPanels.join() !== entry.panels.join() || newBlurs.join() !== (entry.blurs ?? []).concat(['off', 'off', 'off']).slice(0, newPanels.length).join() || newGrey !== entry.cameraGrey || newCrop !== (entry.cropTop ?? 0) || newFit !== (entry.singleFit ?? 'fit')) {
          if (rebuilding.has(entry.id)) return sendJson(res, 409, { error: 'Already rebuilding this clip' })
          rebuilding.add(entry.id)
          try {
            const changed = { ...entry, panels: newPanels, blurs: newBlurs, cameraGrey: newGrey, cropTop: newCrop, singleFit: newFit }
            await buildClip(store.folderFor(entry.id), changed)
            store.update(entry.id, { panels: newPanels, blurs: newBlurs, cameraGrey: newGrey, cropTop: newCrop, singleFit: newFit, renderedAt: Date.now() })
          } finally {
            rebuilding.delete(entry.id)
          }
        }
        return sendJson(res, 200, store.get(entry.id))
      }
      const saveRoute = /^\/api\/captures\/([^/]+)\/save-to-photos$/.exec(url.pathname)
      if (saveRoute && req.method === 'POST') {
        const entry = store.get(saveRoute[1])
        if (!entry) return sendJson(res, 404, { error: 'No such capture' })
        if (state.saving) return sendJson(res, 409, { error: 'A clip is already being saved' })
        if (rebuilding.has(entry.id)) return sendJson(res, 409, { error: 'The clip is still being rebuilt' })
        const body = await readJson(req, 8_000_000)
        if (entry.saved && !body.again) return sendJson(res, 409, { error: 'This capture is already in Photos. Press Save again to put in another copy.' })
        const options = readClipOptions(entry, body)
        if (options.error) return sendJson(res, 400, { error: options.error })
        state.saveError = null
        state.saving = { id: entry.id, step: 'building' }
        saveToPhotos(entry.id, { ...options, soundName: options.soundFile ? path.basename(options.soundFile) : null }) // runs in the background; the page watches /api/state
        return sendJson(res, 202, { ok: true })
      }
      if (captureRoute && req.method === 'DELETE') {
        const ok = store.remove(captureRoute[1])
        if (ok) say(`Deleted capture ${captureRoute[1]} (the Delete button was pressed, on the page or in the corner panel)`)
        return sendJson(res, ok ? 200 : 404, { ok })
      }

      if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
        const file = insideFolder(store.capturesDir, url.pathname.slice('/files/'.length))
        if (!file) { res.writeHead(404); return res.end('Not found') }
        return sendFile(req, res, file)
      }
      if (req.method === 'GET') {
        const file = insideFolder(publicDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1))
        if (!file) { res.writeHead(404); return res.end('Not found') }
        return sendFile(req, res, file)
      }
      res.writeHead(404)
      res.end('Not found')
    } catch (e) {
      sendJson(res, 500, { error: e.message })
    }
  }

  const server = http.createServer(handle)
  quiet.available?.().then((ready) => say(ready ? 'Quiet mode: Do Not Disturb will be on while a capture records.' : 'Quiet mode is not set up (see the README). Notifications can appear in captures.')).catch(() => {})
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port ?? config.port, '127.0.0.1', () => {
      scheduleNext()
      resolve({
        server,
        port: server.address().port,
        state,
        store,
        autoCapture,
        quiet,
        close() { clearTimeout(timer); server.close() },
      })
    })
  })
}

// ---------------------------------------------------------------- run directly

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // First run on a new Mac: start from the example settings.
  const configFile = path.join(HERE, 'config.json')
  if (!fs.existsSync(configFile)) fs.copyFileSync(path.join(HERE, 'config.example.json'), configFile)
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  startServer({ config })
    .then((app) => {
      // Closing the Terminal window or pressing Control-C must never leave Do Not Disturb on.
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { app.quiet.offNowIfActive(); process.exit(0) })
      return app
    })
    .then((app) => console.log(`Process Log is running at http://localhost:${app.port}  (every ${config.everyMinutes} minutes). Leave this window open.`))
    .catch((e) => {
      console.error(e.code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Is the Process Log already running?` : e.message)
      process.exit(1)
    })
}
