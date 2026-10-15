// Tests for the finished clip, the sound folder and saving into Photos. Run with:  node tests/story-test.mjs
//
// The Photos app is replaced by a fake that records which file it was handed, so nothing is
// added to your library. The sound folder, the clip-building (ffmpeg) and the server's saving
// journey are the real code.
//
// What these tests CANNOT prove: that Photos accepts the file. The AppleScript was only checked
// to compile against Photos' command list. Your first real "Save to Photos" is the proof.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { FFMPEG, FFPROBE } from '../capture.js'
import { listFolder, searchSounds, resolveInside } from '../sounds.js'
import { buildStoryArgs, renderStory } from '../story.js'
import { PHOTOS_ALBUM } from '../photos.js'
import { startServer } from '../server.js'

let passed = 0
let failed = 0
async function test(name, fn) {
  try { await fn(); console.log(`ok    ${name}`); passed++ } catch (e) { console.log(`FAIL  ${name}\n${e.stack}`); failed++ }
}
const tempDir = () => fs.mkdtempSync(path.join(process.env.PL_TEST_TMP || os.tmpdir(), 'process-log-post-test-'))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const ff = (...args) => execFileSync(FFMPEG, ['-v', 'error', '-y', ...args], { stdio: 'pipe' })

function streams(file) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels,pix_fmt,duration,start_time', '-of', 'json', file], { encoding: 'utf8' })
  const list = JSON.parse(out).streams
  return { video: list.find((s) => s.codec_type === 'video'), audio: list.find((s) => s.codec_type === 'audio') }
}
const pixelOf = (file, x, y) => {
  const out = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', `crop=2:2:${x}:${y},format=rgb24`, '-f', 'rawvideo', '-'], { encoding: 'buffer' })
  return [out[0], out[1], out[2]]
}

// A finished clip (solid blue, 1080x1920) of a given length, a sound, and a caption picture with one white box.
function makeMaterials(dir, { seconds = 6 } = {}) {
  ff('-f', 'lavfi', '-i', `color=c=blue:s=1080x1920:r=30`, '-t', String(seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'final.mp4'))
  ff('-f', 'lavfi', '-i', 'color=c=white:s=400x120,format=rgba', '-vf', 'pad=1080:1920:100:100:color=black@0', '-frames:v', '1', path.join(dir, 'caption.png'))
}
const makeSound = (file, seconds) => ff('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, file)

// ------------------------------------------------------------ the sounds folder

await test('the sounds folder lists folders and sound files only, in natural order, and hides hidden things', () => {
  const root = tempDir()
  fs.mkdirSync(path.join(root, 'Ambience'))
  fs.mkdirSync(path.join(root, 'Horror', 'Doors'), { recursive: true })
  fs.mkdirSync(path.join(root, '.hidden'))
  for (const f of ['b10.wav', 'b2.wav', 'notes.txt', '.DS_Store', 'Ambience/Wind.mp3', 'Horror/Doors/Creak Door.wav', 'Horror/scream.aif']) {
    fs.writeFileSync(path.join(root, f), 'x')
  }
  const top = listFolder(root)
  assert.deepEqual(top.folders.map((f) => f.name), ['Ambience', 'Horror'])
  assert.deepEqual(top.files.map((f) => f.name), ['b2.wav', 'b10.wav'])
  assert.equal(top.path, '')
  const horror = listFolder(root, 'Horror')
  assert.equal(horror.path, 'Horror')
  assert.deepEqual(horror.folders.map((f) => f.name), ['Doors'])
  assert.deepEqual(horror.files.map((f) => f.name), ['scream.aif'])
  fs.rmSync(root, { recursive: true, force: true })
})

await test('a path that climbs out of the sounds folder is refused', () => {
  const root = tempDir()
  assert.equal(resolveInside(root, '../etc'), null)
  assert.equal(resolveInside(root, 'a/../../x'), null)
  assert.equal(resolveInside(root, '/etc/passwd'), null)
  assert.equal(resolveInside(root, 'Horror/Doors'), path.join(path.resolve(root), 'Horror', 'Doors'))
  assert.throws(() => listFolder(root, '..'), /outside/)
  fs.rmSync(root, { recursive: true, force: true })
})

await test('search finds sound files in any subfolder by every word typed, and stops at the limit', () => {
  const root = tempDir()
  fs.mkdirSync(path.join(root, 'Horror', 'Doors'), { recursive: true })
  fs.mkdirSync(path.join(root, 'Ambience'))
  for (const f of ['Horror/Doors/Creak Door.wav', 'Horror/Doors/Slam.wav', 'Ambience/Door Bell.mp3', 'Ambience/notes.txt']) fs.writeFileSync(path.join(root, f), 'x')
  assert.deepEqual(searchSounds(root, 'door').map((r) => r.name), ['Creak Door.wav', 'Door Bell.mp3', 'Slam.wav']) // 'Slam' is in a folder called Doors
  assert.deepEqual(searchSounds(root, 'horror creak').map((r) => r.path), [path.join('Horror', 'Doors', 'Creak Door.wav')])
  assert.deepEqual(searchSounds(root, 'notes'), [])
  assert.deepEqual(searchSounds(root, '   '), [])
  assert.equal(searchSounds(root, 'wav', 1).length, 1)
  fs.rmSync(root, { recursive: true, force: true })
})

// ------------------------------------------------------------ the finished clip

await test('story clip: Instagram-ready video, the caption is on top, and a short sound is padded to the clip length', async () => {
  const dir = tempDir()
  makeMaterials(dir)
  const sound = path.join(dir, 'beep.wav'); makeSound(sound, 2)
  const { file, seconds } = await renderStory(dir, { withCaption: true, soundFile: sound })
  const s = streams(file)
  assert.equal(s.video.codec_name, 'h264')
  assert.equal(`${s.video.width}x${s.video.height}`, '1080x1920')
  assert.equal(s.video.pix_fmt, 'yuv420p')
  assert.equal(s.video.r_frame_rate, '30/1')
  assert.equal(s.audio.codec_name, 'aac')
  assert.equal(s.audio.sample_rate, '48000')
  assert.equal(s.audio.channels, 2)
  assert.ok(Math.abs(seconds - 6) < 0.2)
  assert.ok(Math.abs(Number(s.audio.duration) - 6) < 0.3, `the sound should be padded to the clip length (got ${s.audio.duration})`)
  // the picture and the sound both start at exactly 0 and end together, so nothing is shown as black at either end
  assert.ok(Number(s.video.start_time) < 0.01, `the video must start at 0 (got ${s.video.start_time})`)
  assert.ok(Number(s.audio.start_time) < 0.01, `the sound must start at 0 (got ${s.audio.start_time})`)
  assert.ok(Math.abs(Number(s.video.duration) - Number(s.audio.duration)) < 0.1, 'picture and sound must be the same length')
  const [r, g, b] = pixelOf(file, 200, 150)
  assert.ok(r > 200 && g > 200 && b > 200, 'the caption box should be white on top of the clip')
  const [r2, g2, b2] = pixelOf(file, 900, 1500)
  assert.ok(b2 > 200 && r2 < 60 && g2 < 60, 'the rest of the clip should be untouched')
  // the index is at the front, and there are no edit lists (both are Instagram's rules)
  const bytes = fs.readFileSync(file)
  assert.ok(bytes.indexOf('moov') > 0 && bytes.indexOf('moov') < bytes.indexOf('mdat'), 'moov must come before mdat')
  assert.equal(bytes.indexOf('elst'), -1, 'no edit lists allowed')
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('story clip: with no sound there is no audio track, with no caption the picture is untouched, and a long sound is cut', async () => {
  const dir = tempDir()
  makeMaterials(dir)
  const plain = await renderStory(dir, { withCaption: false, soundFile: null })
  const s = streams(plain.file)
  assert.equal(s.audio, undefined)
  const [r, g, b] = pixelOf(plain.file, 200, 150)
  assert.ok(b > 200 && r < 60 && g < 60, 'no caption: nothing should be drawn')

  const longSound = path.join(dir, 'long.wav'); makeSound(longSound, 20)
  const cut = await renderStory(dir, { withCaption: false, soundFile: longSound })
  assert.ok(Math.abs(Number(streams(cut.file).audio.duration) - 6) < 0.3)
  assert.ok(Math.abs(cut.seconds - 6) < 0.2)
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('story clip: a clip under 3 seconds is refused with a plain message, and no half-made file is left', async () => {
  const dir = tempDir()
  makeMaterials(dir, { seconds: 2 })
  await assert.rejects(renderStory(dir, { withCaption: false, soundFile: null }), /at least 3/)
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('story')), [])
  fs.rmSync(dir, { recursive: true, force: true })
})

await test('story clip: the recipe maps the sound only when there is one, and always uses the story settings', () => {
  const args = buildStoryArgs({ finalFile: 'f.mp4', captionFile: null, soundFile: null, seconds: 6, outFile: 'o.mp4' })
  assert.ok(args.includes('-an') && !args.includes('-filter_complex'))
  for (const wanted of ['libx264', 'yuv420p', '+faststart']) assert.ok(args.includes(wanted), wanted)
  const full = buildStoryArgs({ finalFile: 'f.mp4', captionFile: 'c.png', soundFile: 's.wav', seconds: 6, outFile: 'o.mp4' })
  assert.ok(full.includes('aac') && full.join(' ').includes('overlay=0:0'))
})

// ------------------------------------------------------------ the server's saving journey

function solid(name, colour, size, kind) {
  return { name, kind, number: kind === 'screen' ? Number(name.slice(-1)) : undefined, fps: kind === 'camera' ? 30 : 15, bitrate: '4M', maxWidth: kind === 'camera' ? 1280 : 1920, inputArgs: ['-f', 'lavfi', '-i', `color=c=${colour}:s=${size}:r=15`] }
}
const sources = () => [solid('screen0', 'red', '2940x1912', 'screen'), solid('screen1', 'green', '1920x1080', 'screen'), solid('camera', 'blue', '1280x720', 'camera')]

async function bootSaving({ importFails = null } = {}) {
  const rootDir = tempDir()
  const soundsDir = path.join(tempDir(), 'Sound Effects')
  fs.mkdirSync(path.join(soundsDir, 'Ambience'), { recursive: true })
  makeSound(path.join(soundsDir, 'Ambience', 'Wind.wav'), 2)
  fs.writeFileSync(path.join(soundsDir, 'notes.txt'), 'x')
  const imported = []
  const importer = async (file) => {
    if (importFails) throw new Error(importFails)
    const copy = path.join(rootDir, `imported-${imported.length}.mp4`) // keep a copy to inspect: the original may be replaced later
    fs.copyFileSync(file, copy)
    imported.push({ file, copy })
  }
  const config = { port: 0, everyMinutes: 15, seconds: 3.5, warmupSeconds: 0.5, defaultPanels: ['screen1', 'camera'], cameraName: 'FaceTime', soundsFolder: soundsDir }
  const app = await startServer({ rootDir, config, getSources: async () => sources(), screenIsLocked: async () => false, importer })
  const call = async (method, url, body) => {
    const res = await fetch(`http://127.0.0.1:${app.port}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  await call('POST', '/api/capture'); await wait(150)
  while (app.state.capturing) await wait(200)
  const id = app.store.list()[0].id
  const finish = async () => { while (app.state.saving) await wait(100) }
  return { app, imported, call, id, rootDir, soundsDir, finish, close: () => { app.close(); fs.rmSync(rootDir, { recursive: true, force: true }); fs.rmSync(path.dirname(soundsDir), { recursive: true, force: true }) } }
}
const captionPng = () => {
  const d = tempDir(); const f = path.join(d, 'c.png')
  ff('-f', 'lavfi', '-i', 'color=c=white:s=400x120,format=rgba', '-vf', 'pad=1080:1920:100:100:color=black@0', '-frames:v', '1', f)
  const data = `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`
  fs.rmSync(d, { recursive: true, force: true })
  return data
}

await test('save: builds the finished clip with caption and sound, hands it to Photos, and remembers it', async () => {
  const t = await bootSaving()
  try {
    t.app.store.update(t.id, { pending: true })
    const res = await t.call('POST', `/api/captures/${t.id}/save-to-photos`, { sound: path.join('Ambience', 'Wind.wav'), captionImage: captionPng() })
    assert.equal(res.status, 202, JSON.stringify(res.body))
    assert.equal(t.app.state.saving.id, t.id)
    await t.finish()
    assert.equal(t.app.state.saveError, null)
    assert.equal(t.imported.length, 1)
    assert.equal(path.basename(t.imported[0].file), 'story.mp4')
    const s = streams(t.imported[0].copy)
    assert.equal(`${s.video.width}x${s.video.height}`, '1080x1920')
    assert.ok(s.audio && s.audio.codec_name === 'aac', 'the sound should be in the saved clip')
    const [r, g, b] = pixelOf(t.imported[0].copy, 200, 150)
    assert.ok(r > 200 && g > 200 && b > 200, 'the caption should be on the clip')
    const entry = t.app.store.get(t.id)
    assert.equal(entry.saved.sound, 'Wind.wav')
    assert.equal(entry.pending, false, 'saving a capture clears its "waiting for a caption" reminder')
  } finally { t.close() }
})

await test('save: with no caption and no sound the clip is plain, and the album name is the one the README promises', async () => {
  const t = await bootSaving()
  try {
    await t.call('POST', `/api/captures/${t.id}/save-to-photos`, {})
    await t.finish()
    assert.equal(streams(t.imported[0].copy).audio, undefined)
    const [r, g, b] = pixelOf(t.imported[0].copy, 200, 150)
    assert.ok(g > 120 && r < 90 && b < 90, 'the picture should be untouched (screen 1 is green)')
    assert.equal(PHOTOS_ALBUM, 'Process Log')
    assert.equal(t.app.store.get(t.id).saved.sound, null)
  } finally { t.close() }
})

await test('save: a second save of the same capture needs "again", and only one clip is saved at a time', async () => {
  const t = await bootSaving()
  try {
    assert.equal((await t.call('POST', `/api/captures/${t.id}/save-to-photos`, {})).status, 202)
    assert.equal((await t.call('POST', `/api/captures/${t.id}/save-to-photos`, { again: true })).status, 409)
    await t.finish()
    const second = await t.call('POST', `/api/captures/${t.id}/save-to-photos`, {})
    assert.equal(second.status, 409)
    assert.match(second.body.error, /already in Photos/)
    assert.equal((await t.call('POST', `/api/captures/${t.id}/save-to-photos`, { again: true })).status, 202)
    await t.finish()
    assert.equal(t.imported.length, 2)
  } finally { t.close() }
})

await test('save: if Photos refuses, the error stays on screen until dismissed and nothing is marked saved', async () => {
  const t = await bootSaving({ importFails: 'macOS has not allowed Terminal to control Photos.' })
  try {
    await t.call('POST', `/api/captures/${t.id}/save-to-photos`, {})
    await t.finish()
    assert.match(t.app.state.saveError.message, /control Photos/)
    assert.equal(t.app.state.saveError.id, t.id)
    assert.equal(t.app.store.get(t.id).saved, undefined)
    assert.equal((await t.call('POST', '/api/dismiss')).status, 200)
    assert.equal(t.app.state.saveError, null)
  } finally { t.close() }
})

await test('save: bad requests are refused before anything happens (unknown capture, bad sound, bad caption picture)', async () => {
  const t = await bootSaving()
  try {
    assert.equal((await t.call('POST', '/api/captures/2026-01-01_000000/save-to-photos', {})).status, 404)
    for (const sound of ['../../etc/passwd', 'notes.txt', 'Ambience/Missing.wav', '/etc/passwd']) {
      assert.equal((await t.call('POST', `/api/captures/${t.id}/save-to-photos`, { sound })).status, 400, sound)
    }
    assert.equal((await t.call('POST', `/api/captures/${t.id}/save-to-photos`, { captionImage: 'data:image/png;base64,AAAAAAAAAAAA' })).status, 400)
    assert.equal(t.app.state.saving, null)
    assert.deepEqual(t.imported, [])
  } finally { t.close() }
})

await test('save: a clip too short for the Story rules reports it plainly instead of importing', async () => {
  const t = await bootSaving()
  try {
    // shorten the built clip to 2 seconds behind the server's back
    const final = path.join(t.app.store.folderFor(t.id), 'final.mp4')
    ff('-i', final, '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', `${final}.short.mp4`)
    fs.renameSync(`${final}.short.mp4`, final)
    await t.call('POST', `/api/captures/${t.id}/save-to-photos`, {})
    await t.finish()
    assert.match(t.app.state.saveError.message, /at least 3/)
    assert.deepEqual(t.imported, [])
  } finally { t.close() }
})

await test('server: the sound browser lists, searches and plays sounds, and nothing outside the sounds folder', async () => {
  const t = await bootSaving()
  try {
    const top = (await t.call('GET', '/api/sounds')).body
    assert.deepEqual(top.folders.map((f) => f.name), ['Ambience'])
    assert.deepEqual(top.files, [])
    assert.deepEqual((await t.call('GET', '/api/sounds?path=Ambience')).body.files.map((f) => f.name), ['Wind.wav'])
    assert.deepEqual((await t.call('GET', '/api/sounds?q=wind')).body.results.map((f) => f.path), [path.join('Ambience', 'Wind.wav')])
    const play = await fetch(`http://127.0.0.1:${t.app.port}/sounds/Ambience/Wind.wav`, { headers: { Range: 'bytes=0-99' } })
    assert.equal(play.status, 206)
    assert.equal(play.headers.get('content-type'), 'audio/wav')
    assert.equal((await fetch(`http://127.0.0.1:${t.app.port}/sounds/notes.txt`)).status, 404)
    assert.equal((await fetch(`http://127.0.0.1:${t.app.port}/sounds/..%2Fnotes.txt`)).status, 404)
    assert.equal((await t.call('GET', '/api/sounds?path=..')).status, 500)
  } finally { t.close() }
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
