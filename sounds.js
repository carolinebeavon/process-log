// sounds.js — browsing your Sound Effects folder, read-only.
//
// Everything is checked to be inside the one folder named in config.json
// ("soundsFolder"), so the page can never ask for anything else on the Mac.

import fs from 'node:fs'
import path from 'node:path'

export const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.aif', '.aiff', '.m4a', '.aac', '.flac', '.ogg'])

// The real path of `relative` inside `root`, or null if it would climb out of it.
export function resolveInside(root, relative = '') {
  const base = path.resolve(root)
  const full = path.resolve(base, relative)
  return full === base || full.startsWith(base + path.sep) ? full : null
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
const visible = (entry) => !entry.name.startsWith('.')

// The folders and sound files directly inside one folder.
export function listFolder(root, relative = '') {
  const dir = resolveInside(root, relative)
  if (!dir) throw new Error('That folder is outside the sounds folder')
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(visible)
  const folders = entries.filter((e) => e.isDirectory()).map((e) => ({ name: e.name })).sort(byName)
  const files = entries
    .filter((e) => e.isFile() && AUDIO_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
    .map((e) => ({ name: e.name, size: fs.statSync(path.join(dir, e.name)).size }))
    .sort(byName)
  return { path: path.relative(path.resolve(root), dir), folders, files }
}

// Sound files anywhere below the folder whose path (folder names and file name) contains every word typed.
export function searchSounds(root, query, limit = 100) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const base = path.resolve(root)
  const found = []
  const queue = ['']
  while (queue.length > 0 && found.length < limit) {
    const relative = queue.shift()
    for (const entry of fs.readdirSync(path.join(base, relative), { withFileTypes: true })) {
      if (!visible(entry)) continue
      const entryPath = path.join(relative, entry.name)
      if (entry.isDirectory()) queue.push(entryPath)
      else if (AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && words.every((w) => entryPath.toLowerCase().includes(w))) {
        found.push({ name: entry.name, path: entryPath, folder: relative })
        if (found.length >= limit) break
      }
    }
  }
  return found.sort(byName)
}
