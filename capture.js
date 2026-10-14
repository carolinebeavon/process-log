// capture.js — everything that touches ffmpeg.
//
// A "capture" is three short recordings made at the same moment: each screen
// and the FaceTime camera. They are kept as separate files (screen0.mp4,
// screen1.mp4, camera.mp4). The finished clip (final.mp4) is built from ONE
// screen plus the camera, stacked into a 1080 x 1920 Instagram-Story frame:
// the whole screen on top at full width, you underneath filling the rest.
// Because the raw files are kept, the clip can be rebuilt with the other screen.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Homebrew keeps programs in /opt/homebrew/bin on Apple Silicon Macs and /usr/local/bin on Intel ones.
const brew = (name) => ['/opt/homebrew/bin', '/usr/local/bin'].map((dir) => `${dir}/${name}`).find((file) => fs.existsSync(file)) ?? name
export const FFMPEG = brew('ffmpeg')
export const FFPROBE = brew('ffprobe')

export const STORY_WIDTH = 1080
export const STORY_HEIGHT = 1920
const MAX_SCREEN_HEIGHT = 1400 // a very tall screen is cropped so you always keep some room

// Run a program and collect what it prints. It never throws: a non-zero exit
// or a timeout is reported in the result, so the caller can explain it.
export function run(command, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args)
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err = (err + d).slice(-20000) })
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e), killed: false }) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code: signal ? -1 : code, out, err, killed: Boolean(signal) })
    })
  })
}

// ---------------------------------------------------------------- finding devices

// ffmpeg prints a numbered list of cameras and screens. This reads that list.
export function parseDevices(listing, cameraName = 'FaceTime') {
  const video = []
  let inVideoList = false
  for (const line of listing.split('\n')) {
    if (line.includes('AVFoundation video devices')) { inVideoList = true; continue }
    if (line.includes('AVFoundation audio devices')) { inVideoList = false; continue }
    const match = line.match(/\[(\d+)\] (.+)$/)
    if (inVideoList && match) video.push({ index: Number(match[1]), name: match[2].trim() })
  }
  const screens = video
    .map((d) => ({ d, m: d.name.match(/^Capture screen (\d+)$/) }))
    .filter((x) => x.m)
    .map((x) => ({ index: x.d.index, number: Number(x.m[1]) }))
    .sort((a, b) => a.number - b.number)
  const cameraDevice = video.find((d) => d.name.includes(cameraName))
  return { screens, camera: cameraDevice ? { index: cameraDevice.index } : null }
}

export async function findDevices(cameraName) {
  // Asking ffmpeg to list devices always "fails" after printing the list. That is normal.
  const result = await run(FFMPEG, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''])
  return parseDevices(result.err, cameraName)
}

// Turns the device list into the recipe for recording each thing.
export function realSources(devices) {
  if (!devices.camera) throw new Error('Could not find the camera. Is the FaceTime camera available?')
  if (devices.screens.length === 0) throw new Error('Could not find any screen to record.')
  const screens = devices.screens.map((s) => ({
    name: `screen${s.number}`,
    kind: 'screen',
    number: s.number,
    fps: 15,
    bitrate: '8M',
    maxWidth: 1920,
    inputArgs: [
      '-f', 'avfoundation', '-framerate', '15', '-pixel_format', 'uyvy422',
      '-capture_cursor', '1', '-use_wallclock_as_timestamps', '1', '-i', `${s.index}:none`,
    ],
  }))
  const camera = {
    name: 'camera',
    kind: 'camera',
    fps: 30,
    bitrate: '5M',
    maxWidth: 1280,
    inputArgs: [
      '-f', 'avfoundation', '-framerate', '30', '-video_size', '1280x720', '-pixel_format', 'uyvy422',
      '-use_wallclock_as_timestamps', '1', '-i', `${devices.camera.index}:none`,
    ],
  }
  return [...screens, camera]
}

// ---------------------------------------------------------------- recording

// All sources are opened by one ffmpeg so they start together. The first
// `warmupSeconds` are thrown away because a camera is dark while it adjusts.
export function buildRecordArgs(sources, dir, { seconds, warmupSeconds }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y']
  for (const s of sources) args.push(...s.inputArgs)
  sources.forEach((s, i) => {
    args.push(
      '-map', `${i}:v`,
      '-vf', `fps=${s.fps},scale=w='min(${s.maxWidth},iw)':h=-2`,
      '-c:v', 'h264_videotoolbox', '-b:v', s.bitrate, '-pix_fmt', 'yuv420p', '-an',
      '-ss', String(warmupSeconds), '-t', String(seconds),
      '-movflags', '+faststart',
      path.join(dir, `${s.name}.mp4`),
    )
  })
  return args
}

export function recordRaw(sources, dir, { seconds, warmupSeconds }) {
  const timeoutMs = (seconds + warmupSeconds + 30) * 1000
  return run(FFMPEG, buildRecordArgs(sources, dir, { seconds, warmupSeconds }), { timeoutMs })
}

// ---------------------------------------------------------------- reading files

export async function probeSize(file) {
  const r = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file])
  const [w, h] = r.out.trim().split(',').map(Number)
  if (!w || !h) throw new Error(`Could not read the size of ${path.basename(file)}`)
  return { w, h }
}

export async function probeDuration(file) {
  const r = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
  const seconds = Number(r.out.trim())
  if (!(seconds > 0)) throw new Error(`Could not read the length of ${path.basename(file)}`)
  return seconds
}

// True when a recording is (almost) pure black, which is what a switched-off or
// sleeping screen records. Pure black reads as 16 on the video scale.
export async function isBlack(file) {
  const r = await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-i', file,
    '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-',
  ])
  const values = [...r.out.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]))
  if (values.length === 0) return false
  return Math.max(...values) < 20
}

// ---------------------------------------------------------------- the finished clip

// Works out the two heights: the screen at full width, you in what is left.
export function storyLayout(screenSize) {
  const even = (n) => Math.round(n / 2) * 2
  const screenHeight = Math.min(even((STORY_WIDTH * screenSize.h) / screenSize.w), MAX_SCREEN_HEIGHT)
  return { screenHeight, meHeight: STORY_HEIGHT - screenHeight }
}

// A finished clip is one, two or three panels stacked top to bottom. Each panel shows one
// recording: a screen ("screen0", "screen1") or you ("camera"). Any order, and the
// same recording may be used twice.
//
//   three panels : three equal panels (each picture fills its panel, the little that overhangs is trimmed)
//   two panels   : if one is a screen and one is you, the screen is shown WHOLE at full width
//                  and you fill the rest; otherwise two equal halves
export function panelHeights(panels) {
  if (panels.length === 1) return [STORY_HEIGHT]
  if (panels.length === 3) return [STORY_HEIGHT / 3, STORY_HEIGHT / 3, STORY_HEIGHT / 3]
  const screens = panels.filter((p) => p.kind === 'screen')
  if (panels.length === 2 && screens.length === 1) {
    const { screenHeight, meHeight } = storyLayout(screens[0].size)
    return panels.map((p) => (p.kind === 'screen' ? screenHeight : meHeight))
  }
  return [STORY_HEIGHT / 2, STORY_HEIGHT / 2]
}

// How strongly a panel can be blurred to hide something. "heavy" makes writing unreadable.
export const BLUR_SIGMA = { off: 0, soft: 12, heavy: 40 }

// `panels` is a list of { file, kind: 'screen' | 'camera', size: { w, h }, blur: 'off' | 'soft' | 'heavy' }.
// `options.cameraGrey` turns the camera picture (not the screens) black and white.
// `options.cropTop` (0 to 0.4) trims that share off the TOP of every screen (the menu bar, a browser's
// address bar), before it is scaled into its panel. It does not touch the camera.
// A panel with `flip: true` is mirrored left to right (a camera often needs this to match a screen).
// `options.singleFit` only matters for a clip of ONE screen: 'fit' (the default) shows the whole screen in the
// middle of the frame over a soft, darkened, blurred copy of itself; 'fill' makes the screen cover the whole
// frame, which crops away most of its sides. One panel of the camera always fills the frame.
export function buildFinalArgs(panels, outFile, options = {}) {
  if (panels.length < 1 || panels.length > 3) throw new Error('A clip needs one, two or three panels.')
  const W = STORY_WIDTH
  const heights = panelHeights(panels)
  const parts = panels.map((p, i) => {
    const grey = p.kind === 'camera' && options.cameraGrey ? 'hue=s=0,' : ''
    const cropTop = p.kind === 'screen' && options.cropTop > 0 ? `crop=iw:trunc(ih*(1-${options.cropTop})/2)*2:0:trunc(ih*${options.cropTop}/2)*2,` : ''
    const sigma = BLUR_SIGMA[p.blur ?? 'off']
    if (sigma === undefined) throw new Error(`Unknown blur: ${p.blur}`)
    const blur = sigma > 0 ? `gblur=sigma=${sigma},` : ''
    const flip = p.flip ? 'hflip,' : ''
    return `[${i}:v]fps=30,${cropTop}${flip}${grey}scale=${W}:${heights[i]}:force_original_aspect_ratio=increase,crop=${W}:${heights[i]},${blur}setsar=1[p${i}]`
  })
  let filter
  if (panels.length === 1) {
    // One panel is the whole frame, so there is nothing to stack.
    const only = panels[0]
    const sigma = BLUR_SIGMA[only.blur ?? 'off']
    const blur = sigma > 0 ? `gblur=sigma=${sigma},` : ''
    const cropTop = only.kind === 'screen' && options.cropTop > 0 ? `crop=iw:trunc(ih*(1-${options.cropTop})/2)*2:0:trunc(ih*${options.cropTop}/2)*2,` : ''
    if (only.kind === 'screen' && (options.singleFit ?? 'fit') === 'fit') {
      filter = `[0:v]fps=30,${cropTop}${only.flip ? 'hflip,' : ''}split=2[back][front];` +
        `[back]scale=${W}:${STORY_HEIGHT}:force_original_aspect_ratio=increase,crop=${W}:${STORY_HEIGHT},gblur=sigma=40,eq=brightness=-0.15[dark];` +
        `[front]scale=${W}:-2[whole];[dark][whole]overlay=(W-w)/2:(H-h)/2,${blur}setsar=1[v]`
    } else {
      filter = parts[0].replace('[p0]', '[v]')
    }
  } else {
    filter = `${parts.join(';')};${panels.map((_, i) => `[p${i}]`).join('')}vstack=inputs=${panels.length}[v]`
  }
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...panels.flatMap((p) => ['-i', p.file]),
    '-filter_complex', filter,
    '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    outFile,
  ]
}

// Builds final.mp4. It is written under another name first and then renamed,
// so a half-made file is never shown. `panels` is a list of names, top to
// bottom, such as ["screen1", "camera", "screen0"].
export async function renderFinal(dir, { panels, blurs = [], flips = [], cameraGrey, cropTop = 0, singleFit = 'fit' }) {
  const described = []
  for (const [position, name] of panels.entries()) {
    const file = path.join(dir, `${name}.mp4`)
    const kind = name === 'camera' ? 'camera' : 'screen'
    const size = await probeSize(file)
    // a trimmed screen is shorter, which changes how tall it is shown in a two-panel clip
    described.push({ file, kind, size: kind === 'screen' ? { w: size.w, h: Math.round(size.h * (1 - cropTop)) } : size, blur: blurs[position] ?? 'off', flip: Boolean(flips[position]) })
  }
  const temp = path.join(dir, 'final.tmp.mp4')
  const result = await run(FFMPEG, buildFinalArgs(described, temp, { cameraGrey, cropTop, singleFit }), { timeoutMs: 120000 })
  if (result.code !== 0) {
    fs.rmSync(temp, { force: true })
    throw new Error(`Could not build the clip: ${result.err.slice(-300)}`)
  }
  fs.renameSync(temp, path.join(dir, 'final.mp4'))
  await makeJpeg(path.join(dir, 'final.mp4'), path.join(dir, 'poster.jpg'), 540)
}

// One still frame from a video, for the small pictures in the page.
export async function makeJpeg(videoFile, jpegFile, width) {
  const r = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0.5', '-i', videoFile, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', jpegFile])
  if (r.code !== 0) throw new Error(`Could not make a picture from ${path.basename(videoFile)}`)
}
