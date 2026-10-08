;(async function () {
  const api = window.clawd
  const $ = id => document.getElementById(id)
  const LABELS = {
    ground: { jumpRope: 'Jump rope', swing: 'Swing', trampoline: 'Trampoline', ball: 'Beach ball', butterfly: 'Butterfly' },
    space: { drift: 'Drifting', swim: 'Space swim', jetpack: 'Jetpack loop', spin: 'Zero-g spin', wave: 'Waving hello' },
  }
  const listKey = mode => (mode === 'space' ? 'spaceActivities' : 'groundActivities')

  const { settings, displays, version, nowPlaying } = await api.get()
  let s = settings
  $('version').textContent = `Version ${version}`
  $('now').textContent = nowPlaying || '…'

  // Send changes; sliders send at most every 120 ms while dragging.
  let pending = {}, timer = null
  function send(patch, now) {
    Object.assign(pending, patch)
    Object.assign(s, patch)
    clearTimeout(timer)
    const flush = () => {
      const p = pending
      pending = {}
      api.set(p)
    }
    if (now) flush()
    else timer = setTimeout(flush, 120)
  }

  // mode
  for (const b of document.querySelectorAll('#mode button')) b.addEventListener('click', () => send({ mode: b.dataset.mode }, true))

  // activities
  function renderActivities() {
    const box = $('activities')
    box.textContent = ''
    const key = listKey(s.mode)
    for (const [name, label] of Object.entries(LABELS[s.mode])) {
      const on = s[key].includes(name)
      const chip = document.createElement('button')
      chip.className = 'chip'
      chip.textContent = label
      chip.setAttribute('aria-pressed', String(on))
      chip.addEventListener('click', () => {
        const list = on ? s[key].filter(n => n !== name) : [...s[key], name]
        if (!list.length) return // keep at least one
        send({ [key]: Object.keys(LABELS[s.mode]).filter(n => list.includes(n)) }, true)
        sync()
      })
      box.appendChild(chip)
    }
    $('activitiesNote').textContent = s[key].length === 1 ? 'Only one picked: Clawd repeats it.' : 'Clawd picks from these at random.'
  }

  // sliders
  const sliders = {
    interval: v => `${v} s`,
    speed: v => `${Number(v).toFixed(2).replace(/0$/, '')}×`,
    size: v => `${v} px`,
    position: v => `${v}%`,
  }
  for (const [id, fmt] of Object.entries(sliders)) {
    const el = $(id)
    el.addEventListener('input', () => {
      $(id + 'Value').textContent = fmt(el.value)
      if (id === 'interval') intervalHint()
      send({ [id]: Number(el.value) })
    })
  }
  function intervalHint() {
    const v = Number($('interval').value)
    $('intervalHint').textContent =
      s.mode === 'space'
        ? 'How long each space move lasts.'
        : v < 9
          ? 'Shorter than an activity (about 9 s): Clawd switches mid-way.'
          : v > 11
            ? 'Longer than an activity: Clawd takes a breather in between.'
            : 'About one activity each.'
  }

  // switches
  for (const id of ['wander', 'paused', 'hidden', 'startWithWindows']) $(id).addEventListener('change', e => send({ [id]: e.target.checked }, true))
  $('battery').addEventListener('change', e => send({ fps: e.target.checked ? 30 : 60 }, true))

  // displays
  if (displays.length > 1) {
    $('displayRow').hidden = false
    for (const d of displays) $('display').add(new Option(d.label, d.id))
    $('display').addEventListener('change', e => send({ display: e.target.value }, true))
  }

  $('quit').addEventListener('click', () => api.quit())

  function sync() {
    for (const b of document.querySelectorAll('#mode button')) b.setAttribute('aria-pressed', String(b.dataset.mode === s.mode))
    renderActivities()
    for (const [id, fmt] of Object.entries(sliders)) {
      if (document.activeElement !== $(id)) $(id).value = s[id]
      $(id + 'Value').textContent = fmt($(id).value)
    }
    intervalHint()
    const ground = s.mode === 'ground'
    $('positionRow').hidden = !ground
    $('wanderRow').hidden = !ground
    $('spaceNote').hidden = ground
    $('wander').checked = s.wander
    $('paused').checked = s.paused
    $('hidden').checked = s.hidden
    $('startWithWindows').checked = s.startWithWindows
    $('battery').checked = s.fps === 30
    if (displays.length > 1) {
      const known = displays.some(d => d.id === s.display)
      $('display').value = known ? s.display : displays[0].id
    }
  }

  api.onSettings(next => {
    s = { ...next, ...pending }
    sync()
  })
  api.onActivity(label => ($('now').textContent = label))
  sync()
})()
