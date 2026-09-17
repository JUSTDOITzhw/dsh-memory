# dsh-memory

Long-term memory for [dsh](https://deepseek-harness.github.io/deepseek-harness/) that lives in a **private GitHub repository**, so the same notes follow you between machines.

The core memory is injected into every turn; the rest is searched on demand; a write from the model is pushed automatically. Bind once per machine, and both of them share one memory folder.

```
$DSH_HOME/memory/
  MEMORY.md          core memory — injected into every conversation
  notes/*.md         detail — read on demand through memory_search / memory_read
  conflicts/*.md     a local edit that lost a race with another machine
```

## What it does

**Injected core memory.** `MEMORY.md` is registered as a prompt section (`order 400`, `interpolate: false`) and re-read on every assembly. Edit the file and the next turn already knows; no restart, no re-index. The section disappears entirely when the file is empty, so an empty memory costs nothing.

**Four tools, so the model maintains its own memory.**

| Tool | Purpose |
|---|---|
| `memory_list` | What files exist, and how big |
| `memory_read` | Full text of one file |
| `memory_search` | Case-insensitive line search across everything |
| `memory_write` | Append (default) or replace, then queue a push |

`memory_write` is described narrowly on purpose — cross-session facts only (preferences, environment, conventions, traps). Progress notes and one-off conclusions stay in the conversation.

**Automatic sync.** The memory folder is the working copy; the private repository is the source of truth. A pull runs shortly after startup, and a write is pushed after a short debounce. Both are serialized, so a button press cannot interleave with a tool call.

**Conflicts are never destructive.** If a file changed locally *and* remotely since the last sync, the remote version wins the live path and the local version is parked under `conflicts/`, stamped with the machine name. A deletion on the remote side never deletes a local memory.

**Zero runtime dependencies.** The host half imports nothing outside Node's standard library — not even `@deepseek-ai/dsh-tools` (its `defineTool` is replaced by a local equivalent). That is what makes a `link:`ed development checkout load at all: a plugin living outside the profile cannot resolve the official packages, and a static import would take the whole plugin tree down at boot.

## Install

```
dsh plugin --profile web add github:JUSTDOITzhw/dsh-memory
```

Restart dsh, then open the **记忆** badge at the foot of the sidebar.

Then, once per machine:

1. **Bind a GitHub account** — paste a personal access token with `repo` scope. If `dsh-github-manager` is already bound, this plugin reuses its credential and the step is skipped.
2. **Bind a memory repository** — `owner/name` of a **private** repository, or create one from the panel (it is created private, with an initial commit so pushes have a branch to land on).

Repeat on the next machine, pointing at the same repository. That is the whole cross-machine story.

## Configuration

Optional — the panel covers the normal path. In the profile's plugin config:

```yaml
- id: memory
  name: dsh-memory
  config:
    repo: ''                 # owner/name; empty means "bind it in the panel"
    branch: ''               # empty means "adopt the repository's default branch"
    maxCoreBytes: 8192       # budget for the injected core memory
    autoPull: true           # one pull shortly after startup
    autoPush: true           # push after memory_write, debounced
    pushDelayMs: 5000
    sectionOrder: 400        # where the section sits in the system prompt
    searchLimit: 40          # max lines one search returns
    memoryDir: ''            # default $DSH_HOME/memory
    authPath: ''             # default $DSH_HOME/dsh-memory/auth.json
    statePath: ''            # default $DSH_HOME/dsh-memory/state.json
```

## Panel

- **同步** — repository, branch, last pull/push, what is waiting to go out, the file list with an inline editor, and **看注入内容**: the literal text every turn carries, rendered from the same function the prompt section calls.
- **设置** — account binding, repository binding (with a picker over your repositories), and creating a new private memory repository.

## Credential handling

The token is stored at `$DSH_HOME/dsh-memory/auth.json` with mode `0600`, or read from `$DSH_HOME/github-manager/auth.json` when this plugin has none of its own. **It is never sent to the browser half** — the panel only ever learns the login and the sync state. All routes are loopback-and-same-origin guarded.

## Tests

```
node test/smoke.mjs      # 47 checks
```

Covers path-traversal rejection, atomic writes, search, the core-memory budget, and the whole sync decision tree (pull / push / both-sides-changed / stale-sha retry / serialized entry points) against an in-memory GitHub — including the conflict branches that are painful to reproduce by hand.

## License

MIT
