/**
 * dsh-memory — the memory folder itself.
 *
 * Layout, under `$DSH_HOME/memory` (or whatever `root` the caller passes):
 *
 *   MEMORY.md            core memory, injected into every conversation
 *   notes/*.md           detail, fetched on demand through the memory_* tools
 *   conflicts/*.md       a local edit that lost a race with another machine
 *
 * Everything here is pure filesystem work with no dsh dependency, so the smoke
 * test can drive it against a temporary directory. The sync engine in
 * `sync.js` sits on top of `listMemory` / `readMemory` / `writeMemory` and a
 * content hash per file.
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** Injected into every conversation. Keep it small — it costs tokens forever. */
export const CORE_FILE = 'MEMORY.md'
/** Where detail lives, so the core file stays short. */
export const NOTES_DIR = 'notes'
/** A local edit that lost a race is moved here instead of being discarded. */
export const CONFLICT_DIR = 'conflicts'
/** Only markdown is treated as memory; anything else is left alone. */
export const MEMORY_EXT = '.md'
/** Directories skipped while walking the memory tree. */
export const SKIP_DIRS = new Set(['.git', 'node_modules', '.cache', 'tmp'])
/** Refuse to read or write a single memory file larger than this. */
export const MAX_FILE_BYTES = 1024 * 1024
/** Refuse paths deeper than this many segments. */
export const MAX_DEPTH = 4
/** Default core-memory budget before the injected block is clipped. */
export const DEFAULT_MAX_CORE_BYTES = 8192

/** Written once, when a memory repository is bound and the tree is still empty. */
export const SEED_CORE = `# 长期记忆

> 本文件由 dsh-memory 同步到 GitHub，并在每轮对话开始时注入上下文。
> 这里只写长期有效的事实（偏好、环境、约定、踩过的坑）——它一直占上下文。
> 细节写进 \`notes/\` 下的文件，需要时用 \`memory_search\` / \`memory_read\` 查。

## 用户偏好

## 环境

## 项目约定
`

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

const toPosix = (value) => String(value).replace(/\\/g, '/')

/**
 * Normalize a model-supplied relative path, or return `null` when it must not
 * be touched. This is the only gate between a tool argument and the disk: no
 * absolute paths, no drive letters, no `..`, no escapes out of the root, and
 * markdown only.
 */
export function safeRel(input, { extension = MEMORY_EXT, maxDepth = MAX_DEPTH } = {}) {
  if (typeof input !== 'string') return null
  const trimmed = toPosix(input).trim().replace(/^\.\/+/, '')
  if (trimmed === '') return null
  if (trimmed.startsWith('/')) return null
  if (/^[A-Za-z]:/.test(trimmed)) return null
  if (trimmed.endsWith('/')) return null
  const parts = trimmed.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.length === 0 || parts.length > maxDepth) return null
  if (parts.some((part) => part === '..' || part.includes('\0'))) return null
  if (extension !== '' && !parts[parts.length - 1].toLowerCase().endsWith(extension)) return null
  return parts.join('/')
}

/** Absolute path for an already-validated relative path. */
export function pathOf(root, rel) {
  return join(root, ...toPosix(rel).split('/'))
}

/** True when `abs` is inside `root` (used as a second, independent check). */
export function isUnder(root, abs) {
  const base = resolve(root)
  const target = resolve(abs)
  if (target === base) return false
  return target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

export function ensureRoot(root) {
  mkdirSync(join(root, NOTES_DIR), { recursive: true })
  return root
}

/* ------------------------------------------------------------------ *
 * Reading and writing
 * ------------------------------------------------------------------ */

export function hashOf(text) {
  return createHash('sha256').update(text ?? '', 'utf8').digest('hex')
}

function sizeOf(abs) {
  try {
    return statSync(abs).size
  } catch {
    return 0
  }
}

/** Read one memory file, or `null` when it is absent, too large, or a directory. */
export function readMemory(root, rel) {
  const safe = safeRel(rel)
  if (safe === null) return null
  const abs = pathOf(root, safe)
  if (!isUnder(root, abs)) return null
  if (sizeOf(abs) > MAX_FILE_BYTES) return null
  try {
    const text = readFileSync(abs, 'utf8')
    return text.startsWith('\uFEFF') ? text.slice(1) : text
  } catch {
    return null
  }
}

/**
 * Write one memory file atomically: a sibling temp file is renamed over the
 * target, so a crash mid-write cannot leave a half-written memory behind.
 */
export function writeMemory(root, rel, text) {
  const safe = safeRel(rel)
  if (safe === null) return { ok: false, message: `非法记忆路径：${String(rel)}` }
  const body = typeof text === 'string' ? text : ''
  if (Buffer.byteLength(body, 'utf8') > MAX_FILE_BYTES) {
    return { ok: false, message: `内容超过 ${MAX_FILE_BYTES} 字节上限` }
  }
  const abs = pathOf(root, safe)
  if (!isUnder(root, abs)) return { ok: false, message: `路径越出记忆目录：${safe}` }
  try {
    mkdirSync(dirname(abs), { recursive: true })
    const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, body, 'utf8')
    renameSync(tmp, abs)
    return { ok: true, path: safe, bytes: Buffer.byteLength(body, 'utf8') }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** Append to a memory file, creating it (and a heading) when it is new. */
export function appendMemory(root, rel, text) {
  const safe = safeRel(rel)
  if (safe === null) return { ok: false, message: `非法记忆路径：${String(rel)}` }
  const current = readMemory(root, safe)
  const addition = typeof text === 'string' ? text : ''
  if (current === null) return writeMemory(root, safe, addition.endsWith('\n') ? addition : `${addition}\n`)
  const base = current.endsWith('\n') || current === '' ? current : `${current}\n`
  return writeMemory(root, safe, `${base}${addition.endsWith('\n') ? addition : `${addition}\n`}`)
}

export function deleteMemory(root, rel) {
  const safe = safeRel(rel)
  if (safe === null) return false
  const abs = pathOf(root, safe)
  if (!isUnder(root, abs)) return false
  if (!existsSync(abs)) return false
  try {
    rmSync(abs)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * Walking and searching
 * ------------------------------------------------------------------ */

/**
 * Every memory file, sorted by path. `MEMORY.md` is listed first so the panel
 * and the tool output both lead with what the model actually sees.
 */
export function listMemory(root, { maxDepth = MAX_DEPTH } = {}) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(join(dir, entry.name), depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (!entry.name.toLowerCase().endsWith(MEMORY_EXT)) continue
      const abs = join(dir, entry.name)
      const rel = toPosix(relative(root, abs))
      found.push({ path: rel, bytes: sizeOf(abs), mtime: mtimeOf(abs) })
    }
  }
  walk(root, 1)
  found.sort((a, b) => {
    if (a.path === CORE_FILE) return -1
    if (b.path === CORE_FILE) return 1
    return a.path.localeCompare(b.path)
  })
  return found
}

function mtimeOf(abs) {
  try {
    return statSync(abs).mtime.toISOString()
  } catch {
    return ''
  }
}

/**
 * Case-insensitive substring search over every memory file. Returns one hit
 * per matching line, capped by `limit`, so a broad query cannot flood a turn.
 */
export function searchMemory(root, query, { limit = 40 } = {}) {
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (needle === '') return []
  const hits = []
  for (const file of listMemory(root)) {
    const text = readMemory(root, file.path)
    if (text === null) continue
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (!line.toLowerCase().includes(needle)) continue
      hits.push({ path: file.path, line: index + 1, text: line.trim().slice(0, 240) })
      if (hits.length >= limit) return hits
    }
  }
  return hits
}

/**
 * Content hash per file, plus the bytes. The sync engine keeps the previous
 * snapshot to decide whether a file changed locally, remotely, or both.
 */
export function snapshot(root) {
  const files = {}
  for (const file of listMemory(root)) {
    const text = readMemory(root, file.path)
    files[file.path] = { hash: hashOf(text ?? ''), bytes: file.bytes }
  }
  return files
}

/* ------------------------------------------------------------------ *
 * The injected block
 * ------------------------------------------------------------------ */

/**
 * The core-memory block handed to the prompt section. Clipped to `maxBytes`
 * with a visible marker rather than silently truncated, and empty when there is
 * nothing to say — an empty section adds no tokens at all.
 */
export function renderCore(root, { maxBytes = DEFAULT_MAX_CORE_BYTES, notes = null } = {}) {
  const text = readMemory(root, CORE_FILE)
  if (text === null || text.trim() === '') return ''
  const clipped = clip(text.trim(), maxBytes)
  const files = notes ?? listMemory(root).filter((file) => file.path !== CORE_FILE)
  const index = files.length === 0
    ? ''
    : `\n\n其余记忆文件（用 \`memory_read\` 读全文，用 \`memory_search\` 全文检索）：\n${
      files.slice(0, 24).map((file) => `- ${file.path}（${file.bytes} 字节）`).join('\n')}${
      files.length > 24 ? `\n- …另有 ${files.length - 24} 个` : ''}`
  return `${clipped.text}${index}${clipped.truncated ? '\n\n（核心记忆超出预算，已被截断；完整内容见 memory_read("MEMORY.md")。）' : ''}`
}

/** Byte-budgeted clip that never splits a UTF-8 character. */
export function clip(text, maxBytes) {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= maxBytes) return { text, truncated: false }
  const sliced = Buffer.from(text, 'utf8').subarray(0, Math.max(0, maxBytes)).toString('utf8')
  /* A trailing partial character decodes as U+FFFD; drop it. */
  return { text: sliced.replace(/\uFFFD+$/u, ''), truncated: true }
}

/* ------------------------------------------------------------------ *
 * GitHub payloads
 * ------------------------------------------------------------------ */

/** GitHub's contents API speaks base64 in both directions. */
export function encodeBase64(text) {
  return Buffer.from(text ?? '', 'utf8').toString('base64')
}

export function decodeBase64(value) {
  const cleaned = typeof value === 'string' ? value.replace(/\s+/g, '') : ''
  if (cleaned === '') return ''
  try {
    return Buffer.from(cleaned, 'base64').toString('utf8')
  } catch {
    return ''
  }
}
