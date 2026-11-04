#!/usr/bin/env node

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const STALE_MS = 120_000
const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '/data', '.dsh')
const lockDir = join(home, 'integrations', 'dsh-weixin', 'lock')

let entries = []
try {
  entries = (await readdir(lockDir)).filter((name) => name.endsWith('.lock'))
} catch {
  entries = []
}

if (entries.length === 0) {
  console.error('unhealthy: no poller lock (run the QR login, then restart)')
  process.exit(1)
}

let newest
for (const entry of entries) {
  const file = join(lockDir, entry)
  const info = await stat(file).catch(() => undefined)
  if (info === undefined) continue
  if (newest === undefined || info.mtimeMs > newest.mtimeMs) newest = { file, mtimeMs: info.mtimeMs }
}

if (newest === undefined) {
  console.error('unhealthy: poller lock disappeared during the check')
  process.exit(1)
}

const age = Date.now() - newest.mtimeMs
if (age > STALE_MS) {
  console.error(`unhealthy: last successful poll was ${Math.round(age / 1000)}s ago`)
  process.exit(1)
}

try {
  const holder = JSON.parse(await readFile(newest.file, 'utf8'))
  process.kill(Number(holder.pid), 0)
} catch (error) {
  if (error?.code === 'ESRCH') {
    console.error('unhealthy: poller pid is gone')
    process.exit(1)
  }
}

console.log(`healthy: last poll ${Math.round(age / 1000)}s ago`)
