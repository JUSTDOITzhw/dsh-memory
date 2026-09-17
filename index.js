/**
 * dsh-memory — host half.
 *
 * Three jobs, all registered from this plugin's own `apply()` so that
 * uninstalling it leaves nothing behind:
 *
 *   1. a prompt section carrying the core memory (`MEMORY.md`), re-read on
 *      every assembly — edit the file and the next turn already knows;
 *   2. four `memory_*` tools so the model can list, read, search and extend
 *      the folder on its own;
 *   3. loopback routes plus a private GitHub repository, so the same folder
 *      follows you between machines.
 *
 * The credential is never sent to the browser half; the panel only ever learns
 * the login, the avatar and the sync state.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import * as storeModule from './lib/store.js'
import {
  CORE_FILE,
  DEFAULT_MAX_CORE_BYTES,
  MAX_FILE_BYTES,
  NOTES_DIR,
  SEED_CORE,
  appendMemory,
  deleteMemory,
  ensureRoot,
  listMemory,
  readMemory,
  renderCore,
  searchMemory,
  writeMemory,
} from './lib/store.js'
import { createSync, createMemoryRepo, emptyState, parseRepo, repoDefaultBranch } from './lib/sync.js'

export const name = 'memory'
export const inject = ['tools', 'systemPrompt', 'webServer']

const API = '/api/memory'
const GITHUB = 'https://api.github.com'

const DEFAULTS = {
  /** `owner/name` of the private memory repository. Empty means "bind it in the panel". */
  repo: '',
  /** Empty means "adopt the repository's default branch when binding". */
  branch: '',
  /** Byte budget for the injected core memory. */
  maxCoreBytes: DEFAULT_MAX_CORE_BYTES,
  /** Pull once shortly after startup. */
  autoPull: true,
  /** Push after the model writes a memory, debounced by `pushDelayMs`. */
  autoPush: true,
  pushDelayMs: 5000,
  /** Where the prompt section sits. 400 keeps it after the persona and before
      first-party tool guidance (which starts at 500). */
  sectionOrder: 400,
  /** Overrides for tests and unusual layouts. Empty means the defaults below. */
  memoryDir: '',
  authPath: '',
  statePath: '',
  /** How many times a single search may hit before it stops. */
  searchLimit: 40,
}

const messageOf = (error) => (error instanceof Error ? error.message : String(error))
const asText = (value) => (typeof value === 'string' ? value : '')
const clampInt = (value, fallback, min, max) => {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/**
 * A local stand-in for `@deepseek-ai/dsh-tools`' `defineTool`.
 *
 * The official helper is pleasant — a schema DSL, argument validation, a
 * default renderer — but importing it pins this plugin's module graph to a
 * package that only resolves *inside* a dsh profile. A `link:`ed development
 * checkout lives outside the profile, so that import throws
 * ERR_MODULE_NOT_FOUND at boot and takes the whole plugin tree down with it
 * (observed, not theorised: the first three loads failed exactly this way).
 *
 * Registering a plain definition keeps `ctx.tools` as the only contract, so the
 * plugin behaves identically whether it was installed with `link:`, with
 * `github:` or from npm. The argument validation that is dropped here is
 * replaced by the explicit checks each `execute` already performs — every tool
 * below tolerates a missing or wrongly typed argument by answering with a
 * sentence rather than throwing.
 */
function defineTool(options) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(options.parameters ?? {})) {
    const { required: isRequired, ...rest } = spec
    properties[key] = rest
    if (isRequired === true) required.push(key)
  }
  const output = options.output ?? {}
  return {
    name: options.name,
    description: options.description,
    parameters: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
    output: {
      schema: output.schema ?? { type: 'string' },
      render: output.render ?? ((_args, value) => [{ type: 'text', text: String(value) }]),
    },
    execute: options.execute,
    ...(typeof options.timeoutMs === 'number' ? { timeoutMs: options.timeoutMs } : {}),
  }
}

/* ------------------------------------------------------------------ *
 * Paths and config
 * ------------------------------------------------------------------ */

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const home = dshHome()
  const pickPath = (value, fallback) =>
    typeof value === 'string' && value.trim() !== '' ? resolve(value) : fallback
  return {
    repo: asText(input.repo).trim(),
    branch: asText(input.branch).trim(),
    maxCoreBytes: clampInt(input.maxCoreBytes, DEFAULTS.maxCoreBytes, 512, 262144),
    autoPull: input.autoPull !== false,
    autoPush: input.autoPush !== false,
    pushDelayMs: clampInt(input.pushDelayMs, DEFAULTS.pushDelayMs, 0, 600000),
    sectionOrder: clampInt(input.sectionOrder, DEFAULTS.sectionOrder, -2000, 20000),
    searchLimit: clampInt(input.searchLimit, DEFAULTS.searchLimit, 1, 200),
    memoryDir: pickPath(input.memoryDir, join(home, 'memory')),
    authPath: pickPath(input.authPath, join(home, 'dsh-memory', 'auth.json')),
    statePath: pickPath(input.statePath, join(home, 'dsh-memory', 'state.json')),
    /** Read-only reuse of the GitHub manager's credential, when this plugin has none. */
    fallbackAuthPath: join(home, 'github-manager', 'auth.json'),
  }
}

/* ------------------------------------------------------------------ *
 * Credential
 * ------------------------------------------------------------------ */

function readAuthRecord(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (raw === null || typeof raw !== 'object') return null
    if (typeof raw.token !== 'string' || raw.token === '') return null
    return raw
  } catch {
    return null
  }
}

function writeAuthRecord(file, record) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    /* Windows ignores the mode; best effort everywhere else. */
  }
}

/* ------------------------------------------------------------------ *
 * GitHub REST (same shape as the manager plugin, so failures read alike)
 * ------------------------------------------------------------------ */

function describeFailure(status, data, text) {
  if (status === 0) return ''
  const detail = data !== null && typeof data === 'object' ? data : null
  const base = detail !== null && typeof detail.message === 'string' ? detail.message : ''
  const composed = base.trim()
  if (composed !== '') return composed
  if (text !== '') return text.slice(0, 300)
  return `GitHub 返回 ${status}`
}

function createGh(getToken) {
  return async function gh(method, path, { body, accept, timeoutMs = 30000 } = {}) {
    const headers = {
      accept: accept ?? 'application/vnd.github+json',
      'user-agent': 'dsh-memory',
      'x-github-api-version': '2022-11-28',
    }
    const token = getToken()
    if (typeof token === 'string' && token !== '') headers.authorization = `Bearer ${token}`
    let payload
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    let response
    try {
      response = await fetch(`${GITHUB}${path}`, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      return { ok: false, status: 0, data: null, text: '', message: `无法连接 api.github.com：${messageOf(error)}` }
    }
    const text = await response.text()
    let data = null
    if (text !== '') {
      try {
        data = JSON.parse(text)
      } catch {
        data = null
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      data,
      text,
      scopes: response.headers.get('x-oauth-scopes'),
      message: describeFailure(response.status, data, text),
    }
  }
}

/* ------------------------------------------------------------------ *
 * State file
 * ------------------------------------------------------------------ */

function loadState(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (raw === null || typeof raw !== 'object') return emptyState()
    return {
      ...emptyState(),
      ...raw,
      files: raw.files !== null && typeof raw.files === 'object' ? raw.files : {},
    }
  } catch {
    return emptyState()
  }
}

function saveStateTo(file, state) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch {
    /* A failed ledger write is reported through the next status read. */
  }
}

/* ------------------------------------------------------------------ *
 * Tool text
 * ------------------------------------------------------------------ */

const CORE_HINT = `核心记忆 ${CORE_FILE} 会注入每轮对话；其余文件只在需要时读取。`

function describeFiles(root) {
  const files = listMemory(root)
  if (files.length === 0) return `记忆目录还是空的。${CORE_HINT}`
  return `${files.length} 个记忆文件（${CORE_HINT}）：\n${
    files.map((file) => `- ${file.path}（${file.bytes} 字节${file.mtime === '' ? '' : `，改于 ${file.mtime}`}）`).join('\n')}`
}

function describeHits(hits, query) {
  if (hits.length === 0) return `没有匹配「${query}」的记忆。`
  return `匹配「${query}」的 ${hits.length} 行：\n${
    hits.map((hit) => `${hit.path}:${hit.line}: ${hit.text}`).join('\n')}`
}

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const root = config.memoryDir
  const state = loadState(config.statePath)
  const runtime = { lastError: '', note: '', syncing: false }

  /** Prefer our own credential, fall back to the GitHub manager's, so a
      machine that already bound the manager needs no second setup. */
  const getToken = () => {
    const record = readAuthRecord(config.authPath) ?? readAuthRecord(config.fallbackAuthPath)
    return record === null ? '' : record.token
  }

  const gh = createGh(getToken)

  const getRepo = () => (typeof state.repo === 'string' && state.repo !== '' ? state.repo : config.repo)
  const getBranch = () => (typeof state.branch === 'string' && state.branch !== '' ? state.branch : config.branch)

  const sync = createSync({
    gh,
    store: storeModule,
    getToken,
    root,
    state,
    saveState: (next) => saveStateTo(config.statePath, next),
    getRepo,
    getBranch,
    log: (message) => { runtime.lastError = message },
  })

  ensureRoot(root)

  /* ---------------- automatic push ---------------- */

  let pushTimer = null
  const schedulePush = () => {
    if (!config.autoPush) return
    if (getRepo() === '' || getToken() === '') return
    if (pushTimer !== null) clearTimeout(pushTimer)
    pushTimer = setTimeout(() => {
      pushTimer = null
      void sync.push().then((result) => {
        runtime.note = result.ok ? `已自动同步：${result.message}` : `自动同步失败：${result.message}`
      })
    }, config.pushDelayMs)
  }

  /* ---------------- prompt section ---------------- */

  /**
   * The exact text handed to the prompt registry on every assembly. The panel
   * renders this same string, so "what does the model actually see?" has one
   * answer instead of two.
   */
  const composeSection = () => {
    const body = renderCore(root, { maxBytes: config.maxCoreBytes })
    if (body === '') return ''
    return `## 长期记忆\n\n以下是本机与远端同步的长期记忆，供参考；与用户当前指令冲突时以用户为准。\n\n${body}\n\n需要更多细节时用 \`memory_search\` 检索、\`memory_read\` 读全文；不要凭印象编造记忆内容。`
  }

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'memory:core',
    order: config.sectionOrder,
    /* Memory is user prose: a literal `{{...}}` must never be read as a prompt
       variable, and an unknown reference would fail the whole assembly. */
    interpolate: false,
    text: composeSection,
  }))

  /* ---------------- tools ---------------- */

  const toolDisposers = []

  const registerTools = () => {
    toolDisposers.push(ctx.tools.register(defineTool({
      name: 'memory_list',
      description: '列出长期记忆里的所有文件。核心记忆每个对话都会自动注入，不需要调用本工具；用它在查找某个主题该去哪个文件时看清单。',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute() {
        return describeFiles(root)
      },
    })))

    toolDisposers.push(ctx.tools.register(defineTool({
      name: 'memory_read',
      description: `读取一个记忆文件的全文。核心记忆 ${CORE_FILE} 已经注入在上下文里，只有它被截断、或要读 notes/ 下的细节时才需要调用。`,
      parameters: {
        path: { type: 'string', required: true, description: `相对记忆目录的路径，例如 ${CORE_FILE} 或 notes/deploy.md` },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const rel = asText(args?.path).trim()
        const text = readMemory(root, rel)
        if (text === null) {
          return `没有找到记忆文件 ${rel}。可用的文件：\n${listMemory(root).map((file) => `- ${file.path}`).join('\n') || '（空）'}`
        }
        return text.trim() === '' ? `${rel} 是空文件。` : text
      },
    })))

    toolDisposers.push(ctx.tools.register(defineTool({
      name: 'memory_search',
      description: '在全部长期记忆里按关键词检索（不区分大小写，返回命中的行）。想知道过去是否记过某件事、某台机器的配置、某个坑，先用它查，别靠猜。',
      parameters: {
        query: { type: 'string', required: true, description: '关键词或短语' },
        limit: { type: 'integer', description: `最多返回多少行，默认 ${DEFAULTS.searchLimit}` },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const query = asText(args?.query).trim()
        if (query === '') return '检索关键词不能为空。'
        const limit = clampInt(args?.limit, config.searchLimit, 1, 200)
        return describeHits(searchMemory(root, query, { limit }), query)
      },
    })))

    toolDisposers.push(ctx.tools.register(defineTool({
      name: 'memory_write',
      description: `往长期记忆里写内容，写入后会自动同步到 GitHub，其他机器下次启动就能拿到。**只写跨会话仍然成立的事实**：用户偏好、项目约定、环境与路径、踩过的坑、正在进行的长期目标。一次性的进度、临时结论、能从文件读出来的东西不要写。默认追加（append）到 ${NOTES_DIR}/ 下的主题文件；只有确实要重写核心记忆 ${CORE_FILE} 全文时才用 replace。`,
      parameters: {
        path: { type: 'string', required: true, description: `相对记忆目录的路径，必须以 .md 结尾，例如 ${CORE_FILE} 或 notes/ue-notes.md` },
        content: { type: 'string', required: true, description: '要写入的 Markdown 内容' },
        mode: { type: 'string', enum: ['append', 'replace'], description: 'append（默认）追加到文件末尾；replace 覆盖整个文件' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const rel = asText(args?.path).trim()
        const content = asText(args?.content)
        const mode = args?.mode === 'replace' ? 'replace' : 'append'
        if (content.trim() === '') return '内容为空，没有写入。'
        const result = mode === 'replace'
          ? writeMemory(root, rel, content)
          : appendMemory(root, rel, content)
        if (!result.ok) return `写入失败：${result.message}`
        schedulePush()
        const queued = config.autoPush && getRepo() !== '' && getToken() !== ''
          ? `，已排队同步到 GitHub（约 ${Math.round(config.pushDelayMs / 1000)} 秒后）`
          : '；尚未配置同步仓库，只写在了本地'
        return `已${mode === 'replace' ? '覆盖' : '追加'}写入 ${result.path}（${result.bytes} 字节）${queued}。`
      },
    })))
  }

  ctx.effect(() => {
    registerTools()
    return () => {
      for (const dispose of toolDisposers.reverse()) {
        try {
          dispose()
        } catch {
          /* already gone with the fiber */
        }
      }
    }
  })

  /* ---------------- routes ---------------- */

  const readAuthBody = () => {
    const record = readAuthRecord(config.authPath)
    if (record !== null) return { bound: true, source: 'memory', account: record.account ?? null }
    const fallback = readAuthRecord(config.fallbackAuthPath)
    if (fallback !== null) return { bound: true, source: 'github-manager', account: fallback.account ?? null }
    return { bound: false, source: '', account: null }
  }

  /**
   * Read the tool registry back rather than reporting what we meant to
   * register: this is the same projection the model receives, so "the tools
   * are there" is an observation and not an intention.
   */
  const inspectTools = () => {
    try {
      const schemas = ctx.tools.schemas()
      const names = Array.isArray(schemas)
        ? schemas.map((item) => item?.name).filter((name) => typeof name === 'string')
        : []
      return { memoryTools: names.filter((name) => name.startsWith('memory_')).sort(), visibleTotal: names.length }
    } catch (error) {
      return { error: messageOf(error) }
    }
  }

  const stateBody = () => {
    const auth = readAuthBody()
    const parsed = parseRepo(getRepo())
    return {
      ok: true,
      bound: auth.bound,
      authSource: auth.source,
      account: auth.account,
      authPath: config.authPath,
      fallbackAuthPath: config.fallbackAuthPath,
      repo: parsed === null ? '' : parsed.full,
      repoInput: getRepo(),
      branch: getBranch(),
      memoryDir: root,
      limits: { maxCoreBytes: config.maxCoreBytes, maxFileBytes: MAX_FILE_BYTES },
      autoPush: config.autoPush,
      autoPull: config.autoPull,
      files: listMemory(root).map((file) => ({ path: file.path, bytes: file.bytes, mtime: file.mtime })),
      sync: sync.status(),
      tools: inspectTools(),
      note: runtime.note,
    }
  }

  /** Bind a repository: validate it, adopt its default branch, then pull. */
  const repoSet = async (payload) => {
    const parsed = parseRepo(asText(payload.repo))
    if (parsed === null) return { status: 400, body: { ok: false, message: '仓库要写成 owner/name 的形式' } }
    const probe = await repoDefaultBranch(gh, parsed.full)
    if (!probe.ok) return { status: 400, body: { ok: false, message: probe.message } }
    const requested = asText(payload.branch).trim()
    state.repo = parsed.full
    state.branch = requested !== '' ? requested : probe.defaultBranch
    state.files = {}
    saveStateTo(config.statePath, state)
    if (listMemory(root).length === 0) {
      writeMemory(root, CORE_FILE, SEED_CORE)
      mkdirSync(join(root, NOTES_DIR), { recursive: true })
    }
    const pulled = await sync.pull()
    return {
      status: 200,
      body: {
        ok: true,
        repo: parsed.full,
        branch: state.branch,
        private: probe.private,
        message: `已绑定 ${parsed.full}（分支 ${state.branch}）：${pulled.message}`,
      },
    }
  }

  const repoCreate = async (payload) => {
    const repoName = asText(payload.name).trim()
    if (repoName === '') return { status: 400, body: { ok: false, message: '请填写仓库名' } }
    const created = await createMemoryRepo(gh, getToken(), { name: repoName })
    if (!created.ok) return { status: 400, body: { ok: false, message: created.message } }
    state.repo = created.full
    state.branch = created.defaultBranch
    state.files = {}
    saveStateTo(config.statePath, state)
    if (listMemory(root).length === 0) {
      writeMemory(root, CORE_FILE, SEED_CORE)
      mkdirSync(join(root, NOTES_DIR), { recursive: true })
    }
    const pushed = await sync.push()
    return {
      status: 200,
      body: {
        ok: true,
        repo: created.full,
        branch: created.defaultBranch,
        htmlUrl: created.htmlUrl,
        message: `已创建私有仓库 ${created.full}：${pushed.message}`,
      },
    }
  }

  const dispatch = {
    'state.refresh': () => ({ status: 200, body: stateBody() }),

    /* The literal prompt text, so the panel can show what every turn carries
       instead of describing it. */
    'section.preview': () => {
      const text = composeSection()
      return {
        status: 200,
        body: {
          ok: true,
          text,
          bytes: Buffer.byteLength(text, 'utf8'),
          maxBytes: config.maxCoreBytes,
          order: config.sectionOrder,
        },
      }
    },

    'sync.pull': async () => {
      runtime.syncing = true
      const result = await sync.pull()
      runtime.syncing = false
      runtime.note = result.message
      if (!result.ok) runtime.lastError = result.message
      return { status: result.ok ? 200 : 409, body: { ...result, state: stateBody() } }
    },

    'sync.push': async () => {
      runtime.syncing = true
      const result = await sync.push()
      runtime.syncing = false
      runtime.note = result.message
      if (!result.ok) runtime.lastError = result.message
      return { status: result.ok ? 200 : 409, body: { ...result, state: stateBody() } }
    },

    'repo.set': (payload) => repoSet(payload),
    'repo.create': (payload) => repoCreate(payload),

    'repos.list': async () => {
      const result = await gh('GET', '/user/repos?per_page=100&sort=updated&affiliation=owner')
      if (!result.ok) return { status: 400, body: { ok: false, message: result.message } }
      const list = Array.isArray(result.data) ? result.data : []
      return {
        status: 200,
        body: {
          ok: true,
          repos: list.map((item) => ({
            fullName: asText(item?.full_name),
            private: item?.private === true,
            defaultBranch: asText(item?.default_branch) || 'main',
            updatedAt: asText(item?.updated_at),
          })),
        },
      }
    },

    'auth.set': async (payload) => {
      const token = asText(payload.token).trim()
      if (token === '') return { status: 400, body: { ok: false, message: '请粘贴 token' } }
      const result = await createGh(() => token)('GET', '/user')
      if (!result.ok) {
        return {
          status: 401,
          body: { ok: false, message: result.status === 401 ? 'token 无效或已过期' : result.message },
        }
      }
      const account = {
        login: asText(result.data?.login),
        avatarUrl: asText(result.data?.avatar_url),
      }
      writeAuthRecord(config.authPath, {
        token,
        source: 'pat',
        savedAt: new Date().toISOString(),
        account,
      })
      return { status: 200, body: { ok: true, account, message: `已绑定 @${account.login}` } }
    },

    'auth.status': async () => {
      const result = await gh('GET', '/user')
      if (!result.ok) {
        return { status: 401, body: { ok: false, message: result.status === 401 ? 'token 无效或已过期' : result.message } }
      }
      const account = { login: asText(result.data?.login), avatarUrl: asText(result.data?.avatar_url) }
      const record = readAuthRecord(config.authPath)
      if (record !== null) writeAuthRecord(config.authPath, { ...record, account })
      return { status: 200, body: { ok: true, account } }
    },

    'auth.clear': () => {
      if (!existsSync(config.authPath)) return { status: 200, body: { ok: true, cleared: false } }
      try {
        writeFileSync(config.authPath, '{}\n', { mode: 0o600 })
        return { status: 200, body: { ok: true, cleared: true } }
      } catch (error) {
        return { status: 400, body: { ok: false, message: messageOf(error) } }
      }
    },

    'file.read': (payload) => {
      const rel = asText(payload.path)
      const text = readMemory(root, rel)
      if (text === null) return { status: 404, body: { ok: false, message: `没有找到 ${rel}` } }
      return { status: 200, body: { ok: true, path: rel, text } }
    },

    'file.write': (payload) => {
      const result = writeMemory(root, asText(payload.path), asText(payload.text))
      if (!result.ok) return { status: 400, body: { ok: false, message: result.message } }
      schedulePush()
      return { status: 200, body: { ok: true, path: result.path, bytes: result.bytes, state: stateBody() } }
    },

    'file.delete': (payload) => {
      const rel = asText(payload.path)
      if (rel === CORE_FILE) return { status: 400, body: { ok: false, message: `${CORE_FILE} 不允许删除` } }
      const removed = deleteMemory(root, rel)
      return { status: 200, body: { ok: true, removed } }
    },

    'seed': () => {
      if (existsSync(join(root, CORE_FILE))) {
        return { status: 200, body: { ok: true, created: false, message: `${CORE_FILE} 已存在` } }
      }
      const result = writeMemory(root, CORE_FILE, SEED_CORE)
      return { status: result.ok ? 200 : 400, body: { ok: result.ok, created: result.ok, message: result.message ?? `已创建 ${CORE_FILE}` } }
    },
  }

  const sendJson = (res, status, body) => {
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(payload)
  }

  const isLoopback = (req) => {
    const address = req.socket?.remoteAddress ?? ''
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  }

  const sameOrigin = (req) => {
    const origin = req.headers?.origin
    if (typeof origin !== 'string' || origin === '') return true
    try {
      const host = new URL(origin).hostname
      return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
    } catch {
      return false
    }
  }

  const guarded = (req) => isLoopback(req) && sameOrigin(req)

  const readBody = (req, limit = 4 * 1024 * 1024) => new Promise((settle) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        settle(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return settle({})
      try {
        settle(JSON.parse(text))
      } catch {
        settle(null)
      }
    })
    req.on('error', () => settle(null))
  })

  const forbidden = (res) => sendJson(res, 403, { ok: false, message: '仅允许本机同源访问' })

  const actionHandler = async (req, res) => {
    const body = await readBody(req)
    if (body === null) return sendJson(res, 400, { ok: false, message: '请求体不是合法 JSON' })
    const handler = dispatch[asText(body.action)]
    if (handler === undefined) return sendJson(res, 400, { ok: false, message: `未知动作：${asText(body.action)}` })
    try {
      const result = await handler(body)
      if (result?.body?.ok === false) runtime.lastError = asText(result.body.message)
      sendJson(res, result?.status ?? 200, result?.body ?? { ok: false, message: '空响应' })
    } catch (error) {
      const message = messageOf(error)
      runtime.lastError = message
      sendJson(res, 409, { ok: false, message })
    }
  }

  const routes = [
    {
      kind: 'exact',
      path: `${API}/state`,
      handler: (req, res) => (guarded(req) ? sendJson(res, 200, stateBody()) : forbidden(res)),
    },
    {
      kind: 'exact',
      path: `${API}/action`,
      handler: (req, res) => {
        if (!guarded(req)) return forbidden(res)
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: '请使用 POST' })
        return actionHandler(req, res)
      },
    },
  ]

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    runtime.note = getRepo() === '' ? 'dsh-memory 已就绪，等待绑定记忆仓库' : 'dsh-memory 已就绪'
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          /* the carrier may already be gone */
        }
      }
    }
  })

  /* One pull shortly after startup: late enough not to slow the boot, early
     enough that the first conversation of the day sees the other machine's
     notes. */
  ctx.effect(() => {
    let cancelled = false
    if (config.autoPull && getRepo() !== '' && getToken() !== '') {
      const timer = setTimeout(() => {
        if (cancelled) return
        void sync.pull().then((result) => {
          if (cancelled) return
          runtime.note = result.ok ? `启动同步：${result.message}` : `启动同步失败：${result.message}`
        })
      }, 1500)
      return () => {
        cancelled = true
        clearTimeout(timer)
        if (pushTimer !== null) clearTimeout(pushTimer)
      }
    }
    return () => {
      cancelled = true
      if (pushTimer !== null) clearTimeout(pushTimer)
    }
  })
}

export const internals = {
  DEFAULTS,
  API,
  resolveConfig,
  dshHome,
  readAuthRecord,
  writeAuthRecord,
  loadState,
  saveStateTo,
  createGh,
  describeFiles,
  describeHits,
  describeFailure,
}
