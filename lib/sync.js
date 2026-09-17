/**
 * dsh-memory — GitHub sync engine.
 *
 * The memory folder is the working copy; a private GitHub repository is the
 * source of truth that every machine shares. This module owns the round trip
 * and, more importantly, the decision of what to do when a file changed on
 * both sides since the last sync.
 *
 * Everything external is injected (`gh`, `store`, `getToken`, `state`), so the
 * smoke test drives the whole thing against a fake GitHub without a network.
 *
 * Bookkeeping: `state.files[rel]` records the git blob `sha` and the content
 * `hash` a file had the last time both sides agreed. That pair is what makes
 * "changed locally" and "changed remotely" two independent questions —
 *   - local changed  = sha256(local file)      !== recorded.hash
 *   - remote changed = tree entry blob sha     !== recorded.sha
 * and only a file that changed on *both* sides is a conflict.
 */

import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { decodeBase64, encodeBase64, hashOf, safeRel } from './store.js'

export const DEFAULT_BRANCH = 'main'
export const COMMIT_PREFIX = 'dsh-memory'

/** Where a losing local edit is parked instead of being thrown away. */
export const CONFLICT_DIR = 'conflicts'

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/** `owner/name`, or `null` when the setting is missing or malformed. */
export function parseRepo(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '')
  const parts = trimmed.split('/')
  if (parts.length !== 2) return null
  const [owner, name] = parts
  if (owner === '' || name === '' || /[^\w.-]/.test(owner) || /[^\w.-]/.test(name)) return null
  return { owner, name, full: `${owner}/${name}` }
}

/** Percent-encode each path segment but keep the slashes. */
export function encodePath(rel) {
  return String(rel).split('/').map(encodeURIComponent).join('/')
}

/** Filesystem-safe, sortable stamp for a conflict copy's name. */
export function stamp(date) {
  const iso = (date instanceof Date ? date : new Date()).toISOString()
  return iso.slice(0, 19).replace(/[:T]/g, '-')
}

/** Where a losing local edit goes: `conflicts/MEMORY-20260917-103000-host.md`. */
export function conflictPathFor(rel, host, date) {
  const clean = String(rel).replace(/\.md$/i, '')
  const flat = clean.replace(/[\\/]/g, '-').replace(/[^\w.-]/g, '')
  const tag = String(host ?? 'host').replace(/[^\w.-]/g, '').slice(0, 24) || 'host'
  return `${CONFLICT_DIR}/${flat}-${stamp(date)}-${tag}.md`
}

/**
 * A block appended to a conflict copy so the next conversation can explain
 * where the file came from without reading the sync log.
 */
export function conflictHeader(rel, remoteSha, date) {
  return `> 这份记忆在 ${(date instanceof Date ? date : new Date()).toISOString()} 与远程版本冲突（远程 ${String(remoteSha).slice(0, 10)}）。
> 当时的本地版本被保存在此文件，远程版本胜出。确认内容后可以合并回 ${rel} 并删掉本文件。
`
}

/* ------------------------------------------------------------------ *
 * The engine
 * ------------------------------------------------------------------ */

/**
 * @param options.gh        `(method, path, options) => Promise<{ok,status,data,text,message}>`
 * @param options.store     the `lib/store.js` surface (listMemory/readMemory/...)
 * @param options.getToken  `() => string` — read per call, so a re-bind takes effect without a restart
 * @param options.root      the memory folder
 * @param options.state     mutable bookkeeping object (see `emptyState`)
 * @param options.saveState called after every change; may be sync or async
 */
export function createSync(options) {
  const {
    gh,
    store,
    getToken = () => '',
    root,
    state = emptyState(),
    saveState = () => {},
    getRepo = () => '',
    getBranch = () => DEFAULT_BRANCH,
    now = () => new Date(),
    host = hostname(),
    maxFiles = 200,
    log = () => {},
  } = options

  const token = () => {
    const value = getToken()
    return typeof value === 'string' ? value : ''
  }

  const repoOf = () => parseRepo(getRepo())

  let pending = null

  /* ---------------- remote reading ---------------- */

  /**
   * The branch's file list. An empty repository answers 404/409 here, which is
   * not an error for us — it just means there is nothing to pull yet.
   */
  async function remoteTree() {
    const repo = repoOf()
    if (repo === null) return { ok: false, message: '尚未配置记忆仓库（形如 owner/name）' }
    const branch = getBranch()
    const result = await gh('GET', `/repos/${repo.full}/git/trees/${encodeURIComponent(branch)}?recursive=1`)
    if (!result.ok) {
      if (result.status === 404 || result.status === 409) {
        return { ok: true, empty: true, tree: [], message: '远端暂无内容（分支可能还不存在）' }
      }
      return { ok: false, status: result.status, message: result.message }
    }
    const raw = Array.isArray(result.data?.tree) ? result.data.tree : []
    const tree = []
    for (const entry of raw) {
      if (entry === null || typeof entry !== 'object') continue
      if (entry.type !== 'blob') continue
      const rel = safeRel(entry.path)
      if (rel === null) continue
      if (typeof entry.size === 'number' && entry.size > store.MAX_FILE_BYTES) continue
      tree.push({ path: rel, sha: String(entry.sha ?? ''), size: typeof entry.size === 'number' ? entry.size : 0 })
      if (tree.length >= maxFiles) break
    }
    return { ok: true, empty: false, tree }
  }

  /** One file's text plus its blob sha, or a readable failure. */
  async function remoteFile(rel) {
    const repo = repoOf()
    if (repo === null) return { ok: false, message: '尚未配置记忆仓库' }
    const result = await gh('GET', `/repos/${repo.full}/contents/${encodePath(rel)}?ref=${encodeURIComponent(getBranch())}`)
    if (!result.ok) return { ok: false, status: result.status, message: result.message }
    const data = result.data ?? {}
    if (data.encoding !== 'base64' || typeof data.content !== 'string') {
      return { ok: false, message: `${rel} 过大或不是文本文件，已跳过` }
    }
    return { ok: true, sha: String(data.sha ?? ''), text: decodeBase64(data.content) }
  }

  /* ---------------- conflict handling ---------------- */

  /**
   * Both sides moved. The remote version wins the live path (the machine you
   * are not sitting at should not silently lose its edit either), and the local
   * version is parked under `conflicts/` so nothing is destroyed.
   */
  function parkConflict(rel, localText, remote) {
    const path = conflictPathFor(rel, host, now())
    const body = `${conflictHeader(rel, remote.sha, now())}\n${localText ?? ''}`
    const written = store.writeMemory(root, path, body)
    const applied = store.writeMemory(root, rel, remote.text)
    state.files[rel] = { sha: remote.sha, hash: hashOf(remote.text), syncedAt: now().toISOString() }
    if (!written.ok || !applied.ok) {
      return { ok: false, message: written.message ?? applied.message ?? '冲突副本写入失败' }
    }
    return { ok: true, path }
  }

  /* ---------------- pull ---------------- */

  async function pullOnce() {
    const repo = repoOf()
    if (repo === null) return { ok: false, status: 401, message: '尚未配置记忆仓库（形如 owner/name）', pulled: [], conflicts: [] }
    if (token() === '') return { ok: false, status: 401, message: '尚未绑定 GitHub 账号', pulled: [], conflicts: [] }

    const tree = await remoteTree()
    if (!tree.ok) return { ok: false, status: tree.status ?? 0, message: tree.message, pulled: [], conflicts: [] }

    const pulled = []
    const conflicts = []
    const notes = []
    const seen = new Set()

    for (const entry of tree.tree) {
      seen.add(entry.path)
      const recorded = state.files[entry.path]
      const localText = store.readMemory(root, entry.path)
      const localHash = hashOf(localText ?? '')
      const localChanged = recorded === undefined ? localText !== null : localHash !== recorded.hash
      const remoteChanged = recorded === undefined ? true : entry.sha !== recorded.sha

      if (!remoteChanged) continue

      const remote = await remoteFile(entry.path)
      if (!remote.ok) {
        notes.push(`${entry.path}（拉取失败：${remote.message}）`)
        continue
      }
      const remoteHash = hashOf(remote.text)

      if (!localChanged) {
        const written = store.writeMemory(root, entry.path, remote.text)
        if (!written.ok) { notes.push(`${entry.path}（写入失败：${written.message}）`); continue }
        state.files[entry.path] = { sha: remote.sha, hash: remoteHash, syncedAt: now().toISOString() }
        pulled.push(entry.path)
        continue
      }

      if (localHash === remoteHash) {
        /* Both sides already agree on the content; only the ledger was stale. */
        state.files[entry.path] = { sha: remote.sha, hash: remoteHash, syncedAt: now().toISOString() }
        continue
      }

      const parked = parkConflict(entry.path, localText, remote)
      if (parked.ok) {
        conflicts.push({ path: entry.path, copy: parked.path })
        pulled.push(entry.path)
      } else {
        notes.push(`${entry.path}（冲突处理失败：${parked.message}）`)
      }
    }

    /* Files that exist locally but not remotely are kept and left for push;
       a deletion on the remote side never deletes a local memory. */
    const remoteOnlyGone = []
    for (const rel of Object.keys(state.files)) {
      if (seen.has(rel)) continue
      if (store.readMemory(root, rel) === null) {
        delete state.files[rel]
        continue
      }
      remoteOnlyGone.push(rel)
      delete state.files[rel]
    }

    state.lastPullAt = now().toISOString()
    state.repo = repo.full
    state.branch = getBranch()
    await saveState(state)
    return {
      ok: true,
      empty: tree.empty === true,
      pulled,
      conflicts,
      notes,
      localOnly: remoteOnlyGone,
      message: describePull({ pulled, conflicts, remoteOnlyGone, empty: tree.empty === true }),
    }
  }

  /* ---------------- push ---------------- */

  async function putFile(rel, text, recorded) {
    const repo = repoOf()
    const body = {
      message: `${COMMIT_PREFIX}: ${rel} from ${host}`,
      content: encodeBase64(text),
      branch: getBranch(),
    }
    if (recorded !== undefined && typeof recorded.sha === 'string' && recorded.sha !== '') body.sha = recorded.sha
    let result = await gh('PUT', `/repos/${repo.full}/contents/${encodePath(rel)}`, { body })

    if (!result.ok && (result.status === 409 || result.status === 422)) {
      /* The remote moved since our ledger was written. Re-read before deciding:
         a genuine conflict parks the local copy, an identical file just
         re-syncs its ledger. */
      const fresh = await remoteFile(rel)
      if (fresh.ok) {
        if (hashOf(fresh.text) === hashOf(text)) {
          state.files[rel] = { sha: fresh.sha, hash: hashOf(text), syncedAt: now().toISOString() }
          return { ok: true, unchanged: true, sha: fresh.sha }
        }
        const parked = parkConflict(rel, text, fresh)
        return parked.ok
          ? { ok: false, conflict: true, copy: parked.path, message: `${rel} 与远端冲突，本地版本已存入 ${parked.path}` }
          : { ok: false, message: parked.message }
      }
      if (fresh.status === 404) {
        /* The file vanished remotely; retry without the stale sha. */
        delete body.sha
        result = await gh('PUT', `/repos/${repo.full}/contents/${encodePath(rel)}`, { body })
      }
    }

    if (!result.ok) {
      const hint = result.status === 404
        ? '（仓库或分支不存在；若仓库是空的，请先在面板里初始化记忆仓库）'
        : ''
      return { ok: false, message: `${result.message}${hint}` }
    }
    const sha = String(result.data?.content?.sha ?? '')
    state.files[rel] = { sha, hash: hashOf(text), syncedAt: now().toISOString() }
    return { ok: true, sha }
  }

  async function pushOnce() {
    const repo = repoOf()
    if (repo === null) return { ok: false, status: 401, message: '尚未配置记忆仓库（形如 owner/name）', pushed: [] }
    if (token() === '') return { ok: false, status: 401, message: '尚未绑定 GitHub 账号', pushed: [] }

    const files = store.snapshot(root)
    const pushed = []
    const skipped = []
    const conflicts = []
    const failed = []

    for (const [rel, info] of Object.entries(files)) {
      const recorded = state.files[rel]
      if (recorded !== undefined && recorded.hash === info.hash) { skipped.push(rel); continue }
      const text = store.readMemory(root, rel)
      if (text === null) { skipped.push(rel); continue }
      const result = await putFile(rel, text, recorded)
      if (result.ok) pushed.push(rel)
      else if (result.conflict === true) conflicts.push({ path: rel, copy: result.copy })
      else failed.push({ path: rel, message: result.message })
    }

    /* Files we know about that disappeared locally are reported, never deleted
       remotely — a deletion is destructive and has to be a human decision. */
    const remoteKept = Object.keys(state.files).filter((rel) => files[rel] === undefined)

    if (failed.length === 0) {
      state.lastPushAt = now().toISOString()
      state.repo = repo.full
      state.branch = getBranch()
      state.lastError = ''
    } else {
      state.lastError = failed.map((item) => `${item.path}: ${item.message}`).join('；')
    }
    await saveState(state)
    return {
      ok: failed.length === 0,
      pushed,
      skipped,
      conflicts,
      failed,
      remoteKept,
      message: describePush({ pushed, conflicts, failed, remoteKept }),
    }
  }

  /* ---------------- serialized entry points ---------------- */

  /** Both entry points share one slot so a button press and a tool call
      cannot interleave their ledger writes. */
  function serialize(run) {
    if (pending !== null) return pending
    pending = (async () => {
      try {
        return await run()
      } catch (error) {
        log(`sync failed: ${messageOf(error)}`)
        return { ok: false, message: messageOf(error) }
      } finally {
        pending = null
      }
    })()
    return pending
  }

  const pull = () => serialize(pullOnce)
  const push = () => serialize(pushOnce)

  /** Local-only view: what a push would carry, and what is out of sync. */
  function status() {
    const files = store.snapshot(root)
    const pendingPush = []
    const unknown = []
    for (const [rel, info] of Object.entries(files)) {
      const recorded = state.files[rel]
      if (recorded === undefined) { unknown.push(rel); continue }
      if (recorded.hash !== info.hash) pendingPush.push(rel)
    }
    const missingLocally = Object.keys(state.files).filter((rel) => files[rel] === undefined)
    return {
      repo: state.repo ?? '',
      branch: state.branch ?? getBranch(),
      fileCount: Object.keys(files).length,
      pendingPush,
      unsynced: unknown,
      missingLocally,
      lastPullAt: state.lastPullAt ?? '',
      lastPushAt: state.lastPushAt ?? '',
      lastError: state.lastError ?? '',
    }
  }

  return { pull, push, status, remoteTree, remoteFile, putFile, parkConflict }
}

export function emptyState() {
  return { repo: '', branch: DEFAULT_BRANCH, files: {}, lastPullAt: '', lastPushAt: '', lastError: '' }
}

/* ------------------------------------------------------------------ *
 * Human-readable summaries
 * ------------------------------------------------------------------ */

function describePull({ pulled, conflicts, remoteOnlyGone, empty }) {
  if (empty) return '远端仓库还没有内容'
  const parts = []
  if (pulled.length > 0) parts.push(`拉取 ${pulled.length} 个文件`)
  if (conflicts.length > 0) parts.push(`${conflicts.length} 个文件与本地冲突，本地版本已存入 conflicts/`)
  if (remoteOnlyGone.length > 0) parts.push(`${remoteOnlyGone.length} 个本地文件远端已无（保留在本地，等待推送）`)
  return parts.length === 0 ? '已是最新' : parts.join('；')
}

function describePush({ pushed, conflicts, failed, remoteKept }) {
  const parts = []
  if (pushed.length > 0) parts.push(`推送 ${pushed.length} 个文件`)
  if (conflicts.length > 0) parts.push(`${conflicts.length} 个文件冲突，本地版本已存入 conflicts/`)
  if (remoteKept.length > 0) parts.push(`${remoteKept.length} 个文件本地已删、远端保留`)
  if (failed.length > 0) parts.push(`${failed.length} 个文件推送失败`)
  return parts.length === 0 ? '没有需要推送的改动' : parts.join('；')
}

/* ------------------------------------------------------------------ *
 * Repository provisioning (used by the panel)
 * ------------------------------------------------------------------ */

/** Create the private memory repository with an initial commit, so pushes have
    a branch to land on without a separate bootstrap step. */
export async function createMemoryRepo(gh, token, { name, description }) {
  const result = await gh('POST', '/user/repos', {
    body: {
      name,
      description: description ?? 'dsh 长期记忆（由 dsh-memory 插件同步）',
      private: true,
      auto_init: true,
      has_issues: false,
      has_wiki: false,
      has_projects: false,
    },
  })
  if (!result.ok) return { ok: false, message: result.message }
  return {
    ok: true,
    full: String(result.data?.full_name ?? ''),
    defaultBranch: String(result.data?.default_branch ?? DEFAULT_BRANCH),
    htmlUrl: String(result.data?.html_url ?? ''),
  }
}

/** The repository's default branch, so a fresh binding can adopt it. */
export async function repoDefaultBranch(gh, full) {
  const result = await gh('GET', `/repos/${full}`)
  if (!result.ok) return { ok: false, message: result.message }
  return {
    ok: true,
    defaultBranch: String(result.data?.default_branch ?? DEFAULT_BRANCH),
    private: result.data?.private === true,
  }
}

export const internals = { existsSync, messageOf }
