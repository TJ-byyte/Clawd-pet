/*!
 * Clawd 3D: Clawd at recess, rendered in real time.
 *
 * One file, no dependencies. A WebGL2 raymarcher (soft shadows, ambient occlusion,
 * subsurface-ish skin, glossy eyes, sky, grass) driven by a procedural animation
 * director (ballistic jumps, squash-and-stretch springs, a verlet rope).
 *
 * Runs wherever a browser engine runs: a web page, Electron, Tauri, OBS, a webview.
 *
 *   <script src="clawd3d.js"></script>
 *   <clawd-recess></clawd-recess>                       drop-in element
 *   <clawd-recess transparent></clawd-recess>           alpha background (desktop pet)
 *   const stage = new Clawd3D.Stage(canvas, options)    or drive a canvas yourself
 */
;(function (root) {
  'use strict'

  // ---------------------------------------------------------------- math --
  const TAU = Math.PI * 2
  const G = 9.8
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
  const lerp = (a, b, s) => a + (b - a) * s
  const seg = (t, a, b) => clamp((t - a) / (b - a), 0, 1)
  const smooth = s => s * s * (3 - 2 * s)
  const smoother = s => s * s * s * (s * (s * 6 - 15) + 10)
  const easeOut = s => 1 - Math.pow(1 - s, 3)
  const easeOutBack = (s, k = 1.70158) => 1 + (k + 1) * Math.pow(s - 1, 3) + k * Math.pow(s - 1, 2)
  const easeInBack = (s, k = 1.70158) => (k + 1) * s * s * s - k * s * s
  const pop = (t, a, b) => (t <= a ? 0 : t >= b ? 1 : easeOutBack(seg(t, a, b)))
  const unpop = (t, a, b) => (t <= a ? 1 : t >= b ? 0 : 1 - easeInBack(seg(t, a, b)))
  const bump = (t, a, b) => (t > a && t < b ? Math.sin(Math.PI * seg(t, a, b)) : 0)
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s]
  const len3 = a => Math.hypot(a[0], a[1], a[2])
  const norm3 = a => scale3(a, 1 / (len3(a) || 1))
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const rotX = (v, a) => {
    const c = Math.cos(a), s = Math.sin(a)
    return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]]
  }
  const rotZ = (v, a) => {
    const c = Math.cos(a), s = Math.sin(a)
    return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]]
  }
  const wrapAngle = a => a - TAU * Math.round(a / TAU)

  // Height of a ballistic hop from y0 at t0 to y1 at t1 (real gravity).
  function arcY(t, t0, t1, y0, y1) {
    const tt = clamp(t, t0, t1)
    return lerp(y0, y1, seg(tt, t0, t1)) + 0.5 * G * (tt - t0) * (t1 - tt)
  }

  // n equal hops from a to b (xz pairs) starting at t0, each `dur` long.
  function hops(t, t0, dur, n, a, b) {
    const T = n * dur
    if (t <= t0) return { x: a[0], z: a[1], y: 0, s: 0 }
    if (t >= t0 + T) return { x: b[0], z: b[1], y: 0, s: 0 }
    const k = Math.floor((t - t0) / dur), s0 = t0 + k * dur
    const s = seg(t, s0, s0 + dur)
    const f = (k + smooth(s)) / n
    return { x: lerp(a[0], b[0], f), z: lerp(a[1], b[1], f), y: arcY(t, s0, s0 + dur, 0, 0), s }
  }
  const hopLegs = s => [0.28, -0.22, 0.22, -0.28].map(v => v * Math.sin(Math.PI * s))

  // Ballistic motion with floor bounces and rolling friction (a ball).
  function ballistic(p0, v0, t, floor, rest = 0.55, fric = 0.78) {
    let p = p0.slice(), v = v0.slice(), left = t
    for (let k = 0; k < 16 && left > 0; k++) {
      const a = -G / 2, b = v[1], c = p[1] - floor
      const disc = b * b - 4 * a * c
      const hit = (-b - Math.sqrt(Math.max(0, disc))) / (2 * a)
      if (!(hit > 1e-4) || hit > left) {
        return [p[0] + v[0] * left, Math.max(floor, p[1] + v[1] * left - 0.5 * G * left * left), p[2] + v[2] * left]
      }
      p = [p[0] + v[0] * hit, floor, p[2] + v[2] * hit]
      v = [v[0] * fric, -(v[1] - G * hit) * rest, v[2] * fric]
      left -= hit
      if (v[1] < 0.45) {
        const k2 = 1.6, e = 1 - Math.exp(-k2 * left)
        return [p[0] + (v[0] / k2) * e, floor, p[2] + (v[2] / k2) * e]
      }
    }
    return p
  }

  function mulberry32(seed) {
    let a = seed >>> 0
    return () => {
      a |= 0
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  // Column-major 4x4 matrices, as WebGL wants them.
  const M4 = {
    id() {
      const m = new Float32Array(16)
      m[0] = m[5] = m[10] = m[15] = 1
      return m
    },
    mul(a, b) {
      const o = new Float32Array(16)
      for (let c = 0; c < 4; c++)
        for (let r = 0; r < 4; r++) {
          let s = 0
          for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
          o[c * 4 + r] = s
        }
      return o
    },
    T(x, y, z) {
      const m = M4.id()
      m[12] = x; m[13] = y; m[14] = z
      return m
    },
    S(x, y, z) {
      const m = M4.id()
      m[0] = x; m[5] = y; m[10] = z
      return m
    },
    Rx(a) {
      const m = M4.id(), c = Math.cos(a), s = Math.sin(a)
      m[5] = c; m[6] = s; m[9] = -s; m[10] = c
      return m
    },
    Ry(a) {
      const m = M4.id(), c = Math.cos(a), s = Math.sin(a)
      m[0] = c; m[2] = -s; m[8] = s; m[10] = c
      return m
    },
    Rz(a) {
      const m = M4.id(), c = Math.cos(a), s = Math.sin(a)
      m[0] = c; m[1] = s; m[4] = -s; m[5] = c
      return m
    },
    apply(m, v) {
      return [
        m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
        m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
        m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
      ]
    },
    invert(m) {
      const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m
      const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10
      const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12
      const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30
      const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32
      const det = 1 / (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06)
      const o = new Float32Array(16)
      o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det
      o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det
      o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det
      o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det
      o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det
      o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det
      o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det
      o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det
      o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det
      o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det
      o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det
      o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det
      o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det
      o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det
      o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det
      o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det
      return o
    },
  }

  M4.fromQuat = q => {
    const [x, y, z, w] = q, m = M4.id()
    m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y + w * z); m[2] = 2 * (x * z - w * y)
    m[4] = 2 * (x * y - w * z); m[5] = 1 - 2 * (x * x + z * z); m[6] = 2 * (y * z + w * x)
    m[8] = 2 * (x * z + w * y); m[9] = 2 * (y * z - w * x); m[10] = 1 - 2 * (x * x + y * y)
    return m
  }

  // Quaternions [x, y, z, w], for tumbling freely in zero gravity.
  const Q = {
    mul(a, b) {
      const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b
      return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz]
    },
    norm(q) {
      const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1
      return q.map(v => v / l)
    },
    conj: q => [-q[0], -q[1], -q[2], q[3]],
    // advance by a world-space angular velocity w (rad/s)
    integrate(q, w, dt) {
      const dq = Q.mul([w[0], w[1], w[2], 0], q)
      return Q.norm(q.map((v, i) => v + 0.5 * dt * dq[i]))
    },
    rotate(q, v) {
      const r = Q.mul(Q.mul(q, [v[0], v[1], v[2], 0]), Q.conj(q))
      return [r[0], r[1], r[2]]
    },
  }

  // ------------------------------------------------------------- the rig --
  // Clawd's local space: origin on the ground between the feet, +y up, +z toward
  // the viewer. Body 1.0 wide, about 0.8 tall. Every activity starts and ends
  // standing at the world origin, so activities flow into one another.
  const EYE = { normal: 0, happy: 1, dizzy: 2, closed: 3 }
  const COM = [0, 0.45, 0]
  const BODY_BOTTOM = [0, 0.22, 0]

  function basePose(t) {
    return {
      x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0,
      pivot: COM.slice(),
      legs: [0, 0, 0, 0],
      arms: [0.18, 0.18], // left, right: raise angle
      eye: EYE.normal, look: [0, 0], squint: 0, stars: 0, blush: 0, quat: null, jet: 0,
      squash: 0.012 * Math.sin(t * 3.2), // breathing
      springy: true,
    }
  }
  function baseProps() {
    return {
      rope: { show: 0, phi: -2.6, physics: false, wrist: 0 },
      swing: { show: 0, angle: 0 },
      tramp: { show: 0, sag: 0 },
      ball: { show: 0, x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 },
      fly: { show: 0, x: 0, y: 1, z: 0, yaw: 0, pitch: 0, flap: 0 },
      flowers: [0, 0, 0, 0, 0, 0],
    }
  }

  // Where the jump-rope handles sit, in local space.
  function handleGeometry(arms, phi, wrist) {
    const w = [0, Math.cos(phi) * wrist, Math.sin(phi) * wrist]
    const tipR = add([0.45, 0.5, 0], rotZ([0.25, 0, 0], arms[1]))
    const tipL = add([-0.45, 0.5, 0], rotZ([-0.25, 0, 0], -arms[0]))
    return {
      topL: add(tipL, [0, 0.05, 0.03]), botL: add(add(tipL, [-0.02, -0.09, 0.06]), w),
      topR: add(tipR, [0, 0.05, 0.03]), botR: add(add(tipR, [0.02, -0.09, 0.06]), w),
    }
  }
  const ROPE_N = 13
  const ROPE_R = 0.62
  function ropeKinematic(M, hg, phi) {
    const dir = [0, Math.cos(phi), Math.sin(phi)]
    const pts = []
    for (let i = 0; i < ROPE_N; i++) {
      const s = i / (ROPE_N - 1)
      const base = [lerp(hg.botL[0], hg.botR[0], s), lerp(hg.botL[1], hg.botR[1], s), lerp(hg.botL[2], hg.botR[2], s)]
      const r = ROPE_R * Math.sqrt(Math.sin(Math.PI * s))
      const w = M4.apply(M, add(base, scale3(dir, r)))
      w[1] = Math.max(w[1], 0.014)
      pts.push(w)
    }
    return pts
  }

  // A verlet rope pinned at both handles; drapes over the ground and Clawd.
  class RopeSim {
    constructor() { this.on = false }
    begin(pts) {
      this.p = pts.map(v => v.slice())
      this.o = pts.map(v => v.slice())
      let L = 0
      for (let i = 1; i < ROPE_N; i++) L += len3(sub(pts[i], pts[i - 1]))
      this.rest = L / (ROPE_N - 1)
      this.on = true
    }
    step(dt, a, b, M, inv) {
      const sub3 = 3, h = dt / sub3
      for (let k = 0; k < sub3; k++) {
        for (let i = 1; i < ROPE_N - 1; i++) {
          const p = this.p[i], o = this.o[i]
          const v = [(p[0] - o[0]) * 0.985, (p[1] - o[1]) * 0.985, (p[2] - o[2]) * 0.985]
          o[0] = p[0]; o[1] = p[1]; o[2] = p[2]
          p[0] += v[0]; p[1] += v[1] - G * h * h; p[2] += v[2]
        }
        this.p[0] = a.slice()
        this.p[ROPE_N - 1] = b.slice()
        for (let it = 0; it < 14; it++) {
          for (let i = 1; i < ROPE_N; i++) {
            const p = this.p[i - 1], q = this.p[i]
            const d = sub(q, p), L = len3(d) || 1e-6
            const wp = i - 1 === 0 ? 0 : 1, wq = i === ROPE_N - 1 ? 0 : 1
            if (wp + wq === 0) continue
            const c = scale3(d, (L - this.rest) / L / (wp + wq))
            if (wp) { p[0] += c[0]; p[1] += c[1]; p[2] += c[2] }
            if (wq) { q[0] -= c[0]; q[1] -= c[1]; q[2] -= c[2] }
          }
          for (let i = 1; i < ROPE_N - 1; i++) {
            const p = this.p[i]
            if (p[1] < 0.014) {
              p[1] = 0.014
              const o = this.o[i]
              o[0] = lerp(o[0], p[0], 0.6); o[2] = lerp(o[2], p[2], 0.6)
            }
            // keep out of the body (a box in Clawd's local space)
            const l = M4.apply(inv, p)
            const dx = 0.58 - Math.abs(l[0]), dy = 0.34 - Math.abs(l[1] - 0.51), dz = 0.36 - Math.abs(l[2])
            if (dx > 0 && dy > 0 && dz > 0) {
              if (dx < dy && dx < dz) l[0] = Math.sign(l[0]) * 0.58
              else if (dy < dz) l[1] = 0.51 + Math.sign(l[1] - 0.51) * 0.34
              else l[2] = Math.sign(l[2] || 1) * 0.36
              const w = M4.apply(M, l)
              p[0] = w[0]; p[1] = w[1]; p[2] = w[2]
            }
          }
        }
      }
      return this.p
    }
  }

  // ---------------------------------------------------------- activities --
  // Each activity: { name, duration (<= 10s), sample(t) -> { pose, props, cam } }.

  function makeJumpRope(rng) {
    const trip = rng() < 0.6
    const START = 0.95, PHI0 = -2.6
    const iv = [0.62, 0.62, 0.62, 0.6, 0.57, 0.54, 0.51, 0.48, 0.46]
    const c = [START + (Math.PI - PHI0) / (TAU / 0.62)]
    for (const d of iv) c.push(c[c.length - 1] + d)
    const N = c.length - 1, tc = c[N]
    const flight = i => (i === N ? 0.64 : 0.66 * (i === 0 ? 0.62 : iv[i - 1]))
    const stuck = Math.PI + TAU * N - 0.35
    const tStuck = c[N - 1] + ((TAU - 0.35) / TAU) * iv[N - 1]
    const ropeOut = trip ? [tc + 2.2, tc + 2.65] : [7.65, 8.1]

    function phiAt(t) {
      if (t < START) return PHI0
      if (t < c[0]) return lerp(PHI0, Math.PI, (t - START) / (c[0] - START))
      for (let i = 0; i < N; i++) {
        if (t < c[i + 1]) {
          const a = Math.PI + TAU * i + (TAU * (t - c[i])) / (c[i + 1] - c[i])
          return trip && i === N - 1 ? Math.min(a, stuck) : a
        }
      }
      if (trip) return stuck
      return Math.PI + TAU * N + 3.4 * easeOut(seg(t, tc, tc + 0.75))
    }

    return {
      name: 'jumpRope',
      duration: 9.6,
      sample(t) {
        const p = basePose(t), pr = baseProps()
        const rope = pr.rope
        rope.show = t < ropeOut[0] ? pop(t, 0.05, 0.55) : unpop(t, ropeOut[0], ropeOut[1])
        rope.phi = phiAt(t)
        rope.physics = trip && t >= tStuck
        rope.wrist = t > START && t < tc + 0.2 ? 0.035 * smooth(seg(t, START, START + 0.25)) : 0
        const spinning = t > START && t < tc + 0.4
        const hold = lerp(0.18, 0.5, smooth(seg(t, 0.05, 0.6)) * (1 - smooth(seg(t, ropeOut[0], ropeOut[1] + 0.3))))
        p.arms = [hold, hold].map(a => a + (spinning ? 0.07 * Math.sin(rope.phi) : 0))
        p.squash += -0.08 * bump(t, c[0] - 0.5, c[0] - 0.22)
        for (let i = 0; i <= N; i++) {
          if (trip && i === N) break
          const f = flight(i), a = c[i] - f / 2, b = c[i] + f / 2
          if (t > a && t < b) {
            const s = seg(t, a, b)
            p.y = arcY(t, a, b, 0, 0)
            p.legs = [0.2, -0.15, 0.15, -0.2].map(v => v * Math.sin(Math.PI * s))
            if (i === N) {
              p.yaw = TAU * smoother(s)
              p.eye = EYE.happy
            }
          }
        }
        if (t > c[5] && t < tc - 0.1) p.squint = 0.4
        const cam = { x: 0, y: 0.62, z: 0, dist: 4.6 }

        if (!trip) {
          if (t > tc && t < 8.7) p.eye = EYE.happy
          const up = smooth(seg(t, tc + 0.35, tc + 0.6)) * (1 - smooth(seg(t, 7.9, 8.3)))
          p.arms = p.arms.map(a => lerp(a, 1.3, up))
          for (const [a, b] of [[8.05, 8.35], [8.4, 8.7]]) if (t > a && t < b) p.y = arcY(t, a, b, 0, 0)
        } else if (t >= tc - 0.14) {
          const tt = t - tc
          p.pivot = [0.53, 0, 0] // right foot: Clawd tips over to the right
          if (tt < 0.06) p.y = 0.07 * Math.sin(Math.PI * seg(tt, -0.14, 0.06))
          const fall = seg(tt, 0, 0.36)
          let roll = -(Math.PI / 2) * fall * fall
          if (tt > 0.36 && tt < 0.56) roll += 0.13 * Math.sin(Math.PI * seg(tt, 0.36, 0.56))
          if (tt > 1.85) roll = -(Math.PI / 2) * (1 - smooth(seg(tt, 1.85, 2.3)))
          p.roll = roll
          p.arms = [lerp(0.5, 1.0, fall), lerp(0.5, 1.5, fall)]
          if (tt > 0.4 && tt < 1.85) {
            p.legs = [0, 1, 2, 3].map(i => 0.6 * Math.sin(tt * 19 + i * 1.7))
            p.arms[0] += 0.25 * Math.sin(tt * 15)
          }
          if (tt > 1.85) {
            const s = smooth(seg(tt, 1.85, 2.4))
            p.arms = [lerp(1.0, 0.18, s), lerp(1.5, 0.18, s)]
          }
          if (tt > 0.34 && tt < 2.1) p.eye = EYE.dizzy
          p.stars = smooth(seg(tt, 0.4, 0.7)) * (1 - smooth(seg(tt, 1.95, 2.3)))
          p.squash += -0.12 * bump(tt, 2.28, 2.5)
          if (tt > 2.32) {
            p.pivot = COM.slice()
            p.yaw = 0.28 * Math.sin((tt - 2.32) * 26) * (1 - seg(tt, 2.32, 2.9))
          }
          cam.x = 0.3 * smooth(seg(tt, 0, 0.5)) * (1 - smooth(seg(tt, 2.0, 2.8)))
        }
        return { pose: p, props: pr, cam }
      },
    }
  }

  function makeSwing(rng) {
    const stick = rng() < 0.6
    const L = 1.42, PIV = [0, 1.82, 0], OM = Math.sqrt(G / L), SIT = 1.15
    // let go just before a forward peak (theta is most negative at 1.5pi + 2pi k)
    const tL = SIT + (3.5 * Math.PI - 0.55) / OM
    const amp = t => 0.8 * smooth(seg(t, SIT, SIT + 2.9))
    const phase = t => OM * (t - SIT)
    const theta = t =>
      t < SIT ? 0 : (t < tL ? amp(t) : amp(tL) * Math.exp(-0.45 * (t - tL))) * Math.sin(phase(t))
    const lean = t => (t < SIT ? 0 : (0.28 * Math.cos(phase(t)) * amp(Math.min(t, tL))) / 0.8)
    const seatTop = th => add(PIV, rotX([0, -L + 0.03, 0], th))
    const seatedLegs = t => 1.35 - (0.4 * Math.cos(phase(t)) * amp(Math.min(t, tL))) / 0.8
    const comSeated = t => add(seatTop(theta(t)), rotX([0, 0.23, 0], theta(t) + lean(t)))

    const pL = theta(tL) + lean(tL)
    const comL = comSeated(tL)
    const vel = scale3(sub(comSeated(tL + 1e-3), comSeated(tL - 1e-3)), 1 / 2e-3)
    vel[1] += 1.7
    vel[2] += 0.2
    const yLand = stick ? 0.45 : 0.23
    const tf = (vel[1] + Math.sqrt(vel[1] * vel[1] + 2 * G * (comL[1] - yLand))) / G
    const tLand = tL + tf
    const comAt = t => {
      const u = t - tL
      return [comL[0] + vel[0] * u, comL[1] + vel[1] * u - 0.5 * G * u * u, comL[2] + vel[2] * u]
    }
    const land = comAt(tLand)
    const pEnd = stick ? TAU : TAU - 0.35
    const legsL = seatedLegs(tL)
    const sitBottom = add(land, rotX([0, -0.23, 0], -0.35))
    const sitRoot = [sitBottom[0], sitBottom[1] - 0.22, sitBottom[2]]
    const tUp = stick ? tLand + 0.55 : tLand + 1.65
    const home = stick ? [land[0], land[2]] : [sitRoot[0], sitRoot[2]]
    const HOP = 0.32
    const n = Math.max(1, Math.ceil(Math.hypot(home[0], home[1]) / 0.5))

    return {
      name: 'swing',
      duration: tUp + n * HOP + 0.25,
      sample(t) {
        const p = basePose(t), pr = baseProps()
        pr.swing.show = t < tLand ? pop(t, 0.12, 0.6) : unpop(t, tLand + 0.15, tLand + 0.6)
        pr.swing.angle = theta(t)
        if (t < 0.45) {
          const s = seg(t, 0, 0.45)
          p.z = lerp(0, -0.5, smooth(s))
          p.y = arcY(t, 0, 0.45, 0, 0)
          p.legs = hopLegs(s)
        } else if (t < 0.75) {
          p.z = -0.5
          p.squash += -0.09 * bump(t, 0.5, 0.75)
        } else if (t < SIT) {
          const s = seg(t, 0.75, SIT)
          p.z = lerp(-0.5, 0, smooth(s))
          p.y = arcY(t, 0.75, SIT, 0, seatTop(0)[1] - 0.22)
          p.legs = [1, 1, 1, 1].map(() => 1.35 * smooth(s))
          p.arms = [lerp(0.18, 1.0, s), lerp(0.18, 1.0, s)]
        } else if (t < tL) {
          const th = theta(t), top = seatTop(th)
          p.pivot = BODY_BOTTOM.slice()
          p.x = top[0]; p.y = top[1] - 0.22; p.z = top[2]
          p.pitch = th + lean(t)
          const lg = seatedLegs(t)
          p.legs = [lg, lg + 0.06, lg - 0.06, lg]
          p.arms = [1.0, 1.0]
          p.springy = false
          if (amp(t) > 0.45) p.eye = EYE.happy
        } else if (t < tLand) {
          const s = seg(t, tL, tLand), com = comAt(t)
          p.x = com[0]; p.y = com[1] - 0.45; p.z = com[2]
          p.pitch = lerp(pL, pEnd, smoother(s))
          const target = stick ? 0 : 1.4
          p.legs = [1, 1, 1, 1].map(() => lerp(legsL, target, smooth(s)) + 0.6 * Math.sin(Math.PI * s))
          p.arms = [lerp(1.0, 1.35, s), lerp(1.0, 1.35, s)]
        } else if (stick && t < tUp) {
          p.x = land[0]; p.z = land[2]
          const a = lerp(1.35, 0.18, smooth(seg(t, tUp - 0.25, tUp)))
          p.arms = [a, a]
          p.eye = EYE.happy
        } else if (!stick && t < tUp) {
          p.pivot = BODY_BOTTOM.slice()
          p.x = sitRoot[0]; p.z = sitRoot[2]
          const up = smooth(seg(t, tLand + 1.25, tUp))
          p.y = lerp(sitRoot[1], 0, up) + 0.05 * bump(t, tLand, tLand + 0.22) + 0.1 * Math.sin(Math.PI * up)
          p.pitch = lerp(-0.35, 0, up) + 0.06 * bump(t, tLand, tLand + 0.3)
          p.legs = [1, 1, 1, 1].map(() => lerp(1.4, 0, up))
          const a = lerp(1.35, 0.18, smooth(seg(t, tLand, tLand + 0.5)))
          p.arms = [a, a]
          if (t < tLand + 1.2) p.eye = EYE.dizzy
          p.stars = smooth(seg(t, tLand + 0.05, tLand + 0.3)) * (1 - smooth(seg(t, tLand + 1.0, tLand + 1.3)))
        } else {
          const h = hops(t, tUp, HOP, n, home, [0, 0])
          p.x = h.x; p.z = h.z; p.y = h.y
          p.legs = hopLegs(h.s)
        }
        return { pose: p, props: pr, cam: { x: p.x * 0.3, y: 0.95, z: p.z * 0.35, dist: 5.0 } }
      },
    }
  }

  function makeTrampoline(rng) {
    const stick = rng() < 0.55
    const MAT = 0.455, START = 1.45, CONTACT = 0.2
    const phases = []
    let t = START, vin = Math.sqrt(2 * G * 0.2)
    const contact = () => {
      phases.push({ kind: 'c', t0: t, t1: t + CONTACT, depth: 0.06 + 0.045 * vin })
      t += CONTACT
    }
    const flightTo = (h, trick) => {
      const T = 2 * Math.sqrt((2 * h) / G)
      phases.push({ kind: 'f', t0: t, t1: t + T, h, trick })
      t += T
      vin = Math.sqrt(2 * G * h)
    }
    ;[[0.35], [0.55], [0.8], [1.0, 'spin'], [1.15, 'flip']].forEach(([h, trick]) => {
      contact()
      flightTo(h, trick)
    })
    contact()
    if (stick) {
      flightTo(0.22)
      contact()
    }
    const tOff = t
    const OFF = stick ? 0.6 : 0.85
    const tA = tOff + OFF
    const offTo = stick ? [0, 0, 1.3] : [1.45, 0, 0.35]
    const tTumble = stick ? tA : tA + 0.6
    const rest = stick ? offTo : [2.05, 0, 0.35]
    const tHome = stick ? tA + 0.5 : tTumble + 0.6
    const HOP = 0.3, n = stick ? 3 : 4

    return {
      name: 'trampoline',
      duration: tHome + n * HOP + 0.2,
      sample(tm) {
        const p = basePose(tm), pr = baseProps()
        pr.tramp.show = tm < tA ? pop(tm, 0.3, 0.8) : unpop(tm, tA + 0.05, tA + 0.5)
        if (tm < 0.7) {
          const h = hops(tm, 0, 0.35, 2, [0, 0], [0, -1.3])
          p.x = h.x; p.z = h.z; p.y = h.y; p.legs = hopLegs(h.s)
        } else if (tm < 0.9) {
          p.z = -1.3
          p.squash += -0.1 * bump(tm, 0.72, 0.9)
        } else if (tm < START) {
          const s = seg(tm, 0.9, START)
          p.z = lerp(-1.3, 0, smooth(s))
          p.y = arcY(tm, 0.9, START, 0, MAT)
          p.legs = hopLegs(s)
          p.arms = [0.18 + 0.8 * Math.sin(Math.PI * s), 0.18 + 0.8 * Math.sin(Math.PI * s)]
        } else if (tm < tOff) {
          const ph = phases.find(q => tm >= q.t0 && tm < q.t1) || phases[phases.length - 1]
          const s = seg(tm, ph.t0, ph.t1)
          if (ph.kind === 'c') {
            const sag = ph.depth * Math.sin(Math.PI * s)
            p.y = MAT - sag
            pr.tramp.sag = sag
            p.squash += -0.1 * Math.sin(Math.PI * s)
            p.arms = [0.3, 0.3]
          } else {
            const since = tm - ph.t0
            pr.tramp.sag = 0.04 * Math.exp(-7 * since) * Math.cos(32 * since)
            p.y = arcY(tm, ph.t0, ph.t1, MAT, MAT)
            const a = 0.3 + 1.0 * Math.sin(Math.PI * s)
            p.arms = [a, a]
            p.legs = [0.25, -0.2, 0.2, -0.25].map(v => v * Math.sin(Math.PI * s))
            if (ph.h >= 0.8) p.eye = EYE.happy
            if (ph.trick === 'spin') p.yaw = TAU * smoother(s)
            if (ph.trick === 'flip') {
              p.pitch = TAU * smoother(s)
              p.legs = [1, 1, 1, 1].map(() => 0.9 * Math.sin(Math.PI * s))
            }
          }
        } else if (tm < tA) {
          const s = seg(tm, tOff, tA)
          pr.tramp.sag = 0.05 * Math.exp(-7 * (tm - tOff)) * Math.cos(32 * (tm - tOff))
          p.x = lerp(0, offTo[0], s); p.z = lerp(0, offTo[2], s)
          p.y = arcY(tm, tOff, tA, MAT, 0)
          p.legs = hopLegs(s)
          if (!stick) {
            p.roll = 0.45 * Math.sin(TAU * 2 * s) * (1 - s)
            p.arms = [0.6 + 0.8 * Math.sin(tm * 30), 0.6 + 0.8 * Math.cos(tm * 27)]
            p.eye = EYE.closed
          }
        } else if (tm < tHome) {
          if (stick) {
            p.x = offTo[0]; p.z = offTo[2]
            const a = lerp(1.35, 0.18, smooth(seg(tm, tHome - 0.2, tHome)))
            p.arms = [a, a]
            p.eye = EYE.happy
          } else if (tm < tTumble) {
            const s = smooth(seg(tm, tA, tTumble))
            p.roll = -TAU * s
            p.x = lerp(offTo[0], rest[0], s); p.z = offTo[2]
            p.y = 0.12 * Math.sin(Math.PI * s)
            p.eye = EYE.dizzy
          } else {
            p.x = rest[0]; p.z = rest[2]
            p.eye = EYE.dizzy
            p.stars = smooth(seg(tm, tTumble, tTumble + 0.2)) * (1 - smooth(seg(tm, tHome - 0.2, tHome)))
            p.yaw = 0.15 * Math.sin((tm - tTumble) * 9)
            p.roll = 0.06 * Math.sin((tm - tTumble) * 7)
          }
        } else {
          const h = hops(tm, tHome, HOP, n, [rest[0], rest[2]], [0, 0])
          p.x = h.x; p.z = h.z; p.y = h.y; p.legs = hopLegs(h.s)
        }
        return { pose: p, props: pr, cam: { x: p.x * 0.45, y: 0.75 + 0.5 * p.y, z: p.z * 0.3, dist: 5.6, fast: true } }
      },
    }
  }

  function makeBall(rng) {
    const kick = rng() < 0.5
    const R = 0.27, HF = 0.17
    const xs = [0.5, -0.05, -0.5, 0.15], cs = [1.55, 2.45, 3.3, 4.15]
    const CY = 0.8 + 0.5 * G * HF * HF + R + 0.02
    const B = xs.map(x => [x, CY, 0])
    // Clawd's moves: a hop under the ball, then a header jump, repeat.
    const moves = [{ t0: 0.95, t1: 1.3, a: 0, b: xs[0] }]
    for (let i = 0; i < 3; i++) moves.push({ t0: cs[i] + HF + 0.03, t1: cs[i + 1] - HF - 0.05, a: xs[i], b: xs[i + 1] })

    // Endings
    const tl = 5.2, Lp = [-0.95, R, 0.15]
    const T3 = tl - cs[3]
    const vLand = [(Lp[0] - B[3][0]) / T3, (R - CY) / T3 - 0.5 * G * T3, (Lp[2] - B[3][2]) / T3]
    const vBounce = [vLand[0] * 0.7, -vLand[1] * 0.5, vLand[2] * 0.7]
    const tk = 6.36
    const kickFrom = ballistic(Lp, vBounce, tk - tl, R)
    const stand = [kickFrom[0] + 0.62, kickFrom[2]]
    const vKick = [-4.2, 4.0, -5.0]
    const tb = cs[3] + 1.75, Hc = [xs[3], 0.8 + R, 0], vBonk = [1.9, 3.2, -1.4]

    function ballAt(t) {
      if (t < cs[0]) return [B[0][0], CY + 0.5 * G * (cs[0] - t) * (cs[0] - t), 0]
      for (let i = 0; i < 3; i++) {
        if (t < cs[i + 1]) {
          const s = seg(t, cs[i], cs[i + 1])
          return [lerp(B[i][0], B[i + 1][0], s), arcY(t, cs[i], cs[i + 1], CY, CY), 0]
        }
      }
      if (kick) {
        if (t < tl) {
          const s = seg(t, cs[3], tl)
          return [lerp(B[3][0], Lp[0], s), arcY(t, cs[3], tl, CY, R), lerp(0, Lp[2], s)]
        }
        if (t < tk) return ballistic(Lp, vBounce, t - tl, R)
        return ballistic(kickFrom, vKick, t - tk, R, 0.5, 0.8)
      }
      if (t < tb) return [B[3][0], arcY(t, cs[3], tb, CY, Hc[1]), 0]
      return ballistic(Hc, vBonk, t - tb, R)
    }

    const tHome = kick ? 7.5 : 8.15
    const homeFrom = kick ? stand : [xs[3], 0]
    const nHome = kick ? 2 : 1, HOP = 0.36

    return {
      name: 'ball',
      duration: tHome + nHome * HOP + 0.3,
      sample(t) {
        const p = basePose(t), pr = baseProps()
        const b = ballAt(t)
        const airborne = b[1] > R + 0.01
        pr.ball = {
          show: t < 7.6 ? pop(t, 0.6, 0.9) : unpop(t, kick ? 8.0 : 7.6, kick ? 8.4 : 8.0),
          x: b[0], y: b[1], z: b[2],
          rz: -b[0] / R * 0.8, rx: b[2] / R, ry: airborne ? t * 3.0 : 0,
        }
        // where Clawd is
        let x = 0, y = 0, z = 0
        let moving = false
        for (const m of moves) {
          if (t >= m.t1) x = m.b
          else if (t > m.t0) {
            const s = seg(t, m.t0, m.t1)
            x = lerp(m.a, m.b, smooth(s))
            y = arcY(t, m.t0, m.t1, 0, 0)
            p.legs = hopLegs(s)
            moving = true
            break
          }
        }
        for (let i = 0; i < 4; i++) {
          const a = cs[i] - HF, bb = cs[i] + HF
          if (t > a && t < bb) {
            y = arcY(t, a, bb, 0, 0)
            p.arms = [0.6, 0.6]
          }
          p.squash += -0.14 * bump(t, cs[i] - 0.02, cs[i] + 0.12)
        }
        if (t < cs[3] + 0.4 || (!kick && t < tb)) {
          p.look = [clamp((b[0] - x) * 0.7, -1, 1), clamp((b[1] - 1.0) * 0.5, -1, 1)]
        }
        if (kick && t > cs[3] + HF) {
          if (t < 5.85) {
            const h = hops(t, 4.45, 0.46, 3, [xs[3], 0], stand)
            x = h.x; z = h.z; y = h.y
            if (h.s) p.legs = hopLegs(h.s)
            p.yaw = -Math.PI / 2 * smooth(seg(t, 4.45, 5.6))
            p.look = [0, clamp((b[1] - 0.8) * 0.5, -1, 1)]
          } else if (t < tHome) {
            x = stand[0]; z = stand[1]
            p.yaw = -Math.PI / 2
            // wind up, strike, follow through
            const leg = t < 6.3 ? -0.65 * smooth(seg(t, 6.0, 6.3)) : t < 6.42 ? lerp(-0.65, 1.15, smooth(seg(t, 6.3, 6.42))) : lerp(1.15, 0, smooth(seg(t, 6.42, 6.8)))
            p.legs = [leg, leg * 0.3, leg * 0.3, leg]
            p.pitch = -0.12 * bump(t, 6.25, 6.6)
            if (t > 6.6) {
              p.eye = EYE.happy
              for (const [a, bb] of [[6.85, 7.15], [7.18, 7.48]]) if (t > a && t < bb) { y = arcY(t, a, bb, 0, 0); p.arms = [1.2, 1.2] }
            }
          } else {
            const h = hops(t, tHome, HOP, nHome, homeFrom, [0, 0])
            x = h.x; z = h.z; y = h.y
            p.legs = hopLegs(h.s)
            p.yaw = -Math.PI / 2 * (1 - smooth(seg(t, tHome, tHome + nHome * HOP)))
            p.eye = EYE.happy
          }
        }
        if (!kick && t > cs[3] + HF) {
          x = xs[3]
          if (t > 4.6 && t < 5.4) p.look = [Math.sin((t - 4.6) * 7), 0.2]
          if (t >= tb) {
            p.pivot = BODY_BOTTOM.slice()
            const down = smooth(seg(t, tb + 0.02, tb + 0.35)), up = smooth(seg(t, 7.35, 7.75))
            const sit = down * (1 - up)
            y = lerp(0, 0.014 - 0.22, sit) + 0.08 * bump(t, tb + 0.02, tb + 0.3) + 0.1 * bump(t, 7.35, 7.75)
            p.pitch = -0.35 * sit
            p.legs = [1, 1, 1, 1].map(() => 1.4 * sit)
            p.squash += -0.3 * bump(t, tb - 0.02, tb + 0.14)
            if (t < 7.35) p.eye = EYE.dizzy
            p.stars = smooth(seg(t, tb + 0.05, tb + 0.3)) * (1 - smooth(seg(t, 7.1, 7.4)))
            if (t > 7.75 && t < tHome) { p.pivot = COM.slice(); p.yaw = 0.25 * Math.sin((t - 7.75) * 26) * (1 - seg(t, 7.75, 8.1)) }
            if (t >= tHome) {
              p.pivot = COM.slice()
              const h = hops(t, tHome, HOP, nHome, homeFrom, [0, 0])
              x = h.x; y = h.y
              p.legs = hopLegs(h.s)
            }
          } else if (t > 5.5) p.look = [0, 1]
        }
        p.x = x; p.y = y; p.z = z
        if (moving && t < cs[3]) p.eye = EYE.normal
        return { pose: p, props: pr, cam: { x: x * 0.4, y: 0.95, z: 0, dist: 5.2 } }
      },
    }
  }

  // Meadow flowers for the butterfly scene: x, z, stem height. The first is the butterfly's.
  const FLOWERS = [[1.4, 0.45, 0.32], [-1.25, 0.35, 0.26], [-0.85, -0.95, 0.3], [1.05, -1.0, 0.24], [1.95, -0.25, 0.28], [-1.9, 0.8, 0.22]]

  // A smooth path through [t, x, y, z] keys (cubic Hermite). Two equal keys in a row
  // are a perch: the path eases in, holds, and eases out.
  function hermitePath(keys) {
    const same = (a, b) => a && b && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]
    return t => {
      if (t <= keys[0][0]) return keys[0].slice(1)
      const last = keys[keys.length - 1]
      if (t >= last[0]) return last.slice(1)
      let i = 0
      while (t > keys[i + 1][0]) i++
      const k0 = keys[i - 1], k1 = keys[i], k2 = keys[i + 1], k3 = keys[i + 2]
      const dt = k2[0] - k1[0], s = (t - k1[0]) / dt
      const tangent = (prev, cur, next) => {
        if (!prev || !next || same(prev, cur) || same(cur, next)) return [0, 0, 0]
        return [1, 2, 3].map(j => ((next[j] - prev[j]) / (next[0] - prev[0])) * dt)
      }
      const m1 = tangent(k0, k1, k2), m2 = tangent(k1, k2, k3)
      const s2 = s * s, s3 = s2 * s
      const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2
      return [1, 2, 3].map((j, n) => h00 * k1[j] + h10 * m1[n] + h01 * k2[j] + h11 * m2[n])
    }
  }

  function makeButterfly(rng) {
    const F = FLOWERS[0]
    const onFlower = [F[0], F[2] + 0.05, F[1]]
    const onHead = [0, 0.818, 0.17]
    const drift = rng() * 0.3
    const path = hermitePath([
      [0.0, -2.8, 1.6, -1.6],
      [0.9, -0.9, 1.15, 0.2],
      [1.4, 0.0, 1.25, 0.7],
      [1.9, 0.7, 1.05, 0.1],
      [2.4, 0.3, 1.2 + drift, -0.6],
      [2.9, 1.1, 0.75, 0.2],
      [3.3, ...onFlower],
      [4.12, ...onFlower],
      [4.5, 1.25, 1.35, 0.1],
      [5.0, 0.4, 1.45, -0.6],
      [5.6, -0.5, 1.1 + drift, -0.3],
      [6.2, -0.4, 1.2, 0.5],
      [6.7, 0.0, 1.05, 0.35],
      [7.0, ...onHead],
      [8.4, ...onHead],
      [8.9, 0.5, 1.5, 0.6],
      [9.6, 1.8, 2.6, -0.5],
    ])
    const speed = t => len3(sub(path(t + 0.05), path(t - 0.05))) / 0.1
    const W = [0.74, 0.24], P = [0.98, 0.32]
    const FLOWER_YAW = Math.atan2(F[0], F[1])
    // Turn toward where the butterfly was a moment ago; never all the way round.
    const yawToward = (t, cx, cz) => {
      const b = path(t - 0.25)
      return Math.atan2(b[0] - cx, Math.max(b[2] - cz, 0.25))
    }

    return {
      name: 'butterfly',
      duration: 9.95,
      sample(t) {
        const p = basePose(t), pr = baseProps()
        pr.flowers = FLOWERS.map((_, i) => (t < 9 ? pop(t, 0.05 + 0.08 * i, 0.55 + 0.08 * i) : unpop(t, 9.05 + 0.05 * i, 9.5 + 0.05 * i)))

        // the butterfly: a smooth path, plus flutter while it flies
        const base = path(t)
        const flying = smooth(seg(speed(t), 0.03, 0.25))
        const pos = [
          base[0] + 0.03 * Math.sin(t * 13) * flying,
          base[1] + 0.045 * Math.sin(t * 9.7 + 1) * flying,
          base[2] + 0.03 * Math.sin(t * 11 + 2) * flying,
        ]
        const v = sub(path(t + 0.08), path(t - 0.08))
        pr.fly = {
          show: t < 9.3 ? pop(t, 0, 0.3) : unpop(t, 9.3, 9.75),
          x: pos[0], y: pos[1], z: pos[2],
          yaw: wrapAngle(Math.atan2(v[0], v[2])) * flying,
          pitch: -clamp(Math.atan2(v[1], Math.hypot(v[0], v[2]) + 1e-4), -0.6, 0.6) * 0.6 * flying,
          flap: lerp(0.3 + 0.35 * Math.sin(t * 3.1), 0.5 + 0.8 * Math.sin(t * TAU * 8), flying), // perched: basking, wings open
        }

        // where Clawd is
        let x = 0, z = 0, y = 0
        const sneak = t > 2.6 && t < 3.85 ? Math.min(seg(t, 2.6, 2.8), 1 - seg(t, 3.65, 3.85)) : 0
        if (t >= 2.6 && t < 3.85) {
          const s = smooth(seg(t, 2.6, 3.85))
          x = W[0] * s; z = W[1] * s
          const ph = (t - 2.6) * TAU * 1.6
          y = 0.045 * Math.abs(Math.sin(ph)) * sneak
          p.legs = [1, -1, 1, -1].map(k => 0.4 * k * Math.sin(ph) * sneak)
          p.roll = 0.06 * Math.sin(ph) * sneak
        } else if (t >= 3.85 && t < 4.05) {
          x = W[0]; z = W[1]
        } else if (t >= 4.05 && t < 4.55) {
          const s = seg(t, 4.05, 4.55)
          x = lerp(W[0], P[0], s); z = lerp(W[1], P[1], s)
          y = arcY(t, 4.05, 4.55, 0, 0)
          p.legs = [1, 1, 1, 1].map(() => -0.5 * Math.sin(Math.PI * s))
        } else if (t >= 4.55 && t < 6.0) {
          x = P[0]; z = P[1]
        } else if (t >= 6.0 && t < 6.75) {
          const h = hops(t, 6.0, 0.375, 2, P, [0, 0])
          x = h.x; z = h.z; y = h.y
          p.legs = hopLegs(h.s)
        }
        for (const [a, b] of [[1.5, 1.8], [1.85, 2.15], [5.62, 5.92]]) {
          if (t > a && t < b) {
            y = arcY(t, a, b, 0, 0)
            p.legs = hopLegs(seg(t, a, b))
          }
        }

        // which way Clawd faces
        let yaw
        if (t < 2.6) yaw = lerp(yawToward(t, 0, 0) * smooth(seg(t, 0.6, 1.0)), FLOWER_YAW, smooth(seg(t, 2.2, 2.6)))
        else if (t < 4.75) yaw = FLOWER_YAW
        else if (t < 5.6) yaw = FLOWER_YAW + 0.55 * Math.sin((t - 4.75) * 7.4) * Math.sin(Math.PI * seg(t, 4.75, 5.6))
        else if (t < 6.0) yaw = lerp(FLOWER_YAW, yawToward(t, P[0], P[1]), smooth(seg(t, 5.6, 6.0)))
        else yaw = lerp(yawToward(t, x, z), 0, smooth(seg(t, 6.0, 6.75)))

        // arms: excited flutters, sneaking, the grab, waving goodbye
        let arm = 0.18 + 0.3 * Math.abs(Math.sin(t * 9)) * bump(t, 1.35, 2.2)
        arm = lerp(arm, 0.55, smooth(seg(t, 2.45, 2.75)) * (1 - smooth(seg(t, 3.85, 4.05))))
        arm = lerp(arm, 1.45, smooth(seg(t, 3.95, 4.15)) * (1 - smooth(seg(t, 4.6, 4.9))))
        const wave = smooth(seg(t, 8.5, 8.8)) * (1 - smooth(seg(t, 9.45, 9.8)))
        p.arms = [arm, lerp(arm, 1.35 + 0.45 * Math.sin((t - 8.6) * 13), wave)]

        p.pitch = 0.3 * bump(t, 4.05, 4.6)
        p.squash += -0.07 * sneak - 0.16 * bump(t, 3.8, 4.08)
        if (sneak > 0) p.squint = 0.55

        const joy = smooth(seg(t, 7.3, 7.5)) * (1 - smooth(seg(t, 8.3, 8.45)))
        if (joy > 0) p.legs = [1, -1, 1, -1].map(k => 0.12 * k * Math.sin(t * 22) * joy)
        p.blush = smooth(seg(t, 7.1, 7.5)) * (1 - smooth(seg(t, 9.0, 9.5)))

        const happy = [[1.3, 1.75], [5.6, 6.75], [7.25, 8.5], [8.8, 9.6]]
        if (happy.some(([a, b]) => t > a && t < b)) p.eye = EYE.happy
        if (t > 4.15 && t < 4.5) p.eye = EYE.closed

        // eyes follow the butterfly, in Clawd's own frame
        const d = [pos[0] - x, pos[1] - (y + 0.6), pos[2] - z]
        const c = Math.cos(yaw), sn = Math.sin(yaw)
        const lx = c * d[0] - sn * d[2], lz = sn * d[0] + c * d[2]
        p.look = [clamp((lx / (Math.abs(lz) + 0.4)) * 1.2, -1, 1), clamp(Math.atan2(d[1], Math.hypot(d[0], d[2])) / 0.6, -1, 1)]

        p.x = x; p.y = y; p.z = z; p.yaw = yaw
        const camX = lerp(x, clamp(base[0], -1.5, 1.5), 0.35)
        return { pose: p, props: pr, cam: { x: camX * 0.6, y: 0.8, z: z * 0.3, dist: 5.0 } }
      },
    }
  }

  const ACTIVITIES = { jumpRope: makeJumpRope, swing: makeSwing, trampoline: makeTrampoline, ball: makeBall, butterfly: makeButterfly }
  const LABELS = { jumpRope: 'Jump rope', swing: 'Swing', trampoline: 'Trampoline', ball: 'Beach ball', butterfly: 'Butterfly' }

  // A breather between activities, when the tempo asks for longer gaps.
  function makeIdle(rng, duration) {
    const a = rng() * TAU
    return {
      name: 'idle',
      duration,
      sample(t) {
        const p = basePose(t), pr = baseProps()
        const env = Math.min(seg(t, 0, 0.6), 1 - seg(t, duration - 0.6, duration))
        p.look = [0.8 * Math.sin(t * 0.9 + a) * env, 0.3 * Math.sin(t * 0.6 + a) * env]
        p.yaw = 0.25 * Math.sin(t * 0.5 + a) * env
        const tap = bump(t % 5, 3.4, 4.4) * env
        p.legs = [1, -1, 1, -1].map(k => 0.1 * k * Math.sin(t * 14) * tap)
        return { pose: p, props: pr, cam: { x: 0, y: 0.62, z: 0, dist: 4.6 } }
      },
    }
  }

  // A stroll along the ground to somewhere new (dx world units). The host shifts
  // Clawd's home by dx when it ends ('walked'), so the next activity starts there.
  function makeWalk(dx) {
    const dir = Math.sign(dx), TURN = 0.45, SPEED = 0.85
    const tw = Math.abs(dx) / SPEED
    const duration = TURN + tw + TURN
    return {
      name: 'walk',
      duration,
      dx,
      sample(t) {
        const p = basePose(t), pr = baseProps()
        const face = (dir * Math.PI) / 2
        if (t < TURN) p.yaw = face * smooth(seg(t, 0, TURN))
        else if (t < TURN + tw) {
          p.yaw = face
          const ph = (t - TURN) * TAU * 2.2
          const env = Math.min(seg(t, TURN, TURN + 0.25), 1 - seg(t, TURN + tw - 0.25, TURN + tw))
          p.y = 0.03 * Math.abs(Math.sin(ph)) * env
          p.legs = [1, -1, 1, -1].map(k => 0.45 * k * Math.sin(ph) * env)
          p.roll = 0.05 * Math.sin(ph) * env
          p.arms = [0.18 + 0.2 * Math.max(0, Math.sin(ph)) * env, 0.18 + 0.2 * Math.max(0, -Math.sin(ph)) * env]
        } else p.yaw = face * (1 - smooth(seg(t, TURN + tw, duration)))
        p.x = dx * smooth(seg(t, TURN * 0.6, TURN + tw))
        return { pose: p, props: pr, cam: { x: p.x, y: 0.62, z: 0, dist: 4.6 } }
      },
    }
  }

  // ---------------------------------------------------------------- space --
  // Astronaut Clawd in a bubble helmet, floating across the whole screen.
  const SPACE_ACTIVITIES = ['drift', 'swim', 'jetpack', 'spin', 'wave']
  const SPACE_LABELS = { drift: 'Drifting', swim: 'Space swim', jetpack: 'Jetpack loop', spin: 'Zero-g spin', wave: 'Waving hello' }
  const SPACE_DURATION = { drift: 9, swim: 9, jetpack: 7, spin: 7, wave: 6 }

  class SpaceDirector {
    constructor(rng) {
      this.rng = rng
      this.bounds = [12, 7]
      this.pos = [6, 3.5]
      const a = rng() * TAU
      this.vel = [Math.cos(a) * 0.35, Math.sin(a) * 0.25]
      this.q = Q.norm([0.08, 0.15, 0.05, 1])
      this.w = [0.15, 0.3, 0.1]
      this.oof = 0
      this.life = 0
      this.t = 0
      this.act = null
    }
    setBounds(w, h) {
      this.bounds = [Math.max(w, 2.2), Math.max(h, 2.2)]
      this.pos = this.pos.map((v, i) => clamp(v, 1, this.bounds[i] - 1))
    }
    start(name, duration) {
      const r = this.rng, a = r() * TAU
      const sp = Math.hypot(this.vel[0], this.vel[1])
      this.act = {
        name,
        duration,
        drift: [(r() - 0.5) * 0.8, (r() - 0.5) * 0.8, (r() - 0.5) * 0.6],
        dir: sp > 0.1 && r() < 0.5 ? [this.vel[0] / sp, this.vel[1] / sp] : [Math.cos(a), Math.sin(a)],
        sign: r() < 0.5 ? -1 : 1,
      }
      this.t = 0
    }
    step(dt, spring) {
      const a = this.act, D = a.duration
      const t = (this.t += dt)
      const L = (this.life += dt)
      const p = basePose(L)
      p.pivot = [0, 0.52, 0]
      p.springy = false
      p.squash = 0.015 * Math.sin(L * 1.6)
      // floating limbs, drifting gaze
      p.legs = [0, 1, 2, 3].map(i => 0.35 * Math.sin(L * 2.1 + i * 1.3))
      p.arms = [0.6 + 0.3 * Math.sin(L * 1.4), 0.6 + 0.3 * Math.sin(L * 1.4 + 1.2)]
      p.look = [0.6 * Math.sin(L * 0.5), 0.3 * Math.sin(L * 0.37)]
      const up = Q.rotate(this.q, [0, 1, 0]), fwd = Q.rotate(this.q, [0, 0, 1])
      const faceViewer = cross(fwd, [0, 0, 1])
      let targetW = a.drift, thrust = [0, 0], damp = 0.03, jet = 0

      if (a.name === 'swim') {
        const P = 1.5, ph = (t % P) / P, power = ph < 0.35
        const arm = power ? lerp(1.5, 0.15, smooth(ph / 0.35)) : lerp(0.15, 1.5, smooth((ph - 0.35) / 0.65))
        p.arms = [arm, arm]
        p.legs = [0, 1, 2, 3].map(i => 0.55 * Math.sin(ph * TAU + (i % 2) * Math.PI))
        const push = power ? Math.sin((Math.PI * ph) / 0.35) : 0
        thrust = [up[0] * 1.8 * push, up[1] * 1.8 * push]
        targetW = add(scale3(cross(up, [a.dir[0], a.dir[1], 0]), 1.6), scale3(faceViewer, 0.6))
        damp = 0.35
        p.eye = EYE.happy
      } else if (a.name === 'jetpack') {
        jet = smooth(seg(t, 0.5, 0.9)) * (1 - smooth(seg(t, D - 2.0, D - 1.4)))
        targetW = add([0, 0, 1.8 * a.sign * jet], scale3(faceViewer, 1.2))
        thrust = [up[0] * 2.0 * jet, up[1] * 2.0 * jet]
        damp = 0.4
        p.arms = [0.25, 0.25]
        p.legs = [0.15, 0.15, 0.15, 0.15]
        if (jet > 0.3) p.eye = EYE.happy
      } else if (a.name === 'spin') {
        const end = Math.min(2.6, D * 0.45)
        if (t < end) {
          const s = smooth(seg(t, 0, 0.8))
          targetW = add([0, 9 * s * a.sign, 0], scale3(cross(up, [0, 1, 0]), 3))
          p.arms = [0.02, 0.02]
          p.legs = [0, 0, 0, 0]
          p.eye = EYE.happy
        } else {
          targetW = scale3(a.drift, 0.5)
          p.eye = EYE.dizzy
          p.stars = smooth(seg(t, end, end + 0.3)) * (1 - smooth(seg(t, D - 0.8, D - 0.2)))
        }
        damp = 0.2
      } else if (a.name === 'wave') {
        // turn upright to face the viewer, slow down, wave
        const qe = Q.conj(this.q), sgn = qe[3] < 0 ? -1 : 1
        targetW = [qe[0] * sgn * 4, qe[1] * sgn * 4, qe[2] * sgn * 4]
        damp = 1.2
        const w = smooth(seg(t, 1.0, 1.4)) * (1 - smooth(seg(t, D - 1.0, D - 0.5)))
        p.arms[1] = lerp(p.arms[1], 1.35 + 0.45 * Math.sin(t * 13), w)
        if (w > 0.5) p.eye = EYE.happy
        p.look = p.look.map(v => v * (1 - w))
        p.blush = 0.6 * w
      }

      const k = 1 - Math.exp(-dt * 2.5)
      this.w = this.w.map((v, i) => lerp(v, targetW[i], k))
      this.q = Q.integrate(this.q, this.w, dt)

      this.vel[0] += thrust[0] * dt
      this.vel[1] += thrust[1] * dt
      const decay = Math.exp(-damp * dt)
      this.vel = this.vel.map(v => v * decay)
      let sp = Math.hypot(this.vel[0], this.vel[1])
      if (sp > 1.6) this.vel = this.vel.map(v => (v * 1.6) / sp)
      if (a.name !== 'wave' && sp < 0.18) {
        this.vel[0] += a.dir[0] * 0.4 * dt
        this.vel[1] += a.dir[1] * 0.4 * dt
      }
      this.pos[0] += this.vel[0] * dt
      this.pos[1] += this.vel[1] * dt

      // bump off the screen edges
      const R = 0.95
      for (let i = 0; i < 2; i++) {
        const lo = R, hi = this.bounds[i] - R
        if ((this.pos[i] < lo && this.vel[i] < 0) || (this.pos[i] > hi && this.vel[i] > 0)) {
          const impact = Math.abs(this.vel[i])
          this.vel[i] = -this.vel[i] * 0.85
          this.pos[i] = clamp(this.pos[i], lo, hi)
          sp = Math.hypot(this.vel[0], this.vel[1]) || 1
          a.dir = [this.vel[0] / sp, this.vel[1] / sp]
          if (impact > 0.15) {
            this.oof = 0.5
            spring.v -= 1.5 + impact * 1.5
            this.w = add(this.w, [(this.rng() - 0.5) * 3, (this.rng() - 0.5) * 3, (this.rng() - 0.5) * 3])
          }
        }
      }
      if (this.oof > 0) {
        this.oof -= dt
        p.eye = EYE.closed
      }
      p.quat = this.q.slice()
      p.jet = jet
      return { pose: p, props: baseProps() }
    }
  }

  // Canvas framing for the desktop-pet modes, in world units (Clawd is 0.8 tall).
  // Ground: the ground line sits groundY above the canvas bottom.
  const PET_FRAME = { ground: { w: 5.6, h: 3.0, groundY: 0.16 }, space: { w: 2.9, h: 2.9 } }

  // -------------------------------------------------------------- shaders --
  const VERT = `#version 300 es
in vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`

  const FRAG = `#version 300 es
precision highp float;
precision highp int;
out vec4 fragColor;

uniform vec2 uRes;
uniform float uTime;
uniform vec3 uCamPos;
uniform mat3 uCamMat;
uniform float uFocal;
uniform float uTransparent;

uniform mat4 uCharInv;
uniform float uCharScale;
uniform vec4 uCharBound;
uniform vec4 uLegs;
uniform vec2 uArms;
uniform vec4 uEye;
uniform float uStars;

uniform vec3 uRope[13];
uniform float uRopeR;
uniform vec4 uRopeBound;
uniform vec4 uHandles[4];

uniform vec2 uSwing;
uniform vec2 uTramp;
uniform vec4 uBall;
uniform mat3 uBallRot;
uniform vec4 uFly;
uniform mat3 uFlyRot;
uniform float uFlap;
uniform vec4 uFlowers[6];
uniform float uFlowersOn;
uniform float uBlush;
uniform vec3 uSunDir;
uniform vec3 uShadowDir;
uniform vec4 uShadowFocus;
uniform float uSpace;
uniform float uJet;
uniform vec4 uBubble;
uniform float uEdgeFade;

#define MAT_CLAWD 1.0
#define MAT_EYE 2.0
#define MAT_STAR 3.0
#define MAT_ROPE 4.0
#define MAT_WOOD 5.0
#define MAT_FRAME 6.0
#define MAT_CHAIN 7.0
#define MAT_SEAT 8.0
#define MAT_MAT 9.0
#define MAT_PAD 10.0
#define MAT_LEGS 11.0
#define MAT_BALL 12.0
#define MAT_WING 13.0
#define MAT_BUG 14.0
#define MAT_STEM 15.0
#define MAT_PETAL 16.0
#define MAT_POLLEN 17.0
#define MAT_SUIT 18.0
#define MAT_NOZZLE 19.0
#define MAT_LIGHT 20.0
#define MAT_FLAME 21.0

#define SUN_DIR uSunDir
const vec3 SUN_COL = vec3(1.0, 0.88, 0.72) * 2.5;
const vec4 LEG_X = vec4(-0.36, -0.12, 0.12, 0.36);

// ---- noise ----
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y);
}
float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++){ s += a*noise(p); p = p*2.03 + vec2(1.7, 9.2); a *= 0.5; } return s; }

// ---- distance functions ----
float sdRoundBox(vec3 p, vec3 b, float r){ vec3 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r; }
float sdCapsule(vec3 p, vec3 a, vec3 b, float r){ vec3 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba)/dot(ba, ba), 0.0, 1.0); return length(pa - ba*h) - r; }
float sdTorus(vec3 p, vec2 t){ vec2 q = vec2(length(p.xz) - t.x, p.y); return length(q) - t.y; }
float smin(float a, float b, float k){ float h = max(k - abs(a - b), 0.0)/k; return min(a, b) - h*h*k*0.25; }
vec3 rotX(vec3 p, float a){ float c = cos(a), s = sin(a); return vec3(p.x, c*p.y - s*p.z, s*p.y + c*p.z); }
vec3 rotZ(vec3 p, float a){ float c = cos(a), s = sin(a); return vec3(c*p.x - s*p.y, s*p.x + c*p.y, p.z); }
vec2 opU(vec2 a, vec2 b){ return a.x < b.x ? a : b; }
float sdStar5(vec2 p, float r, float rf){
  const vec2 k1 = vec2(0.809016994375, -0.587785252292);
  const vec2 k2 = vec2(-k1.x, k1.y);
  p.x = abs(p.x);
  p -= 2.0*max(dot(k1, p), 0.0)*k1;
  p -= 2.0*max(dot(k2, p), 0.0)*k2;
  p.x = abs(p.x);
  p.y -= r;
  vec2 ba = rf*vec2(-k1.y, k1.x) - vec2(0, 1);
  float h = clamp(dot(p, ba)/dot(ba, ba), 0.0, r);
  return length(p - ba*h) * sign(p.y*ba.x - p.x*ba.y);
}

// ---- Clawd, in local space ----
vec2 mapClawd(vec3 p){
  float d = sdRoundBox(p - vec3(0.0, 0.51, 0.0), vec3(0.5, 0.29, 0.30), 0.11);
  for (int i = 0; i < 4; i++){
    float a = uLegs[i];
    vec3 q = rotX(p - vec3(LEG_X[i], 0.27, 0.2*clamp(a/1.4, -1.0, 1.0)), a);
    d = smin(d, sdRoundBox(q - vec3(0.0, -0.13, 0.0), vec3(0.068, 0.135, 0.082), 0.05), 0.035);
  }
  vec3 qr = rotZ(p - vec3(0.45, 0.5, 0.0), -uArms.y);
  d = smin(d, sdRoundBox(qr - vec3(0.12, 0.0, 0.0), vec3(0.13, 0.078, 0.09), 0.05), 0.03);
  vec3 ql = rotZ(p - vec3(-0.45, 0.5, 0.0), uArms.x);
  d = smin(d, sdRoundBox(ql - vec3(-0.12, 0.0, 0.0), vec3(0.13, 0.078, 0.09), 0.05), 0.03);
  vec2 res = vec2(d, MAT_CLAWD);

  int mode = int(uEye.x + 0.5);
  float de = 1e3;
  for (int s = 0; s < 2; s++){
    float sx = s == 0 ? -1.0 : 1.0;
    vec3 q = p - vec3(sx*0.19 + uEye.z*0.035, 0.575 + uEye.w*0.03, 0.30);
    if (mode == 0){
      float hy = 0.088*(1.0 - 0.92*uEye.y);
      de = min(de, sdRoundBox(q, vec3(0.046, hy, 0.022), min(0.03, hy)));
    } else if (mode == 1){
      de = min(de, min(sdCapsule(q, vec3(-0.055, -0.03, 0.0), vec3(0.0, 0.035, 0.0), 0.021),
                       sdCapsule(q, vec3(0.0, 0.035, 0.0), vec3(0.055, -0.03, 0.0), 0.021)));
    } else if (mode == 2){
      de = min(de, min(sdCapsule(q, vec3(-0.05, -0.05, 0.0), vec3(0.05, 0.05, 0.0), 0.018),
                       sdCapsule(q, vec3(-0.05, 0.05, 0.0), vec3(0.05, -0.05, 0.0), 0.018)));
    } else {
      de = min(de, sdCapsule(q, vec3(-0.05, 0.0, 0.0), vec3(0.05, 0.0, 0.0), 0.018));
    }
  }
  res = opU(res, vec2(de, MAT_EYE));

  if (uStars > 0.001){
    for (int k = 0; k < 3; k++){
      float a = uTime*3.5 + float(k)*2.094;
      vec3 c = vec3(cos(a)*0.34, 0.98 + 0.05*sin(a*2.0 + float(k)), sin(a)*0.34);
      vec3 q = p - c;
      float sa = uTime*4.0 + float(k);
      q.xz = mat2(cos(sa), -sin(sa), sin(sa), cos(sa)) * q.xz;
      float d2 = sdStar5(q.xy, 0.075*uStars, 0.45);
      vec2 w = vec2(d2, abs(q.z) - 0.018*uStars);
      float ds = min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - 0.008;
      res = opU(res, vec2(ds, MAT_STAR));
    }
  }

  if (uSpace > 0.5){
    // jetpack on the back of the bubble helmet, two nozzles and an antenna
    vec3 pn = vec3(abs(p.x), p.y, p.z);
    res = opU(res, vec2(sdRoundBox(p - vec3(0.0, 0.5, -0.9), vec3(0.34, 0.36, 0.12), 0.07), MAT_SUIT));
    res = opU(res, vec2(sdCapsule(pn, vec3(0.17, 0.16, -0.92), vec3(0.19, 0.03, -0.95), 0.055), MAT_NOZZLE));
    res = opU(res, vec2(sdCapsule(p, vec3(0.22, 0.85, -0.96), vec3(0.27, 1.3, -1.0), 0.012), MAT_NOZZLE));
    res = opU(res, vec2(length(p - vec3(0.27, 1.32, -1.0)) - 0.04, MAT_LIGHT));
    if (uJet > 0.01){
      float L = 0.34*uJet*(0.85 + 0.15*sin(uTime*47.0));
      vec3 q = pn - vec3(0.19, 0.0, -0.95);
      float h = clamp(-q.y/L, 0.0, 1.0);
      float flame = max(length(q.xz) - mix(0.05, 0.004, h), max(q.y, -q.y - L))*0.8;
      res = opU(res, vec2(flame, MAT_FLAME));
    }
  }
  return res;
}

// ---- butterfly, in its own space: body along +z, wings out along x ----
float sdEllipse2(vec2 p, vec2 r){ return (length(p/r) - 1.0)*min(r.x, r.y); }
float wing2D(vec2 w){
  vec2 a = mat2(0.94, -0.34, 0.34, 0.94)*(w - vec2(0.075, 0.028));
  vec2 b = mat2(0.94, 0.34, -0.34, 0.94)*(w - vec2(0.055, -0.035));
  return smin(sdEllipse2(a, vec2(0.08, 0.048)), sdEllipse2(b, vec2(0.055, 0.042)), 0.015);
}
vec3 wingSpace(vec3 p){
  vec3 q = uFlyRot*(p - uFly.xyz)/uFly.w;
  return rotZ(vec3(abs(q.x), q.y, q.z), -uFlap);
}
vec2 mapFly(vec3 p){
  vec3 q = uFlyRot*(p - uFly.xyz)/uFly.w;
  float b = length(q) - 0.2;
  if (b > 0.1) return vec2(b*uFly.w, 0.0);
  float body = sdCapsule(q, vec3(0.0, 0.0, -0.05), vec3(0.0, 0.0, 0.035), 0.011);
  body = min(body, length(q - vec3(0.0, 0.004, 0.05)) - 0.012);
  vec3 qa = vec3(abs(q.x), q.y, q.z);
  body = min(body, sdCapsule(qa, vec3(0.004, 0.01, 0.055), vec3(0.025, 0.04, 0.095), 0.0025));
  vec2 res = vec2(body, MAT_BUG);
  vec3 w = rotZ(qa, -uFlap);
  vec2 e = vec2(wing2D(w.xz), abs(w.y) - 0.0025);
  float wing = min(max(e.x, e.y), 0.0) + length(max(e, 0.0));
  res = opU(res, vec2(wing, MAT_WING));
  res.x *= uFly.w;
  return res;
}

// ---- meadow flowers ----
vec2 mapFlowers(vec3 p){
  vec2 res = vec2(1e3, 0.0);
  for (int i = 0; i < 6; i++){
    vec4 f = uFlowers[i];
    if (f.w < 0.001) continue;
    vec3 q = (p - vec3(f.x, 0.0, f.y))/f.w;
    float h = f.z;
    float b = length(q - vec3(0.0, h*0.5, 0.0)) - (h*0.5 + 0.1);
    if (b > 0.1){ res.x = min(res.x, b*f.w); continue; }
    float k = q.y/h;
    q.x -= (i == 0 ? 0.0 : 0.02*sin(uTime*1.7 + float(i)*1.3))*k*k;
    float stem = sdCapsule(q, vec3(0.0), vec3(0.0, h, 0.0), 0.008);
    vec3 ql = q - vec3(0.0, h*0.32, 0.0);
    float leaf = max(sdEllipse2(vec2(ql.x - 0.035, ql.y - ql.x*0.5), vec2(0.04, 0.012)), abs(ql.z) - 0.003);
    res = opU(res, vec2(min(stem, leaf)*f.w, MAT_STEM));
    vec3 qh = q - vec3(0.0, h, 0.0);
    float r = length(qh.xz);
    float lobes = 0.085*(0.55 + 0.45*pow(abs(cos(atan(qh.z, qh.x)*2.5)), 0.7));
    float petal = max((r - lobes)*0.7, abs(qh.y - r*r*2.0) - 0.0045);
    res = opU(res, vec2(petal*f.w, MAT_PETAL));
    res = opU(res, vec2((length(qh - vec3(0.0, 0.01, 0.0)) - 0.022)*f.w, MAT_POLLEN));
  }
  return res;
}

vec2 mapChar(vec3 p){
  float b = length(p - uCharBound.xyz) - uCharBound.w;
  if (b > 0.25) return vec2(b, 0.0);
  vec2 r = mapClawd((uCharInv * vec4(p, 1.0)).xyz);
  r.x *= uCharScale;
  return r;
}

vec2 mapRope(vec3 p){
  float b = length(p - uRopeBound.xyz) - uRopeBound.w;
  if (b > 0.2) return vec2(b, 0.0);
  float d = 1e3;
  for (int i = 0; i < 12; i++) d = min(d, sdCapsule(p, uRope[i], uRope[i+1], uRopeR));
  vec2 res = vec2(d, MAT_ROPE);
  float hr = uRopeR*2.4;
  float dh = min(sdCapsule(p, uHandles[0].xyz, uHandles[1].xyz, hr), sdCapsule(p, uHandles[2].xyz, uHandles[3].xyz, hr));
  return opU(res, vec2(dh, MAT_WOOD));
}

vec2 mapSwing(vec3 p){
  float s = uSwing.x;
  vec3 q = p / s;
  float b = length(q - vec3(0.0, 0.95, 0.0)) - 1.95;
  if (b > 0.3) return vec2(b*s, 0.0);
  float df = sdCapsule(q, vec3(-1.22, 1.82, 0.0), vec3(1.22, 1.82, 0.0), 0.055);
  vec3 qs = vec3(abs(q.x), q.y, abs(q.z));
  df = min(df, sdCapsule(qs, vec3(1.12, 1.82, 0.0), vec3(1.34, 0.0, 0.72), 0.045));
  vec2 res = vec2(df, MAT_FRAME);
  vec3 w = rotX(q - vec3(0.0, 1.82, 0.0), -uSwing.y);
  vec3 wc = vec3(abs(w.x) - 0.64, w.y, w.z);
  float link = 0.011 + 0.006*abs(sin(w.y*70.0));
  res = opU(res, vec2(sdCapsule(wc, vec3(0.0), vec3(0.0, -1.40, 0.0), link)*0.8, MAT_CHAIN));
  res = opU(res, vec2(sdRoundBox(w - vec3(0.0, -1.42, 0.0), vec3(0.72, 0.03, 0.21), 0.025), MAT_SEAT));
  res.x *= s;
  return res;
}

vec2 mapTramp(vec3 p){
  float s = uTramp.x;
  vec3 q = p / s;
  float b = length(q - vec3(0.0, 0.25, 0.0)) - 1.25;
  if (b > 0.3) return vec2(b*s, 0.0);
  float r = length(q.xz);
  vec2 res = vec2(sdTorus(q - vec3(0.0, 0.45, 0.0), vec2(0.93, 0.07)), MAT_PAD);
  float dl = 1e3;
  for (int k = 0; k < 6; k++){
    float a = float(k)*1.0472 + 0.52;
    vec2 dir = vec2(cos(a), sin(a));
    dl = min(dl, sdCapsule(q, vec3(dir.x*0.9, 0.42, dir.y*0.9), vec3(dir.x*1.02, 0.0, dir.y*1.02), 0.026));
  }
  res = opU(res, vec2(dl, MAT_LEGS));
  float sag = uTramp.y * max(0.0, 1.0 - r*r/(0.86*0.86));
  float dm = max(abs(q.y - (0.445 - sag)) - 0.01, r - 0.87)*0.6;
  res = opU(res, vec2(dm, MAT_MAT));
  res.x *= s;
  return res;
}

vec2 map(vec3 p){
  vec2 res = mapChar(p);
  if (uRopeR > 1e-4) res = opU(res, mapRope(p));
  if (uSwing.x > 1e-3) res = opU(res, mapSwing(p));
  if (uTramp.x > 1e-3) res = opU(res, mapTramp(p));
  if (uBall.w > 1e-3) res = opU(res, vec2(length(p - uBall.xyz) - uBall.w, MAT_BALL));
  if (uFly.w > 1e-3) res = opU(res, mapFly(p));
  if (uFlowersOn > 0.5) res = opU(res, mapFlowers(p));
  return res;
}

vec3 calcNormal(vec3 p){
  const vec2 e = vec2(1.0, -1.0)*0.0006;
  return normalize(e.xyy*map(p + e.xyy).x + e.yyx*map(p + e.yyx).x + e.yxy*map(p + e.yxy).x + e.xxx*map(p + e.xxx).x);
}

float softShadow(vec3 ro, vec3 rd, float tmin, float tmax, float k){
  float res = 1.0, t = tmin;
  for (int i = 0; i < 72; i++){
    float h = map(ro + rd*t).x;
    res = min(res, k*h/t);
    t += clamp(h, 0.006, 0.2);
    if (res < 0.002 || t > tmax) break;
  }
  res = clamp(res, 0.0, 1.0);
  return res*res*(3.0 - 2.0*res);
}

float calcAO(vec3 p, vec3 n, float spread){
  float occ = 0.0, sca = 1.0;
  for (int i = 0; i < 5; i++){
    float h = 0.012 + spread*float(i)/4.0;
    vec3 q = p + n*h;
    float d = min(map(q).x, q.y);
    occ += (h - d)*sca;
    sca *= 0.82;
  }
  return clamp(1.0 - 2.4*occ/max(spread*2.5, 0.4), 0.0, 1.0);
}

vec3 sky(vec3 rd, float withSun){
  float h = clamp(rd.y, 0.0, 1.0);
  vec3 col = mix(vec3(0.50, 0.68, 0.92), vec3(0.10, 0.28, 0.72), pow(h, 0.38));
  col = mix(col, vec3(0.72, 0.81, 0.93), exp(-max(rd.y, 0.0)*30.0)*0.5);
  float sd = max(dot(rd, SUN_DIR), 0.0);
  col += vec3(1.0, 0.78, 0.52)*pow(sd, 6.0)*0.16;
  col += withSun*vec3(1.0, 0.9, 0.7)*(pow(sd, 900.0)*30.0 + pow(sd, 90.0)*0.5);
  if (rd.y > 0.0){
    vec2 uv = rd.xz/(rd.y + 0.12);
    float c = smoothstep(0.5, 0.86, fbm(uv*1.1 + vec2(uTime*0.012, 0.0)));
    col = mix(col, vec3(1.06, 1.03, 1.0)*(0.82 + 0.2*sd), c*0.85*smoothstep(0.0, 0.2, rd.y));
  }
  return col;
}

vec3 groundAlbedo(vec2 xz){
  float n = fbm(xz*0.9), n2 = noise(xz*18.0), n3 = noise(xz*70.0);
  vec3 grass = mix(vec3(0.05, 0.12, 0.022), vec3(0.12, 0.21, 0.04), n)*(0.78 + 0.38*n2)*(0.88 + 0.24*n3);
  float r = length(xz*vec2(1.0, 1.25));
  float dirt = smoothstep(1.3, 0.62, r + (fbm(xz*3.0) - 0.5)*0.7);
  vec3 soil = mix(vec3(0.19, 0.12, 0.07), vec3(0.29, 0.20, 0.12), n2)*(0.85 + 0.3*n3);
  return mix(grass, soil, dirt*0.85);
}

struct Mat { vec3 alb; float rough; float f0; float metal; float sss; float coat; vec3 emit; float trans; };

Mat getMat(float m, vec3 p){
  Mat M = Mat(vec3(0.5), 0.6, 0.04, 0.0, 0.0, 0.0, vec3(0.0), 0.0);
  if (m < 1.5){
    vec3 q = (uCharInv*vec4(p, 1.0)).xyz;
    float g = noise(q.xy*55.0)*0.5 + noise(q.zy*55.0 + 3.0)*0.5;
    M.alb = vec3(0.72, 0.20, 0.10)*(0.96 + 0.07*g);
    vec2 cheek = vec2(abs(q.x) - 0.31, q.y - 0.455);
    float blush = uBlush*smoothstep(0.075, 0.025, length(cheek))*smoothstep(0.22, 0.28, q.z);
    M.alb = mix(M.alb, vec3(0.80, 0.12, 0.16), blush*0.75);
    M.rough = 0.5; M.sss = 1.0; M.coat = 0.35;
  } else if (m < 2.5){
    M.alb = vec3(0.006); M.rough = 0.1; M.f0 = 0.05; M.coat = 1.0;
  } else if (m < 3.5){
    M.alb = vec3(1.0, 0.72, 0.12); M.rough = 0.3; M.emit = vec3(1.2, 0.85, 0.2)*0.5;
  } else if (m < 4.5){
    float braid = 0.5 + 0.5*sin(dot(p, vec3(90.0, 90.0, 90.0)));
    M.alb = vec3(0.09, 0.06, 0.5)*(0.75 + 0.45*braid); M.rough = 0.7;
  } else if (m < 5.5){
    M.alb = mix(vec3(0.30, 0.15, 0.06), vec3(0.50, 0.29, 0.13), noise(p.xy*vec2(60.0, 6.0))); M.rough = 0.45; M.coat = 0.3;
  } else if (m < 6.5){
    M.alb = vec3(0.02, 0.21, 0.25); M.rough = 0.3; M.f0 = 0.05; M.coat = 0.6;
  } else if (m < 7.5){
    M.alb = vec3(0.62, 0.62, 0.64); M.rough = 0.25; M.metal = 1.0;
  } else if (m < 8.5){
    M.alb = vec3(0.50, 0.05, 0.03); M.rough = 0.55; M.coat = 0.2;
  } else if (m < 9.5){
    float weave = 0.5 + 0.5*sin(p.x*260.0)*sin(p.z*260.0);
    M.alb = vec3(0.012, 0.012, 0.016)*(0.8 + 0.4*weave); M.rough = 0.65;
  } else if (m < 10.5){
    M.alb = vec3(0.02, 0.10, 0.48); M.rough = 0.4; M.coat = 0.5;
  } else if (m < 11.5){
    M.alb = vec3(0.35, 0.36, 0.38); M.rough = 0.3; M.metal = 1.0;
  } else if (m < 12.5){
    vec3 q = uBallRot*(p - uBall.xyz)/uBall.w;
    float a = atan(q.z, q.x);
    float idx = floor((a + 3.14159)/6.28318*6.0);
    vec3 c = vec3(0.92);
    if (idx < 0.5) c = vec3(0.80, 0.03, 0.02);
    else if (idx < 1.5) c = vec3(0.92);
    else if (idx < 2.5) c = vec3(0.02, 0.16, 0.75);
    else if (idx < 3.5) c = vec3(0.95, 0.62, 0.02);
    else if (idx < 4.5) c = vec3(0.92);
    else c = vec3(0.04, 0.50, 0.12);
    if (abs(q.y) > 0.9) c = vec3(0.92);
    M.alb = c; M.rough = 0.18; M.coat = 0.9;
  } else if (m < 13.5){
    vec3 w = wingSpace(p);
    float d2 = wing2D(w.xz);
    float rim = smoothstep(-0.013, -0.007, d2);
    float r = length(w.xz);
    vec3 blue = mix(vec3(0.0, 0.04, 0.32), vec3(0.04, 0.5, 1.0), smoothstep(0.02, 0.12, r));
    float veins = smoothstep(0.75, 1.0, abs(sin(atan(w.z, w.x)*7.0)))*smoothstep(0.03, 0.09, r)*0.35;
    blue *= 1.0 - veins;
    float spots = smoothstep(0.011, 0.006, length(w.xz - vec2(0.138, 0.06))) + smoothstep(0.008, 0.004, length(w.xz - vec2(0.118, 0.082)));
    M.alb = mix(mix(blue, vec3(0.01), rim), vec3(0.95), clamp(spots, 0.0, 1.0)*rim);
    M.rough = 0.3; M.coat = 0.7; M.trans = 0.9*(1.0 - rim);
    M.emit = blue*0.22*(1.0 - rim);
  } else if (m < 14.5){
    M.alb = vec3(0.015, 0.013, 0.012); M.rough = 0.55;
  } else if (m < 15.5){
    M.alb = vec3(0.06, 0.2, 0.035); M.rough = 0.6; M.trans = 0.4;
  } else if (m < 16.5){
    float best = 1e3; int bi = 0;
    for (int i = 0; i < 6; i++){ float dd = length(p.xz - uFlowers[i].xy); if (dd < best){ best = dd; bi = i; } }
    vec3 cols[6] = vec3[6](vec3(0.9, 0.9, 0.86), vec3(0.85, 0.2, 0.42), vec3(0.42, 0.26, 0.82), vec3(0.95, 0.7, 0.08), vec3(0.9, 0.9, 0.86), vec3(0.85, 0.2, 0.42));
    M.alb = cols[bi]*mix(0.75, 1.0, smoothstep(0.02, 0.06, best));
    M.rough = 0.55; M.trans = 0.5;
  } else if (m < 17.5){
    M.alb = vec3(0.85, 0.52, 0.04)*(0.8 + 0.4*noise(p.xz*300.0)); M.rough = 0.85;
  } else if (m < 18.5){
    M.alb = vec3(0.80, 0.81, 0.84); M.rough = 0.35; M.coat = 0.5;
  } else if (m < 19.5){
    M.alb = vec3(0.30, 0.31, 0.34); M.rough = 0.3; M.metal = 1.0;
  } else if (m < 20.5){
    M.alb = vec3(0.8, 0.05, 0.04); M.rough = 0.2; M.coat = 1.0;
    M.emit = vec3(3.0, 0.25, 0.1)*step(0.0, sin(uTime*5.0));
  } else {
    vec3 q = (uCharInv*vec4(p, 1.0)).xyz;
    float h = clamp(-q.y/0.34, 0.0, 1.0);
    M.alb = vec3(0.0);
    M.emit = mix(vec3(2.6, 2.6, 3.0), vec3(2.6, 0.8, 0.15), smoothstep(0.0, 0.6, h))*(1.0 - 0.5*h)*1.6;
  }
  return M;
}

float ggx(float ndh, float rough){ float a = rough*rough; float a2 = a*a; float d = ndh*ndh*(a2 - 1.0) + 1.0; return a2/(3.14159*d*d); }

// Space: a dark studio with a key softbox, a cool rim, and earth-glow from below.
vec3 envSpace(vec3 r){
  vec3 c = mix(vec3(0.01, 0.015, 0.04), vec3(0.03, 0.05, 0.12), clamp(r.y*0.5 + 0.5, 0.0, 1.0));
  c += vec3(0.10, 0.25, 0.55)*pow(clamp(-r.y, 0.0, 1.0), 2.0)*0.8;
  c += vec3(1.0, 0.97, 0.92)*smoothstep(0.93, 0.985, max(dot(r, SUN_DIR), 0.0))*2.5;
  c += vec3(0.4, 0.7, 1.0)*smoothstep(0.9, 0.98, max(dot(r, normalize(vec3(0.8, 0.2, -0.6))), 0.0))*1.5;
  return c;
}

vec3 shade(vec3 p, vec3 n, vec3 rd, Mat M, float sh, float ao){
  bool space = uSpace > 0.5;
  vec3 skyAmb = space ? vec3(0.10, 0.12, 0.24) : vec3(0.36, 0.52, 0.90)*0.62;
  vec3 bounce = space ? vec3(0.12, 0.25, 0.5)*0.7 : vec3(0.28, 0.27, 0.15)*0.45;
  float ndl = dot(n, SUN_DIR);
  float dif = clamp(ndl, 0.0, 1.0)*sh;
  float ndv = clamp(dot(n, -rd), 0.0, 1.0);
  vec3 diffAlb = M.alb*(1.0 - M.metal);
  vec3 col = diffAlb*(SUN_COL*dif + skyAmb*(0.55 + 0.45*n.y)*ao + bounce*clamp(0.5 - 0.5*n.y, 0.0, 1.0)*ao);
  if (M.sss > 0.0){
    float wrap = clamp((ndl + 0.55)/1.55, 0.0, 1.0);
    float scatter = max(wrap - clamp(ndl, 0.0, 1.0), 0.0)*mix(0.4, 1.0, sh);
    col += M.sss*M.alb*vec3(1.0, 0.32, 0.16)*SUN_COL*scatter*0.38;
    col += M.sss*vec3(0.9, 0.25, 0.08)*pow(1.0 - ndv, 3.0)*ao*0.18;
  }
  vec3 h = normalize(SUN_DIR - rd);
  float ndh = clamp(dot(n, h), 0.0, 1.0);
  vec3 F0 = mix(vec3(M.f0), M.alb, M.metal);
  vec3 F = F0 + (1.0 - F0)*pow(1.0 - clamp(dot(h, -rd), 0.0, 1.0), 5.0);
  col += SUN_COL*ggx(ndh, max(M.rough, 0.06))*F*0.25*dif;
  if (M.coat > 0.0) col += SUN_COL*ggx(ndh, 0.14)*0.04*M.coat*dif;
  vec3 r = reflect(rd, n);
  vec3 env = space ? envSpace(r) : (r.y > 0.0 ? sky(r, 0.0) : vec3(0.06, 0.08, 0.03));
  if (space) col += diffAlb*vec3(0.4, 0.7, 1.0)*1.6*clamp(dot(n, normalize(vec3(0.8, 0.2, -0.6))), 0.0, 1.0)*ao;
  vec3 Fv = F0 + (1.0 - F0)*pow(1.0 - ndv, 5.0);
  float envOcc = ao*mix(0.35, 1.0, clamp(r.y*3.0 + 0.5, 0.0, 1.0)*sh*0.5 + 0.5);
  col += env*Fv*envOcc*(1.0 - 0.75*M.rough)*(1.0 + M.coat);
  col += M.alb*SUN_COL*clamp(-ndl, 0.0, 1.0)*M.trans*0.35*mix(0.3, 1.0, sh);
  col += M.emit;
  return col;
}

vec3 aces(vec3 x){ return clamp((x*(2.51*x + 0.03))/(x*(2.43*x + 0.59) + 0.14), 0.0, 1.0); }

// The glass bubble helmet (space): reflections and a rim, over whatever is behind.
vec4 glass(vec3 ro, vec3 rd, float tHit){
  vec3 oc = ro - uBubble.xyz;
  float b = dot(oc, rd), c = dot(oc, oc) - uBubble.w*uBubble.w, h = b*b - c;
  if (h < 0.0) return vec4(0.0);
  h = sqrt(h);
  float t0 = -b - h, t1 = -b + h;
  if (t0 < 0.0 || t0 > tHit) return vec4(0.0);
  vec3 n = normalize(ro + rd*t0 - uBubble.xyz);
  float ndv = clamp(dot(n, -rd), 0.0, 1.0);
  float F = 0.04 + 0.96*pow(1.0 - ndv, 5.0);
  vec3 r = reflect(rd, n);
  float spec = pow(max(dot(r, SUN_DIR), 0.0), 400.0)*14.0 + pow(max(dot(r, SUN_DIR), 0.0), 40.0)*0.35;
  vec3 col = envSpace(r)*F + vec3(spec);
  vec3 n1 = normalize(uBubble.xyz - (ro + rd*t1));
  float back = pow(max(dot(reflect(rd, n1), SUN_DIR), 0.0), 300.0)*3.0*(t1 < tHit ? 1.0 : 0.0);
  col += vec3(back);
  float a = clamp(F*0.85 + 0.045 + (spec + back)*0.4, 0.0, 1.0);
  return vec4(col/max(a, 1e-3), a);
}

void main(){
  vec2 uv = (gl_FragCoord.xy*2.0 - uRes)/min(uRes.x, uRes.y);
  vec3 ro = uCamPos;
  vec3 rd = normalize(uCamMat*vec3(uv, uFocal));
  bool space = uSpace > 0.5;
  bool transparent = uTransparent > 0.5;
  float tGround = (!space && rd.y < 0.0) ? -ro.y/rd.y : 1e5;

  float t = 0.05, m = -1.0;
  float tmax = min(tGround, 40.0);
  for (int i = 0; i < 180; i++){
    vec2 h = map(ro + rd*t);
    if (abs(h.x) < 0.0005*t){ m = h.y; break; }
    t += h.x;
    if (t > tmax) break;
  }

  vec3 col;
  float alpha = 1.0;
  if (m > 0.5 && t < tGround){
    vec3 p = ro + rd*t;
    vec3 n = calcNormal(p);
    Mat M = getMat(m, p);
    float sh = softShadow(p + n*0.002, SUN_DIR, 0.01, 6.0, 9.0);
    float ao = calcAO(p, n, 0.16);
    col = shade(p, n, rd, M, sh, ao);
    if (!transparent) col = mix(col, vec3(0.66, 0.77, 0.92), 1.0 - exp(-0.0006*t*t));
  } else if (tGround < 1e4){
    vec3 p = ro + rd*tGround;
    if (transparent){
      // only a soft contact shadow, and only near Clawd and his props
      float near = min(length(p.xz - uShadowFocus.xy) - 1.2, length(p.xz) - uShadowFocus.z);
      alpha = 0.0;
      if (near < 0.0){
        float sh = softShadow(p + vec3(0.0, 0.001, 0.0), uShadowDir, 0.005, 5.0, 7.0);
        float ao = calcAO(p, vec3(0.0, 1.0, 0.0), 0.45);
        float occ = 1.0 - min(sh, mix(1.0, ao, 0.85));
        alpha = clamp(occ*0.6, 0.0, 0.6)*smoothstep(0.0, 0.35, -near);
      }
      col = vec3(0.0);
    } else {
      float r = length(p.xz);
      float sh = r < 5.5 ? softShadow(p + vec3(0.0, 0.001, 0.0), SUN_DIR, 0.005, 6.0, 12.0) : 1.0;
      float ao = r < 4.5 ? calcAO(p, vec3(0.0, 1.0, 0.0), 0.45) : 1.0;
      vec2 e = vec2(0.015, 0.0);
      float h0 = noise(p.xz*24.0), hx = noise((p.xz + e.xy)*24.0), hz = noise((p.xz + e.yx)*24.0);
      vec3 n = normalize(vec3(-(hx - h0)*0.6, 1.0, -(hz - h0)*0.6));
      Mat M = Mat(groundAlbedo(p.xz), 0.85, 0.03, 0.0, 0.0, 0.0, vec3(0.0), 0.0);
      col = shade(p, n, rd, M, sh, ao);
      col = mix(col, vec3(0.66, 0.77, 0.92), 1.0 - exp(-0.0007*tGround*tGround));
    }
  } else {
    col = transparent ? vec3(0.0) : sky(rd, 1.0);
    alpha = transparent ? 0.0 : 1.0;
  }

  if (!(transparent && m < 0.5)){
    col = aces(col*0.8);
    col = pow(col, vec3(1.0/2.2));
  }
  if (!transparent){
    vec2 q = gl_FragCoord.xy/uRes;
    col *= 0.78 + 0.22*pow(16.0*q.x*q.y*(1.0 - q.x)*(1.0 - q.y), 0.18);
  }
  vec4 outc = vec4(col*alpha, alpha);
  if (space){
    vec4 g = glass(ro, rd, m > 0.5 ? t : 1e5);
    vec3 gc = pow(aces(g.rgb*0.8), vec3(1.0/2.2));
    outc = vec4(gc*g.a, g.a) + outc*(1.0 - g.a);
  }
  if (uEdgeFade > 0.5){
    // fade toward the canvas edges so nothing is cut off with a hard line
    // (1: sides and top, the ground line sits at the bottom; 2: all sides)
    vec2 q = gl_FragCoord.xy/uRes;
    float e = min(min(q.x, 1.0 - q.x), 1.0 - q.y);
    if (uEdgeFade > 1.5) e = min(e, q.y);
    outc *= smoothstep(0.0, 0.07, e);
  }
  outc.rgb += (hash12(gl_FragCoord.xy + fract(uTime)*91.0) - 0.5)/255.0*outc.a;
  fragColor = outc;
}`

  // ---------------------------------------------------------------- stage --
  const UNIFORMS = [
    'uRes', 'uTime', 'uCamPos', 'uCamMat', 'uFocal', 'uTransparent',
    'uCharInv', 'uCharScale', 'uCharBound', 'uLegs', 'uArms', 'uEye', 'uStars',
    'uRope[0]', 'uRopeR', 'uRopeBound', 'uHandles[0]', 'uSwing', 'uTramp', 'uBall', 'uBallRot',
    'uFly', 'uFlyRot', 'uFlap', 'uFlowers[0]', 'uFlowersOn', 'uBlush',
    'uSunDir', 'uShadowDir', 'uShadowFocus', 'uSpace', 'uJet', 'uBubble', 'uEdgeFade',
  ]
  const SUN = norm3([-0.5, 0.74, 0.45])
  const PET_SHADOW = norm3([0.12, 1, 0.08])

  class Stage {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object} [opts]
     *   mode         'scene' (sky and meadow, default), 'ground' (desktop pet on the taskbar)
     *                or 'space' (desktop pet, astronaut, floating); pets are transparent
     *   transparent  alpha background with a soft contact shadow (scene mode)
     *   activity     start with one activity
     *   activities   the activities to pick from (ground: ACTIVITIES, space: SPACE_ACTIVITIES)
     *   interval     seconds between activity changes (0: each plays to its end)
     *   timeScale    animation speed (1 = real time)
     *   wander       ground pet: stroll to new spots between activities (see setWalkRoom)
     *   fps          frame-rate cap (60 or 30)
     *   auto         move on to another activity when one ends (default true)
     *   interactive  drag to orbit, wheel to zoom (scene mode)
     *   seed         random seed for the choices Clawd makes
     *   maxPixelRatio, minScale  rendering budget (the stage adapts resolution to hold frame rate)
     * Events: 'activity' {name, label}, 'walked' {dx}, 'frame' {offsetX, spacePos}.
     */
    constructor(canvas, opts = {}) {
      this.canvas = canvas
      const pet = opts.mode === 'ground' || opts.mode === 'space'
      this.opts = Object.assign(
        { mode: 'scene', transparent: pet, auto: true, interactive: !pet, maxPixelRatio: 2, minScale: 0.4, timeScale: 1, interval: 0, wander: false, fps: 60, activities: null },
        opts,
      )
      this.mode = this.opts.mode
      this.listeners = {}
      const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'high-performance' })
      if (!gl) throw new Error('Clawd3D needs WebGL2')
      this.gl = gl
      this.program = this.compile(VERT, FRAG)
      gl.useProgram(this.program)
      const buf = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
      const loc = gl.getAttribLocation(this.program, 'aPos')
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
      this.u = {}
      for (const name of UNIFORMS) this.u[name] = gl.getUniformLocation(this.program, name)

      this.rng = mulberry32(opts.seed != null ? opts.seed : (Math.random() * 2 ** 32) >>> 0)
      this.forced = null
      this.clock = 0
      this.slotT = 0
      this.spring = { s: 0, v: 0 }
      this.prevCom = null
      this.prevVy = 0
      this.rope = new RopeSim()
      this.blink = { next: 2, t: -1 }
      this.view = { yaw: 0, pitch: 0, zoom: 1 }
      this.cam = { target: [0, 0.62, 0], dist: 4.6 }
      this.walkRoom = [0, 0]
      this.scale = 1
      this.frameEma = 1 / 60
      this.adaptTimer = 0
      this.paused = false
      if (this.mode === 'space') {
        this.space = new SpaceDirector(this.rng)
        this.startSpace()
      } else this.startActivity(this.opts.activity || this.pickNext(), false)
      if (this.opts.interactive) this.bindInput()
      this.resizeObserver = new ResizeObserver(() => this.resize())
      this.resizeObserver.observe(canvas)
      this.resize()
      this.raf = requestAnimationFrame(now => this.frame(now))
    }

    on(event, fn) {
      ;(this.listeners[event] = this.listeners[event] || []).push(fn)
      return () => (this.listeners[event] = this.listeners[event].filter(f => f !== fn))
    }
    emit(event, data) {
      for (const fn of this.listeners[event] || []) fn(data)
    }

    compile(vs, fs) {
      const gl = this.gl
      const make = (type, src) => {
        const s = gl.createShader(type)
        gl.shaderSource(s, src)
        gl.compileShader(s)
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s))
        return s
      }
      const p = gl.createProgram()
      gl.attachShader(p, make(gl.VERTEX_SHADER, vs))
      gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs))
      gl.linkProgram(p)
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p))
      return p
    }

    // Change options while running (activities, interval, timeScale, wander, fps, ...).
    configure(o) {
      Object.assign(this.opts, o)
      const list = this.opts.activities
      if (list && list.length) {
        if (this.mode === 'space' && !list.includes(this.space.act.name)) this.startSpace()
        if (this.mode !== 'space' && this.isReal(this.current) && !list.includes(this.current.name) && !this.forced) this.startNext(true)
      }
      if ('maxPixelRatio' in o) this.resize()
    }

    setPaused(on) {
      this.paused = !!on
      this.lastNow = null
    }

    /** Ground pet: how far Clawd may stroll left and right of home, in world units. */
    setWalkRoom(left, right) {
      this.walkRoom = [Math.max(0, left), Math.max(0, right)]
    }

    /** Space pet: the screen's size in world units. */
    setSpaceBounds(w, h) {
      if (this.space) this.space.setBounds(w, h)
    }

    isReal(a) {
      return a && a.name !== 'idle' && a.name !== 'walk'
    }

    pickNext() {
      const all = Object.keys(ACTIVITIES)
      const list = (this.opts.activities || all).filter(n => ACTIVITIES[n])
      const pool = list.length ? list : all
      const names = pool.length > 1 ? pool.filter(n => !this.current || n !== this.current.name) : pool
      return names[Math.floor(this.rng() * names.length)]
    }

    pickWalk() {
      const [left, right] = this.walkRoom
      for (let i = 0; i < 8; i++) {
        const dx = lerp(-left, right, this.rng())
        if (Math.abs(dx) >= 1.2) return clamp(dx, -6, 6)
      }
      return 0
    }

    startActivity(name, blend) {
      if (blend && this.last) this.blendFrom = { pose: this.last.pose, props: this.last.props, t: 0 }
      this.current = ACTIVITIES[name](this.rng)
      this.t = 0
      this.emit('activity', { name, label: LABELS[name] })
    }

    startNext(blend) {
      if (this.mode === 'ground' && this.opts.wander && !this.forced && this.current && this.current.name !== 'walk' && this.rng() < 0.45) {
        const dx = this.pickWalk()
        if (dx) {
          if (blend && this.last) this.blendFrom = { pose: this.last.pose, props: this.last.props, t: 0 }
          this.current = makeWalk(dx)
          this.t = 0
          this.emit('activity', { name: 'walk', label: 'Strolling' })
          return
        }
      }
      this.slotT = 0
      this.startActivity(this.forced || (this.opts.auto ? this.pickNext() : this.current.name), blend)
    }

    startIdle(duration) {
      this.current = makeIdle(this.rng, Math.max(1.2, duration))
      this.t = 0
      this.emit('activity', { name: 'idle', label: 'Taking a breather' })
    }

    startSpace() {
      const list = (this.opts.activities || SPACE_ACTIVITIES).filter(n => SPACE_ACTIVITIES.includes(n))
      const pool = list.length ? list : SPACE_ACTIVITIES
      const cur = this.space.act && this.space.act.name
      const names = this.forced && SPACE_ACTIVITIES.includes(this.forced) ? [this.forced] : pool.length > 1 ? pool.filter(n => n !== cur) : pool
      const name = names[Math.floor(this.rng() * names.length)]
      const iv = this.opts.interval
      this.space.start(name, iv ? clamp(iv, 4, 120) : SPACE_DURATION[name])
      this.emit('activity', { name, label: SPACE_LABELS[name] })
    }

    // Which activity runs next: the tempo (interval) cuts long ones short, or
    // pads short ones with a breather; strolls happen in between.
    schedule() {
      const cur = this.current, iv = this.opts.interval
      if (this.t >= cur.duration) {
        const over = Math.min(this.t - cur.duration, 0.1)
        if (cur.name === 'walk') this.emit('walked', { dx: cur.dx })
        if (this.isReal(cur) && iv && this.slotT + 1.2 < iv) this.startIdle(iv - this.slotT)
        else this.startNext(false)
        this.t = over
      } else if (this.isReal(cur) && iv && this.slotT >= iv) this.startNext(true)
    }

    /** Play one activity now (null: back to automatic). */
    play(name) {
      this.forced = name || null
      if (!name) return
      if (this.mode === 'space') this.startSpace()
      else {
        this.slotT = 0
        this.startActivity(name, true)
      }
    }

    setTransparent(on) {
      this.opts.transparent = !!on
    }

    /** Jump to time t of an activity, simulating everything up to it (for stills and tests). */
    seek(name, t, seed = 1) {
      this.rng = mulberry32(seed)
      this.spring = { s: 0, v: 0 }
      this.prevCom = null
      this.rope.on = false
      this.blendFrom = null
      if (this.mode === 'space') {
        const bounds = this.space.bounds
        this.space = new SpaceDirector(this.rng)
        this.space.setBounds(bounds[0], bounds[1])
        this.space.pos = [bounds[0] / 2, bounds[1] / 2]
        this.forced = name
        this.startSpace()
      } else {
        this.slotT = 0
        this.startActivity(name, false)
      }
      const dt = 1 / 60
      let elapsed = 0
      while (elapsed + dt < t) {
        this.step(dt)
        elapsed += dt
      }
      this.step(Math.max(0, t - elapsed))
      this.paused = true
      this.renderedPaused = false
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, this.opts.maxPixelRatio)
      const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr * this.scale))
      const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr * this.scale))
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w
        this.canvas.height = h
      }
    }

    bindInput() {
      const c = this.canvas
      let drag = null
      c.addEventListener('pointerdown', e => {
        drag = { x: e.clientX, y: e.clientY, yaw: this.view.yaw, pitch: this.view.pitch }
        c.setPointerCapture(e.pointerId)
      })
      c.addEventListener('pointermove', e => {
        if (!drag) return
        this.view.yaw = drag.yaw - (e.clientX - drag.x) * 0.006
        this.view.pitch = clamp(drag.pitch + (e.clientY - drag.y) * 0.004, -0.18, 0.9)
      })
      const end = () => (drag = null)
      c.addEventListener('pointerup', end)
      c.addEventListener('pointercancel', end)
      c.addEventListener('wheel', e => {
        e.preventDefault()
        this.view.zoom = clamp(this.view.zoom * Math.exp(e.deltaY * 0.001), 0.55, 1.8)
      }, { passive: false })
    }

    // Advance the world by dt seconds of real time.
    step(dt) {
      const sdt = dt * this.opts.timeScale
      this.clock += sdt
      let pose, props, cam = null
      if (this.mode === 'space') {
        if (this.space.t >= this.space.act.duration) this.startSpace()
        ;({ pose, props } = this.space.step(sdt, this.spring))
      } else {
        this.t += sdt
        this.slotT += sdt
        this.schedule()
        ;({ pose, props, cam } = this.current.sample(this.t))
        if (this.blendFrom) {
          this.blendFrom.t += sdt
          const s = smooth(seg(this.blendFrom.t, 0, 0.45))
          pose = blendPose(this.blendFrom.pose, pose, s)
          props = blendProps(this.blendFrom.props, props, s)
          if (s >= 1) this.blendFrom = null
        }
      }
      this.last = { pose, props }

      // blinking
      this.blink.next -= dt
      if (this.blink.next <= 0) {
        this.blink.t = 0
        this.blink.next = 1.8 + this.rng() * 3.2
      }
      let blink = 0
      if (this.blink.t >= 0) {
        this.blink.t += dt
        blink = Math.sin(Math.PI * seg(this.blink.t, 0, 0.16))
        if (this.blink.t > 0.16) this.blink.t = -1
      }

      // squash and stretch: a spring kicked by sudden upward acceleration (landings)
      const rigid = poseMatrix(pose, 1, 1)
      const com = M4.apply(rigid, COM)
      const vy = this.prevCom && sdt > 0 ? (com[1] - this.prevCom[1]) / sdt : 0
      if (pose.springy && this.prevCom && sdt > 0) {
        const acc = (vy - this.prevVy) / sdt + G
        if (acc > 14) this.spring.v -= (acc - 14) * sdt * 0.9
      }
      this.prevCom = com
      this.prevVy = vy
      const target = pose.springy ? clamp(Math.abs(vy) * 0.022, 0, 0.09) : 0
      const n = Math.max(1, Math.ceil(sdt / (1 / 240)))
      for (let i = 0; i < n; i++) {
        const h = sdt / n
        const a = -320 * (this.spring.s - target) - 13 * this.spring.v
        this.spring.v += a * h
        this.spring.s = clamp(this.spring.s + this.spring.v * h, -0.3, 0.25)
      }
      const sy = 1 + clamp(this.spring.s + pose.squash, -0.35, 0.3)
      const sxz = 1 / Math.sqrt(sy)
      const M = poseMatrix(pose, sxz, sy)
      const inv = M4.invert(M)

      // rope
      let rope = null
      if (props.rope.show > 0.001) {
        const hg = handleGeometry(pose.arms, props.rope.phi, props.rope.wrist)
        const world = Object.fromEntries(Object.entries(hg).map(([k, v]) => [k, M4.apply(M, v)]))
        let pts
        if (props.rope.physics) {
          if (!this.rope.on) this.rope.begin(ropeKinematic(M, hg, props.rope.phi))
          pts = this.rope.step(sdt, world.botL, world.botR, M, inv)
        } else {
          this.rope.on = false
          pts = ropeKinematic(M, hg, props.rope.phi)
        }
        rope = { pts, handles: [world.topL, world.botL, world.topR, world.botR], r: 0.013 * props.rope.show }
      } else this.rope.on = false

      // camera (scene mode)
      if (cam) {
        const k = 1 - Math.exp(-sdt * (cam.fast ? 4 : 2.2))
        const tgt = [cam.x, cam.y, cam.z]
        this.cam.target = this.cam.target.map((v, i) => lerp(v, tgt[i], k))
        this.cam.dist = lerp(this.cam.dist, cam.dist, k)
      }

      this.frameState = {
        pose, props, M, inv, sxz, sy, rope,
        blink: Math.max(blink, pose.squint),
        offsetX: this.mode === 'ground' ? pose.x : 0,
        spacePos: this.space ? this.space.pos.slice() : null,
      }
    }

    frame(nowMs) {
      this.raf = requestAnimationFrame(now => this.frame(now))
      const now = nowMs / 1000
      if (this.lastNow != null && now - this.lastNow < 1 / this.opts.fps - 0.004) return
      const dt = this.lastNow == null ? 1 / 60 : clamp(now - this.lastNow, 0, 1 / 15)
      this.lastNow = now
      if (this.paused) {
        if (this.frameState && this.renderedPaused) return
        if (!this.frameState) this.step(0)
        this.renderedPaused = true
      } else {
        this.renderedPaused = false
        this.step(dt)
        this.adapt(dt)
      }
      this.emit('frame', this.frameState)
      this.render()
    }

    // Hold the frame rate by trading resolution.
    adapt(dt) {
      this.frameEma = lerp(this.frameEma, dt, 0.05)
      this.adaptTimer += dt
      if (this.adaptTimer < 0.75) return
      this.adaptTimer = 0
      const before = this.scale
      const slow = this.opts.fps >= 50 ? 1 / 45 : 1 / 26, fast = this.opts.fps >= 50 ? 1 / 57 : 1 / 31
      if (this.frameEma > slow) this.scale = Math.max(this.opts.minScale, this.scale * 0.85)
      else if (this.frameEma < fast) this.scale = Math.min(1, this.scale * 1.08)
      if (Math.abs(before - this.scale) > 0.01) this.resize()
    }

    render() {
      const gl = this.gl, u = this.u, f = this.frameState
      if (!f) return
      const { pose, props, M, inv, sxz, sy, rope } = f
      gl.viewport(0, 0, this.canvas.width, this.canvas.height)
      gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height)
      gl.uniform1f(u.uTime, this.clock)
      gl.uniform1f(u.uTransparent, this.opts.transparent ? 1 : 0)

      let pos, t, focal
      if (this.mode === 'scene') {
        // a slow drift plus whatever the viewer dragged
        const yaw = 0.38 * Math.sin(this.clock * 0.09) + this.view.yaw
        const el = 0.2 + this.view.pitch
        const d = this.cam.dist * this.view.zoom
        t = this.cam.target
        pos = [t[0] + d * Math.sin(yaw) * Math.cos(el), t[1] + d * Math.sin(el), t[2] + d * Math.cos(yaw) * Math.cos(el)]
        focal = 1 / Math.tan((32 * Math.PI) / 360)
      } else {
        // pets: a fixed, nearly flat camera framing PET_FRAME exactly
        const F = PET_FRAME[this.mode], half = F.h / 2, d = 7
        const el = this.mode === 'ground' ? 0.1 : 0
        t = this.mode === 'ground' ? [f.offsetX, half - F.groundY, 0] : [0, 0.52, 0]
        pos = [t[0], t[1] + d * Math.sin(el), t[2] + d * Math.cos(el)]
        focal = d / half
      }
      const fwd = norm3(sub(t, pos))
      const right = norm3(cross(fwd, [0, 1, 0]))
      const up = cross(right, fwd)
      gl.uniform3fv(u.uCamPos, pos)
      gl.uniformMatrix3fv(u.uCamMat, false, [...right, ...up, ...fwd])
      gl.uniform1f(u.uFocal, focal)

      gl.uniform3fv(u.uSunDir, SUN)
      gl.uniform3fv(u.uShadowDir, this.mode === 'ground' ? PET_SHADOW : SUN)
      gl.uniform1f(u.uSpace, this.mode === 'space' ? 1 : 0)
      gl.uniform1f(u.uJet, pose.jet || 0)
      gl.uniform1f(u.uEdgeFade, this.mode === 'space' ? 2 : this.mode === 'ground' ? 1 : 0)

      gl.uniformMatrix4fv(u.uCharInv, false, inv)
      gl.uniform1f(u.uCharScale, Math.min(sxz, sy))
      const c = M4.apply(M, [0, 0.5, 0])
      gl.uniform4f(u.uCharBound, c[0], c[1], c[2], (this.mode === 'space' ? 1.4 : 0.9) * Math.max(sxz, sy))
      const bc = M4.apply(M, [0, 0.52, 0])
      gl.uniform4f(u.uBubble, bc[0], bc[1], bc[2], 0.8 * Math.max(sxz, sy))
      const propsR = Math.max(props.swing.show > 0.01 ? 1.7 : 0, props.tramp.show > 0.01 ? 1.25 : 0, props.flowers.some(v => v > 0.01) ? 2.2 : 0)
      gl.uniform4f(u.uShadowFocus, c[0], c[2], this.mode === 'scene' ? 4 : propsR, 0)
      gl.uniform4f(u.uLegs, ...pose.legs)
      gl.uniform2f(u.uArms, pose.arms[0], pose.arms[1])
      gl.uniform4f(u.uEye, pose.eye, f.blink, pose.look[0], pose.look[1])
      gl.uniform1f(u.uStars, pose.stars)

      if (rope) {
        const flat = new Float32Array(ROPE_N * 3)
        let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9]
        rope.pts.forEach((p, i) => {
          flat.set(p, i * 3)
          lo = lo.map((v, j) => Math.min(v, p[j]))
          hi = hi.map((v, j) => Math.max(v, p[j]))
        })
        for (const p of rope.handles) {
          lo = lo.map((v, j) => Math.min(v, p[j]))
          hi = hi.map((v, j) => Math.max(v, p[j]))
        }
        gl.uniform3fv(u['uRope[0]'], flat)
        gl.uniform1f(u.uRopeR, rope.r)
        const mid = scale3(add(lo, hi), 0.5)
        gl.uniform4f(u.uRopeBound, mid[0], mid[1], mid[2], len3(sub(hi, lo)) * 0.5 + 0.05)
        const hv = new Float32Array(16)
        rope.handles.forEach((p, i) => hv.set([p[0], p[1], p[2], 0], i * 4))
        gl.uniform4fv(u['uHandles[0]'], hv)
      } else gl.uniform1f(u.uRopeR, 0)

      gl.uniform2f(u.uSwing, props.swing.show, props.swing.angle)
      gl.uniform2f(u.uTramp, props.tramp.show, props.tramp.sag)
      const b = props.ball
      gl.uniform4f(u.uBall, b.x, b.y, b.z, 0.27 * b.show)
      // world -> ball space: the transpose of the ball's rotation
      const R = M4.mul(M4.Rz(b.rz), M4.mul(M4.Rx(b.rx), M4.Ry(b.ry)))
      gl.uniformMatrix3fv(u.uBallRot, false, [R[0], R[4], R[8], R[1], R[5], R[9], R[2], R[6], R[10]])

      const fly = props.fly
      gl.uniform4f(u.uFly, fly.x, fly.y, fly.z, fly.show * 1.35)
      const FR = M4.mul(M4.Ry(fly.yaw), M4.Rx(fly.pitch))
      gl.uniformMatrix3fv(u.uFlyRot, false, [FR[0], FR[4], FR[8], FR[1], FR[5], FR[9], FR[2], FR[6], FR[10]])
      gl.uniform1f(u.uFlap, fly.flap)
      const fl = new Float32Array(24)
      FLOWERS.forEach((fw, i) => fl.set([fw[0], fw[1], fw[2], props.flowers[i]], i * 4))
      gl.uniform4fv(u['uFlowers[0]'], fl)
      gl.uniform1f(u.uFlowersOn, props.flowers.some(v => v > 0.001) ? 1 : 0)
      gl.uniform1f(u.uBlush, pose.blush)

      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

    dispose() {
      cancelAnimationFrame(this.raf)
      this.resizeObserver.disconnect()
      const ext = this.gl.getExtension('WEBGL_lose_context')
      if (ext) ext.loseContext()
    }
  }

  function poseMatrix(p, sxz, sy) {
    const [px, py, pz] = p.pivot
    let m = M4.T(p.x + px, p.y + py, p.z + pz)
    if (p.quat) m = M4.mul(m, M4.fromQuat(p.quat))
    else {
      m = M4.mul(m, M4.Ry(p.yaw))
      m = M4.mul(m, M4.Rx(p.pitch))
      m = M4.mul(m, M4.Rz(p.roll))
    }
    m = M4.mul(m, M4.T(-px, -py, -pz))
    return M4.mul(m, M4.S(sxz, sy, sxz))
  }

  function blendPose(a, b, s) {
    const out = Object.assign({}, b)
    for (const k of ['x', 'y', 'z']) out[k] = lerp(a[k], b[k], s)
    for (const k of ['yaw', 'pitch', 'roll']) out[k] = wrapAngle(a[k]) + wrapAngle(wrapAngle(b[k]) - wrapAngle(a[k])) * s
    out.pivot = a.pivot.map((v, i) => lerp(v, b.pivot[i], s))
    out.legs = a.legs.map((v, i) => lerp(v, b.legs[i], s))
    out.arms = a.arms.map((v, i) => lerp(v, b.arms[i], s))
    out.look = a.look.map((v, i) => lerp(v, b.look[i], s))
    out.stars = lerp(a.stars, b.stars, s)
    out.blush = lerp(a.blush, b.blush, s)
    out.squash = lerp(a.squash, b.squash, s)
    out.eye = s < 0.5 ? a.eye : b.eye
    return out
  }
  function blendProps(a, b, s) {
    const out = JSON.parse(JSON.stringify(b))
    out.rope.show = lerp(a.rope.show, b.rope.show, s)
    if (b.rope.show < 0.001 && a.rope.show > 0.001) {
      out.rope = Object.assign({}, a.rope, { show: lerp(a.rope.show, 0, s), physics: false })
    }
    out.swing.show = lerp(a.swing.show, b.swing.show, s)
    if (b.swing.show < 0.001) out.swing.angle = a.swing.angle
    out.tramp.show = lerp(a.tramp.show, b.tramp.show, s)
    out.ball.show = lerp(a.ball.show, b.ball.show, s)
    out.fly.show = lerp(a.fly.show, b.fly.show, s)
    if (b.fly.show < 0.001) Object.assign(out.fly, a.fly, { show: out.fly.show })
    out.flowers = a.flowers.map((v, i) => lerp(v, b.flowers[i], s))
    if (b.ball.show < 0.001) Object.assign(out.ball, a.ball, { show: out.ball.show })
    return out
  }

  // ------------------------------------------------------------- element --
  if (typeof customElements !== 'undefined' && !customElements.get('clawd-recess')) {
    customElements.define(
      'clawd-recess',
      class extends HTMLElement {
        connectedCallback() {
          if (this.stage) return
          const shadow = this.attachShadow({ mode: 'open' })
          shadow.innerHTML = '<style>:host{display:block;position:relative;width:420px;height:420px}canvas{width:100%;height:100%;display:block;touch-action:none}</style><canvas></canvas>'
          this.stage = new Stage(shadow.querySelector('canvas'), {
            mode: this.getAttribute('mode') || 'scene',
            transparent: this.hasAttribute('transparent'),
            activity: this.getAttribute('activity') || undefined,
            interactive: !this.hasAttribute('static'),
          })
        }
        disconnectedCallback() {
          if (this.stage) this.stage.dispose()
          this.stage = null
        }
      },
    )
  }

  root.Clawd3D = { Stage, ACTIVITIES: Object.keys(ACTIVITIES), LABELS, SPACE_ACTIVITIES, SPACE_LABELS, PET_FRAME }
})(typeof window !== 'undefined' ? window : globalThis)
