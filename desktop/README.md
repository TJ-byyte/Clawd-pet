# Clawd desktop pet

Clawd lives on your Windows desktop. Run **`dist/Clawd-1.0.0.exe`**: it's one portable file, so
nothing gets installed.

- **On the taskbar**: Clawd stands on top of the taskbar and plays: jump rope, swing,
  trampoline, beach ball, butterfly. Between activities he strolls to new spots.
- **Floating in space**: astronaut Clawd, in a bubble helmet with a jetpack, drifts across the
  whole screen in zero gravity. He swims, does jetpack loops and zero-g spins, waves hello, and
  bumps off the screen edges.

Clicks always pass through Clawd: his window ignores the mouse completely, so anything under
him stays clickable.

## Settings

Clawd sits in the system tray (the ^ area by the clock). Click the icon to open the settings; the
right-click menu also switches modes, pauses, hides, and quits. Settings apply immediately and
are saved in `%APPDATA%\Clawd\settings.json`.

| Setting | What it does |
| --- | --- |
| Mode | On the taskbar, or floating in space |
| Activities | Which activities he picks from (each mode has its own list) |
| Switch activity every | 4–60 s. Shorter than an activity (~9 s) cuts it mid-way; longer adds breathers |
| Animation speed | 0.5×–1.5× |
| Size | Clawd's height, 60–300 px |
| Home on the taskbar | Where he plays, left to right |
| Wander around | Stroll to new spots between activities |
| Screen | Which monitor (only shown with more than one) |
| Pause, Hide, Battery saver (30 fps), Start with Windows | |

The first launch opens the settings window, so you can see where he lives.

## Build it yourself

```bash
npm install
```

```bash
npm start
```

```bash
npm run dist
```

`npm start` runs the app from source. `npm run dist` builds `dist/Clawd-<version>.exe`. Both
copy the engine (`../clawd3d.js`) into `engine/` and redraw the icons first. If `npm install`
skipped Electron's download (newer npm versions don't run install scripts), run
`node node_modules/electron/install.js`.

`overlay.html` also runs in a plain browser for quick checks:
`overlay.html?mode=space&size=140` (served by `../serve.mjs`).

## How it works

- `main.js` creates the overlay as a transparent, frameless, always-on-top window that
  `setIgnoreMouseEvents(true)` makes fully click-through. It covers the work area on the
  taskbar, or the whole display in space (one pixel short, so Windows never treats it as a
  full-screen app). `main.js` also runs the tray and the settings window and stores the
  settings.
- `overlay.js` renders Clawd into one small canvas and slides it across the empty window each
  frame, so the GPU only shades the pixels around him.
- The engine's `ground` and `space` modes do the rest. `CLAWD_SMOKE=<folder>` boots the app with
  throwaway settings, saves screenshots of both windows there, and quits.
