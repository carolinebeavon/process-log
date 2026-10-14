# Process Log

A small tool that records a short clip of your creative process: both screens and the
FaceTime camera, every 15 minutes, or whenever you press the big button. You caption the
clips you like, save them into your **Photos** app (with the caption on the video), and delete
the ones you don't. Nothing is ever sent anywhere. It is separate from the Web Builder.

## Before you start (for anyone new to this)

**What you need:** a Mac (macOS 13 or newer; built and tried on a MacBook Air M2 only), a camera, and these free tools:
- **Node.js** (version 18 or newer; tried on 24): download the LTS version from https://nodejs.org
- **ffmpeg**: does the recording and joins the video. `Install.command` offers to add it for you through Homebrew (https://brew.sh).
- **Apple's command line tools** (only for the menu-bar button; everything else works without it): run `xcode-select --install` in Terminal.

**Install:**
1. Unzip it anywhere (a folder in Documents is fine).
2. Double-click **Install.command**. If macOS says it cannot open it because it is from the internet, right-click it, choose **Open**, then **Open** again. (Or: System Settings, Privacy & Security, scroll down, **Open Anyway**.)
3. Double-click **Start Process Log.command**. Allow Terminal to use the camera and record the screen when macOS asks.

**Your settings** live in `config.json`, made for you on first start from `config.example.json`. Things you may well need to change: `cameraName` (a piece of your camera's name, "FaceTime" for the built-in one; if you use another camera, put a word from its name), `defaultPanels`, and `soundsFolder` (a folder of sound files for the sound chooser; leave it empty to hide that part).

**Privacy:** everything stays on your Mac. The tool does not use the internet at all, has no accounts and sends nothing anywhere. It does record your screens and your camera, so be careful what is on screen. Recordings are kept in the `captures` folder until you delete them; deleting a capture deletes its files for good.

**Honest limits:** it has only been run on one Mac so far. Things most likely to differ on yours: which screen is "Screen 1" and "Screen 2" (the page shows a small picture of each so you can tell), a camera with a different name, and Macs with no second screen (it then uses the screens you have). The real "Save to Photos", the menu-bar button's click and the Do Not Disturb shortcuts are the least tested parts.

## Starting it

Double-click **Start Process Log.command**. A Terminal window opens and the page opens in your
browser at http://localhost:3002. **Leave the Terminal window open while you want it logging.**
Close it (or press Control-C in it) to stop.

The first time, macOS asks whether Terminal may use the camera, record the screen, and (the first
time you press Save to Photos) control Photos. Say yes to each.
(Screen recording may also need a switch in System Settings, Privacy & Security, Screen & System
Audio Recording, and then Terminal has to be quit and started again. Photos is under Privacy &
Security, Automation, Terminal.)

It only logs while the Mac is awake and the Terminal window is open.

## What it does

- **Every 15 minutes** it records about 6 seconds of both screens and the camera (no sound), silently: no banner, no sound, and the menu-bar icon does not change. (macOS itself always shows its green camera dot and purple screen-recording dot while it records. That cannot be switched off.)
- When any capture is finished, whether automatic or from the big button or the menu-bar icon, a small panel waits in the **bottom-right corner** of the MacBook screen: "New capture, waiting for a caption", with **Caption** (opens the page at that capture) and **Delete** (removes the capture and its videos for good; the first click turns the button into "Sure? Delete", and a second click within 3 seconds does it). It stays until you caption, save or delete it (the **Skip** button on the page's card also clears it without deleting), and it hides itself while a capture is recording so it never appears in your own clip. This panel is part of the menu-bar button app (below).
- **CAPTURE NOW** does the same on the spot, and counts down while it records. (Only the automatic ones are silent; the button counts down so you know when to move.)
- **Capture every** (top of the page) sets how often it captures on its own, from every 5 minutes to every 2 hours. A change takes effect at once, the countdown starts again from that moment, and it is remembered when you restart.
- **Pause logging** stops the automatic captures (the big button still works).
- Each capture is a card. The clip plays by itself, silently and on a loop, while it is on screen (click it to pause or play). On the card you can:
  - Write a **caption**. It saves itself as you type (it says "Saved", or "NOT saved" if something is wrong).
  - Choose the **panels**: three drop-downs, Top / Middle / Bottom. Each can be **Screen 1**, **Screen 2** or **Me**, in any order, and the same one can be used twice. Set the Bottom one to "nothing" for a two-panel clip, and the Middle one to "nothing" as well for a **one-panel clip** that fills the whole frame. With one screen, the "One screen" menu chooses between **Whole screen, blurred backdrop** (the whole screen in the middle of the frame, over a soft darkened copy of itself; the default) and **Fill the frame** (the screen covers everything, so most of its left and right sides are cropped off). One panel of the camera just fills the frame. In a two-panel clip of one screen and you, the screen is shown whole at full width and you fill the rest; otherwise the panels are equal. The small pictures of the two screens tell them apart.
  - **Trim the top** of the screens with the "Trim top" slider (0 to 30 percent). It cuts the macOS menu bar and a browser's address bar out of the screen panels, so a Story does not show `localhost:3002` or your tabs. It never touches the camera. To make it the starting value for every new capture, set `screenCropTop` in `config.json` (for example `0.08` for 8 percent).
  - Set a **Blur** (soft or heavy) on any panel on its own, to hide something. Only the finished clip is blurred; the raw recordings are never changed.
  - Switch **Me in black and white** (new captures start black and white; see the settings).
  - **Save to Photos**: builds the finished clip with the caption printed on the video and, if you chose one, a sound, and puts it into the Photos app in an album called **Process Log** (with iCloud Photos on, it is on your phone shortly after). From there you add links, music and so on in Instagram yourself.
    - **Sound**: the "Choose a sound" chip opens your Sound Effects folder (search it, or browse the subfolders, and press the play button to listen). The sound is cut to the clip's length with a short fade. The choice is remembered. The x clears it.
    - **Caption position and size**: the caption shows live on the clip as you type. **Drag it with the mouse** to put it anywhere (it will not leave the frame), use the **Size** slider to make the text bigger or smaller, or "Snap caption to…" top, middle or bottom as a starting point. While you drag, two dashed lines mark the top and bottom ~270 pixels where Instagram puts its own buttons. Each capture remembers its own caption position and size.
    - The clip is made to Instagram's rules for an uploaded Story (1080 x 1920, MP4, H.264, 30 frames a second, AAC sound), so it can be posted from Photos as it is.
    - Pressing it again on a saved capture asks first, and puts in a second copy (for example with a changed caption). Saving also clears the "waiting for a caption" reminder.
  - **Delete** removes the capture and all its video files for good.
- **Quiet during a capture** (optional, needs two shortcuts you make once): while a capture records, Do Not Disturb is switched on so no banner or sound lands in the clip, and it is switched off again the moment the recording ends. Notifications are not lost: they wait in Notification Center. Make the two shortcuts in the **Shortcuts** app: one with a single action **Set Focus** (Turn Do Not Disturb **On**, until turned off), named exactly `Process Log quiet on`; one with **Set Focus** (Turn Do Not Disturb **Off**), named exactly `Process Log quiet off`. Restart the Process Log; its Terminal window then says "Quiet mode: Do Not Disturb will be on while a capture records". If the shortcuts are missing or fail, captures carry on without it. If the "off" shortcut ever fails, a yellow note on the page says Do Not Disturb may still be on, and closing the Process Log also switches it off. One limit: macOS does not let the tool see your current Focus, so "off" always ends Do Not Disturb, even if you had turned a Focus on yourself.
- Skipped on purpose: a capture while the screen is locked, or when every screen is black (switched off or asleep). A yellow note tells you.
- The Terminal window prints a time-stamped line for every capture, failure, save and delete. Keep an eye on it if a capture ever goes missing.

## The menu-bar button

**Process Log Menu.app** puts a small icon in the Mac's top bar. **Click it to capture now.** Beside the icon a small countdown (for example `12:34`) shows the time until the next automatic capture. It is hidden while logging is paused, and it stays out of the way during an automatic capture (that one is silent). A button capture shows its own red countdown. **Right-click** (or Control-click) the icon for a menu: pause / resume, **show the countdown in the menu bar** (tick it off if your menu bar is crowded), open the page, remove the button. If the Process Log is not running, clicking it starts it. Build it with `./build-menu-button.sh` (needs nothing extra; it uses the Swift that is already on the Mac), then double-click the app. It is made for you and signed by nobody: if macOS ever complains, right-click it and choose Open.

## Where things are kept

```
process-log/
  captures/<date_time>/   one folder per capture:
      screen0.mp4, screen1.mp4, camera.mp4   the raw recordings (kept, so you can change your mind)
      final.mp4, poster.jpg                  the clip as built on the card (no caption) and its still
      story.mp4, caption.png                 the finished clip that was saved to Photos, and the caption picture on it
      thumb-screen0.jpg, thumb-screen1.jpg   the little pictures of each screen
  log.json                the list of captures, captions and choices
  config.json             the settings
```

A day of captures is a few hundred MB. Deleting a capture frees all of it. (Photos keeps its own copy of anything you saved.)

## Settings (config.json; restart the tool after changing)

| | |
|---|---|
| `everyMinutes` | how often it captures on its own (15). You can change it on the page ("Capture every", top right); the page saves it here for you |
| `seconds` | length of each clip (6) |
| `warmupSeconds` | seconds thrown away at the start while the camera adjusts (1) |
| `defaultPanels` | the panels a new capture starts with, top to bottom, one, two or three of `screen0`, `screen1`, `camera` (`["screen1", "camera"]`; use `["screen1"]` for one full-screen panel) |
| `cameraName` | part of your camera's name (`FaceTime` for the built-in one) |
| `screenCropTop` | how much to trim off the top of the screens for new captures, 0 to 0.4 (0 = none; try 0.08 to hide the address bar) |
| `cameraBlackAndWhite` | new captures start with the camera in black and white (true) |
| `quietShortcutOn`, `quietShortcutOff` | the names of your two Do Not Disturb shortcuts (`Process Log quiet on` and `Process Log quiet off`) |
| `soundsFolder` | the folder the sound chooser opens (a folder of sound files; empty hides the chooser) |
| `port` | the address number, 3002 |

## The files

- `server.js`: the little server: the timer, the BIG button, saving to Photos, and the page's requests.
- `capture.js`: everything that uses ffmpeg for recording: finding the camera and screens, recording, stacking the panels (with blur and black and white) into the story-shaped clip.
- `story.js`: makes the finished clip (`story.mp4`) from the card's clip plus the caption picture and the sound.
- `photos.js`: hands a clip to the Photos app (a few lines of AppleScript).
- `quiet.js`: runs your two Shortcuts to switch Do Not Disturb on and off around a recording.
- `sounds.js`: reads your Sound Effects folder, read-only, and nothing outside it.
- `store.js`: the list of captures (`log.json`) and deleting a capture's folder.
- `public/`: the page you see (`index.html`, `style.css`, `app.js`). The caption is drawn onto a transparent picture by the page, so any font or emoji works.
- `menubar/ProcessLogMenu.swift` and `build-menu-button.sh`: the menu-bar button and the corner panel.
- `tests/process-log-test.mjs` (recording, panels, blur, reminders, timer) and `tests/story-test.mjs` (sound folder, finished clip, saving). Run each with `node tests/<name>`; about two minutes in all. They use stand-in coloured pictures and a fake Photos, not your camera, screens or library. They do **not** cover the menu-bar button or corner panel (the panel was seen on screen; clicking the icon and the panel hiding itself during a capture have not been checked), nor the real Photos import (the AppleScript was only checked to compile).

## History

Posting straight to Instagram (through Buffer or Meta's API) was planned and then dropped on 2026-10-14: both need the clip put on a public web address first. Saving to Photos keeps everything on this Mac.

## Licence

MIT. You may use, copy, change and share it freely; keep the copyright line and the licence text with it. It comes as is, with no promise that it works on your Mac. See the `LICENSE` file.
