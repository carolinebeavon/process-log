// app.js — the Process Log page. Plain JavaScript, no framework.
//
// The server does the recording; this page asks it "what is the state?" every
// few seconds and draws it: the big button, the countdown, and one card per
// capture where you can caption it, choose its panels, save the finished clip into Photos, or delete it.

// The three panels of a clip, top to bottom. The bottom one can be "nothing", which makes a two-panel clip.
const SLOT_LABELS = ['Top', 'Middle', 'Bottom']

const bigButton = document.getElementById('big')
const bigLabel = document.getElementById('big-label')
const bigHint = document.getElementById('big-hint')
const statusText = document.getElementById('status')
const pauseButton = document.getElementById('pause')
const everySelect = document.getElementById('every')
const errorBox = document.getElementById('error')
const noteBox = document.getElementById('note')
const listEl = document.getElementById('list')
const emptyEl = document.getElementById('empty')

let state = null

// The sound and the caption position are remembered between visits. If the browser will not
// store them, everything still works; they are just forgotten.
const remembered = (key, fallback) => { try { return JSON.parse(localStorage.getItem(`processlog.${key}`)) ?? fallback } catch { return fallback } }
const remember = (key, value) => { try { localStorage.setItem(`processlog.${key}`, JSON.stringify(value)) } catch { /* fine */ } }
let chosenSound = remembered('sound', null) // { path, name } or null
let captionPosition = remembered('captionPosition', 'bottom')
const cards = new Map() // capture id -> { el, ... } so a card is drawn once and then updated

// ---------------------------------------------------------------- talking to the server

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `The server answered ${res.status}`)
  return data
}

// Shorthand for building page elements.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  Object.assign(node, props)
  for (const child of children) node.append(child)
  return node
}

// ---------------------------------------------------------------- the top of the page

function formatCountdown(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function drawTop() {
  if (!state) return
  if (state.capturing) {
    bigButton.disabled = true
    const left = Math.ceil(state.seconds + state.warmupSeconds - (Date.now() - state.captureStartedAt) / 1000)
    bigLabel.textContent = state.phase === 'recording' && left > 0 ? `Recording… ${left}` : 'Building the clip…'
    bigHint.textContent = 'Hold still, or carry on working'
  } else {
    bigButton.disabled = false
    bigLabel.textContent = 'Capture now'
    bigHint.textContent = `${state.seconds} seconds of both screens and you`
  }

  statusText.classList.toggle('status--on', state.logging)
  statusText.classList.toggle('status--off', !state.logging)
  statusText.textContent = state.logging
    ? `Logging on · next capture in ${formatCountdown(state.nextAt - Date.now())}`
    : 'Logging paused · nothing is captured automatically'
  pauseButton.textContent = state.logging ? 'Pause logging' : 'Resume logging'
  drawFrequency()

  errorBox.hidden = !state.error
  if (state.error) document.getElementById('error-text').textContent = `Capture failed: ${state.error.message}`
  const saveErrorBox = document.getElementById('save-error')
  saveErrorBox.hidden = !state.saveError
  if (state.saveError) document.getElementById('save-error-text').textContent = `Saving to Photos failed: ${state.saveError.message}`
  noteBox.hidden = !state.note
  if (state.note) document.getElementById('note-text').textContent = state.note.message
}

// "Capture every …": the choices are fixed, plus whatever the settings file already has if that is something else.
const EVERY_CHOICES = [5, 10, 15, 20, 30, 45, 60, 90, 120]
const minutesText = (m) => (m < 60 ? `${m} minutes` : m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} minutes`)
function drawFrequency() {
  const choices = EVERY_CHOICES.includes(state.everyMinutes) ? EVERY_CHOICES : [...EVERY_CHOICES, state.everyMinutes].sort((a, b) => a - b)
  if (everySelect.options.length !== choices.length || [...everySelect.options].some((o, i) => Number(o.value) !== choices[i])) {
    everySelect.textContent = ''
    for (const m of choices) everySelect.append(el('option', { value: String(m), textContent: minutesText(m) }))
  }
  if (document.activeElement !== everySelect) everySelect.value = String(state.everyMinutes)
}
everySelect.addEventListener('change', () => {
  api('POST', '/api/settings', { everyMinutes: Number(everySelect.value) }).then(refresh).catch((e) => { showProblem(e.message); refresh() })
})

bigButton.addEventListener('click', () => {
  bigButton.disabled = true
  api('POST', '/api/capture').then(refresh).catch((e) => showProblem(e.message))
})
pauseButton.addEventListener('click', () => {
  api('POST', '/api/logging', { on: !state.logging }).then(refresh).catch((e) => showProblem(e.message))
})
document.getElementById('error-dismiss').addEventListener('click', () => api('POST', '/api/dismiss').then(refresh))
document.getElementById('save-error-dismiss').addEventListener('click', () => api('POST', '/api/dismiss').then(refresh))
document.getElementById('note-dismiss').addEventListener('click', () => api('POST', '/api/dismiss').then(refresh))

function showProblem(message) {
  errorBox.hidden = false
  document.getElementById('error-text').textContent = message
}

// ---------------------------------------------------------------- one card per capture

function whenText(entry) {
  const when = new Date(entry.time).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  return [when, entry.kind === 'auto' ? ' · automatic' : ' · button']
}

function makeCard(entry) {
  const video = el('video', { muted: true, loop: true, playsInline: true, preload: 'metadata' })
  video.addEventListener('click', () => {
    if (video.dataset.justDragged) { delete video.dataset.justDragged; return } // that click was the end of dragging the caption
    video.paused ? video.play() : video.pause()
  })
  const busy = el('div', { className: 'clip__busy', textContent: 'Rebuilding…' })

  // One dropdown per panel. Each can show either screen of this capture, or you.
  const slotRows = []
  const slots = SLOT_LABELS.map((label, position) => {
    const select = el('select', { className: 'slot' })
    const blur = el('select', { className: 'slot slot--blur', title: 'Blur this panel to hide something' })
    for (const [value, text] of [['off', 'Blur: off'], ['soft', 'Blur: soft'], ['heavy', 'Blur: heavy']]) blur.append(el('option', { value, textContent: text }))
    const flip = el('button', { className: 'chip-button flip', type: 'button', textContent: 'Flip', title: 'Mirror this panel left to right' })
    flip.setAttribute('aria-pressed', 'false')
    if (position === 1) select.append(el('option', { value: '', textContent: 'nothing (one panel, full screen)' }))
    if (position === 2) select.append(el('option', { value: '', textContent: 'nothing (two panels)' }))
    for (const screen of entry.screens) select.append(el('option', { value: screen.name, textContent: `Screen ${screen.number + 1}` }))
    select.append(el('option', { value: 'camera', textContent: 'Me' }))
    const apply = () => {
      // A panel set to "nothing" ends the list: with the middle one off there is just one panel.
      const used = []
      for (const slot of slots) { if (slot.select.value === '') break; used.push(slot) }
      change(entry.id, { panels: used.map((s) => s.select.value), blurs: used.map((s) => s.blur.value), flips: used.map((s) => s.flip.getAttribute('aria-pressed') === 'true') })
    }
    select.addEventListener('change', apply)
    blur.addEventListener('change', apply)
    flip.addEventListener('click', () => { flip.setAttribute('aria-pressed', String(flip.getAttribute('aria-pressed') !== 'true')); apply() })
    slotRows.push(el('div', { className: 'slot-row' }, el('span', { textContent: label }), select, blur, flip))
    return { select, blur, flip }
  })

  // Small pictures so you can tell which screen is which. They are not buttons.
  const screenPictures = el('div', { className: 'row' })
  for (const screen of entry.screens) {
    const image = el('img', { alt: '', src: `/files/${entry.id}/thumb-${screen.name}.jpg` })
    screenPictures.append(el('figure', { className: 'screen-picture' }, image, el('figcaption', { textContent: `Screen ${screen.number + 1} (${screen.w}×${screen.h})` })))
  }

  const greyButton = el('button', { className: 'switch', type: 'button' },
    el('span', { className: 'switch__track' }, el('span', { className: 'switch__thumb' })),
    el('span', { textContent: 'Me in black and white' }))
  greyButton.setAttribute('role', 'switch')
  greyButton.addEventListener('click', () => change(entry.id, { cameraGrey: greyButton.getAttribute('aria-checked') !== 'true' }))

  const skipButton = el('button', { className: 'chip-button', type: 'button', textContent: 'Skip' })
  skipButton.addEventListener('click', () => api('PATCH', `/api/captures/${entry.id}`, { dismiss: true }).then(refresh).catch((e) => showProblem(e.message)))
  const waiting = el('div', { className: 'waiting' }, el('span', { textContent: 'Waiting for a caption' }), skipButton)

  const caption = el('textarea', { maxLength: 2200, placeholder: 'Add a caption…', value: entry.caption })

  // The caption as it will look on the saved clip, drawn over the video. Drag it to move it.
  const captionView = { box: entry.captionBox ?? presetBox(captionPosition, entry.caption) }
  const preview = Object.assign(document.createElement('canvas'), { className: 'clip__caption', width: FRAME_WIDTH, height: FRAME_HEIGHT })
  let previewRect = null
  let dragging = null
  const redrawCaption = () => { previewRect = drawCaption(preview, caption.value, captionView.box, Boolean(dragging)); sizeSlider.value = String(captionView.box.size) }
  let boxTimer = null
  function saveCaptionBox() {
    clearTimeout(boxTimer)
    boxTimer = setTimeout(() => api('PATCH', `/api/captures/${entry.id}`, { captionBox: captionView.box }).catch((e) => showProblem(e.message)), 300)
  }
  caption.addEventListener('input', redrawCaption)
  const captionStatus = el('div', { className: 'caption-status' })
  let saveTimer = null
  const save = async () => {
    clearTimeout(saveTimer)
    captionStatus.className = 'caption-status'
    captionStatus.textContent = 'Saving…'
    try {
      await api('PATCH', `/api/captures/${entry.id}`, { caption: caption.value })
      captionStatus.textContent = 'Saved'
    } catch (e) {
      captionStatus.className = 'caption-status caption-status--bad'
      captionStatus.textContent = `NOT saved: ${e.message}`
    }
  }
  caption.addEventListener('input', () => {
    captionStatus.className = 'caption-status'
    captionStatus.textContent = 'Typing…'
    clearTimeout(saveTimer)
    saveTimer = setTimeout(save, 700)
  })
  caption.addEventListener('blur', () => { if (saveTimer) save() })

  const deleteButton = el('button', { className: 'ghost ghost--danger', type: 'button', textContent: 'Delete' })
  deleteButton.addEventListener('click', async () => {
    if (!confirm('Delete this capture and all its video files for good?')) return
    try {
      await api('DELETE', `/api/captures/${entry.id}`)
      await refresh()
    } catch (e) { showProblem(e.message) }
  })

  // Saving: a sound (chosen once, used for every save), where the caption sits, and the button.
  const soundLabel = el('button', { className: 'chip-button', type: 'button', title: 'Choose a sound from your Sound Effects folder' })
  soundLabel.addEventListener('click', openSoundPicker)
  const clearSound = el('button', { className: 'icon-button', type: 'button', textContent: '×', title: 'Save without sound' })
  clearSound.addEventListener('click', () => setSound(null))
  const positionSelect = el('select', { className: 'slot', title: 'Where the caption sits on the video' })
  for (const [value, text] of [['bottom', 'Caption at the bottom'], ['middle', 'Caption in the middle'], ['top', 'Caption at the top']]) positionSelect.append(el('option', { value, textContent: text }))
  positionSelect.insertBefore(el('option', { value: '', textContent: 'Snap caption to…' }), positionSelect.firstChild)
  positionSelect.value = ''
  positionSelect.addEventListener('change', () => {
    if (!positionSelect.value) return
    captionPosition = positionSelect.value
    remember('captionPosition', captionPosition)
    captionView.box = presetBox(captionPosition, caption.value, captionView.box.size)
    positionSelect.value = ''
    redrawCaption()
    saveCaptionBox()
  })
  const sizeSlider = el('input', { className: 'size-slider', type: 'range', min: 28, max: 84, step: 1, title: 'Caption text size' })
  sizeSlider.setAttribute('aria-label', 'Caption text size')
  sizeSlider.addEventListener('input', () => { captionView.box = { ...captionView.box, size: Number(sizeSlider.value) }; redrawCaption() })
  sizeSlider.addEventListener('change', saveCaptionBox)
  const saveButton = el('button', { className: 'save', type: 'button' })
  saveButton.addEventListener('click', () => saveToPhotos(entry.id))
  const saveStatus = el('div', { className: 'save-status' })
  const soundRow = el('div', { className: 'row' }, soundLabel, clearSound)
  const saveGroup = el('div', { className: 'save-group' },
    el('div', { className: 'group-label', textContent: 'Save the finished clip into Photos (caption and sound on it)' }),
    soundRow,
    el('div', { className: 'row' }, positionSelect, el('span', { className: 'sound-name', textContent: 'Size' }), sizeSlider, el('span', { className: 'sound-name', textContent: 'or drag the caption on the clip' })),
    el('div', { className: 'row row--save' }, saveButton, saveStatus))

  const [whenLabel] = whenText(entry)
  const head = el('div', { className: 'card__head' },
    el('div', { className: 'when', textContent: whenLabel }),
    el('span', { className: 'chip', textContent: entry.kind === 'auto' ? 'Automatic' : 'Button' }),
    waiting,
    el('span', { className: 'spacer' }),
    deleteButton)
  // Trims the top off the screens (the menu bar, a browser's address bar). It does not touch you.
  const cropLabel = el('span', { className: 'sound-name' })
  const cropSlider = el('input', { className: 'size-slider', type: 'range', min: 0, max: 30, step: 1, title: 'Trim this much off the top of the screens, to cut out the menu bar or a browser address bar' })
  cropSlider.setAttribute('aria-label', 'Trim the top of the screens')
  cropSlider.addEventListener('input', () => { cropLabel.textContent = cropSlider.value === '0' ? 'off' : `${cropSlider.value}%` })
  cropSlider.addEventListener('change', () => change(entry.id, { cropTop: Number(cropSlider.value) / 100 }))
  // With only one panel and it is a screen: show the whole screen over a blurred backdrop, or fill the frame.
  const fitSelect = el('select', { className: 'slot', title: 'How the single screen sits in the frame' })
  for (const [value, text] of [['fit', 'Whole screen, blurred backdrop'], ['fill', 'Fill the frame (crops the sides)']]) fitSelect.append(el('option', { value, textContent: text }))
  fitSelect.addEventListener('change', () => change(entry.id, { singleFit: fitSelect.value }))
  const fitRow = el('div', { className: 'slot-row' }, el('span', { textContent: 'One screen' }), fitSelect)
  const cropRow = el('div', { className: 'slot-row' }, el('span', { textContent: 'Trim top' }), cropSlider, cropLabel)
  const panelGroup = el('div', { className: 'group' }, el('div', { className: 'group-label', textContent: 'Panels' }), ...slotRows, fitRow, cropRow, screenPictures, greyButton)
  const saveBox = el('div', { className: 'group' }, ...saveGroup.children)
  const details = el('div', { className: 'details' }, head, el('div', {}, caption, captionStatus), panelGroup, saveBox)
  const playBadge = el('div', { className: 'clip__play' }, el('span', { textContent: '▶' }))
  const clip = el('div', { className: 'clip' }, video, preview, playBadge, busy)

  // Dragging the caption: press on the caption box (not on the rest of the video) and move.
  const toFrame = (event) => {
    const rect = clip.getBoundingClientRect()
    return { x: ((event.clientX - rect.left) / rect.width) * FRAME_WIDTH, y: ((event.clientY - rect.top) / rect.height) * FRAME_HEIGHT }
  }
  const overCaption = (point) => previewRect && point.x >= previewRect.left - 20 && point.x <= previewRect.left + previewRect.width + 20 && point.y >= previewRect.top - 20 && point.y <= previewRect.top + previewRect.height + 20
  clip.addEventListener('pointerdown', (event) => {
    const point = toFrame(event)
    if (!overCaption(point)) return
    dragging = { dx: captionView.box.x * FRAME_WIDTH - point.x, dy: captionView.box.y * FRAME_HEIGHT - point.y, moved: false }
    clip.setPointerCapture(event.pointerId)
    clip.classList.add('clip--dragging')
    redrawCaption()
    event.preventDefault()
  })
  clip.addEventListener('pointermove', (event) => {
    const point = toFrame(event)
    if (!dragging) { clip.classList.toggle('clip--over-caption', Boolean(overCaption(point))); return }
    dragging.moved = true
    captionView.box = { ...captionView.box, x: (point.x + dragging.dx) / FRAME_WIDTH, y: (point.y + dragging.dy) / FRAME_HEIGHT }
    redrawCaption()
  })
  const endDrag = () => {
    if (!dragging) return
    const moved = dragging.moved
    dragging = null
    clip.classList.remove('clip--dragging')
    redrawCaption()
    if (moved) { saveCaptionBox(); video.dataset.justDragged = '1' }
  }
  clip.addEventListener('pointerup', endDrag)
  clip.addEventListener('pointercancel', endDrag)

  const card = el('article', { className: 'card' }, clip, details)

  // The clip plays itself, silently and on a loop, while it is on screen, so you can watch it as you caption it.
  clip.classList.add('clip--paused') // the play badge shows until the clip is really playing
  video.addEventListener('pause', () => clip.classList.add('clip--paused'))
  video.addEventListener('playing', () => clip.classList.remove('clip--paused'))
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    new IntersectionObserver(([seen]) => { if (seen.isIntersecting) video.play().catch(() => {}); else video.pause() }, { threshold: 0.3 }).observe(video)
  }

  redrawCaption()
  return { el: card, video, caption, waiting, greyButton, slots, fitRow, fitSelect, cropSlider, cropLabel, soundRow, soundLabel, clearSound, positionSelect, saveButton, saveStatus, view: captionView, renderedAt: null }
}

// Brings an existing card up to date with the server's version of the capture.
// It never touches the caption box, so typing is never interrupted.
function updateCard(card, entry, isBusy) {
  if (card.renderedAt !== entry.renderedAt) {
    card.renderedAt = entry.renderedAt
    card.video.poster = `/files/${entry.id}/poster.jpg?v=${entry.renderedAt}`
    card.video.src = `/files/${entry.id}/final.mp4?v=${entry.renderedAt}`
  }
  card.el.classList.toggle('card--busy', isBusy)
  card.el.classList.toggle('card--waiting', Boolean(entry.pending))
  card.waiting.hidden = !entry.pending
  card.greyButton.setAttribute('aria-checked', String(Boolean(entry.cameraGrey)))
  card.greyButton.disabled = isBusy
  card.cropSlider.disabled = isBusy
  if (document.activeElement !== card.cropSlider) {
    card.cropSlider.value = String(Math.round((entry.cropTop ?? 0) * 100))
    card.cropLabel.textContent = card.cropSlider.value === '0' ? 'off' : `${card.cropSlider.value}%`
  }
  drawSaveGroup(card, entry)
  card.fitRow.hidden = !(entry.panels.length === 1 && entry.panels[0] !== 'camera')
  card.fitSelect.value = entry.singleFit ?? 'fit'
  card.fitSelect.disabled = isBusy
  card.slots.forEach(({ select, blur, flip }, position) => {
    select.value = entry.panels[position] ?? ''
    // the panels below a "nothing" are off, so they cannot be set
    if (position > 0) select.disabled = isBusy || entry.panels[position - 1] === undefined
    blur.value = (entry.blurs ?? [])[position] ?? 'off'
    if (position === 0) select.disabled = isBusy
    blur.disabled = isBusy || entry.panels[position] === undefined
    flip.setAttribute('aria-pressed', String(Boolean((entry.flips ?? [])[position])))
    flip.disabled = isBusy || entry.panels[position] === undefined
  })
}

const SAVE_STEPS = {
  building: 'Making the clip with the caption and sound…',
  importing: 'Putting it into Photos…',
}
const clock = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

function drawSaveGroup(card, entry) {
  const saving = state.saving
  const mine = saving && saving.id === entry.id
  card.soundLabel.textContent = chosenSound ? `♪ ${chosenSound.name}` : '♪ Choose a sound…'
  card.clearSound.hidden = !chosenSound
  card.soundRow.hidden = !state.soundsAvailable // no sounds folder set in config.json: nothing to choose from
  card.saveButton.textContent = entry.saved ? 'SAVE AGAIN' : 'SAVE TO PHOTOS'
  card.saveButton.disabled = Boolean(saving)
  let text = ''
  if (mine) text = SAVE_STEPS[saving.step] ?? ''
  else if (saving) text = 'Another clip is being saved'
  else if (entry.saved) text = `In Photos (album "Process Log") since ${clock(entry.saved.at)}`
  card.saveStatus.textContent = text
}

// The caption box. It is drawn the same way for the live preview on the clip and for the
// transparent picture (1080 x 1920, the size of the video) that is laid over the saved clip.
// `box` is { x, y, size }: where its CENTRE is (0 to 1 across and down the frame) and the text
// size in pixels. Instagram's own buttons cover roughly the top and bottom 270 pixels.
const FRAME_WIDTH = 1080
const FRAME_HEIGHT = 1920
const SAFE_EDGE = 270
const DEFAULT_SIZE = 46

function layoutCaption(g, text, size) {
  const maxTextWidth = 720 // narrow enough to leave room to slide the box sideways
  g.font = `600 ${size}px -apple-system, "Helvetica Neue", Arial, sans-serif`
  const lines = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const attempt = line ? `${line} ${word}` : word
      if (line && g.measureText(attempt).width > maxTextWidth) { lines.push(line); line = word } else line = attempt
    }
    lines.push(line)
  }
  if (lines.length > 12) { lines.length = 12; lines[11] += '…' }
  const lineHeight = size * 1.35
  const padding = size * 0.65
  const textWidth = Math.min(maxTextWidth, Math.max(...lines.map((l) => g.measureText(l).width)))
  return { lines, lineHeight, padding, width: textWidth + padding * 2, height: lines.length * lineHeight + padding * 2 - size * 0.26 }
}

// The centre of a box that sits at the top, middle or bottom (just inside Instagram's button areas).
function presetBox(position, text, size = DEFAULT_SIZE) {
  const { height } = layoutCaption(document.createElement('canvas').getContext('2d'), text || ' ', size)
  const centreY = position === 'top' ? SAFE_EDGE + height / 2 : position === 'middle' ? FRAME_HEIGHT / 2 : FRAME_HEIGHT - SAFE_EDGE - height / 2
  return { x: 0.5, y: centreY / FRAME_HEIGHT, size }
}

// Draws the caption onto `canvas` (which must be 1080 x 1920) and returns where the box is,
// as { left, top, width, height } in frame pixels, so it can be clicked on and dragged.
function drawCaption(canvas, text, box, withGuides = false) {
  const g = canvas.getContext('2d')
  g.clearRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT)
  if (withGuides) {
    g.save()
    g.strokeStyle = 'rgba(255, 255, 255, 0.55)'
    g.lineWidth = 3
    g.setLineDash([18, 14])
    for (const y of [SAFE_EDGE, FRAME_HEIGHT - SAFE_EDGE]) { g.beginPath(); g.moveTo(0, y); g.lineTo(FRAME_WIDTH, y); g.stroke() }
    g.restore()
  }
  if (!text.trim()) return null
  const layout = layoutCaption(g, text.trim(), box.size)
  const centreX = Math.min(Math.max(box.x * FRAME_WIDTH, layout.width / 2), FRAME_WIDTH - layout.width / 2)
  const centreY = Math.min(Math.max(box.y * FRAME_HEIGHT, layout.height / 2), FRAME_HEIGHT - layout.height / 2)
  const left = centreX - layout.width / 2
  const top = centreY - layout.height / 2
  g.fillStyle = 'rgba(0, 0, 0, 0.62)'
  g.beginPath()
  g.roundRect(left, top, layout.width, layout.height, box.size * 0.6)
  g.fill()
  g.fillStyle = '#ffffff'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  layout.lines.forEach((line, i) => g.fillText(line, FRAME_WIDTH / 2 + (centreX - FRAME_WIDTH / 2), top + layout.padding + layout.lineHeight / 2 - box.size * 0.13 + i * layout.lineHeight))
  return { left, top, width: layout.width, height: layout.height }
}

// The transparent picture the server lays over the clip.
function captionPicture(text, box) {
  const canvas = Object.assign(document.createElement('canvas'), { width: FRAME_WIDTH, height: FRAME_HEIGHT })
  drawCaption(canvas, text, box)
  return canvas.toDataURL('image/png')
}

// "Save to Photos": the server builds the finished clip (caption and sound on it) and hands it to Photos.
async function saveToPhotos(id) {
  const card = cards.get(id)
  const entry = state.captures.find((c) => c.id === id)
  let again = false
  if (entry.saved) {
    if (!confirm('This capture is already in Photos. Put in another copy (for example with a changed caption)?')) return
    again = true
  }
  card.saveButton.disabled = true
  try {
    const text = card.caption.value
    await api('PATCH', `/api/captures/${id}`, { caption: text }) // make sure the saved caption is what is used
    await api('POST', `/api/captures/${id}/save-to-photos`, {
      sound: chosenSound ? chosenSound.path : null,
      captionImage: text.trim() ? captionPicture(text.trim(), card.view.box) : null,
      again,
    })
  } catch (e) {
    showProblem(e.message)
  }
  await refresh()
}

// ---------------------------------------------------------------- the sound picker

function setSound(sound) {
  chosenSound = sound
  remember('sound', sound)
  drawList()
}

let picker = null
function openSoundPicker() {
  if (!picker) picker = buildSoundPicker()
  picker.open()
}

function buildSoundPicker() {
  const audio = new Audio()
  let playing = null
  const crumbs = el('div', { className: 'picker__crumbs' })
  const list = el('div', { className: 'picker__list' })
  const search = el('input', { className: 'picker__search', type: 'search', placeholder: 'Search every sound…' })
  const closeButton = el('button', { className: 'chip-button', type: 'button', textContent: 'Close' })
  const panel = el('div', { className: 'picker__panel' }, el('div', { className: 'picker__top' }, el('strong', { textContent: 'Choose a sound' }), closeButton), search, crumbs, list)
  const overlay = el('div', { className: 'picker', hidden: true }, panel)
  document.body.append(overlay)

  const urlFor = (soundPath) => `/sounds/${soundPath.split('/').map(encodeURIComponent).join('/')}`
  function stop() { audio.pause(); playing = null; list.querySelectorAll('.picker__play').forEach((b) => { b.textContent = '▶' }) }

  function soundRow(name, soundPath, where) {
    const play = el('button', { className: 'small picker__play', type: 'button', textContent: '▶', title: 'Listen' })
    play.addEventListener('click', () => {
      if (playing === soundPath) { stop(); return }
      stop()
      playing = soundPath
      audio.src = urlFor(soundPath)
      audio.play().catch(() => { stop() })
      play.textContent = '■'
    })
    const use = el('button', { className: 'chip-button', type: 'button', textContent: 'Use this' })
    use.addEventListener('click', () => { stop(); setSound({ path: soundPath, name }); overlay.hidden = true })
    return el('div', { className: 'picker__row' }, play, el('span', { className: 'picker__name' }, name, where ? el('small', { textContent: ` in ${where}` }) : ''), use)
  }

  async function show(folder) {
    stop()
    search.value = ''
    list.textContent = 'Loading…'
    try {
      const data = await api('GET', `/api/sounds?path=${encodeURIComponent(folder)}`)
      crumbs.textContent = ''
      const parts = data.path ? data.path.split('/') : []
      const crumb = (label, target) => { const b = el('button', { className: 'chip-button', type: 'button', textContent: label }); b.addEventListener('click', () => show(target)); crumbs.append(b) }
      crumb('Sound Effects', '')
      parts.forEach((part, i) => crumb(part, parts.slice(0, i + 1).join('/')))
      list.textContent = ''
      for (const f of data.folders) {
        const open = el('button', { className: 'picker__folder', type: 'button', textContent: `📁 ${f.name}` })
        open.addEventListener('click', () => show(data.path ? `${data.path}/${f.name}` : f.name))
        list.append(open)
      }
      for (const f of data.files) list.append(soundRow(f.name, data.path ? `${data.path}/${f.name}` : f.name, ''))
      if (data.folders.length + data.files.length === 0) list.textContent = 'Nothing here.'
    } catch (e) { list.textContent = e.message }
  }

  let searchTimer = null
  search.addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(async () => {
      const query = search.value.trim()
      if (!query) { show(''); return }
      stop()
      try {
        const data = await api('GET', `/api/sounds?q=${encodeURIComponent(query)}`)
        list.textContent = ''
        for (const r of data.results) list.append(soundRow(r.name, r.path, r.folder))
        if (data.results.length === 0) list.textContent = 'No sound matches.'
      } catch (e) { list.textContent = e.message }
    }, 300)
  })
  closeButton.addEventListener('click', () => { stop(); overlay.hidden = true })
  overlay.addEventListener('click', (event) => { if (event.target === overlay) { stop(); overlay.hidden = true } })
  audio.addEventListener('ended', stop)
  return { open() { overlay.hidden = false; show('') } }
}

const rebuildingHere = new Set() // ids this page has just asked to rebuild

async function change(id, choice) {
  rebuildingHere.add(id)
  drawList()
  try {
    await api('PATCH', `/api/captures/${id}`, choice)
  } catch (e) {
    showProblem(e.message)
  } finally {
    rebuildingHere.delete(id)
    await refresh()
  }
}

function drawList() {
  if (!state) return
  const ids = new Set(state.captures.map((c) => c.id))
  for (const [id, card] of cards) {
    if (!ids.has(id)) { card.el.remove(); cards.delete(id) }
  }
  state.captures.forEach((entry, position) => {
    let card = cards.get(entry.id)
    if (!card) { card = makeCard(entry); cards.set(entry.id, card) }
    updateCard(card, entry, rebuildingHere.has(entry.id) || state.rebuilding.includes(entry.id))
    if (listEl.children[position] !== card.el) listEl.insertBefore(card.el, listEl.children[position] || null)
  })
  emptyEl.hidden = state.captures.length > 0
  jumpToCaptureInAddress()
}

// The corner panel opens the page as ...#<capture id>. Scroll to that card once and
// put the cursor in its caption box.
let jumped = false
function jumpToCaptureInAddress() {
  if (jumped || !location.hash) return
  const card = cards.get(location.hash.slice(1))
  if (!card) return
  jumped = true
  card.el.scrollIntoView({ block: 'center' })
  card.caption.focus()
}

// ---------------------------------------------------------------- keeping up to date

let pollTimer = null
async function refresh() {
  clearTimeout(pollTimer)
  try {
    state = await api('GET', '/api/state')
    drawTop()
    drawList()
  } catch {
    statusText.className = 'status status--off'
    statusText.textContent = 'Cannot reach the Process Log server. Is its Terminal window still open?'
  }
  const quick = state && (state.capturing || state.saving || state.rebuilding.length > 0 || rebuildingHere.size > 0)
  pollTimer = setTimeout(refresh, quick ? 1000 : 5000)
}

// The countdown ticks every second without asking the server.
setInterval(drawTop, 1000)
refresh()
