# AGENTS.md — pi-qqbot 开发说明

给在本目录工作的 AI coding agent 看。用户文档是 `README.md`，决策与协议事实是
`docs/PLAN.md`，架构是 `docs/ARCHITECTURE.md`，发布流程是 `docs/DEVELOPMENT.md`。

## 这是什么

一个 Pi 扩展：把 QQ 官方机器人接到**当前 Pi 会话**。QQ 消息经 WebSocket 网关进来，
用 `pi.sendUserMessage()` 注入会话；Pi 跑完后把最终 assistant 文本用被动回复发回 QQ。
零运行时依赖，只 import `node:` 内置模块（Node ≥ 22.19）。

## 目录与职责

| 路径 | 职责 |
|---|---|
| `src/index.js` | 扩展入口：生命周期、`/qq` 命令、服务检测、session 切换 |
| `src/gateway.js` | QQ WebSocket 网关：identify / 心跳 / resume / 关闭码 / 重连 |
| `src/api.js` | HTTP：取网关地址、发文本/Markdown/typing |
| `src/auth.js` | access_token 缓存、提前刷新、脱敏 |
| `src/session.js` | 桥：串行队列、注入、收集回答、回复预算、`/qq new` 拦截 |
| `src/text.js` | 事件归一化、引用消息、@ 清理、Markdown 清理、代码围栏分片 |
| `src/media.js` | `[[file:路径]]` 解析、敏感路径/大小校验、分片上传、`msg_type=7` 发送 |
| `src/config.js` | `~/.pi/agent/pi-qqbot.json` 读取、归一化、校验、env 覆盖 |
| `src/service.js` | 后台常驻服务的状态文件、心跳、起停 |
| `src/lock.js` | 单实例锁（避免两个 pi 抢网关） |
| `bin/pi-qqbot.mjs` | 常驻启动器：拉起 `pi --mode rpc` 并保活 |
| `test/mock-qq.mjs` | 本地假 QQ 平台（HTTP + 最小 WebSocket 服务端） |
| `test/unit.test.mjs` | 单测 + mock 集成（默认测试入口） |
| `test/media.test.mjs` | 文件标记、路径校验、分片上传、媒体发送 |
| `docs/` | 架构、开发流程、决策记录 |
| `examples/config.json` | 配置样例 |
| `scripts/install.sh` / `uninstall.sh` | 软链安装 / 卸载 |
| `scripts/publish-to-core.sh` | 开发副本 → 正式目录（仅维护者用） |
| `test/e2e*.mjs` | 真 pi 端到端（会调模型或不调模型，见下） |

## 命令

```bash
npm test                  # 38 项单测 + mock 平台集成，几秒
npm run e2e               # 真 pi --mode rpc + mock QQ，会调一次模型
npm run e2e:service       # 后台服务进程，不调模型
npm run e2e:service-cmd   # 真 pi 里执行 /qq start|stop，不调模型
./scripts/publish-to-core.sh          # 语法 + 单测 + 差异预览（不改文件）
./scripts/publish-to-core.sh --apply  # 备份正式版后发布到 ~/Agent/Core/系统/智能设定/Pi插件/pi-qqbot
```

手工调试：

```bash
pi --extension ~/Agent/Temp/pi-qqbot-dev        # 用开发副本启动，不碰正式版
/qq status ; /qq log 50 ; /qq take（锁被活进程占用时）
```

## 硬约束

1. **零运行时依赖**：不要引入 npm 包。HTTP 用 `fetch`，WebSocket 用全局 `WebSocket`，
   加密用 `node:crypto`。依赖会让扩展在 `pi install` 之外无法加载。
2. **不要改软链指向**：`~/.pi/agent/extensions/pi-qqbot` 永远指向正式目录
   `~/Agent/Core/系统/智能设定/Pi插件/pi-qqbot`。测试用 `--extension`，发布用 `scripts/publish-to-core.sh`。
3. **凭据不进仓库**：AppID/AppSecret 只在 `~/.pi/agent/pi-qqbot.json`（0600）。
   代码、文档、测试、日志里都不许出现真实值。
4. **发布只走 `scripts/publish-to-core.sh`**：手工 `cp -r` 会漏掉删除和校验。发布前必须
   `npm test` 全过；改了网关/发送/协议要额外 `npm run e2e`。
5. **协议事实以 `docs/PLAN.md` 为准**：intents `1<<25`、被动回复窗口（群 5min / 单聊 60min）、
   单聊每条最多 4 次 / 群 5 次、`msg_id+msg_seq` 去重、媒体 CDN 要带 `Authorization: QQBot ***
   改这些之前先补测试。
6. **QQ 侧 `/qq new` 的实现方式不能换**：必须走
   `pi.sendUserMessage("/qq new", { expandPromptTemplates: true })` 让 Pi 派发扩展命令，
   handler 里 `ctx.newSession()`。不要缓存旧 `ctx` 直接调——`newSession` 返回后旧 ctx 立刻失效。
7. **换会话会重跑扩展工厂**：网关、队列、锁状态必须存在 `globalThis[Symbol.for(...)]` 单例里，
   否则 `/new` 之后会多连一条网关、多抢一次锁。
8. **测试不连真 QQ**：全部用 `test/mock-qq.mjs`。`npm run e2e` 会花一次模型调用，别在循环里跑。

## 常见改动入口

| 想改什么 | 改哪里 | 别忘了 |
|---|---|---|
| 加配置项 | `src/config.js` 默认值 + 归一化 + 校验 | `README.md` 配置表、`examples/config.json` |
| 改文本/分片 | `src/text.js` | `test/unit.test.mjs` 的文本用例 |
| 改回复发送 | `src/session.js` 的 `#deliver` | 预算/窗口/额度测试 |
| 改网关行为 | `src/gateway.js` | 关闭码表、重连测试 |
| 加终端命令 | `src/index.js` 的 `registerCommand` + `HELP` | README 用法表 |
| 改服务管理 | `src/service.js` + `bin/pi-qqbot.mjs` | 两个 `e2e-service*` 脚本 |

## 完成标准

- `npm test` 全过（当前 38 项），无挂起、无未捕获 rejection。
- 触及协议/网关/发送/会话切换时：`npm run e2e` 通过（pong → `/qq new` → 新会话继续对话）。
- 触及服务模式时：`npm run e2e:service` 与 `e2e:service-cmd` 通过。
- `./scripts/publish-to-core.sh` 预览里的差异与本次改动一致，没有意外删除。
- `npm pack --dry-run` 的文件清单只包含运行必需文件（无凭据、无日志、无 `.git`）。
- 文档同步：README 面向用户、PLAN 记决策、本文件记开发约束。
