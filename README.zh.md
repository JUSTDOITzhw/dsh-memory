# dsh-memory

给 [dsh](https://deepseek-harness.github.io/deepseek-harness/) 的长期记忆，存在一个**私有的 GitHub 仓库**里，所以同一份笔记会跟着你在多台电脑之间走。

核心记忆每轮对话都注入；细节按需检索；模型写入后自动推送。每台机器绑一次，两边共用同一个记忆目录。

```
$DSH_HOME/memory/
  MEMORY.md          核心记忆 —— 每轮对话都注入
  notes/*.md         细节 —— 用 memory_search / memory_read 按需读
  conflicts/*.md     与另一台机器撞车时，本地那一版留在这里
```

## 它做什么

**注入核心记忆。** `MEMORY.md` 注册成一个提示词段（`order 400`、`interpolate: false`），每次组装都重新读一遍。改完文件，下一轮就已经知道；不用重启，不用重建索引。文件为空时整段消失 —— 没记忆就不花 token。

**四个工具，让模型自己维护记忆。**

| 工具 | 用途 |
|---|---|
| `memory_list` | 有哪些文件、多大 |
| `memory_read` | 读某个文件全文 |
| `memory_search` | 全部记忆里按关键词检索（不区分大小写） |
| `memory_write` | 追加（默认）或覆盖，然后排队推送 |

`memory_write` 的描述是刻意写窄的 —— 只写跨会话仍然成立的事实（偏好、环境、约定、踩过的坑）。过程性的进度和一次性结论留在对话里。

**自动同步。** 记忆目录是工作副本，私有仓库是真源。dsh 启动后不久自动拉一次；写入后短暂延迟自动推一次。拉和推共用一条串行通道，按钮和工具调用不会交错。

**冲突不丢数据。** 如果某个文件自上次同步以来本地和远端都改过，远端版本占住正式文件，本地版本存进 `conflicts/` 并以机器名标记。远端删除永远不删本地记忆。

**零运行时依赖。** 宿主半侧只 import Node 标准库 —— 连 `@deepseek-ai/dsh-tools` 都不 import（它的 `defineTool` 由本地等价物替代）。这正是 `link:` 开发态能加载起来的原因：位于 profile 之外的插件解析不到官方包，一个静态 import 会在启动时把整棵插件树拖死。

## 安装

```
dsh plugin --profile web add github:JUSTDOITzhw/dsh-memory
```

重启 dsh，点侧栏底部的 **记忆** 徽标。

然后每台机器绑一次：

1. **绑 GitHub 账号** —— 粘一个带 `repo` 权限的 personal access token。如果 `dsh-github-manager` 已经绑过，本插件直接复用它，这一步会跳过。
2. **绑记忆仓库** —— 填**私有**仓库的 `owner/name`，或者直接在面板里新建一个（建出来就是私有的，并带一个初始提交，这样推送有分支可落）。

换下一台机器，绑同一个仓库 —— 跨机就这些。

## 配置

可选，常规路径在面板里就够了。profile 的插件配置：

```yaml
- id: memory
  name: dsh-memory
  config:
    repo: ''                 # owner/name；留空表示在面板里绑
    branch: ''               # 留空表示采用仓库的默认分支
    maxCoreBytes: 8192       # 注入的核心记忆预算
    autoPull: true           # 启动后不久自动拉一次
    autoPush: true           # memory_write 后自动推（有防抖）
    pushDelayMs: 5000
    sectionOrder: 400        # 这一段在系统提示词里的位置
    searchLimit: 40          # 单次检索最多返回多少行
    memoryDir: ''            # 默认 $DSH_HOME/memory
    authPath: ''             # 默认 $DSH_HOME/dsh-memory/auth.json
    statePath: ''            # 默认 $DSH_HOME/dsh-memory/state.json
```

## 面板

- **同步** —— 仓库、分支、上次拉取/推送、待推送项、文件列表（可就地编辑），以及 **看注入内容**：每轮对话携带的原文，由提示词段调用的同一个函数渲染出来。
- **设置** —— 绑定账号、绑定仓库（可从你的仓库列表里挑）、新建一个私有记忆仓库。

## 凭据

token 存在 `$DSH_HOME/dsh-memory/auth.json`（权限 `0600`），本插件没有自己的凭据时读 `$DSH_HOME/github-manager/auth.json`。**它永远不会下发到浏览器半侧** —— 面板只知道登录名和同步状态。所有路由都做回环 + 同源校验。

## 测试

```
node test/smoke.mjs      # 47 项
```

覆盖路径穿越拦截、原子写、检索、核心记忆预算，以及完整的同步决策树（拉 / 推 / 两边都改 / 旧 sha 重试 / 入口串行化）—— 跑在一个内存里的 GitHub 上，其中包含手搓很难复现的冲突分支。

## 许可

MIT
