// Runs inside the click-through overlay window. Clawd renders into one small
// canvas that moves across the (otherwise empty, transparent) window.
;(async function () {
  const api = window.clawd || browserApi()
  const { PET_FRAME } = Clawd3D
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

  let { settings, geometry } = await api.get()
  let stage = null
  let canvas = null
  let ppu = 1 // pixels per world unit
  let frameSize = [0, 0]
  let home = null // ground: Clawd's home x on screen, in px

  const activitiesFor = s => (s.mode === 'space' ? s.spaceActivities : s.groundActivities)

  function build() {
    if (stage) stage.dispose()
    if (canvas) canvas.remove()
    // a fresh canvas each time: a disposed WebGL context can't be reused
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    sizeCanvas()
    stage = new Clawd3D.Stage(canvas, {
      mode: settings.mode,
      activities: activitiesFor(settings),
      interval: settings.interval,
      timeScale: settings.speed,
      wander: settings.wander,
      fps: settings.fps,
      maxPixelRatio: 1.5,
    })
    stage.on('activity', a => api.activity(a.label))
    stage.on('walked', ({ dx }) => {
      home += dx * ppu
      updateRoom()
    })
    stage.on('frame', place)
    window.clawdStage = stage // handy from devtools
    const first = stage.space ? Clawd3D.SPACE_LABELS[stage.space.act.name] : Clawd3D.LABELS[stage.current.name]
    api.activity(first)
    layout(true)
    stage.setPaused(settings.paused)
  }

  function sizeCanvas() {
    ppu = settings.size / 0.8 // Clawd is 0.8 world units tall
    const F = PET_FRAME[settings.mode]
    frameSize = [F.w * ppu, F.h * ppu]
    canvas.style.width = `${frameSize[0]}px`
    canvas.style.height = `${frameSize[1]}px`
  }

  function margin() {
    return 0.9 * ppu
  }

  function layout(resetHome) {
    sizeCanvas()
    if (settings.mode === 'ground') {
      const m = margin()
      if (resetHome || home == null) home = m + (geometry.width - 2 * m) * (settings.position / 100)
      home = clamp(home, m, Math.max(m, geometry.width - m))
      updateRoom()
    } else {
      stage.setSpaceBounds(geometry.width / ppu, geometry.height / ppu)
    }
  }

  function updateRoom() {
    const m = margin()
    stage.setWalkRoom((home - m) / ppu, (geometry.width - m - home) / ppu)
  }

  // Called by the stage every frame, just before it draws.
  function place(f) {
    if (!f) return
    let x, y
    if (settings.mode === 'ground') {
      x = home + f.offsetX * ppu - frameSize[0] / 2
      y = geometry.height - frameSize[1] + PET_FRAME.ground.groundY * ppu
    } else {
      x = f.spacePos[0] * ppu - frameSize[0] / 2
      y = geometry.height - f.spacePos[1] * ppu - frameSize[1] / 2
    }
    canvas.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
  }

  api.onSettings(next => {
    const prev = settings
    settings = next
    if (prev.mode !== next.mode) return build()
    stage.configure({ activities: activitiesFor(next), interval: next.interval, timeScale: next.speed, wander: next.wander, fps: next.fps })
    if (prev.paused !== next.paused) stage.setPaused(next.paused)
    if (prev.size !== next.size || prev.position !== next.position) layout(prev.position !== next.position)
  })

  api.onGeometry(g => {
    geometry = g
    layout(false)
  })

  build()

  // Lets overlay.html run in a plain browser for development:
  // overlay.html?mode=space&size=140
  function browserApi() {
    const q = new URLSearchParams(location.search)
    const s = {
      mode: q.get('mode') || 'ground',
      groundActivities: Clawd3D.ACTIVITIES,
      spaceActivities: Clawd3D.SPACE_ACTIVITIES,
      interval: Number(q.get('interval') || 10),
      speed: Number(q.get('speed') || 1),
      size: Number(q.get('size') || 120),
      position: 50,
      wander: q.get('wander') !== '0',
      fps: 60,
      paused: false,
    }
    document.documentElement.style.background = q.get('bg') || '#5b6f8f'
    return {
      get: async () => ({ settings: s, geometry: { width: innerWidth, height: innerHeight } }),
      activity: label => (document.title = `Clawd · ${label}`),
      onSettings() {},
      onGeometry(fn) {
        addEventListener('resize', () => fn({ width: innerWidth, height: innerHeight }))
      },
    }
  }
})()
