// photos.js — saves a finished clip into the Photos app (and so, with iCloud Photos on, onto your phone).
//
// It asks the Photos app, with a few lines of AppleScript, to import the file into an album called
// "Process Log" so the clips are easy to find. The first time, macOS asks whether Terminal may control
// Photos; say yes. Importing never deletes or changes anything already in your library.

import { run } from './capture.js'

export const PHOTOS_ALBUM = 'Process Log'

const SCRIPT = [
  'on run argv',
  '  set theFile to POSIX file (item 1 of argv)',
  '  tell application "Photos"',
  `    if not (exists album "${PHOTOS_ALBUM}") then make new album named "${PHOTOS_ALBUM}"`,
  `    import {theFile} into album "${PHOTOS_ALBUM}" skip check duplicates true`,
  '  end tell',
  'end run',
]

export async function importIntoPhotos(file) {
  const args = SCRIPT.flatMap((line) => ['-e', line])
  const result = await run('osascript', [...args, file], { timeoutMs: 180000 })
  if (result.code === 0) return
  if (/-1743|not authorized|not allowed/i.test(result.err)) {
    throw new Error('macOS has not allowed Terminal to control Photos. Open System Settings, Privacy & Security, Automation, and switch on Photos under Terminal, then try again.')
  }
  throw new Error(`Photos could not import the clip: ${(result.err || 'no details').trim().slice(-300)}`)
}
