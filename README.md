# Clawd at Recess (3D)

Clawd, the Claude Code mascot, playing at recess in real-time 3D: jump rope (sometimes he trips and
the rope drapes over him), the swing (backflip dismount, or a seat landing), the trampoline (spins,
flips, sometimes a tumble off the side), a beach ball (headers, then a kick or a bonk on the head) and
a butterfly chase (he tiptoes up to it on a daisy, pounces and misses, then it lands on his head while
he blushes, and he waves it goodbye).
Activities change every 8–10 seconds and always hand off in the same standing pose, so they flow.

Everything is in **`clawd3d.js`**: one file, no dependencies, no build step.

## Run it

Double-click `index.html`, or serve the folder:

```bash
node serve.mjs
```

Then open http://localhost:5180. Drag to orbit, scroll to zoom, and pick an activity from the dock.
**Desktop pet** previews the transparent mode.

Freeze any moment (stills, tests): `index.html?activity=swing&t=4.8&seed=1`.
Activities: `jumpRope`, `swing`, `trampoline`, `ball`, `butterfly`.

## Put it anywhere

Drop-in element:

```html
<script src="clawd3d.js"></script>
<clawd-recess style="width:420px;height:420px"></clawd-recess>
<clawd-recess transparent activity="trampoline"></clawd-recess>
```

Or drive your own canvas:

```js
const stage = new Clawd3D.Stage(canvas, { transparent: true, activity: 'swing', seed: 42 })
stage.on('activity', ({ name, label }) => console.log(label))
stage.play('ball')    // switch now (blends smoothly); stage.play(null) returns to automatic
stage.dispose()
```

Options: `transparent`, `activity`, `auto` (default true), `interactive` (orbit/zoom, default
true), `seed`, `maxPixelRatio`, `minScale`.

## How it works

- **Renderer**: a single WebGL2 fragment shader raymarches signed distance fields. Clawd is a
  rounded box with four legs and two arm nubs, smoothly blended. Lighting is a warm sun with
  soft shadows, sky and ground bounce, ambient occlusion, a wrap/subsurface term for the vinyl-toy
  skin, GGX highlights with a clearcoat, then ACES tone mapping. The resolution adapts to hold the
  frame rate on slower GPUs.
- **Director**: each activity is a pure function of time, so any moment can be replayed exactly.
  Jumps use real gravity, and the swing is a real pendulum (period from its chain length). The
  dismount is ballistic, launched with the swing's own velocity.
- **Secondary motion**: a damped spring adds squash and stretch, kicked by landings. The rope
  switches to a verlet simulation when it snags, pinned to the handles and colliding with the
  ground and the body.

## Desktop pet (.exe)

`desktop/` packages this as a Windows app: Clawd on your taskbar, or floating in space as an
astronaut. The window lets every click through, and a tray icon opens the settings.
See [desktop/README.md](desktop/README.md); the built app is `desktop/dist/Clawd-1.0.0.exe`.
