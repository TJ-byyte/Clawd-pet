// Copies the one-file engine (../clawd3d.js) into the app, so the app ships it.
import { copyFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const from = fileURLToPath(new URL('../../clawd3d.js', import.meta.url))
const dir = fileURLToPath(new URL('../engine/', import.meta.url))
mkdirSync(dir, { recursive: true })
copyFileSync(from, dir + 'clawd3d.js')
console.log('engine synced')
