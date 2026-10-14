// quiet.js — keeps notification banners out of a capture.
//
// macOS lets other programs change Focus (Do Not Disturb) only through the Shortcuts app. So you
// make two tiny shortcuts there, named as in config.json ("quietShortcutOn" / "quietShortcutOff"),
// and this runs them: "on" just before the recording starts, "off" as soon as it ends. While Do Not
// Disturb is on, banners and sounds stay silent and notifications are filed in Notification Center
// to read later.
//
// It never stops a capture: if the shortcuts are missing or fail, the capture goes ahead (without
// the quiet). If "off" fails, it throws, so the page can warn you that Do Not Disturb may still be on.
//
// Limitation: macOS does not let this read your current Focus, so "off" always ends Do Not Disturb,
// even if you had turned it on yourself before the capture.

import { execFileSync } from 'node:child_process'
import { run } from './capture.js'

export function createQuiet(config, runner = run, say = () => {}) {
  const onName = config.quietShortcutOn
  const offName = config.quietShortcutOff
  let names = null // the shortcuts that exist, read once
  let active = false // true between a successful "on" and the matching "off"

  async function shortcutExists(name) {
    if (!names) {
      const result = await runner('shortcuts', ['list'], { timeoutMs: 15000 })
      names = result.code === 0 ? result.out.split('\n').map((line) => line.trim()) : []
    }
    return names.includes(name)
  }

  return {
    // Are both shortcuts set up? (Used to tell you at start-up.)
    async available() {
      return Boolean(onName && offName && (await shortcutExists(onName)) && (await shortcutExists(offName)))
    },

    // Returns true when Do Not Disturb is now on (so the caller knows to call off()).
    async on() {
      if (!onName || !offName || !(await shortcutExists(onName)) || !(await shortcutExists(offName))) return false
      const result = await runner('shortcuts', ['run', onName], { timeoutMs: 15000 })
      if (result.code !== 0) {
        say(`Quiet mode: the shortcut "${onName}" failed (${(result.err || 'no details').trim().slice(-120)}). Capturing without it.`)
        return false
      }
      active = true
      return true
    },

    async off() {
      const result = await runner('shortcuts', ['run', offName], { timeoutMs: 15000 })
      if (result.code !== 0) throw new Error(`The shortcut "${offName}" failed, so Do Not Disturb may still be on: ${(result.err || 'no details').trim().slice(-120)}`)
      active = false
    },

    // For when the server is closed in the middle of a capture: do not leave Do Not Disturb on.
    offNowIfActive() {
      if (!active) return
      try { execFileSync('shortcuts', ['run', offName], { timeout: 15000, stdio: 'ignore' }) } catch { /* nothing more can be done */ }
      active = false
    },
  }
}
