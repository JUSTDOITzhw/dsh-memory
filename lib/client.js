/**
 * dsh-memory — browser half.
 *
 * Contributes one action into the `sidebar.footer.action` slot: a memory badge
 * at the foot of the sidebar. Opening it renders a frame-wide panel with two
 * tabs — sync and setup — which drive the host half's loopback routes. The
 * GitHub token never reaches this half; it only ever sees the login and the
 * sync state.
 *
 * Packaged as a loader lazy-CJS factory product: the whole module body lives
 * inside the factory closure and runs at materialization. Only the
 * platform-seeded `react` module is required, so the bundle stays pure.
 *
 * Styling follows the same rules as the other in-tree panels: `--dsw-alias-*`
 * semantic aliases only, no colour literals, no theme branches.
 */
window.__ModuleLoader__.load({
  id: "dsh-memory",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    const API = "/api/memory";
    /* Shown in the panel header: the client half is read once at dsh activation
     * and cached, so a restart is the only way to pick up an edit. Printing the
     * version makes "did my restart land?" a one-glance question. */
    const VERSION = "0.1.0";

    const TABS = [
      { id: "sync", label: "同步" },
      { id: "setup", label: "设置" },
    ];

    /* ------------------------------------------------------------------ *
     * Pure helpers (asserted directly by the smoke test)
     * ------------------------------------------------------------------ */

    function formatBytes(bytes) {
      const value = typeof bytes === "number" && Number.isFinite(bytes) ? bytes : 0;
      if (value < 1024) return `${value} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
      return `${(value / 1024 / 1024).toFixed(1)} MB`;
    }

    function formatWhen(iso, now) {
      if (typeof iso !== "string" || iso === "") return "";
      const then = Date.parse(iso);
      if (Number.isNaN(then)) return "";
      const at = typeof now === "number" ? now : Date.now();
      const seconds = Math.max(0, Math.round((at - then) / 1000));
      if (seconds < 60) return "刚刚";
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return `${minutes} 分钟前`;
      const hours = Math.round(minutes / 60);
      if (hours < 24) return `${hours} 小时前`;
      const days = Math.round(hours / 24);
      if (days < 30) return `${days} 天前`;
      return `${Math.round(days / 30)} 个月前`;
    }

    function asText(value) {
      return typeof value === "string" ? value : "";
    }

    /**
     * The one line the badge shows next to "记忆". Ordered by what a glance
     * should answer first: is it configured, is anything wrong, is anything
     * waiting to go out.
     */
    function summaryOf(state) {
      if (state === null || state === undefined || state.ok !== true) return "读取中…";
      if (state.bound !== true) return "未绑定账号";
      if (asText(state.repo) === "") return "未绑定仓库";
      const sync = state.sync ?? {};
      const pending = Array.isArray(sync.pendingPush) ? sync.pendingPush.length : 0;
      const unsynced = Array.isArray(sync.unsynced) ? sync.unsynced.length : 0;
      if (asText(sync.lastError) !== "") return "同步出错";
      if (pending + unsynced > 0) return `${pending + unsynced} 项待推送`;
      const count = typeof sync.fileCount === "number" ? sync.fileCount : 0;
      return count === 0 ? "记忆为空" : `${count} 个文件`;
    }

    /** Which colour the status dot wears. */
    function statusTone(state) {
      if (state === null || state === undefined || state.ok !== true) return "idle";
      if (state.bound !== true || asText(state.repo) === "") return "off";
      if (asText(state.sync?.lastError) !== "") return "error";
      const pending = (state.sync?.pendingPush?.length ?? 0) + (state.sync?.unsynced?.length ?? 0);
      return pending > 0 ? "pending" : "ok";
    }

    /** File rows only need to be as big as what they actually say. */
    function normalizeFiles(payload) {
      const list = Array.isArray(payload) ? payload : [];
      return list
        .map((item) => {
          const row = item !== null && typeof item === "object" ? item : {};
          const path = asText(row.path);
          if (path === "") return null;
          return {
            path,
            bytes: typeof row.bytes === "number" ? row.bytes : 0,
            mtime: asText(row.mtime),
          };
        })
        .filter((row) => row !== null);
    }

    /* ------------------------------------------------------------------ *
     * Host transport
     * ------------------------------------------------------------------ */

    async function getState() {
      try {
        const response = await fetch(`${API}/state`, { headers: { accept: "application/json" } });
        const body = await response.json();
        return body !== null && typeof body === "object" ? body : { ok: false };
      } catch (error) {
        return { ok: false, message: `无法连接宿主：${error && error.message ? error.message : String(error)}` };
      }
    }

    async function post(action, payload) {
      const request = { action, ...(payload === undefined ? {} : payload) };
      try {
        const response = await fetch(`${API}/action`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        });
        const body = await response.json();
        const shaped = body !== null && typeof body === "object" ? body : { ok: false, message: `HTTP ${response.status}` };
        return { status: response.status, ok: shaped.ok === true, body: shaped };
      } catch (error) {
        return {
          status: 0,
          ok: false,
          body: { ok: false, message: `请求失败：${error && error.message ? error.message : String(error)}` },
        };
      }
    }

    /* ------------------------------------------------------------------ *
     * Styling
     * ------------------------------------------------------------------ */

    const CSS = `
.dsh-mm-layer{flex:0 0 auto;align-items:center;width:100%;height:42px;margin:8px 0 0;display:flex;position:relative;order:800}
.dsh-mm-layer.dsh-mm-rail{width:36px;height:36px;margin:0}
.dsh-mm-badge{box-sizing:border-box;width:100%;height:42px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;margin:0;padding:0 10px 0 8px;font-family:inherit;font-size:14px;display:inline-flex;overflow:hidden}
.dsh-mm-badge:hover,.dsh-mm-badge[data-active]{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mm-badgeLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}
.dsh-mm-badgeHint{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;margin-left:auto;font-size:12px;line-height:16px}
.dsh-mm-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-caption)}
.dsh-mm-dot[data-tone=ok]{background:var(--dsw-alias-state-success-primary)}
.dsh-mm-dot[data-tone=pending]{background:var(--dsw-alias-state-warn-primary)}
.dsh-mm-dot[data-tone=error]{background:var(--dsw-alias-state-error-primary)}
.dsh-mm-dot[data-tone=off]{background:var(--dsw-alias-label-caption)}
.dsh-mm-rail .dsh-mm-badge{corner-shape:round;border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;padding:0;margin:0}
.dsh-mm-rail .dsh-mm-dot{position:absolute;top:5px;right:2px}
.dsh-mm-panel{z-index:40;background:var(--dsw-specific-menu);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);width:460px;max-width:calc(100vw - 24px);max-height:min(70vh,640px);box-shadow:var(--dsw-elevation-prominent);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border:0;border-radius:12px;flex-direction:column;display:flex;position:fixed;overflow:hidden}
.dsh-mm-header{box-sizing:border-box;flex:none;justify-content:space-between;align-items:center;min-height:44px;gap:8px;padding:10px 12px;display:flex}
.dsh-mm-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:20px;display:flex;align-items:center;gap:8px;min-width:0}
.dsh-mm-version{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.dsh-mm-x{corner-shape:round;width:26px;height:26px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;justify-content:center;align-items:center;display:inline-flex;flex:none;font-size:16px;line-height:1}
.dsh-mm-x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsh-mm-tabs{flex:none;display:flex;gap:2px;padding:0 12px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dsh-mm-tab{color:var(--dsw-alias-label-tertiary);cursor:pointer;font:var(--dsw-font-xs-13);background:0 0;border:0;padding:0 10px;height:32px;position:relative}
.dsh-mm-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-mm-tab[data-active]{color:var(--dsw-alias-state-business-primary)}
.dsh-mm-tab[data-active]:after{background:var(--dsw-alias-state-business-primary);content:"";border-radius:1px 1px 0 0;height:2px;position:absolute;bottom:0;left:10px;right:10px}
.dsh-mm-body{flex:1;min-height:0;padding:12px;overflow-y:auto;display:flex;flex-direction:column;gap:10px}
.dsh-mm-field{display:flex;flex-direction:column;gap:5px}
.dsh-mm-label{color:var(--dsw-alias-label-caption);font-size:11px;font-weight:500;line-height:16px;text-transform:uppercase;letter-spacing:.04em}
.dsh-mm-input,.dsh-mm-select{border:.5px solid var(--dsw-alias-border-l3);box-sizing:border-box;width:100%;height:30px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);background:var(--dsw-alias-bg-base);border-radius:8px;padding:0 9px}
.dsh-mm-input:focus,.dsh-mm-select:focus{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}
.dsh-mm-input[data-mono]{font-family:var(--dsh-font-mono,monospace);font-size:12px}
.dsh-mm-area{box-sizing:border-box;width:100%;min-height:210px;resize:vertical;color:var(--dsw-alias-label-primary);font-family:var(--dsh-font-mono,monospace);font-size:12px;line-height:18px;background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;padding:8px 9px}
.dsh-mm-area:focus{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}
.dsh-mm-pre{margin:0;max-height:220px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--dsh-font-mono,monospace);font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-markdown-code-block);border-radius:8px;padding:8px 9px}
.dsh-mm-row{display:flex;gap:8px;align-items:center}
.dsh-mm-rowwrap{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dsh-mm-btn{corner-shape:round;border:.5px solid var(--dsw-alias-border-l3);height:28px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13);cursor:pointer;background:0 0;border-radius:999px;align-items:center;justify-content:center;gap:6px;padding:0 12px;display:inline-flex;flex:none}
.dsh-mm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-mm-btn:disabled{opacity:.45;cursor:default}
.dsh-mm-btn[data-variant=primary]{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted)}
.dsh-mm-btn[data-variant=primary]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-label-primary-inverted)}
.dsh-mm-btn[data-variant=danger]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-border-l4)}
.dsh-mm-btn[data-variant=danger]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.dsh-mm-note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsh-mm-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh-mm-ok{color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh-mm-card{border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.dsh-mm-kv{display:flex;justify-content:space-between;gap:10px;font-size:12px;line-height:18px}
.dsh-mm-kv dt{color:var(--dsw-alias-label-tertiary);flex:none;margin:0}
.dsh-mm-kv dd{color:var(--dsw-alias-label-primary);margin:0;min-width:0;text-align:right;overflow-wrap:anywhere}
.dsh-mm-kv dd[data-mono]{font-family:var(--dsh-font-mono,monospace);font-size:11px}
.dsh-mm-list{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.dsh-mm-item{border:.5px solid var(--dsw-alias-border-l4);border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;flex:0 0 auto}
.dsh-mm-item[data-open]{border-color:var(--dsw-alias-state-business-primary)}
.dsh-mm-itemHead{display:flex;align-items:center;gap:8px;cursor:pointer;min-height:20px}
.dsh-mm-itemName{min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.dsh-mm-itemMeta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;flex:none;margin-left:auto}
.dsh-mm-tag{background:var(--dsw-alias-button-ghost-active-fill);height:18px;color:var(--dsw-alias-label-caption);border-radius:9px;flex:none;align-items:center;padding:0 6px;font-size:11px;line-height:18px;display:inline-flex}
.dsh-mm-tag[data-tone=core]{background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-state-business-primary)}
.dsh-mm-split{display:flex;gap:6px}
.dsh-mm-split .dsh-mm-btn{flex:1}
`

    function ensureStyle() {
      if (typeof document === "undefined") return;
      const id = "dsh-memory-style";
      if (document.getElementById(id) !== null) return;
      const style = document.createElement("style");
      style.id = id;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    /* ------------------------------------------------------------------ *
     * Mark
     * ------------------------------------------------------------------ */

    function MemoryMark(props) {
      const size = typeof props?.size === "number" ? props.size : 16;
      return h("svg", {
        width: size,
        height: size,
        viewBox: "0 0 16 16",
        fill: "none",
        "aria-hidden": "true",
        style: { flex: "none" },
      },
        h("path", {
          d: "M3.6 2.4h5.9l2.9 2.9v8.3H3.6z",
          stroke: "currentColor",
          strokeWidth: 1.2,
          strokeLinejoin: "round",
        }),
        h("path", {
          d: "M6.1 7h4.9M6.1 9.5h4.9M6.1 12h2.9",
          stroke: "currentColor",
          strokeWidth: 1.2,
          strokeLinecap: "round",
        }));
    }

    /* ------------------------------------------------------------------ *
     * Tabs
     * ------------------------------------------------------------------ */

    function InfoRow(props) {
      return h("div", { className: "dsh-mm-kv" },
        h("dt", null, props.label),
        h("dd", { "data-mono": props.mono ? "" : undefined }, props.value));
    }

    function SyncTab(props) {
      const { state, refresh, busy, run } = props;
      const sync = state?.sync ?? {};
      const files = normalizeFiles(state?.files);
      const [open, setOpen] = React.useState(null);
      const [draft, setDraft] = React.useState("");
      const [loaded, setLoaded] = React.useState(false);
      const [saved, setSaved] = React.useState("");
      const [preview, setPreview] = React.useState(null);

      /** Show the literal prompt text, so "what does every turn carry?" is
       *  answered by the same string the section provider returns. */
      const showPreview = async () => {
        if (preview !== null) { setPreview(null); return; }
        const answer = await post("section.preview");
        setPreview(answer.ok
          ? {
            text: asText(answer.body?.text),
            bytes: typeof answer.body?.bytes === "number" ? answer.body.bytes : 0,
            maxBytes: typeof answer.body?.maxBytes === "number" ? answer.body.maxBytes : 0,
          }
          : { text: `读取失败：${asText(answer.body?.message)}`, bytes: 0, maxBytes: 0 });
      };

      const openFile = async (path) => {
        if (open === path) { setOpen(null); return; }
        setOpen(path);
        setLoaded(false);
        setSaved("");
        const answer = await post("file.read", { path });
        setDraft(answer.ok ? asText(answer.body.text) : `读取失败：${asText(answer.body?.message)}`);
        setLoaded(true);
      };

      const save = async () => {
        const answer = await post("file.write", { path: open, text: draft });
        setSaved(answer.ok ? "已保存，稍后自动同步" : `保存失败：${asText(answer.body?.message)}`);
        if (answer.ok) refresh();
      };

      const pending = (sync.pendingPush?.length ?? 0) + (sync.unsynced?.length ?? 0);

      return h("div", { className: "dsh-mm-body" },
        h("div", { className: "dsh-mm-rowwrap" },
          h("button", {
            type: "button",
            className: "dsh-mm-btn",
            disabled: busy || state?.bound !== true || asText(state?.repo) === "",
            onClick: () => run("sync.pull"),
          }, busy ? "同步中…" : "立即拉取"),
          h("button", {
            type: "button",
            className: "dsh-mm-btn",
            "data-variant": "primary",
            disabled: busy || state?.bound !== true || asText(state?.repo) === "",
            onClick: () => run("sync.push"),
          }, "立即推送"),
          h("button", {
            type: "button",
            className: "dsh-mm-btn",
            onClick: () => { void showPreview(); },
          }, preview === null ? "看注入内容" : "收起"),
          h("span", { className: "dsh-mm-note", style: { marginLeft: "auto" } },
            state?.autoPush === true ? "写入后自动推送" : "自动推送已关")),

        h("div", { className: "dsh-mm-card" },
          h("dl", { style: { display: "flex", flexDirection: "column", gap: "6px", margin: 0 } },
            h(InfoRow, { label: "仓库", value: asText(state?.repo) || "未绑定", mono: true }),
            h(InfoRow, { label: "分支", value: asText(state?.branch) || "—", mono: true }),
            h(InfoRow, { label: "上次拉取", value: formatWhen(asText(sync.lastPullAt)) || "从未" }),
            h(InfoRow, { label: "上次推送", value: formatWhen(asText(sync.lastPushAt)) || "从未" }),
            h(InfoRow, { label: "待推送", value: pending === 0 ? "无" : `${pending} 个文件` }),
            h(InfoRow, { label: "记忆目录", value: asText(state?.memoryDir) || "—", mono: true })),
          asText(sync.lastError) === "" ? null : h("div", { className: "dsh-mm-error" }, `上次出错：${sync.lastError}`),
          asText(state?.note) === "" ? null : h("div", { className: "dsh-mm-note" }, asText(state.note))),

        preview === null ? null : h("div", { className: "dsh-mm-card" },
          h("span", { className: "dsh-mm-label" }, `每轮注入的内容 · ${preview.bytes} / ${preview.maxBytes} 字节`),
          h("pre", { className: "dsh-mm-pre" },
            preview.text === "" ? "（当前没有可注入的核心记忆）" : preview.text)),

        h("div", { className: "dsh-mm-field" },
          h("span", { className: "dsh-mm-label" }, `记忆文件（${files.length}）`),
          files.length === 0
            ? h("div", { className: "dsh-mm-note" }, "还没有记忆文件。绑定仓库后会自动创建 MEMORY.md。")
            : h("ul", { className: "dsh-mm-list" }, files.map((file) => h("li", {
              key: file.path,
              className: "dsh-mm-item",
              "data-open": open === file.path ? "" : undefined,
            },
              h("div", { className: "dsh-mm-itemHead", onClick: () => { void openFile(file.path); } },
                file.path === "MEMORY.md" ? h("span", { className: "dsh-mm-tag", "data-tone": "core" }, "核心") : null,
                h("span", { className: "dsh-mm-itemName" }, file.path),
                h("span", { className: "dsh-mm-itemMeta" }, `${formatBytes(file.bytes)} · ${formatWhen(file.mtime) || "—"}`)),
              open === file.path
                ? h("div", { className: "dsh-mm-field" },
                  h("textarea", {
                    className: "dsh-mm-area",
                    value: loaded ? draft : "读取中…",
                    spellCheck: false,
                    onChange: (event) => setDraft(event.target.value),
                  }),
                  h("div", { className: "dsh-mm-rowwrap" },
                    h("button", { type: "button", className: "dsh-mm-btn", "data-variant": "primary", disabled: !loaded, onClick: () => { void save(); } }, "保存"),
                    h("button", { type: "button", className: "dsh-mm-btn", onClick: () => { void openFile(file.path); } }, "关闭"),
                    saved === "" ? null : h("span", { className: saved.startsWith("已保存") ? "dsh-mm-ok" : "dsh-mm-error" }, saved)))
                : null)))));
    }

    function SetupTab(props) {
      const { state, refresh, busy, run } = props;
      const [repo, setRepo] = React.useState("");
      const [branch, setBranch] = React.useState("");
      const [name, setName] = React.useState("dsh-memory");
      const [token, setToken] = React.useState("");
      const [repos, setRepos] = React.useState(null);
      const [message, setMessage] = React.useState("");

      React.useEffect(() => {
        if (repo === "" && asText(state?.repoInput) !== "") setRepo(state.repoInput);
      }, [state, repo]);

      const doBind = async () => {
        const answer = await post("repo.set", { repo, branch });
        setMessage(asText(answer.body?.message));
        refresh();
      };

      const doCreate = async () => {
        const answer = await post("repo.create", { name });
        setMessage(asText(answer.body?.message));
        refresh();
      };

      const doList = async () => {
        const answer = await post("repos.list");
        setRepos(answer.ok && Array.isArray(answer.body?.repos) ? answer.body.repos : []);
        if (!answer.ok) setMessage(asText(answer.body?.message));
      };

      const doBindToken = async () => {
        const answer = await post("auth.set", { token });
        setMessage(asText(answer.body?.message));
        if (answer.ok) setToken("");
        refresh();
      };

      const bound = state?.bound === true;

      return h("div", { className: "dsh-mm-body" },
        h("div", { className: "dsh-mm-card" },
          h("span", { className: "dsh-mm-label" }, "GitHub 账号"),
          bound
            ? h("div", { className: "dsh-mm-note" },
              `已绑定 ${asText(state?.account?.login) || "（未知账号）"}`,
              state?.authSource === "github-manager" ? "（复用 dsh-github-manager 的凭据）" : "")
            : h("div", { className: "dsh-mm-note" }, "还没有 GitHub 凭据。粘贴一个带 repo 权限的 personal access token。"),
          h("div", { className: "dsh-mm-field" },
            h("input", {
              className: "dsh-mm-input",
              "data-mono": "",
              type: "password",
              placeholder: "ghp_… 或 github_pat_…",
              value: token,
              onChange: (event) => setToken(event.target.value),
            })),
          h("div", { className: "dsh-mm-rowwrap" },
            h("button", { type: "button", className: "dsh-mm-btn", "data-variant": "primary", disabled: busy || token.trim() === "", onClick: () => { void doBindToken(); } }, "绑定"),
            h("button", { type: "button", className: "dsh-mm-btn", disabled: busy, onClick: () => run("auth.status") }, "校验"),
            bound ? h("button", {
              type: "button",
              className: "dsh-mm-btn",
              "data-variant": "danger",
              disabled: busy,
              onClick: () => run("auth.clear"),
            }, "解绑") : null)),

        h("div", { className: "dsh-mm-card" },
          h("span", { className: "dsh-mm-label" }, "记忆仓库（私有）"),
          h("div", { className: "dsh-mm-field" },
            h("input", {
              className: "dsh-mm-input",
              "data-mono": "",
              placeholder: "owner/name，例如 zhangsan/dsh-memory",
              value: repo,
              onChange: (event) => setRepo(event.target.value),
            })),
          h("div", { className: "dsh-mm-field" },
            h("input", {
              className: "dsh-mm-input",
              "data-mono": "",
              placeholder: "分支（留空用仓库默认分支）",
              value: branch,
              onChange: (event) => setBranch(event.target.value),
            })),
          h("div", { className: "dsh-mm-rowwrap" },
            h("button", { type: "button", className: "dsh-mm-btn", "data-variant": "primary", disabled: busy || repo.trim() === "", onClick: () => { void doBind(); } }, "绑定并拉取"),
            h("button", { type: "button", className: "dsh-mm-btn", disabled: busy || !bound, onClick: () => { void doList(); } }, "列出我的仓库")),
          repos === null
            ? null
            : h("div", { className: "dsh-mm-field" },
              h("select", {
                className: "dsh-mm-select",
                value: "",
                onChange: (event) => { if (event.target.value !== "") setRepo(event.target.value); },
              },
                h("option", { value: "" }, `共 ${repos.length} 个仓库，选一个`),
                repos.map((item) => h("option", { key: item.fullName, value: item.fullName },
                  `${item.fullName}${item.private ? "（私有）" : ""}`)))),

          h("div", { className: "dsh-mm-field" },
            h("span", { className: "dsh-mm-note" }, "还没有仓库？用下面的名字新建一个私有的记忆仓库（会带一个初始提交）。")),
          h("div", { className: "dsh-mm-row" },
            h("input", {
              className: "dsh-mm-input",
              "data-mono": "",
              value: name,
              onChange: (event) => setName(event.target.value),
            }),
            h("button", {
              type: "button",
              className: "dsh-mm-btn",
              disabled: busy || !bound || name.trim() === "",
              onClick: () => { void doCreate(); },
            }, "新建私有仓库"))),

        message === "" ? null : h("div", { className: "dsh-mm-ok" }, message),
        h("div", { className: "dsh-mm-note" },
          "记忆写在本机 ", asText(state?.memoryDir) || "…",
          "，并同步到上面这个仓库。在另一台电脑上装好本插件、绑同一个仓库，即可拉到同一份记忆。"));
    }

    /* ------------------------------------------------------------------ *
     * Panel and badge
     * ------------------------------------------------------------------ */

    function Panel(props) {
      const [tab, setTab] = React.useState("sync");
      const [state, setState] = React.useState(null);
      const [anchor, setAnchor] = React.useState(null);
      const [busy, setBusy] = React.useState(false);

      const refresh = React.useCallback(async () => {
        const answer = await getState();
        setState(answer);
      }, []);

      React.useEffect(() => { void refresh(); }, [refresh]);

      const run = React.useCallback(async (action) => {
        setBusy(true);
        const answer = await post(action);
        const body = answer.body ?? {};
        setBusy(false);
        if (answer.ok && body.state !== undefined && body.state !== null) setState(body.state);
        else void refresh();
      }, [refresh]);

      /* The panel is a frame-wide surface, so it is positioned from the slot
         node it was opened from rather than from any session geometry. */
      React.useEffect(() => {
        if (typeof document === "undefined") return;
        const host = document.querySelector("[data-dsh-memory-anchor]");
        if (host === null) return;
        const rect = host.getBoundingClientRect();
        setAnchor({ left: Math.max(8, rect.left), bottom: Math.max(8, window.innerHeight - rect.top + 8) });
      }, []);

      React.useEffect(() => {
        const onKey = (event) => { if (event.key === "Escape") props.onClose(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [props]);

      const style = anchor === null
        ? { left: 12, bottom: 96 }
        : { left: anchor.left, bottom: anchor.bottom };

      return h("div", { className: "dsh-mm-panel", style, role: "dialog", "aria-label": "长期记忆" },
        h("div", { className: "dsh-mm-header" },
          h("div", { className: "dsh-mm-title" },
            h(MemoryMark, { size: 15 }),
            h("span", null, "长期记忆"),
            h("span", { className: "dsh-mm-version" }, `v${VERSION}`)),
          h("button", { type: "button", className: "dsh-mm-x", onClick: props.onClose, title: "关闭", "aria-label": "关闭" }, "×")),
        h("div", { className: "dsh-mm-tabs" },
          TABS.map((item) => h("button", {
            type: "button",
            key: item.id,
            className: "dsh-mm-tab",
            "data-active": tab === item.id ? "" : undefined,
            onClick: () => setTab(item.id),
          }, item.label))),
        state === null
          ? h("div", { className: "dsh-mm-body" }, h("div", { className: "dsh-mm-note" }, "读取状态…"))
          : tab === "sync"
            ? h(SyncTab, { state, refresh, busy, run })
            : h(SetupTab, { state, refresh, busy, run }));
    }

    /** The sidebar badge: one slot node, holding the toggle and the panel.
     *  The sidebar foot renders either wide (a full row beside Settings) or as
     *  a 56px rail; the owner hands the occupant `wide`, and the rail variant
     *  drops the label and keeps the mark. */
    function Badge(props) {
      const [open, setOpen] = React.useState(false);
      const [state, setState] = React.useState(null);

      React.useEffect(() => {
        let live = true;
        void getState().then((answer) => { if (live) setState(answer); });
        return () => { live = false; };
      }, [open]);

      const tone = statusTone(state);
      const hint = summaryOf(state);
      const wide = !(props !== undefined && props.wide === false);
      const tip = `长期记忆：${hint}`;

      return h("div", {
        className: wide ? "dsh-mm-layer" : "dsh-mm-layer dsh-mm-rail",
        "data-dsh-memory-anchor": "",
      },
        open ? h(Panel, { onClose: () => setOpen(false) }) : null,
        h("button", {
          type: "button",
          className: "dsh-mm-badge",
          "data-active": open ? "" : undefined,
          title: tip,
          "aria-label": tip,
          "aria-expanded": open ? "true" : "false",
          onClick: () => setOpen((value) => !value),
        },
          h(MemoryMark, { size: wide ? 16 : 18 }),
          wide ? h("span", { className: "dsh-mm-badgeLabel" }, "记忆") : null,
          wide ? h("span", { className: "dsh-mm-badgeHint" }, hint) : null,
          h("span", { className: "dsh-mm-dot", "data-tone": tone })));
    }

    const inject = ["slots"];

    function apply(ctx) {
      ensureStyle();
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
        name: "sidebar.footer.action",
        id: "memory",
      }, Badge));
    }

    exports.apply = apply;
    exports.inject = inject;
    /* Exposed for the smoke test only: the pure helpers and the injected CSS are
     * worth asserting directly rather than through markup. */
    exports.internals = {
      VERSION,
      TABS,
      API,
      CSS,
      formatBytes,
      formatWhen,
      summaryOf,
      statusTone,
      normalizeFiles,
      ensureStyle,
      MemoryMark,
      SyncTab,
      SetupTab,
      Panel,
      Badge,
      apply,
    };
    return module.exports;
  },
});
