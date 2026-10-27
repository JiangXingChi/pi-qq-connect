# PLAN：pi-qq-connect 0.4.0 —— QQ 会话与桌面同能力

## 1 目标

在 QQ 里聊天，得到的工具、模型、会话、命令、输出长度都和在本机终端里用 pi 一致。
允许保留的差异只有 QQ 平台本身的硬限制（见 §1.3）。

## 1.1 已核实的差距（现状 0.3.0）

| # | 差距 | 证据 |
|---|---|---|
| 1 | 内置扩展全关：tool-search、codemode、mcp、llama.cpp | 启动参数 `--no-extensions`；实测工具表 12 个，补 `-e builtin:tool-search` 后 13 个 |
| 2 | 资源发现被绕过：0.3.0 用 `pi list` 自己枚举 npm 包 | 本地扩展目录 `~/.pi/agent/extensions`、项目 `.pi/extensions` 不加载；`pi config` 里禁用的包照样加载；`-builtin:` 覆盖不生效 |
| 3 | RPC 对话框无人应答 | `src/session.js` 不处理 `extension_ui_request` 的 select/confirm/input/editor → 扩展要用户选择时直接超时或挂住（如子代理 interview、确认类工具） |
| 4 | 内置斜杠命令不可用 | `/model` `/thinking` `/compact` `/new` `/resume` `/tree` `/export` 是 TUI-only；RPC 有等价命令但插件没接 |
| 5 | 长回答被丢弃 | 4 段 × 4000 字符封顶，超出部分直接丢 |
| 6 | 会话信息不可见/不可操作 | 模型、思考级别、上下文用量、会话名在 QQ 里看不到 |
| 7 | `/qq new` 靠 15 秒轮询判定 | 日志出现「开新会话失败：15 秒内没有切到新会话」 |

## 1.2 非目标

- 不改网关、消息队列、锁、媒体收发、分片协议
- 不做多用户会话隔离（仍是一条上下文）
- 不实现 QQ 主动消息（平台已下线）

## 1.3 平台硬限制（无法消除）

群里必须 @、被动回复窗口（群 5 分钟、单聊 60 分钟最多 4 条）、单条 4000 字符量级。
长输出用「正文 + 文件」绕过，其余只能靠用户补一句话。

## 2 设计

### 2.1 启动器：把资源加载交回 pi（新默认 `extensions: "auto"`）

- 启动参数简化为 `pi --mode rpc --session-id <id> --extension <本插件根目录>`，
  去掉 `--no-extensions` 与 `pi list` 枚举，让 pi 走完整发现流程：
  内置扩展、settings 里的 packages、`~/.pi/agent/extensions`、项目 `.pi/extensions`、
  skills、prompt 模板、主题、AGENTS.md。
- 双加载安全：`RUNTIME_KEY = Symbol.for("pi-qq-connect.runtime.v1")` 挂在 globalThis，
  两份副本共享同一 runtime，`registered` 守卫保证只连一条网关（0.3.0 已实现）。
  保留显式 `--extension <root>` 作为兜底（未安装也能跑）。
- 配置项 `extensions`：新增 `"auto"`（默认）＝交给发现；`"none"`＝旧隔离；
  数组＝显式白名单并继续用 `--no-extensions`（0.3.0 能力保留）。
- 发现阶段报错不阻塞 QQ：启动失败仍按现有退避重启。

### 2.2 对话框：先「不挂死」，再谈交互（`bin/pi-qq-connect.mjs`）

`extension_ui_request` 只会发给 RPC 客户端（启动器），而启动器以前把 stdout 直接继承给
journald，等于没人应答：扩展弹对话框会一直等。0.4.0 的做法：

- 启动器持续排空 stdout（顺带避免管道写满导致 pi 卡死）
- 命中 `select` / `confirm` / `input` / `editor` 时立刻回 `extension_ui_response{cancelled:true}`，
  并在 stderr 记一行「后台无人应答，已按取消处理」
- 真正的「QQ 里点选」需要跨进程回传（网关在扩展进程、stdin 在启动器进程），留到 0.5.0

### 2.3 内置命令映射（新增 `src/commands.js`）

QQ 里以 `/` 开头且非 `/qq` 的消息，先查映射表，命中则调 RPC 命令，不再丢给模型：

实现落在进程内扩展 API（比走 RPC 少一次跨进程往返，也不需要客户端）：

| QQ 命令 | 实现 |
|---|---|
| `/new [名称]` | 借一句内部扩展命令 `/qq __new` 进入 `ExtensionCommandContext`，`ctx.newSession()` 结果直接 resolve 回来（不再轮询）；`/qq new` 只是别名 |
| `/model` `/model 3` `/model provider/id` | `ctx.modelRegistry.getAvailable()` 列清单，`pi.setModel()` 切换 |
| `/thinking [级别]` | `pi.getThinkingLevel()` / `pi.setThinkingLevel()` |
| `/compact [说明]` | `ctx.compact({ customInstructions })` |
| `/session` | `pi.getSessionName()` + `ctx.getContextUsage()` + `sessionManager` 信息 |
| `/name [名称]` | `pi.setSessionName()` |
| `/tools` | `pi.getActiveTools()` |
| 扩展命令 / prompt 模板 / `/skill:x` | `pi.getCommands()` 校验后 `sendUserMessage(..., { expandPromptTemplates: true })` |
| TUI 专用（`/resume` `/tree` `/export` `/fork` …） | v1 明确拒绝并提示只能在终端用 |

未命中映射的 `/xxx` 回一句提示，不喂模型。

`/qq new` 与 `/new` 的差别只在实现路径：前者是「往会话里注入一句 `/qq new`
再轮询 15 秒」，失败常是假失败，严重时句柄 stale 要 `/qq stop` + `/qq start`；
后者直接走 RPC `new_session`，同步返回 `success`/`cancelled`。0.4.0 之后两者同源，
`/qq new` 只作为习惯别名保留，注入式实现与轮询一并删除。

### 2.4 长输出

- 未超限：照现状分片发送
- 超限：发正文末段提示「完整回答见附件」+ 写 `tmp/qq-reply-<时间>.md` 用 `[[file:]]` 发出
- 配置 `overflow`: `"file"`（默认）/ `"truncate"`（0.3.0 行为）

### 2.5 会话可观测

`/qq status` 增补：模型、思考级别、上下文用量、会话名、已加载插件数。

### 2.6 交付

- 版本 0.4.0，更新 `package.json`、`CHANGELOG.md`、`README.md`（新增「与终端一致」一节）
- 安装方式改为本地目录 `pi install /home/teacat/Agent/Core/应用/pi-qq-connect`（稳定路径）
- systemd `ExecStart` 指向该项目 `bin/pi-qq-connect.mjs`
- 保留 npm 0.3.0 作为回退方案（`extensions: "none"` 也能起）

## 3 验证（实际执行）

1. `node --test test/`：28 项，覆盖命令解析/回执、启动参数（auto/none/数组/builtin）、
   切换期间暂存与取消、长回答落盘、配置归一。
   （上游的 mock-QQ e2e 没随 npm 包发布，本地不可用；改为直接起真 pi 验证。）
2. 参数等价性实测：`pi --mode rpc --session-id X --extension <本目录>` 与「不带本插件的
   `pi --mode rpc`」工具表完全一致（13 个，含内置 `tool_search`）；0.3.0 的
   `--no-extensions` 组合少 4 个。`read/edit/write` 在 RPC 模式下由 Pi 以 deferred 方式暴露，
   与是否挂本插件无关。
3. 启动器实跑：`PIQQCONNECT_CONFIG=<临时 config>` 拉起，参数为 `extensions="auto"`、
   无 `--no-extensions`，扩展正常加载并自报 `enabled=false`，未触碰线上网关。
4. 线上切换：`pi remove npm:pi-qq-connect` + `pi install <本目录>`，systemd `ExecStart` 指向
   本目录，`systemctl --user restart` 后 0.4.0 在线、网关 READY、心跳正常。
5. 待人工确认：QQ 里发 `/help`、`/session`、`/model`、`/new` 与超长回答转文件。

## 4 风险

- 自动发现会加载更多插件 → 每轮系统提示变长、token 增加；可用 `extensions` 配置回收
- 两份 pi-qq-connect 同时被加载 → 依赖 `Symbol.for` 幂等守卫；启动日志须只有一条「连接网关」
- 对话框桥接期间用户乱发消息 → 队列 + 超时兜底，绝不无限等待
- 重启服务会断线十几秒，需用户挑时间
