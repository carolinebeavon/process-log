// Tests for the Process Log. Run with:  node tests/process-log-test.mjs
//
// They use no camera and no screen: the server is started with stand-in
// pictures (a solid red "screen 0", a green "screen 1", a blue "camera") made by
// ffmpeg itself, so each panel of a finished clip can be told apart by colour.
// Nothing here touches your real captures: every run uses a fresh temporary folder.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { parseDevices, realSources, storyLayout, panelHeights, buildFinalArgs, FFMPEG, FFPROBE } from '../capture.js'
import { createStore, makeId } from '../store.js'
import { startServer } from '../server.js'
import { createQuiet } from '../quiet.js'

let passed = 0
let failed = 0
async function test(name, fn) {
  try { await fn(); console.log(`ok    ${name}`); passed++ } catch (e) { console.log(`FAIL  ${name}\n${e.stack}`); failed++ }
}
const tempRoot = () => fs.mkdtempSync(path.join(process.env.PL_TEST_TMP || os.tmpdir(), 'process-log-test-'))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------ stand-in sources

const solid = (name, colour, size, extra) => ({
  name, kind: name === 'camera' ? 'camera' : 'screen', number: name === 'camera' ? undefined : Number(name.slice(-1)),
  fps: name === 'camera' ? 30 : 15, bitrate: '4M', maxWidth: name === 'camera' ? 1280 : 1920,
  inputArgs: ['-f', 'lavfi', '-i', `color=c=${colour}:s=${size}:r=15`], ...extra,
})
const colourSources = () => [solid('screen0', 'red', '2940x1912'), solid('screen1', 'green', '1920x1080'), solid('camera', 'blue', '1280x720')]
const blackSources = () => [solid('screen0', 'black', '2940x1912'), solid('screen1', 'black', '1920x1080'), solid('camera', 'blue', '1280x720')]
const brokenSources = () => [{ ...solid('screen0', 'red', '640x360'), inputArgs: ['-f', 'lavfi', '-i', 'nosuchsource=1'] }, solid('camera', 'blue', '1280x720')]

const config = { port: 0, everyMinutes: 15, seconds: 2, warmupSeconds: 0.5, defaultPanels: ['screen1', 'camera'], cameraName: 'FaceTime' }

async function boot(sources, extra = {}) {
  const rootDir = tempRoot()
  const { config: configChanges, ...otherOptions } = extra
  const app = await startServer({ rootDir, getSources: typeof sources === 'function' ? sources : async () => sources, screenIsLocked: async () => false, ...otherOptions, config: { ...config, ...configChanges } })
  const call = async (method, url, body) => {
    const res = await fetch(`http://127.0.0.1:${app.port}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  const finish = async () => { while (app.state.capturing) await wait(200) }
  return { app, rootDir, call, finish, close: () => { app.close(); fs.rmSync(rootDir, { recursive: true, force: true }) } }
}

// The colour [r, g, b] of one pixel in a finished clip.
function pixel(file, x, y) {
  const out = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', `crop=2:2:${x}:${y},format=rgb24`, '-f', 'rawvideo', '-'], { encoding: 'buffer' })
  return [out[0], out[1], out[2]]
}
const isGrey = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) < 20
const dominant = ([r, g, b]) => (r > 150 && g < 90 && b < 90 ? 'red' : g > 120 && r < 90 && b < 90 ? 'green' : b > 150 && r < 90 && g < 90 ? 'blue' : `unclear(${r},${g},${b})`)
const panels = (file) => [300, 960, 1650].map((y) => dominant(pixel(file, 540, y)))
const size = (file) => execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim()

// ------------------------------------------------------------ pure pieces

const LISTING = `[AVFoundation indev @ 0x7c14c14140] AVFoundation video devices:
[AVFoundation indev @ 0x7c14c14140] [0] FaceTime HD Camera
[AVFoundation indev @ 0x7c14c14140] [1] Example iPhone Camera
[AVFoundation indev @ 0x7c14c14140] [2] Example iPhone Desk View Camera
[AVFoundation indev @ 0x7c14c14140] [3] Capture screen 0
[AVFoundation indev @ 0x7c14c14140] [4] Capture screen 1
[AVFoundation indev @ 0x7c14c14140] AVFoundation audio devices:
[AVFoundation indev @ 0x7c14c14140] [0] MacBook Air Microphone
[AVFoundation indev @ 0x7c14c14140] [3] Example AirPods`

await test('the device list is read: camera and both screens found, microphones ignored', () => {
  const d = parseDevices(LISTING, 'FaceTime')
  assert.equal(d.camera.index, 0)
  assert.deepEqual(d.screens, [{ index: 3, number: 0 }, { index: 4, number: 1 }])
})

await test('a missing camera or no screens gives a plain error', () => {
  assert.equal(parseDevices(LISTING, 'NoSuchCamera').camera, null)
  assert.throws(() => realSources(parseDevices(LISTING, 'NoSuchCamera')), /camera/)
  assert.throws(() => realSources({ camera: { index: 0 }, screens: [] }), /screen/)
})

await test('the real recording recipe names the camera and screen devices and strips sound', () => {
  const sources = realSources(parseDevices(LISTING, 'FaceTime'))
  assert.deepEqual(sources.map((s) => s.name), ['screen0', 'screen1', 'camera'])
  assert.ok(sources[0].inputArgs.includes('3:none') && sources[1].inputArgs.includes('4:none') && sources[2].inputArgs.includes('0:none'))
})

await test('screen height at full width plus your height always fills 1920, and both are even', () => {
  for (const [w, h] of [[2940, 1912], [1920, 1080], [1920, 1200], [2560, 1440]]) {
    const l = storyLayout({ w, h })
    assert.equal(l.screenHeight + l.meHeight, 1920)
    assert.ok(l.screenHeight % 2 === 0 && l.meHeight % 2 === 0)
  }
  assert.equal(storyLayout({ w: 1920, h: 1080 }).screenHeight, 608)
})

await test('panel heights: three equal thirds; a screen and you = the whole screen plus the rest; anything else = halves', () => {
  const screen = { kind: 'screen', size: { w: 1920, h: 1080 } }
  const me = { kind: 'camera', size: { w: 1280, h: 720 } }
  assert.deepEqual(panelHeights([screen]), [1920], 'one panel is the whole frame')
  assert.deepEqual(panelHeights([screen, me, screen]), [640, 640, 640])
  assert.deepEqual(panelHeights([screen, me]), [608, 1312])
  assert.deepEqual(panelHeights([me, screen]), [1312, 608])
  assert.deepEqual(panelHeights([screen, screen]), [960, 960])
  assert.deepEqual(panelHeights([me, me]), [960, 960])
})

await test('a clip with no panels, or four, is refused; one panel is allowed', () => {
  const one = [{ file: 'a.mp4', kind: 'screen', size: { w: 10, h: 10 } }]
  assert.throws(() => buildFinalArgs([], 'o.mp4'), /one, two or three/)
  assert.throws(() => buildFinalArgs([...one, ...one, ...one, ...one], 'o.mp4'), /one, two or three/)
  assert.ok(buildFinalArgs(one, 'o.mp4').includes('[v]'))
  assert.ok(!buildFinalArgs(one, 'o.mp4').join(' ').includes('vstack'), 'nothing to stack with one panel')
})

await test('ids look like the day and time, and the store refuses an id that is not one', () => {
  assert.equal(makeId(new Date(2026, 9, 14, 10, 25, 30)), '2026-10-14_102530')
  const root = tempRoot()
  const store = createStore(root)
  assert.throws(() => store.folderFor('../../etc'), /Not a capture id/)
  fs.rmSync(root, { recursive: true, force: true })
})

await test('the store keeps captions across a restart, lists newest first, and delete removes the folder', () => {
  const root = tempRoot()
  let store = createStore(root)
  for (const id of ['2026-10-14_100000', '2026-10-14_101500']) {
    fs.mkdirSync(store.folderFor(id))
    fs.writeFileSync(path.join(store.folderFor(id), 'final.mp4'), 'x')
    store.add({ id, caption: '' })
  }
  store.update('2026-10-14_100000', { caption: 'first sketch' })
  store = createStore(root) // as if the server had been restarted
  assert.deepEqual(store.list().map((e) => e.id), ['2026-10-14_101500', '2026-10-14_100000'])
  assert.equal(store.get('2026-10-14_100000').caption, 'first sketch')
  assert.equal(store.remove('2026-10-14_100000'), true)
  assert.equal(fs.existsSync(store.folderFor('2026-10-14_100000')), false)
  assert.equal(store.remove('2026-10-14_100000'), false)
  store.update('2026-10-14_101500', { caption: 'a'.repeat(5000) })
  assert.equal(store.get('2026-10-14_101500').caption.length, 2200)
  fs.rmSync(root, { recursive: true, force: true })
})

await test('a damaged log.json stops the store from starting instead of being wiped', () => {
  const root = tempRoot()
  fs.writeFileSync(path.join(root, 'log.json'), '{ not json')
  assert.throws(() => createStore(root))
  fs.rmSync(root, { recursive: true, force: true })
})

// ------------------------------------------------------------ the real server

await test('a capture records all three, builds a 1080x1920 clip, and a second press while recording is refused', async () => {
  const t = await boot(colourSources())
  try {
    assert.equal((await t.call('POST', '/api/capture')).status, 202)
    await wait(100)
    assert.equal((await t.call('POST', '/api/capture')).status, 409)
    await t.finish()
    const { body } = await t.call('GET', '/api/state')
    assert.equal(body.error, null, JSON.stringify(body.error))
    assert.equal(body.captures.length, 1)
    const entry = body.captures[0]
    assert.equal(entry.kind, 'button')
    assert.deepEqual(entry.panels, ['screen1', 'camera']) // the default panels from the config
    const dir = t.app.store.folderFor(entry.id)
    for (const f of ['screen0.mp4', 'screen1.mp4', 'camera.mp4', 'final.mp4', 'poster.jpg', 'thumb-screen0.jpg', 'thumb-screen1.jpg']) assert.ok(fs.existsSync(path.join(dir, f)), `${f} is missing`)
    assert.equal(size(path.join(dir, 'final.mp4')), '1080,1920')
    assert.ok(Number(size(path.join(dir, 'screen0.mp4')).split(',')[0]) <= 1920, 'the big screen should be shrunk to 1920 wide')
    // two panels: the chosen (green) screen on top, you (blue) underneath
    assert.deepEqual([dominant(pixel(path.join(dir, 'final.mp4'), 540, 300)), dominant(pixel(path.join(dir, 'final.mp4'), 540, 1700))], ['green', 'blue'])
  } finally { t.close() }
})

await test('each panel can be set to any screen or to you, in any order, with two or three panels', async () => {
  const t = await boot(colourSources())
  try {
    await t.call('POST', '/api/capture'); await wait(100); await t.finish()
    const id = (await t.call('GET', '/api/state')).body.captures[0].id
    const final = path.join(t.app.store.folderFor(id), 'final.mp4')
    const set = async (panels) => {
      const res = await t.call('PATCH', `/api/captures/${id}`, { panels })
      assert.equal(res.status, 200, JSON.stringify(res.body))
      assert.equal(size(final), '1080,1920')
    }

    await set(['screen0', 'camera'])                       // two panels: the other screen
    assert.deepEqual([dominant(pixel(final, 540, 300)), dominant(pixel(final, 540, 1700))], ['red', 'blue'])
    await set(['camera', 'screen1'])                       // you on top this time
    assert.deepEqual([dominant(pixel(final, 540, 300)), dominant(pixel(final, 540, 1700))], ['blue', 'green'])
    await set(['screen0', 'screen1'])                      // two screens, equal halves
    assert.deepEqual([dominant(pixel(final, 540, 300)), dominant(pixel(final, 540, 1650))], ['red', 'green'])

    await set(['screen0', 'camera', 'screen0'])            // the same screen twice
    assert.deepEqual(panels(final), ['red', 'blue', 'red'])
    await set(['screen1', 'camera', 'screen0'])            // both screens
    assert.deepEqual(panels(final), ['green', 'blue', 'red'])
    await set(['camera', 'screen0', 'screen1'])            // any order
    assert.deepEqual(panels(final), ['blue', 'red', 'green'])
    await set(['camera', 'camera', 'screen1'])             // even you twice
    assert.deepEqual(panels(final), ['blue', 'blue', 'green'])

    assert.deepEqual((await t.call('GET', '/api/state')).body.captures[0].panels, ['camera', 'camera', 'screen1']) // remembered
  } finally { t.close() }
})

await test('blur is set per panel: each panel blurs on its own, only in the finished clip, and bad values are refused', async () => {
  // a screen that is half black, half white, so a blurred edge can be measured
  const edge = { ...solid('screen1', 'white', '1920x1080'), inputArgs: ['-f', 'lavfi', '-i', 'color=c=white:s=1920x1080:r=15,drawbox=x=0:y=0:w=960:h=1080:color=black:t=fill'] }
  const t = await boot([solid('screen0', 'red', '2940x1912'), edge, solid('camera', 'blue', '1280x720')])
  try {
    await t.call('POST', '/api/capture'); await wait(100); await t.finish()
    const id = (await t.call('GET', '/api/state')).body.captures[0].id
    const dir = t.app.store.folderFor(id)
    const final = path.join(dir, 'final.mp4')
    const rawBefore = fs.statSync(path.join(dir, 'screen1.mp4')).size
    const redOf = (y) => pixel(final, 530, y)[0] // just left of the black/white edge

    const res = await t.call('PATCH', `/api/captures/${id}`, { panels: ['screen1', 'screen1', 'screen1'], blurs: ['off', 'soft', 'heavy'] })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const [sharp, soft, heavy] = [redOf(300), redOf(960), redOf(1650)]
    assert.ok(sharp < 20, `the unblurred panel should still have a hard edge (got ${sharp})`)
    assert.ok(soft > sharp + 25, `soft should smear the edge (sharp ${sharp}, soft ${soft})`)
    assert.ok(heavy > soft + 15, `heavy should smear it more (soft ${soft}, heavy ${heavy})`)
    assert.equal(fs.statSync(path.join(dir, 'screen1.mp4')).size, rawBefore, 'the raw recording is never blurred')

    // blur one panel only, other screen and you stay sharp
    await t.call('PATCH', `/api/captures/${id}`, { panels: ['screen0', 'camera', 'screen1'], blurs: ['off', 'off', 'heavy'] })
    assert.deepEqual([dominant(pixel(final, 540, 300)), dominant(pixel(final, 540, 960))], ['red', 'blue'])
    assert.ok(redOf(1650) > 60)

    // blur settings stay with their slots when only the panels change, and are remembered
    assert.deepEqual((await t.call('GET', '/api/state')).body.captures[0].blurs, ['off', 'off', 'heavy'])
    for (const blurs of [['off', 'gigantic', 'off'], ['off', 'off', 'off', 'off'], 'heavy']) {
      assert.equal((await t.call('PATCH', `/api/captures/${id}`, { blurs })).status, 400, JSON.stringify(blurs))
    }
    assert.deepEqual((await t.call('GET', '/api/state')).body.captures[0].blurs, ['off', 'off', 'heavy'])

    // two panels: the blur list is cut to match
    await t.call('PATCH', `/api/captures/${id}`, { panels: ['screen1', 'camera'] })
    assert.deepEqual((await t.call('GET', '/api/state')).body.captures[0].blurs, ['off', 'off'])
  } finally { t.close() }
})

await test('one panel: the whole frame is the camera, a screen over a blurred backdrop ("fit"), or the screen filling the frame ("fill")', async () => {
  // a green screen with a blue stripe down its far left edge, so we can tell whether the sides are kept or cropped away
  const striped = { ...solid('screen1', 'green', '1920x1080'), inputArgs: ['-f', 'lavfi', '-i', 'color=c=green:s=1920x1080:r=15,drawbox=x=0:y=0:w=100:h=1080:color=blue:t=fill'] }
  const t = await boot([solid('screen0', 'red', '2940x1912'), striped, solid('camera', 'blue', '1280x720')])
  try {
    await t.call('POST', '/api/capture'); await wait(100); await t.finish()
    const id = t.app.store.list()[0].id
    const final = path.join(t.app.store.folderFor(id), 'final.mp4')
    const patch = async (body) => { const r = await t.call('PATCH', `/api/captures/${id}`, body); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(size(final), '1080,1920') }

    // the camera alone fills the frame, top to bottom
    await patch({ panels: ['camera'] })
    assert.deepEqual([dominant(pixel(final, 540, 40)), dominant(pixel(final, 540, 960)), dominant(pixel(final, 540, 1880))], ['blue', 'blue', 'blue'])

    // a screen, "fit" (the default): the whole screen in the middle, a darker blurred copy behind it
    await patch({ panels: ['screen1'] })
    assert.equal(t.app.store.get(id).singleFit, 'fit')
    assert.deepEqual(pixel(final, 10, 960).map((c) => c > 150), [false, false, true], 'the blue stripe at the far left of the screen is visible')
    const [, middleGreen] = pixel(final, 540, 960)
    const [, backdropGreen] = pixel(final, 540, 100)
    assert.ok(middleGreen > 118, 'the screen itself is green in the middle')
    assert.ok(backdropGreen > 30 && backdropGreen < middleGreen - 15, `the backdrop is a darker green (middle ${middleGreen}, backdrop ${backdropGreen})`)

    // "fill": the screen covers the frame, so its far-left stripe is cropped off and green runs top to bottom
    await patch({ singleFit: 'fill' })
    assert.deepEqual([dominant(pixel(final, 10, 960)), dominant(pixel(final, 540, 40)), dominant(pixel(final, 540, 1880))], ['green', 'green', 'green'])
    assert.equal(t.app.store.get(id).singleFit, 'fill')

    // the choice only matters for a screen; bad values are refused and change nothing
    for (const bad of ['stretch', 3, null]) assert.equal((await t.call('PATCH', `/api/captures/${id}`, { singleFit: bad })).status, 400, JSON.stringify(bad))
    assert.equal(t.app.store.get(id).singleFit, 'fill')

    // a blur and a trim apply to the single panel too
    await patch({ singleFit: 'fit', blurs: ['heavy'], cropTop: 0.2, panels: ['screen1'] })
    assert.deepEqual(t.app.store.get(id).blurs, ['heavy'])
  } finally { t.close() }
})

await test('trim top: the recipe crops screens only (never the camera), and not at all when it is off', () => {
  const screen = { file: 's.mp4', kind: 'screen', size: { w: 1920, h: 1080 } }
  const me = { file: 'c.mp4', kind: 'camera', size: { w: 1280, h: 720 } }
  const filterOf = (args) => args[args.indexOf('-filter_complex') + 1]
  const trimmed = filterOf(buildFinalArgs([screen, me, screen], 'o.mp4', { cropTop: 0.1 }))
  assert.equal(trimmed.split('crop=iw:trunc').length - 1, 2, 'both screen panels are trimmed')
  const parts = trimmed.split(';')
  assert.ok(parts[0].includes('crop=iw:trunc') && !parts[1].includes('crop=iw:trunc') && parts[2].includes('crop=iw:trunc'), 'the camera panel is not trimmed')
  assert.ok(!filterOf(buildFinalArgs([screen, me], 'o.mp4', {})).includes('crop=iw:trunc'))
  assert.ok(!filterOf(buildFinalArgs([screen, me], 'o.mp4', { cropTop: 0 })).includes('crop=iw:trunc'))
})

await test('trim top: the top of a screen (the menu bar, a browser address bar) is cut off, in two and three panels, and the camera is untouched', async () => {
  // a screen with a red strip across its top fifth and green below it, like an address bar above a page
  const withBar = { ...solid('screen1', 'green', '1920x1080'), inputArgs: ['-f', 'lavfi', '-i', 'color=c=green:s=1920x1080:r=15,drawbox=x=0:y=0:w=1920:h=216:color=red:t=fill'] }
  const t = await boot([solid('screen0', 'red', '2940x1912'), withBar, solid('camera', 'blue', '1280x720')])
  try {
    await t.call('POST', '/api/capture'); await wait(100); await t.finish()
    const entry = t.app.store.list()[0]
    assert.equal(entry.cropTop, 0, 'off unless asked for')
    const final = path.join(t.app.store.folderFor(entry.id), 'final.mp4')
    assert.equal(dominant(pixel(final, 540, 6)), 'red', 'the strip is there before trimming')

    assert.equal((await t.call('PATCH', `/api/captures/${entry.id}`, { cropTop: 0.25 })).status, 200)
    assert.equal(size(final), '1080,1920')
    assert.equal(dominant(pixel(final, 540, 6)), 'green', 'the strip is gone after trimming')
    assert.equal(dominant(pixel(final, 540, 1800)), 'blue', 'the camera is not trimmed')

    // three panels: the third panel is the same screen again, and is trimmed too
    await t.call('PATCH', `/api/captures/${entry.id}`, { panels: ['screen1', 'camera', 'screen1'] })
    assert.deepEqual([dominant(pixel(final, 540, 6)), dominant(pixel(final, 540, 1290))], ['green', 'green'])
    await t.call('PATCH', `/api/captures/${entry.id}`, { cropTop: 0 })
    assert.deepEqual([dominant(pixel(final, 540, 6)), dominant(pixel(final, 540, 1290))], ['red', 'red'], 'back to untrimmed')

    // remembered, and bad values refused
    await t.call('PATCH', `/api/captures/${entry.id}`, { cropTop: 0.2 })
    assert.equal(t.app.store.get(entry.id).cropTop, 0.2)
    for (const bad of [0.9, -0.1, 'ten', null]) assert.equal((await t.call('PATCH', `/api/captures/${entry.id}`, { cropTop: bad })).status, 400, JSON.stringify(bad))
    assert.equal(t.app.store.get(entry.id).cropTop, 0.2)
  } finally { t.close() }
})

await test('trim top: new captures start with the trim from the settings (screenCropTop)', async () => {
  const withBar = { ...solid('screen1', 'green', '1920x1080'), inputArgs: ['-f', 'lavfi', '-i', 'color=c=green:s=1920x1080:r=15,drawbox=x=0:y=0:w=1920:h=216:color=red:t=fill'] }
  const t = await boot([solid('screen0', 'red', '2940x1912'), withBar, solid('camera', 'blue', '1280x720')], { config: { screenCropTop: 0.25 } })
  try {
    await t.call('POST', '/api/capture'); await wait(100); await t.finish()
    const entry = t.app.store.list()[0]
    assert.equal(entry.cropTop, 0.25)
    assert.equal(dominant(pixel(path.join(t.app.store.folderFor(entry.id), 'final.mp4'), 540, 6)), 'green')
  } finally { t.close() }
})

await test('the caption position and size are remembered per capture, and out-of-range or odd values are refused', async () => {
  const t = await boot(colourSources())
  try {
    await t.call('POST', '/api/capture'); await wait(100); await t.finish()
    const id = (await t.call('GET', '/api/state')).body.captures[0].id
    assert.equal((await t.call('GET', '/api/state')).body.captures[0].captionBox, undefined)
    assert.equal((await t.call('PATCH', `/api/captures/${id}`, { captionBox: { x: 0.3, y: 0.82, size: 52 } })).status, 200)
    assert.deepEqual((await t.call('GET', '/api/state')).body.captures[0].captionBox, { x: 0.3, y: 0.82, size: 52 })
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(t.rootDir, 'log.json'), 'utf8'))[0].captionBox, { x: 0.3, y: 0.82, size: 52 }, 'it must be saved to disk')
    for (const bad of [{ x: 1.4, y: 0.5, size: 46 }, { x: 0.5, y: -0.1, size: 46 }, { x: 0.5, y: 0.5, size: 5 }, { x: 0.5, y: 0.5, size: 400 }, { x: 'a', y: 0.5, size: 46 }, { x: 0.5, y: 0.5 }, 'middle', null]) {
      assert.equal((await t.call('PATCH', `/api/captures/${id}`, { captionBox: bad })).status, 400, JSON.stringify(bad))
    }
    assert.deepEqual((await t.call('GET', '/api/state')).body.captures[0].captionBox, { x: 0.3, y: 0.82, size: 52 }, 'bad values change nothing')
  } finally { t.close() }
})

await test('bad panel choices are refused and change nothing', async () => {
  const t = await boot(colourSources())
  try {
    await t.call('POST', '/api/capture'); await wait(100); await t.finish()
    const id = (await t.call('GET', '/api/state')).body.captures[0].id
    for (const panels of [['screen0', 'camera', 'screen1', 'camera'], ['screen7', 'camera'], ['screen0', 'sideways'], 'screen0', []]) {
      assert.equal((await t.call('PATCH', `/api/captures/${id}`, { panels })).status, 400, JSON.stringify(panels))
    }
    assert.equal((await t.call('PATCH', '/api/captures/2026-01-01_000000', { caption: 'x' })).status, 404)
    assert.deepEqual((await t.call('GET', '/api/state')).body.captures[0].panels, ['screen1', 'camera'])
  } finally { t.close() }
})

await test('the starting panels follow the config, and a screen that is not plugged in is swapped for one that is', async () => {
  const three = await boot(colourSources(), { config: { defaultPanels: ['screen0', 'camera', 'screen1'] } })
  try {
    await three.call('POST', '/api/capture'); await wait(100); await three.finish()
    assert.deepEqual(three.app.store.list()[0].panels, ['screen0', 'camera', 'screen1'])
  } finally { three.close() }

  const oneScreen = [solid('screen0', 'red', '2940x1912'), solid('camera', 'blue', '1280x720')]
  const t = await boot(oneScreen, { config: { defaultPanels: ['screen1', 'camera', 'screen1'] } })
  try {
    await t.call('POST', '/api/capture'); await wait(100); await t.finish()
    assert.deepEqual(t.app.store.list()[0].panels, ['screen0', 'camera', 'screen0'])
  } finally { t.close() }
})

await test('a caption is saved, and delete removes the capture and all its files', async () => {
  const t = await boot(colourSources())
  try {
    await t.call('POST', '/api/capture'); await wait(100); await t.finish()
    const id = (await t.call('GET', '/api/state')).body.captures[0].id
    await t.call('PATCH', `/api/captures/${id}`, { caption: 'blocking in the sky' })
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.rootDir, 'log.json'), 'utf8'))[0].caption, 'blocking in the sky')
    const dir = t.app.store.folderFor(id)
    assert.equal((await t.call('DELETE', `/api/captures/${id}`)).status, 200)
    assert.equal(fs.existsSync(dir), false)
    assert.equal((await t.call('GET', '/api/state')).body.captures.length, 0)
    assert.equal((await t.call('DELETE', `/api/captures/${id}`)).status, 404)
  } finally { t.close() }
})

await test('videos are served with range support, and a path that climbs out of the folder is refused', async () => {
  const t = await boot(colourSources())
  try {
    await t.call('POST', '/api/capture'); await wait(100); await t.finish()
    const id = (await t.call('GET', '/api/state')).body.captures[0].id
    const res = await fetch(`http://127.0.0.1:${t.app.port}/files/${id}/final.mp4`, { headers: { Range: 'bytes=0-99' } })
    assert.equal(res.status, 206)
    assert.equal((await res.arrayBuffer()).byteLength, 100)
    const status = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: t.app.port, path: '/files/..%2Flog.json' }, (r) => { r.resume(); resolve(r.statusCode) }))
    assert.equal(status, 404)
  } finally { t.close() }
})

await test('a capture where every screen is black is thrown away with a note, not saved', async () => {
  const t = await boot(blackSources())
  try {
    await t.call('POST', '/api/capture'); await wait(100); await t.finish()
    const { body } = await t.call('GET', '/api/state')
    assert.equal(body.captures.length, 0)
    assert.match(body.note.message, /black/)
    assert.deepEqual(fs.readdirSync(t.app.store.capturesDir), [])
  } finally { t.close() }
})

await test('a recording that fails leaves an error on screen, saves nothing, and a later good capture clears it', async () => {
  let sources = brokenSources()
  const t = await boot(async () => sources)
  try {
    await t.call('POST', '/api/capture'); await wait(100); await t.finish()
    let s = (await t.call('GET', '/api/state')).body
    assert.ok(s.error && s.error.message.length > 0)
    assert.equal(s.captures.length, 0)
    assert.deepEqual(fs.readdirSync(t.app.store.capturesDir), [])
    sources = colourSources()
    await t.call('POST', '/api/capture'); await wait(100); await t.finish()
    s = (await t.call('GET', '/api/state')).body
    assert.equal(s.error, null)
    assert.equal(s.captures.length, 1)
  } finally { t.close() }
})

await test('the capture frequency can be changed on the page: it applies at once, restarts the countdown, is saved, and bad values are refused', async () => {
  const t = await boot(colourSources())
  try {
    fs.writeFileSync(path.join(t.rootDir, 'config.json'), JSON.stringify({ everyMinutes: 15, defaultPanels: ['screen1', 'camera'], cameraName: 'Other camera' }))
    const before = t.app.state.nextAt
    const res = await t.call('POST', '/api/settings', { everyMinutes: 30 })
    assert.equal(res.status, 200)
    const state = (await t.call('GET', '/api/state')).body
    assert.equal(state.everyMinutes, 30)
    const minutesAhead = (t.app.state.nextAt - Date.now()) / 60000
    assert.ok(minutesAhead > 29.5 && minutesAhead <= 30, `the next capture is 30 minutes from now (got ${minutesAhead})`)
    assert.ok(t.app.state.nextAt > before)
    const saved = JSON.parse(fs.readFileSync(path.join(t.rootDir, 'config.json'), 'utf8'))
    assert.equal(saved.everyMinutes, 30, 'saved to the settings file')
    assert.equal(saved.cameraName, 'Other camera', 'the other settings are kept as they were')
    for (const bad of [0, 1, -5, 2.5, 5000, '15', null, undefined]) assert.equal((await t.call('POST', '/api/settings', { everyMinutes: bad })).status, 400, String(bad))
    assert.equal(t.app.state.nextAt > 0 && (await t.call('GET', '/api/state')).body.everyMinutes, 30, 'bad values change nothing')
  } finally { t.close() }
})

await test('changing the frequency while logging is paused does not switch logging back on', async () => {
  const t = await boot(colourSources())
  try {
    await t.call('POST', '/api/logging', { on: false })
    assert.equal((await t.call('POST', '/api/settings', { everyMinutes: 10 })).status, 200)
    assert.equal(t.app.state.logging, false)
    assert.equal(t.app.state.nextAt, null)
    await t.call('POST', '/api/logging', { on: true })
    assert.ok((t.app.state.nextAt - Date.now()) / 60000 > 9.5, 'resuming uses the new spacing')
  } finally { t.close() }
})

await test('the 15-minute timer skips while the screen is locked, and does nothing while paused', async () => {
  let locked = true
  const t = await boot(colourSources(), { screenIsLocked: async () => locked })
  try {
    await t.app.autoCapture()
    assert.match(t.app.state.note.message, /locked/)
    assert.equal(t.app.store.list().length, 0)

    await t.call('POST', '/api/logging', { on: false })
    locked = false
    await t.app.autoCapture()
    assert.equal(t.app.store.list().length, 0)
    assert.equal(t.app.state.nextAt, null)

    await t.call('POST', '/api/logging', { on: true })
    assert.ok(t.app.state.nextAt > Date.now())
    await t.app.autoCapture()
    assert.equal(t.app.store.list().length, 1)
    assert.equal(t.app.store.list()[0].kind, 'auto')
  } finally { t.close() }
})

await test('every capture, automatic or from a button, is marked as waiting for a caption (no sound, no banner)', async () => {
  const t = await boot(colourSources())
  try {
    await t.app.autoCapture()
    await t.call('POST', '/api/capture'); await wait(100); await t.finish()
    const [button, auto] = t.app.store.list() // newest first
    assert.equal(auto.kind, 'auto')
    assert.equal(auto.pending, true)
    assert.equal(button.kind, 'button')
    assert.equal(button.pending, true)
  } finally { t.close() }
})

await test('the waiting reminder goes away when you caption it or dismiss it, but not for an empty caption', async () => {
  const t = await boot(colourSources())
  try {
    await t.app.autoCapture()
    const id = t.app.store.list()[0].id
    await t.call('PATCH', `/api/captures/${id}`, { caption: '   ' })
    assert.equal(t.app.store.get(id).pending, true)
    await t.call('PATCH', `/api/captures/${id}`, { caption: 'drawing the horizon' })
    assert.equal(t.app.store.get(id).pending, false)
    await t.app.autoCapture()
    const id2 = t.app.store.list()[0].id
    assert.equal(t.app.store.get(id2).pending, true)
    await t.call('PATCH', `/api/captures/${id2}`, { dismiss: true })
    assert.equal(t.app.store.get(id2).pending, false)
  } finally { t.close() }
})

await test('while an automatic capture runs the server says so (so the menu button stays quiet), a button capture says "button"', async () => {
  const t = await boot(colourSources())
  try {
    const auto = t.app.autoCapture()
    await wait(300)
    assert.equal(t.app.state.captureKind, 'auto')
    await auto
    assert.equal(t.app.state.captureKind, null)
    await t.call('POST', '/api/capture'); await wait(300)
    assert.equal(t.app.state.captureKind, 'button')
    await t.finish()
  } finally { t.close() }
})

await test('black and white: only the camera panel loses its colour, the screens keep theirs, and it can be switched per capture', async () => {
  const t = await boot(colourSources(), { config: { cameraBlackAndWhite: true } })
  try {
    await t.call('POST', '/api/capture'); await wait(100); await t.finish()
    const entry = t.app.store.list()[0]
    assert.equal(entry.cameraGrey, true)
    const final = path.join(t.app.store.folderFor(entry.id), 'final.mp4')
    assert.equal(dominant(pixel(final, 540, 300)), 'green')   // the screen is untouched
    assert.ok(isGrey(pixel(final, 540, 1700)), 'the camera should be grey')

    await t.call('PATCH', `/api/captures/${entry.id}`, { cameraGrey: false })
    assert.equal(dominant(pixel(final, 540, 1700)), 'blue')   // colour again

    await t.call('PATCH', `/api/captures/${entry.id}`, { cameraGrey: true, panels: ['screen1', 'camera', 'screen0'] })
    assert.equal(dominant(pixel(final, 540, 300)), 'green')
    assert.ok(isGrey(pixel(final, 540, 960)), 'the camera panel in the middle should be grey')
    assert.equal(dominant(pixel(final, 540, 1650)), 'red')    // the other screen is untouched
  } finally { t.close() }
})

await test('without the black-and-white setting the camera stays in colour', async () => {
  const t = await boot(colourSources())
  try {
    await t.call('POST', '/api/capture'); await wait(100); await t.finish()
    const entry = t.app.store.list()[0]
    assert.equal(entry.cameraGrey, false)
    assert.equal(dominant(pixel(path.join(t.app.store.folderFor(entry.id), 'final.mp4'), 540, 1700)), 'blue')
  } finally { t.close() }
})

// ------------------------------------------------------------ quiet mode (Do Not Disturb while recording)

function fakeShortcuts({ existing = ['Process Log quiet on', 'Process Log quiet off'], failOn = [] } = {}) {
  const calls = []
  const runner = async (command, args) => {
    calls.push([command, ...args].join(' | '))
    if (args[0] === 'list') return { code: 0, out: existing.join('\n') + '\nSome other shortcut\n', err: '' }
    if (args[0] === 'run' && failOn.includes(args[1])) return { code: 1, out: '', err: 'Shortcut failed' }
    return { code: 0, out: '', err: '' }
  }
  return { calls, runner }
}
const quietConfig = { quietShortcutOn: 'Process Log quiet on', quietShortcutOff: 'Process Log quiet off' }

await test('quiet: runs the "on" shortcut then the "off" shortcut by name (spaces and all), and nothing else', async () => {
  const fake = fakeShortcuts()
  const quiet = createQuiet(quietConfig, fake.runner)
  assert.equal(await quiet.available(), true)
  assert.equal(await quiet.on(), true)
  await quiet.off()
  assert.deepEqual(fake.calls, ['shortcuts | list', 'shortcuts | run | Process Log quiet on', 'shortcuts | run | Process Log quiet off'])
})

await test('quiet: with no names set, or a shortcut that does not exist, nothing is run and the capture simply goes ahead', async () => {
  const none = fakeShortcuts()
  assert.equal(await createQuiet({}, none.runner).on(), false)
  assert.deepEqual(none.calls, [])
  const missing = fakeShortcuts({ existing: ['Process Log quiet on'] }) // "off" was never made
  const quiet = createQuiet(quietConfig, missing.runner)
  assert.equal(await quiet.available(), false)
  assert.equal(await quiet.on(), false)
  assert.ok(!missing.calls.some((c) => c.includes('| run |')), 'it must not switch Do Not Disturb on if it cannot switch it off again')
})

await test('quiet: if "on" fails it says so and returns false; if "off" fails it throws so the page can warn', async () => {
  const said = []
  const failingOn = fakeShortcuts({ failOn: ['Process Log quiet on'] })
  assert.equal(await createQuiet(quietConfig, failingOn.runner, (m) => said.push(m)).on(), false)
  assert.match(said[0], /failed/)
  const failingOff = fakeShortcuts({ failOn: ['Process Log quiet off'] })
  const quiet = createQuiet(quietConfig, failingOff.runner)
  await quiet.on()
  await assert.rejects(quiet.off(), /Do Not Disturb may still be on/)
})

await test('quiet: during a capture Do Not Disturb is on only while recording, and is switched off even if the recording fails', async () => {
  for (const sources of [colourSources(), brokenSources()]) {
    const calls = []
    let phaseAtOff = null
    let appRef = null
    const quiet = { on: async () => { calls.push('on'); return true }, off: async () => { calls.push('off'); phaseAtOff = appRef.state.phase } }
    const t = await boot(sources, { quiet })
    appRef = t.app
    try {
      await t.call('POST', '/api/capture'); await wait(100); await t.finish()
      assert.deepEqual(calls, ['on', 'off'])
      assert.equal(phaseAtOff, 'recording', '"off" runs as soon as the recording ends, before the clip is built')
    } finally { t.close() }
  }
})

await test('quiet: a failed "on" does not stop the capture, and "off" is not run when "on" never worked', async () => {
  const calls = []
  const quiet = { on: async () => { calls.push('on'); return false }, off: async () => { calls.push('off') } }
  const t = await boot(colourSources(), { quiet })
  try {
    await t.call('POST', '/api/capture'); await wait(100); await t.finish()
    assert.deepEqual(calls, ['on'])
    assert.equal(t.app.store.list().length, 1)
  } finally { t.close() }
})

await test('quiet: if "off" fails the capture is still saved and a warning stays on the page', async () => {
  const quiet = { on: async () => true, off: async () => { throw new Error('The shortcut "Process Log quiet off" failed, so Do Not Disturb may still be on: x') } }
  const t = await boot(colourSources(), { quiet })
  try {
    await t.call('POST', '/api/capture'); await wait(100); await t.finish()
    assert.equal(t.app.store.list().length, 1)
    assert.match(t.app.state.note.message, /Do Not Disturb may still be on/)
  } finally { t.close() }
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
