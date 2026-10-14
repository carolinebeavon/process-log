// store.js — the list of captures, kept in log.json beside the video folders.
//
//   captures/2026-10-14_102530/   one folder per capture (the videos and pictures)
//   log.json                      the list: time, caption, which screen, which layout

import fs from 'node:fs'
import path from 'node:path'

const ID_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{6}$/
export const MAX_CAPTION = 2200

export function makeId(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

export function createStore(rootDir) {
  const logFile = path.join(rootDir, 'log.json')
  const capturesDir = path.join(rootDir, 'captures')
  fs.mkdirSync(capturesDir, { recursive: true })

  let entries = []
  if (fs.existsSync(logFile)) {
    // If the file is damaged this throws, which stops the server with a clear
    // message. That is better than quietly starting empty and overwriting it.
    entries = JSON.parse(fs.readFileSync(logFile, 'utf8'))
  }

  function save() {
    const temp = `${logFile}.tmp`
    fs.writeFileSync(temp, JSON.stringify(entries, null, 2))
    fs.renameSync(temp, logFile)
  }

  return {
    capturesDir,
    folderFor(id) {
      if (!ID_PATTERN.test(id)) throw new Error('Not a capture id')
      return path.join(capturesDir, id)
    },
    list() {
      return [...entries].sort((a, b) => (a.id < b.id ? 1 : -1)) // newest first
    },
    get(id) {
      return entries.find((e) => e.id === id) || null
    },
    add(entry) {
      entries.push(entry)
      save()
      return entry
    },
    update(id, changes) {
      const entry = this.get(id)
      if (!entry) return null
      Object.assign(entry, changes)
      if (typeof entry.caption === 'string') entry.caption = entry.caption.slice(0, MAX_CAPTION)
      save()
      return entry
    },
    // Deletes the capture's folder (all its videos) for good, then its list entry.
    remove(id) {
      const entry = this.get(id)
      if (!entry) return false
      fs.rmSync(this.folderFor(id), { recursive: true, force: true })
      entries = entries.filter((e) => e.id !== id)
      save()
      return true
    },
  }
}
