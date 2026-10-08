// Clawd desktop pet: a click-through overlay window that Clawd lives in, a tray
// icon, and a settings window. Settings persist in the user's app-data folder.
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const GROUND = ['jumpRope', 'swing', 'trampoline', 'ball', 'butterfly']
const SPACE = ['drift', 'swim', 'jetpack', 'spin', 'wave']
const DEFAULTS = {
  mode: 'ground', // 'ground': on the taskbar; 'space': floating over the whole screen
  groundActivities: GROUND,
  spaceActivities: SPACE,
  interval: 10, // seconds between activity changes
  speed: 1, // animation speed
  size: 120, // Clawd's height in pixels
  position: 70, // ground: where home is along the taskbar, % of the screen width
  wander: true, // ground: stroll to new spots between activities
  display: 'primary',
  fps: 60,
  paused: false,
  hidden: false,
  startWithWindows: false,
}

let settings = { ...DEFAULTS }
let firstRun = false
let overlay = null
let settingsWin = null
let tray = null
let nowPlaying = ''

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
const asset = name => path.join(__dirname, 'assets', name)

function load() {
  try {
    settings = sanitize({ ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) })
  } catch {
    firstRun = true
    settings = { ...DEFAULTS }
  }
}

function save() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2))
}

function sanitize(s) {
  const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d)
  const list = (v, all) => {
    const l = Array.isArray(v) ? all.filter(n => v.includes(n)) : all
    return l.length ? l : all
  }
  return {
    mode: s.mode === 'space' ? 'space' : 'ground',
    groundActivities: list(s.groundActivities, GROUND),
    spaceActivities: list(s.spaceActivities, SPACE),
    interval: num(s.interval, 4, 120, DEFAULTS.interval),
    speed: num(s.speed, 0.25, 2, 1),
    size: num(s.size, 50, 320, DEFAULTS.size),
    position: num(s.position, 0, 100, DEFAULTS.position),
    wander: !!s.wander,
    display: String(s.display ?? 'primary'),
    fps: Number(s.fps) === 30 ? 30 : 60,
    paused: !!s.paused,
    hidden: !!s.hidden,
    startWithWindows: !!s.startWithWindows,
  }
}

function targetDisplay() {
  return screen.getAllDisplays().find(d => String(d.id) === settings.display) || screen.getPrimaryDisplay()
}

// Ground mode covers the work area, so the ground is the top of the taskbar.
// Space mode covers the whole display, one pixel short so Windows never treats
// the overlay as a full-screen app.
function overlayBounds() {
  const d = targetDisplay()
  if (settings.mode === 'ground') return { ...d.workArea }
  return { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height - 1 }
}

function geometry() {
  const b = overlayBounds()
  return { width: b.width, height: b.height }
}

function displays() {
  const primary = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    label: `${d.id === primary ? 'Main display' : `Display ${i + 1}`} (${d.size.width}×${d.size.height})`,
  }))
}

function createOverlay() {
  overlay = new BrowserWindow({
    ...overlayBounds(),
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    title: 'Clawd',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  // Every click goes straight through to whatever is underneath.
  overlay.setIgnoreMouseEvents(true)
  overlay.setAlwaysOnTop(true, 'screen-saver')
  overlay.loadFile('overlay.html')
  overlay.once('ready-to-show', () => {
    // Windows trims a new window to the work area; space mode needs the taskbar too
    overlay.setBounds(overlayBounds())
    if (!settings.hidden) overlay.showInactive()
  })
  overlay.on('closed', () => (overlay = null))
}

function placeOverlay() {
  if (!overlay) return
  overlay.setBounds(overlayBounds())
  overlay.webContents.send('clawd:geometry', geometry())
}

function openSettings() {
  if (settingsWin) {
    settingsWin.show()
    settingsWin.focus()
    return
  }
  settingsWin = new BrowserWindow({
    width: 460,
    height: 800,
    minWidth: 400,
    minHeight: 520,
    title: 'Clawd',
    icon: asset('icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  })
  settingsWin.setMenu(null)
  settingsWin.loadFile('settings.html')
  settingsWin.once('ready-to-show', () => settingsWin.show())
  settingsWin.on('closed', () => (settingsWin = null))
}

function broadcast(channel, data) {
  for (const w of [overlay, settingsWin]) if (w && !w.isDestroyed()) w.webContents.send(channel, data)
}

function apply(patch) {
  const before = settings
  settings = sanitize({ ...settings, ...patch })
  save()
  if ('startWithWindows' in patch) {
    // a portable build runs from a temp folder; register the exe the user launched
    app.setLoginItemSettings({ openAtLogin: settings.startWithWindows, path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath })
  }
  if (before.mode !== settings.mode || before.display !== settings.display) placeOverlay()
  if (overlay && before.hidden !== settings.hidden) settings.hidden ? overlay.hide() : overlay.showInactive()
  broadcast('clawd:settings', settings)
  refreshTray()
  return settings
}

function refreshTray() {
  if (!tray) return
  tray.setToolTip(nowPlaying ? `Clawd · ${nowPlaying}` : 'Clawd')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Settings…', click: openSettings },
      { type: 'separator' },
      { label: 'On the taskbar', type: 'radio', checked: settings.mode === 'ground', click: () => apply({ mode: 'ground' }) },
      { label: 'Floating in space', type: 'radio', checked: settings.mode === 'space', click: () => apply({ mode: 'space' }) },
      { type: 'separator' },
      { label: 'Pause', type: 'checkbox', checked: settings.paused, click: item => apply({ paused: item.checked }) },
      { label: 'Hide Clawd', type: 'checkbox', checked: settings.hidden, click: item => apply({ hidden: item.checked }) },
      { type: 'separator' },
      { label: 'Quit Clawd', click: () => app.quit() },
    ]),
  )
}

function createTray() {
  const icon = nativeImage.createEmpty()
  icon.addRepresentation({ scaleFactor: 1, buffer: fs.readFileSync(asset('tray16.png')) })
  icon.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(asset('tray32.png')) })
  tray = new Tray(icon)
  tray.on('click', openSettings)
  refreshTray()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', openSettings)
  app.setAppUserModelId('dev.clawd.desktoppet')

  ipcMain.handle('clawd:get', () => ({ settings, geometry: geometry(), displays: displays(), version: app.getVersion(), nowPlaying }))
  ipcMain.handle('clawd:set', (_e, patch) => apply(patch || {}))
  ipcMain.on('clawd:activity', (_e, label) => {
    nowPlaying = String(label || '')
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('clawd:activity', nowPlaying)
    if (tray) tray.setToolTip(`Clawd · ${nowPlaying}`)
  })
  ipcMain.on('clawd:quit', () => app.quit())

  // CLAWD_SMOKE=<folder>: boot with throwaway settings, report problems, save
  // screenshots of both windows into <folder>, then quit (used to test builds).
  const smoke = process.env.CLAWD_SMOKE
  if (smoke) {
    app.setPath('userData', path.join(app.getPath('temp'), 'clawd-smoke'))
    fs.rmSync(path.join(app.getPath('userData'), 'settings.json'), { force: true })
  }

  app.whenReady().then(() => {
    load()
    createOverlay()
    createTray()
    for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, placeOverlay)
    if (firstRun || smoke) {
      save()
      openSettings()
    }
    if (smoke) runSmoke(smoke)
  })

  function runSmoke(dir) {
    const log = (...a) => console.log('[smoke]', ...a)
    overlay.webContents.on('console-message', (e, level, message) => log('overlay console:', message ?? e.message))
    overlay.webContents.on('render-process-gone', (_e, d) => log('overlay renderer gone:', d.reason))
    log('gpu', JSON.stringify(app.getGPUFeatureStatus()))
    log('overlay bounds', JSON.stringify(overlay.getBounds()), 'click-through: setIgnoreMouseEvents(true)')
    setTimeout(async () => {
      fs.mkdirSync(dir, { recursive: true })
      const state = await overlay.webContents.executeJavaScript(
        'window.clawdStage ? { mode: clawdStage.mode, activity: (clawdStage.current || clawdStage.space.act).name, canvas: [clawdStage.canvas.width, clawdStage.canvas.height], fps: Math.round(1 / clawdStage.frameEma) } : "no stage"',
      )
      log('overlay state', JSON.stringify(state), 'now playing:', nowPlaying)
      fs.writeFileSync(path.join(dir, 'overlay.png'), (await overlay.webContents.capturePage()).toPNG())
      fs.writeFileSync(path.join(dir, 'settings.png'), (await settingsWin.webContents.capturePage()).toPNG())
      apply({ mode: settings.mode === 'space' ? 'ground' : 'space' })
      setTimeout(async () => {
        const s2 = await overlay.webContents.executeJavaScript('window.clawdStage ? { mode: clawdStage.mode, activity: (clawdStage.current || clawdStage.space.act).name, fps: Math.round(1 / clawdStage.frameEma) } : "no stage"')
        log('after switching mode', JSON.stringify(s2), JSON.stringify(overlay.getBounds()))
        fs.writeFileSync(path.join(dir, 'overlay-space.png'), (await overlay.webContents.capturePage()).toPNG())
        log('done')
        app.quit()
      }, 4000)
    }, 6000)
  }

  // Closing the settings window keeps Clawd running in the tray.
  app.on('window-all-closed', () => {})
}
