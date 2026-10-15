// story.js — makes the finished Story clip (story.mp4) that is saved into Photos.
//
// It starts from the clip you built on the card (final.mp4) and adds, if wanted:
//   - the caption, as a transparent 1080 x 1920 picture drawn by the page (caption.png)
//   - a sound file from your Sound Effects folder, cut to the clip's length with a short fade
// and re-encodes it to the settings Instagram asks for when you upload it yourself: MP4, H.264,
// 30 frames a second, AAC sound at 48 kHz, the index at the front of the file, no edit lists, under 100 MB.

import fs from 'node:fs'
import path from 'node:path'
import { FFMPEG, run, probeDuration } from './capture.js'

const MIN_SECONDS = 3
const MAX_SECONDS = 60
const MAX_BYTES = 100 * 1024 * 1024

export function buildStoryArgs({ finalFile, captionFile, soundFile, seconds, outFile }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', finalFile]
  const filters = []
  let videoMap = '0:v'
  let nextInput = 1
  if (captionFile) {
    args.push('-i', captionFile)
    filters.push('[0:v][1:v]overlay=0:0:format=auto[v]')
    videoMap = '[v]'
    nextInput = 2
  }
  let audioMap = null
  if (soundFile) {
    args.push('-i', soundFile)
    const fadeOutStart = Math.max(0, seconds - 0.8).toFixed(2)
    filters.push(`[${nextInput}:a]aresample=48000,atrim=0:${seconds},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.2,afade=t=out:st=${fadeOutStart}:d=0.8,apad=whole_dur=${seconds}[a]`)
    audioMap = '[a]'
  }
  if (filters.length > 0) args.push('-filter_complex', filters.join(';'))
  args.push('-map', videoMap)
  if (audioMap) args.push('-map', audioMap, '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2')
  else args.push('-an')
  args.push(
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    // bframes=0: with B-frames and no edit list the video starts 0.067 s into the file, and Photos / Instagram
    // fill that gap (and the end) with black. Without B-frames the clip starts at exactly 0.
    '-r', '30', '-x264-params', 'open-gop=0:bframes=0', '-t', String(seconds),
    '-movflags', '+faststart', '-use_editlist', '0', '-map_chapters', '-1',
    outFile,
  )
  return args
}

// Builds story.mp4 inside the capture's folder. `withCaption` uses caption.png from that folder.
export async function renderStory(dir, { withCaption, soundFile }) {
  const finalFile = path.join(dir, 'final.mp4')
  const seconds = Number((await probeDuration(finalFile)).toFixed(2))
  if (seconds < MIN_SECONDS) throw new Error(`The clip is ${seconds} seconds long; Instagram needs at least ${MIN_SECONDS}.`)
  if (seconds > MAX_SECONDS) throw new Error(`The clip is ${seconds} seconds long; Instagram allows at most ${MAX_SECONDS}.`)
  const temp = path.join(dir, 'story.tmp.mp4')
  const result = await run(FFMPEG, buildStoryArgs({
    finalFile, seconds, outFile: temp, soundFile: soundFile || null,
    captionFile: withCaption ? path.join(dir, 'caption.png') : null,
  }), { timeoutMs: 180000 })
  if (result.code !== 0) {
    fs.rmSync(temp, { force: true })
    throw new Error(`Could not make the clip for Instagram: ${result.err.slice(-300)}`)
  }
  const bytes = fs.statSync(temp).size
  if (bytes > MAX_BYTES) {
    fs.rmSync(temp, { force: true })
    throw new Error('The clip came out over 100 MB, which Instagram refuses.')
  }
  const file = path.join(dir, 'story.mp4')
  fs.renameSync(temp, file)
  return { file, bytes, seconds }
}
