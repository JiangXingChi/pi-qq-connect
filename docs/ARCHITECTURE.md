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
| `src/config.js` | 读取 `~/.pi/agent/pi-qqbot.json`，归一化、校验、环境变量覆盖 |
| `src/auth.js` | AppID/AppSecret → access_token，缓存与并发去重 |
| `src/api.js` | 网关地址、消息、Markdown、typing、富媒体上传与发送 |
| `src/gateway.js` | 零依赖 WebSocket：Hello/Identify/Resume/心跳/重连/关闭码分类 |
| `src/text.js` | 事件归一化、@ 清理、引用消息、信封、Markdown 清理、代码围栏分片 |
| `src/session.js` | QQ ⇄ Pi 桥：队列、注入、回答收集、回复预算、`/qq new`、出站文件 |
| `src/media.js` | `[[file:路径]]` 解析、敏感路径/大小校验、分片上传 |
| `src/service.js` | 后台常驻服务状态文件、心跳、起停、stale pid 处理 |
| `src/lock.js` | 单实例锁 + 看门狗 |
| `src/log.js` | 文件日志、级别过滤、2 MiB 轮转 |
| `bin/pi-qqbot.mjs` | detached 启动 `pi --mode rpc --no-session --extension <dir>` |

## 一次消息的生命周期

1. 网关推送事件，`normalizeEvent` 归一化为 `{kind, chatId, userId, msgId, text, attachments, quote}`。
2. 权限过滤（`allowUsers` / `allowGroups` / `allowAll`）、`msg_id` 去重、入队（上限 `maxQueue`）。
3. 等 `agent_settled` 后 `pi.sendUserMessage()` 注入；`before_agent_start` 标记这轮来自 QQ。
4. `message_end` 收集最终 assistant 文本；`agent_settled` 触发 `#deliver`。
5. 去掉 `[[file:...]]` 后按 4000 字/段切片（保留代码围栏），用 `msg_id + msg_seq` 被动回复。
6. 文件逐个上传（`upload_prepare → PUT → part_finish → /files`），再 `msg_type=7` 发送。

## 会话切换

QQ 里发 `/qq new`：桥拦截，不注入模型，改用
`pi.sendUserMessage("/qq new", { expandPromptTemplates: true })` 派发扩展命令，handler 拿到新鲜的
`ExtensionCommandContext` 调 `ctx.newSession()`。`session_shutdown(reason="new")` /
`session_start(reason="new")` 时插件不重建网关、不释放锁；桥清空旧队列并回执。

## 后台服务

`/qq start` 让当前进程先让出网关和锁，再 detached 拉起 `bin/pi-qqbot.mjs`，它执行
`pi --mode rpc --no-session --extension <dir>` 并保持 stdin 打开。服务每 15 秒写心跳到
`~/.pi/agent/pi-qqbot.service.json`；超过 45 秒未更新视为掉线。TUI 里的扩展检测到服务在线时
只做控制面，不连网关、不抢锁。

## 状态文件

| 路径 | 内容 |
|---|---|
| `~/.pi/agent/pi-qqbot.json` | 配置（含凭据，权限 600） |
| `~/.pi/agent/pi-qqbot.log` | 运行日志（轮转 `.1`） |
| `~/.pi/agent/pi-qqbot.lock` | 网关单实例锁（pid/host/at） |
| `~/.pi/agent/pi-qqbot.service.json` | 后台服务 pid、会话、心跳 |
| `~/.pi/agent/pi-qqbot.service.log` | 服务 stdout/stderr |

## 安全边界

- 凭据只在配置文件，不写日志、不进仓库；日志对 openid/msg_id 做掩码。
- 出站文件必须由模型在回复里显式标记；插件再校验普通文件、≤200MB、非敏感路径。
- 被动回复额度：单聊 4 次、群聊 5 次（含回执和重试）；超时回退到同会话最新 `msg_id`。
- 单实例锁避免两个 Pi 进程各收一半 QQ 消息；`/qq take` 只用于锁冲突。

## 测试

- `npm test`：36 项，mock QQ（HTTP + 最小 WebSocket）覆盖网关、桥、配置、媒体上传。
- `npm run e2e`：真 `pi --mode rpc` + mock QQ，调一次模型。
- `npm run e2e:service` / `e2e:service-cmd`：后台服务生命周期与 `/qq start|stop`。
