// Draws Clawd as pixel art and writes the app and tray icons as PNGs (no dependencies).
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

// 16x16: B body, E eye, . transparent
const ART = [
  '................',
  '................',
  '................',
  '...BBBBBBBBBB...',
  '...BBBBBBBBBB...',
  '...BBEBBBBEBB...',
  '.BBBBEBBBBEBBBB.',
  '.BBBBBBBBBBBBBB.',
  '...BBBBBBBBBB...',
  '...BBBBBBBBBB...',
  '....B.B..B.B....',
  '....B.B..B.B....',
  '................',
  '................',
  '................',
  '................',
]
const COLORS = { B: [0xd9, 0x77, 0x57, 255], E: [0x1f, 0x1a, 0x17, 255], '.': [0, 0, 0, 0] }

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function png(size) {
  const scale = size / 16
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const c = COLORS[ART[Math.floor(y / scale)][Math.floor(x / scale)]]
      raw.set(c, y * (size * 4 + 1) + 1 + x * 4)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const out = p => fileURLToPath(new URL(p, import.meta.url))
mkdirSync(out('../assets/'), { recursive: true })
mkdirSync(out('../build/'), { recursive: true })
writeFileSync(out('../assets/tray16.png'), png(16))
writeFileSync(out('../assets/tray32.png'), png(32))
writeFileSync(out('../assets/icon.png'), png(256))
writeFileSync(out('../build/icon.png'), png(256))
console.log('icons written')
