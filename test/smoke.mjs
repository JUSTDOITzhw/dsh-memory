/**
 * dsh-memory smoke test.
 *
 * Runs against a temporary memory folder and an in-memory GitHub, so the whole
 * sync decision tree — including the conflict branches that are painful to
 * reproduce by hand — is pinned by evidence rather than by argument.
 *
 *   node test/smoke.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as store from '../lib/store.js'
import {
  conflictPathFor,
  createSync,
  encodePath,
  emptyState,
  parseRepo,
  stamp,
} from '../lib/sync.js'

const failures = []
let checks = 0

function test(name, body) {
  checks += 1
  try {
    body()
  } catch (error) {
    failures.push({ name, error })
  }
}

async function testAsync(name, body) {
  checks += 1
  try {
    await body()
  } catch (error) {
    failures.push({ name, error })
  }
}

const tmp = (tag) => mkdtempSync(join(tmpdir(), `dsh-memory-${tag}-`))

/* ------------------------------------------------------------------ *
 * store
 * ------------------------------------------------------------------ */

test('safeRel 接受普通的相对路径', () => {
  assert.equal(store.safeRel('MEMORY.md'), 'MEMORY.md')
  assert.equal(store.safeRel('notes/a.md'), 'notes/a.md')
  assert.equal(store.safeRel('./notes/a.md'), 'notes/a.md')
  assert.equal(store.safeRel('notes\\a.md'), 'notes/a.md')
  assert.equal(store.safeRel('  notes/a.md  '), 'notes/a.md')
})

test('safeRel 拒绝越界与非 markdown', () => {
  assert.equal(store.safeRel('../x.md'), null)
  assert.equal(store.safeRel('notes/../../x.md'), null)
  assert.equal(store.safeRel('/etc/passwd.md'), null)
  assert.equal(store.safeRel('C:/x.md'), null)
  assert.equal(store.safeRel('notes/'), null)
  assert.equal(store.safeRel(''), null)
  assert.equal(store.safeRel('   '), null)
  assert.equal(store.safeRel('a.txt'), null)
  assert.equal(store.safeRel('a/b/c/d/e.md'), null)
  assert.equal(store.safeRel(null), null)
  assert.equal(store.safeRel('notes/\0evil.md'), null)
})

test('isUnder 只看真正的子路径', () => {
  const root = join(tmpdir(), 'root')
  assert.equal(store.isUnder(root, join(root, 'a.md')), true)
  assert.equal(store.isUnder(root, join(root, 'notes', 'a.md')), true)
  assert.equal(store.isUnder(root, join(tmpdir(), 'root-evil', 'a.md')), false)
  assert.equal(store.isUnder(root, root), false)
})

test('写读往返保留中文与换行', () => {
  const root = tmp('rw')
  const text = '# 记忆\n\n- 偏好：说话简短\n- 路径：C:\\Users\\张\n'
  const written = store.writeMemory(root, 'notes/zh.md', text)
  assert.equal(written.ok, true)
  assert.equal(written.path, 'notes/zh.md')
  assert.equal(store.readMemory(root, 'notes/zh.md'), text)
  rmSync(root, { recursive: true, force: true })
})

test('写入拒绝非法路径与超大内容', () => {
  const root = tmp('guard')
  assert.equal(store.writeMemory(root, '../escape.md', 'x').ok, false)
  assert.equal(store.writeMemory(root, 'a.txt', 'x').ok, false)
  const huge = 'a'.repeat(store.MAX_FILE_BYTES + 1)
  assert.equal(store.writeMemory(root, 'big.md', huge).ok, false)
  rmSync(root, { recursive: true, force: true })
})

test('appendMemory 新建与追加', () => {
  const root = tmp('append')
  const created = store.appendMemory(root, 'notes/log.md', '第一行')
  assert.equal(created.ok, true)
  assert.equal(store.readMemory(root, 'notes/log.md'), '第一行\n')
  store.appendMemory(root, 'notes/log.md', '第二行')
  assert.equal(store.readMemory(root, 'notes/log.md'), '第一行\n第二行\n')
  store.appendMemory(root, 'notes/log.md', '第三行\n')
  assert.equal(store.readMemory(root, 'notes/log.md'), '第一行\n第二行\n第三行\n')
  assert.equal(store.appendMemory(root, '../x.md', 'nope').ok, false)
  rmSync(root, { recursive: true, force: true })
})

test('listMemory 让核心文件排第一并过滤杂项', () => {
  const root = tmp('list')
  store.ensureRoot(root)
  store.writeMemory(root, 'MEMORY.md', 'core')
  store.writeMemory(root, 'notes/b.md', 'b')
  store.writeMemory(root, 'notes/a.md', 'a')
  store.writeMemory(root, 'conflicts/x.md', 'c')
  writeFileSync(join(root, 'notes', 'notes.txt'), 'ignored')
  mkdirSync(join(root, '.hidden'), { recursive: true })
  writeFileSync(join(root, '.hidden', 'secret.md'), 'ignored')
  const paths = store.listMemory(root).map((file) => file.path)
  assert.deepEqual(paths, ['MEMORY.md', 'conflicts/x.md', 'notes/a.md', 'notes/b.md'])
  rmSync(root, { recursive: true, force: true })
})

test('searchMemory 给出行号并尊重 limit', () => {
  const root = tmp('search')
  store.writeMemory(root, 'MEMORY.md', 'alpha\nbeta\nALPHA again\n')
  store.writeMemory(root, 'notes/n.md', 'alpha in notes\n')
  const hits = store.searchMemory(root, 'alpha')
  assert.equal(hits.length, 3)
  assert.deepEqual(hits[0], { path: 'MEMORY.md', line: 1, text: 'alpha' })
  assert.equal(hits[1].line, 3)
  assert.equal(hits[2].path, 'notes/n.md')
  assert.equal(store.searchMemory(root, 'alpha', { limit: 1 }).length, 1)
  assert.equal(store.searchMemory(root, '').length, 0)
  rmSync(root, { recursive: true, force: true })
})

test('snapshot 的 hash 跟着内容走', () => {
  const root = tmp('snap')
  store.writeMemory(root, 'MEMORY.md', 'one')
  const first = store.snapshot(root)
  const second = store.snapshot(root)
  assert.deepEqual(first, second)
  store.writeMemory(root, 'MEMORY.md', 'two')
  assert.notEqual(store.snapshot(root)['MEMORY.md'].hash, first['MEMORY.md'].hash)
  rmSync(root, { recursive: true, force: true })
})

test('renderCore 为空目录返回空串（不占 token）', () => {
  const root = tmp('empty')
  store.ensureRoot(root)
  assert.equal(store.renderCore(root), '')
  store.writeMemory(root, 'MEMORY.md', '   \n\n')
  assert.equal(store.renderCore(root), '')
  rmSync(root, { recursive: true, force: true })
})

test('renderCore 带上笔记索引', () => {
  const root = tmp('core')
  store.writeMemory(root, 'MEMORY.md', '# 核心\n- 说话简短')
  store.writeMemory(root, 'notes/ue.md', 'ue notes')
  const out = store.renderCore(root, { maxBytes: 4096 })
  assert.ok(out.includes('# 核心'), '核心内容应在')
  assert.ok(out.includes('memory_read'), '应提示如何读细节')
  assert.ok(out.includes('notes/ue.md'), '笔记索引应在')
  assert.ok(!out.includes('（核心记忆超出预算'), '没超预算就不该有截断提示')
  rmSync(root, { recursive: true, force: true })
})

test('renderCore 超预算时截断并说明', () => {
  const root = tmp('clip')
  store.writeMemory(root, 'MEMORY.md', '中'.repeat(400))
  const out = store.renderCore(root, { maxBytes: 300 })
  assert.ok(out.includes('已被截断'), '应给出截断提示')
  assert.ok(!out.includes('\uFFFD'), '不能切碎多字节字符')
  rmSync(root, { recursive: true, force: true })
})

test('clip 边界', () => {
  assert.deepEqual(store.clip('abc', 10), { text: 'abc', truncated: false })
  assert.deepEqual(store.clip('abc', 3), { text: 'abc', truncated: false })
  assert.equal(store.clip('abcd', 3).truncated, true)
  assert.equal(store.clip('中中中', 4).text, '中')
  assert.equal(store.clip('', 0).text, '')
})

test('base64 往返', () => {
  const text = '中文 mixed\n{{literal}}\n'
  assert.equal(store.decodeBase64(store.encodeBase64(text)), text)
  assert.equal(store.decodeBase64(''), '')
  assert.equal(store.decodeBase64(null), '')
})

/* ------------------------------------------------------------------ *
 * sync — pure helpers
 * ------------------------------------------------------------------ */

test('parseRepo 归一化各种写法', () => {
  assert.deepEqual(parseRepo('me/mem'), { owner: 'me', name: 'mem', full: 'me/mem' })
  assert.deepEqual(parseRepo(' https://github.com/me/mem.git ')?.full, 'me/mem')
  assert.deepEqual(parseRepo('me/mem/')?.full, 'me/mem')
  assert.equal(parseRepo('me'), null)
  assert.equal(parseRepo('me/mem/extra'), null)
  assert.equal(parseRepo(''), null)
  assert.equal(parseRepo(null), null)
  assert.equal(parseRepo('me/mem?x=1'), null)
})

test('encodePath 只编码段', () => {
  assert.equal(encodePath('notes/a b.md'), 'notes/a%20b.md')
  assert.equal(encodePath('MEMORY.md'), 'MEMORY.md')
})

test('冲突副本的命名可排序且带主机名', () => {
  const at = new Date('2026-09-17T10:30:00Z')
  assert.equal(stamp(at), '2026-09-17-10-30-00')
  assert.equal(conflictPathFor('MEMORY.md', 'desk', at), 'conflicts/MEMORY-2026-09-17-10-30-00-desk.md')
  assert.equal(conflictPathFor('notes/ue.md', 'a b!', at), 'conflicts/notes-ue-2026-09-17-10-30-00-ab.md')
})

/* ------------------------------------------------------------------ *
 * sync — against an in-memory GitHub
 * ------------------------------------------------------------------ */

/**
 * The smallest GitHub that can answer the three calls the engine makes, plus
 * the failure modes that matter: a stale sha on PUT, and a missing branch.
 */
function fakeGitHub({ files = {}, branch = 'main', empty = false, repoExists = true } = {}) {
  const state = { branch, repo: { private: true, defaultBranch: branch }, files: {} }
  for (const [path, text] of Object.entries(files)) state.files[path] = { text, sha: `sha-${path}-${text.length}` }
  let counter = 0
  const calls = []
  let putFailure = null

  const gh = async (method, path, options = {}) => {
    calls.push({ method, path, body: options.body })
    const url = new URL(`https://api.github.com${path}`)
    const segments = url.pathname.split('/').filter((part) => part !== '').map(decodeURIComponent)

    if (segments[0] === 'user' && segments[1] === 'repos' && method === 'POST') {
      return { ok: true, status: 201, data: { full_name: 'me/created', default_branch: 'main', html_url: 'https://github.com/me/created' }, message: '' }
    }
    if (segments[0] !== 'repos') return { ok: false, status: 404, data: null, message: 'not found' }
    if (!repoExists) return { ok: false, status: 404, data: null, message: 'Not Found' }
    /* Everything after /repos/{owner}/{repo}; empty means the repo itself. */
    const rest = segments.slice(3)

    if (rest[0] === 'git' && rest[1] === 'trees') {
      if (empty) return { ok: false, status: 409, data: null, message: 'Git Repository is empty.' }
      const tree = Object.entries(state.files).map(([path, entry]) => ({
        path,
        type: 'blob',
        sha: entry.sha,
        size: Buffer.byteLength(entry.text, 'utf8'),
      }))
      return { ok: true, status: 200, data: { tree }, message: '' }
    }

    if (rest[0] === 'contents') {
      const rel = rest.slice(1).join('/')
      if (method === 'GET') {
        const entry = state.files[rel]
        if (entry === undefined) return { ok: false, status: 404, data: null, message: 'Not Found' }
        return {
          ok: true,
          status: 200,
          data: { sha: entry.sha, encoding: 'base64', content: store.encodeBase64(entry.text) },
          message: '',
        }
      }
      if (method === 'PUT') {
        if (putFailure !== null) {
          const failure = putFailure
          putFailure = null
          return { ok: false, status: failure.status, data: null, message: failure.message }
        }
        const body = options.body ?? {}
        const current = state.files[rel]
        if (body.sha !== undefined && current !== undefined && current.sha !== body.sha) {
          return { ok: false, status: 409, data: null, message: 'sha does not match' }
        }
        if (body.sha !== undefined && current === undefined) {
          return { ok: false, status: 422, data: null, message: 'sha is invalid' }
        }
        counter += 1
        const text = store.decodeBase64(body.content)
        const sha = `put-${counter}`
        state.files[rel] = { text, sha }
        return { ok: true, status: 201, data: { content: { sha } }, message: '' }
      }
    }

    if (rest.length === 0 && method === 'GET') {
      return { ok: true, status: 200, data: { private: state.repo.private, default_branch: state.repo.defaultBranch }, message: '' }
    }
    return { ok: false, status: 404, data: null, message: 'not found' }
  }

  return {
    gh,
    state,
    calls,
    setPutFailure: (failure) => { putFailure = failure },
  }
}

function engine({ github, root, repo = 'me/mem', token = 'tok' }) {
  const state = emptyState()
  const sync = createSync({
    gh: github.gh,
    store,
    getToken: () => token,
    root,
    state,
    saveState: () => {},
    getRepo: () => repo,
    getBranch: () => 'main',
    now: () => new Date('2026-09-17T10:30:00Z'),
    host: 'testbox',
    log: () => {},
  })
  return { sync, state }
}

await testAsync('拉取：未配置仓库时明确失败', async () => {
  const root = tmp('norepo')
  const { sync } = engine({ github: fakeGitHub(), root, repo: '' })
  const result = await sync.pull()
  assert.equal(result.ok, false)
  assert.match(result.message, /尚未配置记忆仓库/)
  rmSync(root, { recursive: true, force: true })
})

await testAsync('拉取：没有凭据时不发请求', async () => {
  const root = tmp('notoken')
  const github = fakeGitHub()
  const { sync } = engine({ github, root, token: '' })
  const result = await sync.pull()
  assert.equal(result.ok, false)
  assert.equal(github.calls.length, 0)
  rmSync(root, { recursive: true, force: true })
})

await testAsync('拉取：空仓库不算错误', async () => {
  const root = tmp('emptyremote')
  const { sync } = engine({ github: fakeGitHub({ empty: true }), root })
  const result = await sync.pull()
  assert.equal(result.ok, true)
  assert.equal(result.empty, true)
  assert.match(result.message, /还没有内容/)
  rmSync(root, { recursive: true, force: true })
})

await testAsync('拉取：远端新文件落到本地并记账', async () => {
  const root = tmp('pullnew')
  store.ensureRoot(root)
  const github = fakeGitHub({ files: { 'MEMORY.md': '# 远端核心', 'notes/a.md': 'A' } })
  const { sync, state } = engine({ github, root })
  const result = await sync.pull()
  assert.equal(result.ok, true)
  assert.deepEqual(result.pulled, ['MEMORY.md', 'notes/a.md'])
  assert.equal(store.readMemory(root, 'MEMORY.md'), '# 远端核心')
  assert.equal(store.readMemory(root, 'notes/a.md'), 'A')
  assert.equal(typeof state.files['MEMORY.md'].sha, 'string')
  assert.equal(state.files['MEMORY.md'].hash, store.hashOf('# 远端核心'))
  assert.equal(state.lastPullAt, '2026-09-17T10:30:00.000Z')
  rmSync(root, { recursive: true, force: true })
})

await testAsync('拉取：远端改了而本地没动 → 覆盖本地', async () => {
  const root = tmp('pullclean')
  store.writeMemory(root, 'MEMORY.md', 'old')
  const github = fakeGitHub({ files: { 'MEMORY.md': 'new' } })
  const { sync, state } = engine({ github, root })
  /* Pretend we synced when the remote said "old". */
  state.files['MEMORY.md'] = { sha: github.state.files['MEMORY.md'].sha, hash: store.hashOf('old') }
  github.state.files['MEMORY.md'] = { text: 'new', sha: 'sha-new' }
  const result = await sync.pull()
  assert.deepEqual(result.pulled, ['MEMORY.md'])
  assert.equal(store.readMemory(root, 'MEMORY.md'), 'new')
  rmSync(root, { recursive: true, force: true })
})

await testAsync('拉取：本地改了而远端没动 → 本地不动，留给推送', async () => {
  const root = tmp('pulllocal')
  store.writeMemory(root, 'MEMORY.md', 'local edit')
  const github = fakeGitHub({ files: { 'MEMORY.md': 'remote' } })
  const { sync, state } = engine({ github, root })
  state.files['MEMORY.md'] = { sha: github.state.files['MEMORY.md'].sha, hash: store.hashOf('remote') }
  const result = await sync.pull()
  assert.deepEqual(result.pulled, [])
  assert.equal(store.readMemory(root, 'MEMORY.md'), 'local edit')
  assert.equal(sync.status().pendingPush.includes('MEMORY.md'), true)
  rmSync(root, { recursive: true, force: true })
})

await testAsync('拉取：两边都改 → 远端胜出，本地版本进 conflicts/', async () => {
  const root = tmp('pullclash')
  store.writeMemory(root, 'MEMORY.md', 'local version')
  const github = fakeGitHub({ files: { 'MEMORY.md': 'remote version' } })
  const { sync, state } = engine({ github, root })
  state.files['MEMORY.md'] = { sha: 'stale-sha', hash: store.hashOf('base version') }
  const result = await sync.pull()
  assert.equal(result.conflicts.length, 1)
  assert.equal(result.conflicts[0].path, 'MEMORY.md')
  assert.equal(store.readMemory(root, 'MEMORY.md'), 'remote version')
  const copy = store.readMemory(root, result.conflicts[0].copy)
  assert.ok(copy.includes('local version'), '冲突副本要留住本地内容')
  assert.ok(copy.includes('冲突'), '冲突副本要说明来由')
  assert.equal(state.files['MEMORY.md'].hash, store.hashOf('remote version'))
  rmSync(root, { recursive: true, force: true })
})

await testAsync('拉取：内容其实一样时不制造冲突', async () => {
  const root = tmp('samecontent')
  store.writeMemory(root, 'MEMORY.md', 'same')
  const github = fakeGitHub({ files: { 'MEMORY.md': 'same' } })
  const { sync, state } = engine({ github, root })
  const result = await sync.pull()
  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(result.pulled, [])
  assert.equal(state.files['MEMORY.md'].hash, store.hashOf('same'))
  rmSync(root, { recursive: true, force: true })
})

await testAsync('拉取：本地独有文件不被远端删除', async () => {
  const root = tmp('localsurvive')
  store.writeMemory(root, 'MEMORY.md', 'shared')
  store.writeMemory(root, 'notes/mine.md', 'only here')
  const github = fakeGitHub({ files: { 'MEMORY.md': 'shared' } })
  const { sync, state } = engine({ github, root })
  state.files['notes/mine.md'] = { sha: 'was-remote', hash: store.hashOf('only here') }
  const result = await sync.pull()
  assert.equal(store.readMemory(root, 'notes/mine.md'), 'only here')
  assert.equal(state.files['notes/mine.md'], undefined, '记账清掉，等推送重建')
  assert.equal(sync.status().unsynced.includes('notes/mine.md'), true)
  rmSync(root, { recursive: true, force: true })
})

await testAsync('推送：新文件带上内容与提交信息', async () => {
  const root = tmp('pushnew')
  store.writeMemory(root, 'MEMORY.md', 'fresh')
  const github = fakeGitHub({ files: {} })
  const { sync, state } = engine({ github, root })
  const result = await sync.push()
  assert.equal(result.ok, true)
  assert.deepEqual(result.pushed, ['MEMORY.md'])
  assert.equal(github.state.files['MEMORY.md'].text, 'fresh')
  assert.match(github.calls.at(-1).body.message, /dsh-memory: MEMORY\.md from testbox/)
  assert.equal(state.files['MEMORY.md'].sha, 'put-1')
  rmSync(root, { recursive: true, force: true })
})

await testAsync('推送：没改动的文件不重复提交', async () => {
  const root = tmp('pushnoop')
  store.writeMemory(root, 'MEMORY.md', 'stable')
  const github = fakeGitHub({ files: { 'MEMORY.md': 'stable' } })
  const { sync, state } = engine({ github, root })
  state.files['MEMORY.md'] = { sha: github.state.files['MEMORY.md'].sha, hash: store.hashOf('stable') }
  const result = await sync.push()
  assert.deepEqual(result.pushed, [])
  assert.deepEqual(result.skipped, ['MEMORY.md'])
  assert.equal(github.calls.filter((call) => call.method === 'PUT').length, 0)
  rmSync(root, { recursive: true, force: true })
})

await testAsync('推送：本地改动用旧 sha 做乐观锁', async () => {
  const root = tmp('pushlock')
  store.writeMemory(root, 'MEMORY.md', 'changed locally')
  const github = fakeGitHub({ files: { 'MEMORY.md': 'original' } })
  const { sync, state } = engine({ github, root })
  const before = github.state.files['MEMORY.md'].sha
  state.files['MEMORY.md'] = { sha: before, hash: store.hashOf('original') }
  const result = await sync.push()
  assert.deepEqual(result.pushed, ['MEMORY.md'])
  const put = github.calls.filter((call) => call.method === 'PUT').at(-1)
  assert.equal(put.body.sha, before, '要用读到的旧 sha 做乐观锁')
  rmSync(root, { recursive: true, force: true })
})

await testAsync('推送：远端并发改动且内容不同 → 冲突副本，远端不被覆盖', async () => {
  const root = tmp('pushclash')
  store.writeMemory(root, 'MEMORY.md', 'mine')
  const github = fakeGitHub({ files: { 'MEMORY.md': 'theirs' } })
  const { sync, state } = engine({ github, root })
  state.files['MEMORY.md'] = { sha: 'old-sha', hash: store.hashOf('base') }
  const result = await sync.push()
  assert.equal(result.conflicts.length, 1)
  assert.equal(github.state.files['MEMORY.md'].text, 'theirs', '远端必须保住')
  assert.equal(store.readMemory(root, 'MEMORY.md'), 'theirs', '本地回到远端版本')
  assert.ok(store.readMemory(root, result.conflicts[0].copy).includes('mine'), '本地版本进冲突副本')
  rmSync(root, { recursive: true, force: true })
})

await testAsync('推送：远端并发改动但内容一致 → 只修记账，不算冲突', async () => {
  const root = tmp('pushsame')
  store.writeMemory(root, 'MEMORY.md', 'identical')
  const github = fakeGitHub({ files: { 'MEMORY.md': 'identical' } })
  const { sync, state } = engine({ github, root })
  state.files['MEMORY.md'] = { sha: 'old-sha', hash: store.hashOf('other') }
  const result = await sync.push()
  assert.deepEqual(result.conflicts, [])
  assert.equal(result.ok, true)
  rmSync(root, { recursive: true, force: true })
})

await testAsync('推送：失败时把错误记进状态而不是抛出去', async () => {
  const root = tmp('pushfail')
  store.writeMemory(root, 'MEMORY.md', 'x')
  const github = fakeGitHub({ files: {} })
  const { sync, state } = engine({ github, root })
  github.setPutFailure({ status: 500, message: '服务器错误' })
  const result = await sync.push()
  assert.equal(result.ok, false)
  assert.equal(result.failed.length, 1)
  assert.match(state.lastError, /服务器错误/)
  rmSync(root, { recursive: true, force: true })
})

await testAsync('推送：并发调用被串行化', async () => {
  const root = tmp('serial')
  store.writeMemory(root, 'MEMORY.md', 'x')
  const github = fakeGitHub({ files: {} })
  const { sync } = engine({ github, root })
  const [first, second] = await Promise.all([sync.push(), sync.push()])
  assert.deepEqual(first, second, '第二次应复用同一次运行')
  assert.equal(github.calls.filter((call) => call.method === 'PUT').length, 1)
  rmSync(root, { recursive: true, force: true })
})

await testAsync('status 区分待推送与未记账', async () => {
  const root = tmp('status')
  store.writeMemory(root, 'MEMORY.md', 'known')
  store.writeMemory(root, 'notes/new.md', 'new')
  const github = fakeGitHub({ files: { 'MEMORY.md': 'known' } })
  const { sync, state } = engine({ github, root })
  state.files['MEMORY.md'] = { sha: 'a', hash: store.hashOf('known') }
  const status = sync.status()
  assert.equal(status.fileCount, 2)
  assert.deepEqual(status.pendingPush, [])
  assert.deepEqual(status.unsynced, ['notes/new.md'])
  assert.deepEqual(status.missingLocally, [])
  store.writeMemory(root, 'MEMORY.md', 'edited')
  assert.deepEqual(sync.status().pendingPush, ['MEMORY.md'])
  rmSync(root, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ *
 * client half
 * ------------------------------------------------------------------ */

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
}

let spec = null
globalThis.window = { __ModuleLoader__: { load: (value) => { spec = value } } }
await import('../lib/client.js')
const client = spec.factory((name) => {
  if (name === 'react') return reactStub
  throw new Error(`客户端不应该 require ${name}`)
})

test('客户端模块契约', () => {
  assert.equal(spec.id, 'dsh-memory')
  assert.deepEqual(client.inject, ['slots'])
  assert.equal(typeof client.apply, 'function')
  assert.equal(client.internals.VERSION, '0.1.0')
  assert.equal(client.internals.API, '/api/memory')
})

test('statusTone 覆盖四种状态', () => {
  const { statusTone } = client.internals
  assert.equal(statusTone(null), 'idle')
  assert.equal(statusTone({ ok: true, bound: false, repo: '' }), 'off')
  assert.equal(statusTone({ ok: true, bound: true, repo: 'me/mem', sync: { pendingPush: [], unsynced: [] } }), 'ok')
  assert.equal(statusTone({ ok: true, bound: true, repo: 'me/mem', sync: { pendingPush: ['a'], unsynced: [] } }), 'pending')
  assert.equal(statusTone({ ok: true, bound: true, repo: 'me/mem', sync: { lastError: 'boom' } }), 'error')
})

test('summaryOf 说人话', () => {
  const { summaryOf } = client.internals
  assert.equal(summaryOf(null), '读取中…')
  assert.equal(summaryOf({ ok: true, bound: false }), '未绑定账号')
  assert.equal(summaryOf({ ok: true, bound: true, repo: '' }), '未绑定仓库')
  assert.equal(summaryOf({ ok: true, bound: true, repo: 'me/mem', sync: { fileCount: 0 } }), '记忆为空')
  assert.equal(summaryOf({ ok: true, bound: true, repo: 'me/mem', sync: { fileCount: 3 } }), '3 个文件')
  assert.equal(summaryOf({ ok: true, bound: true, repo: 'me/mem', sync: { fileCount: 3, pendingPush: ['a'] } }), '1 项待推送')
  assert.equal(summaryOf({ ok: true, bound: true, repo: 'me/mem', sync: { lastError: 'x' } }), '同步出错')
})

test('normalizeFiles 丢掉没有路径的行', () => {
  const rows = client.internals.normalizeFiles([
    { path: 'MEMORY.md', bytes: 12, mtime: 'x' },
    { path: '', bytes: 1 },
    null,
    'nonsense',
    { path: 'notes/a.md' },
  ])
  assert.deepEqual(rows, [
    { path: 'MEMORY.md', bytes: 12, mtime: 'x' },
    { path: 'notes/a.md', bytes: 0, mtime: '' },
  ])
})

test('formatBytes / formatWhen', () => {
  const { formatBytes, formatWhen } = client.internals
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(undefined), '0 B')
  assert.equal(formatWhen('', 0), '')
  assert.equal(formatWhen('not-a-date', 0), '')
  const now = Date.parse('2026-09-17T10:30:00Z')
  assert.equal(formatWhen('2026-09-17T10:29:40Z', now), '刚刚')
  assert.equal(formatWhen('2026-09-17T10:00:00Z', now), '30 分钟前')
  assert.equal(formatWhen('2026-09-17T02:30:00Z', now), '8 小时前')
})

test('注入的 CSS 带着槽位契约', () => {
  const css = client.internals.CSS
  assert.ok(css.includes('.dsh-mm-layer{'), 'layer 规则应在')
  assert.ok(css.includes('order:800'), '要排在 github 徽标之上')
  assert.ok(css.includes('.dsh-mm-layer.dsh-mm-rail{'), '折叠成 rail 的变体应在')
  assert.ok(css.includes('.dsh-mm-panel{'), '面板规则应在')
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(css), '不许出现颜色字面量，只能用主题别名')
})

test('apply 把徽标挂到 sidebar.footer.action', () => {
  const registered = []
  const injected = []
  const fakeCtx = {
    slots: {
      inject: (name, body) => { injected.push(name); body() },
      register: (target, component) => { registered.push({ target, component }); return () => {} },
    },
  }
  client.apply(fakeCtx)
  assert.deepEqual(injected, ['sidebar.footer.action'])
  assert.equal(registered.length, 1)
  assert.equal(registered[0].target.name, 'sidebar.footer.action')
  assert.equal(registered[0].target.id, 'memory')
  assert.equal(typeof registered[0].component, 'function')
})

/* ------------------------------------------------------------------ *
 * host half — source contract
 *
 * index.js imports @deepseek-ai/dsh-tools, which only resolves inside a dsh
 * process; the real check for it is the GUI run. Here we pin the parts of the
 * contract that a careless edit would silently break.
 * ------------------------------------------------------------------ */

const hostSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const patchSource = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('宿主声明三条必需服务', () => {
  assert.ok(hostSource.includes("inject = ['tools', 'systemPrompt', 'webServer']"))
})

test('宿主不 import 任何 @deepseek-ai/*（link: 安装下解析不到，会炸掉整棵插件树）', () => {
  assert.ok(!/from\s+'@deepseek-ai\//.test(hostSource), 'index.js 不能静态 import 官方包')
  assert.ok(!/import\(\s*['"]@deepseek-ai\//.test(hostSource), 'index.js 也不能动态 import 官方包')
  assert.ok(hostSource.includes('function defineTool('), '应改用本地 defineTool')
})

test('记忆段不做变量插值（否则字面 {{ }} 会炸掉整次组装）', () => {
  assert.ok(hostSource.includes('interpolate: false'), 'interpolate: false 必须在')
  assert.ok(hostSource.includes("name: 'memory:core'"))
})

test('四个 memory_* 工具都在', () => {
  for (const tool of ['memory_list', 'memory_read', 'memory_search', 'memory_write']) {
    assert.ok(hostSource.includes(`name: '${tool}'`), `${tool} 应该在`)
  }
})

test('路由挂在 /api/memory 下且校验回环同源', () => {
  assert.ok(hostSource.includes("const API = '/api/memory'"))
  assert.ok(hostSource.includes('isLoopback'))
  assert.ok(hostSource.includes('sameOrigin'))
})

test('清单与 patch 声明齐备', () => {
  assert.equal(manifest.name, 'dsh-memory')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(manifest.files.includes('lib'))
  assert.ok(manifest.exports['./client'].endsWith('lib/client.js'))
  assert.ok(patchSource.includes('name: dsh-memory'))
  assert.ok(patchSource.includes('id: memory'))
})

/* ------------------------------------------------------------------ */

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length}/${checks} 项失败\n`)
  for (const { name, error } of failures) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${error instanceof Error ? error.message : String(error)}`)
    if (error instanceof Error && error.expected !== undefined) {
      console.error(`    expected: ${JSON.stringify(error.expected)}`)
      console.error(`    actual:   ${JSON.stringify(error.actual)}`)
    }
  }
  process.exit(1)
}

console.log(`✓ dsh-memory smoke: ${checks} 项全部通过`)
