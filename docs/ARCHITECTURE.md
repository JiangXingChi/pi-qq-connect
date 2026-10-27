# 架构

```
QQ 客户端
   │ 私聊 / 群里 @
   ▼
QQ 开放平台 WebSocket 网关
   │ C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE
   ▼
src/gateway.js ──► src/session.js（QqBridge）
   │                     │
   │                     ├─ 串行队列，等 agent_settled
   │                     ├─ pi.sendUserMessage(prompt)
   │                     └─ 收集 assistant 文本 → 被动回复
   ▼
src/api.js ──► https://api.bot.qq.com（生产）/ sandbox.api.sgroup.qq.com（沙箱）
   ▲
   └─ src/auth.js（AppAccessToken 缓存，提前 60 秒刷新）
```

## 模块

| 文件 | 职责 |
|---|---|
| `src/index.js` | 扩展入口：`session_start` / `session_shutdown`、`/qq` 命令、进程级单例、服务检测 |
| `src/config.js` | 读取 `~/.pi/agent/pi-qq-connect.json`，归一化、校验、环境变量覆盖 |
| `src/auth.js` | AppID/AppSecret → access_token，缓存与并发去重 |
| `src/api.js` | 网关地址、消息、Markdown、typing、富媒体上传与发送 |
| `src/gateway.js` | 零依赖 WebSocket：Hello/Identify/Resume/心跳/重连/关闭码分类 |
| `src/text.js` | 事件归一化、@ 清理、引用消息、信封、Markdown 清理、代码围栏分片 |
| `src/session.js` | QQ ⇄ Pi 桥：队列、命令拦截、注入、回答收集、回复预算、长回答落盘、出站文件 |
| `src/commands.js` | QQ 侧桌面命令：`/new` `/model` `/thinking` `/compact` `/session` `/name` `/tools` `/help` |
| `src/media.js` | `[[file:路径]]` 解析、敏感路径/大小校验、分片上传 |
| `src/service.js` | 后台常驻服务状态文件、心跳、起停、stale pid 处理 |
| `src/lock.js` | 单实例锁 + 看门狗 |
| `src/log.js` | 文件日志、级别过滤、2 MiB 轮转 |
| `bin/pi-qq-connect.mjs` | detached 启动 `pi --mode rpc --session-id pi-qq-connect-service --extension <dir>`，排空 stdout 并自动应答扩展对话框 |

## 一次消息的生命周期

1. 网关推送事件，`normalizeEvent` 归一化为 `{kind, chatId, userId, msgId, text, attachments, quote}`。
2. 权限过滤（`allowUsers` / `allowGroups` / `allowAll`）、`msg_id` 去重、入队（上限 `maxQueue`）。
3. 等 `agent_settled` 后 `pi.sendUserMessage()` 注入；`before_agent_start` 标记这轮来自 QQ。
4. `message_end` 收集最终 assistant 文本；`agent_settled` 触发 `#deliver`。
5. 去掉 `[[file:...]]` 后按 4000 字/段切片（保留代码围栏），用 `msg_id + msg_seq` 被动回复；
   段落数超过本轮额度时，全文写进 `replyDir` 当附件发（`overflow: "file"`），落盘失败才截断。
6. 文件逐个上传（`upload_prepare → PUT → part_finish → /files`），再 `msg_type=7` 发送。

## 命令（0.4.0）

以 `/` 开头的消息由桥拦截，**不注入模型**：

1. `parseCommand()` 切出 `{name, args}`；
2. `src/commands.js` 认识的（`/new` `/model` `/thinking` `/compact` `/session` `/name` `/tools` `/help`）
   直接用扩展 API 执行，结果当纯文本回执；
3. TUI 专用命令（`/resume` `/tree` `/export` …）明确回「只能在终端用」，不会被当成提问；
4. `pi.getCommands()` 里有的（技能 `/skill:x`、提示模板、其它插件的命令）原样
   `sendUserMessage(..., { expandPromptTemplates: true })` 转发，且**不加信封头**，否则不再以 `/` 开头；
5. 都不匹配 → 回一句「不认识的命令」，同样不进模型。

`/new` 需要 `ExtensionCommandContext.newSession()`，只能在命令处理器里调。桥的处理方式是派发一句
内部命令 `/qq __new`：`requestNewSession()` 先把结果 promise 挂到 `state.pendingExec`，命令处理器
执行完 `ctx.newSession()` 直接把真实结果 resolve 回去（0.3.0 及以前是轮询 15 秒，常报假失败）。
`/qq new` 保留为别名，行为相同；`/qq new` 在 QQ 里只会回一条「已并入 `/new`」。

换会话期间（`bridge.beginSwitch()`，可重复调用，只续看门狗、不清暂存）到达的消息进 `deferred`；
新会话实例的 `session_start` 触发 `endSwitch()`：保住原来排队的消息、丢掉旧会话的在途回答、
把暂存的条目**重新解析**（斜杠命令重新走命令通道，绝不喂模型）后放回队列。
若 30 秒内没等到 `session_start`（被拒绝、报错、超时），定时器或 `requestNewSession()` 的失败分支
会 `cancelSwitch()`，绝不让消息卡在暂存区。`requestNewSession()` 的超时是 35 秒（略长于看门狗，
31~35 秒内新的 `/new` 会被拒）；只有**确实收到过 `session_shutdown`** 时，失败才交给看门狗与接棒，
纯失败（被取消、报错、超时且根本没换）立刻 `cancelSwitch()`。

## 资源加载（0.4.0）

启动参数默认 `extensions: "auto"`：只加 `--extension <本插件>`，**不加** `--no-extensions`，
让 Pi 自己走完整发现流程（内置扩展、settings 里的包、`~/.pi/agent/extensions`、项目 `.pi/extensions`、
技能、模板、主题、`AGENTS.md`）。QQ 会话因此与终端会话加载同一套资源。

`extensions: "none"` 退回隔离模式（`--no-extensions` + 只挂自身）；数组是白名单，
`builtin:tool-search` 这类条目原样透传。自动发现与显式 `--extension` 同时命中时：
同一个 `pi` 对象只注册一次（`WeakSet`）；若 pi 给的是两个不同对象（实测会这样），
再按 `session_start` 的同一个 `ctx` 选举负责人，只让一个实例处理事件与接棒。

Pi 1.4 起，换会话/重载后旧 `pi` 和旧 `ctx` 句柄立即作废，再用会抛
`This extension ctx is stale after session replacement or reload...`。实测时序：
旧实例先收到 `session_shutdown`（句柄当场作废）→ 扩展工厂重跑出新实例 → 新实例收到 `session_start`
→ 旧实例的 `withSession` 才执行。插件的处理是：

- 事件**按 pi 实例注册**；命令每个会话只由选中的实例注册一次（同名命令重复注册会让 pi「谁都别执行」）；
  状态走 `globalThis` 单例；
- `switchSession()` 传 `withSession`，在回调里刷新 `state.ctx`；
- `session_shutdown` 的换会话/重载类 reason → `bridge.beginSwitch()`（暂停注入、暂存消息，网关和锁保留）；
  只有 `quit`/`exit`/`shutdown` 才收摊，未知 reason 按换会话处理并记一条 warn；
- 新实例的 `session_start` → `bridge.adopt(pi)` 换掉死句柄 + `endSwitch()` 收尾；
- 万一仍命中 stale（例如新实例没加载出来）→ 记一条 error、给 QQ 回一次提示、**暂停但不自毁**：
  队列与网关保留，等下一次 `adopt()` 自动恢复；每个切换周期只提示一次；
- `session_start` 时若已没有活动桥 → 直接 `start(ctx)` 重建，网关和锁保持。

后台服务的启动参数必须是**稳定路径**（例如 `pi install` 后的包目录）。若 `--extension` 指向的目录
已经不存在，Pi 会静默跳过该扩展，新会话里根本没有插件实例——这种情况只能靠别用临时目录来避免。

## 进程角色

同一份代码会在三种角色里运行，判断错了就会出现「服务在跑但 CLI 也连网关」或「终端 `/new`
把线上 QQ 会话切走」：

| 角色 | 识别方式 | 行为 |
|---|---|---|
| 普通 TUI（无服务） | 状态文件不存在/心跳过期 | 连网关、持锁 |
| TUI 控制面（服务在线） | 状态文件健康，且不是服务进程 | 不连网关、不抢锁，只执行 `/qq status/start/stop` |
| 后台服务进程 | `PIQQCONNECT_SERVICE_PID === 状态文件 pid` **且** `ppid === 状态文件 pid` | 连网关；`/new` 放行 |

只比对环境变量不够：服务里的工具子进程会继承它，孙进程会被误认成服务。`ppid` 检查
把范围限定在启动器直接拉起的那一个 `pi` 子进程。

## 后台服务

`/qq start` 让当前进程先让出网关和锁，再 detached 拉起 `bin/pi-qq-connect.mjs`，它执行
`pi --mode rpc --session-id pi-qq-connect-service --extension <dir>` 并保持 stdin 打开。服务每 15 秒写心跳到
`~/.pi/agent/pi-qq-connect.service.json`；超过 45 秒未更新视为掉线。TUI 里的扩展检测到服务在线时
只做控制面，不连网关、不抢锁。

## 状态文件

| 路径 | 内容 |
|---|---|
| `~/.pi/agent/pi-qq-connect.json` | 配置（含凭据，权限 600） |
| `~/.pi/agent/pi-qq-connect.log` | 运行日志（轮转 `.1`） |
| `~/.pi/agent/pi-qq-connect.lock` | 网关单实例锁（pid/host/at） |
| `~/.pi/agent/pi-qq-connect.service.json` | 后台服务 pid、会话、心跳 |
| `~/.pi/agent/pi-qq-connect.service.log` | 服务 stdout/stderr |

## 安全边界

- 凭据只在配置文件，不写日志、不进仓库；日志对 openid/msg_id 做掩码。
- 出站文件必须由模型在回复里显式标记；插件再校验普通文件、≤200MB、非敏感路径。
- 被动回复额度：单聊 4 次、群聊 5 次（含回执；重试复用 `msg_seq`，不额外占额度）；超时回退到同会话最新 `msg_id`。
- 单实例锁避免两个 Pi 进程各收一半 QQ 消息；`/qq take` 只用于锁冲突。

## 测试

- `npm test`：150 项，mock QQ（HTTP + 最小 WebSocket）覆盖网关、桥、配置、媒体上传、会话接棒/切换回归。
- `npm run e2e`：真 `pi --mode rpc` + mock QQ，调两次模型；断言 `/new` 后新会话能继续对话、QQ 侧与 pi 命令通道都仍可用、日志无 stale/无 30 秒看门狗（回执耗时只打印，不作门槛）。
- `test/dual-load.test.mjs`：把插件复制成两份显式加载（真 pi），断言只有一个负责人、`/qq` 只回一次；本机没有 `pi` 时自动 skip。
- `npm run e2e:service` / `e2e:service-cmd`：后台服务生命周期与 `/qq start|stop`。
