# PLAN：pi-qqbot（QQ 官方机器人 ⇄ 当前 Pi 会话）

## 目标

自用 Pi 插件：QQ 官方机器人收到的消息进入**当前 Pi 会话**，Pi 的最终回答回到 QQ。
QQ 里就是这一个会话，有连续上下文。零外部依赖、单目录、一条命令装。

## 当前状态（2026-10-23）

- 版本 `0.2.6`，Node ≥ 22.19，零运行时依赖。
- 验证：`npm test` 42 项全过；`npm run e2e` / `e2e:service` / `e2e:service-cmd` 三组真 pi 端到端全过。
- 已实现：
  - QQ 私聊 + 群 @ 消息接入当前 Pi 会话，回答按被动回复发回
  - 串行队列、msg_id 去重、被动窗口兜底、回复额度（`replyQuota`）
  - 引用消息、@ 前缀清理、入站图片（带 QQBot token 下载）、语音取 QQ 转写
  - 代码围栏分片、Markdown 可选、单聊「正在输入」、发送重试/随机 `msg_seq`
  - 单实例锁 + 锁看门狗；对外命令 6 条：`/qq status|start|stop|new|log|take`
  - `service`：后台常驻 pi（`pi-qqbot-service` 会话）、心跳、防双开、stale pid 防误杀
  - `bin/pi-qqbot.mjs` 常驻启动器 + systemd 单元示例
- 未做 / 候选（按优先级）：
  1. 服务崩溃自愈：目前靠 `/qq start` 或 systemd，插件不自动重拉
  2. 多会话隔离：所有 QQ 对话共用一条 Pi 上下文（可用 `/qq new` 手动切）
  3. 出站富媒体已做：`[[file:...]]` 标记 + 分片上传
  4. Markdown 默认仍是 `plain`，需要用户在配置里显式开
  5. 频道（guild）与频道私信未接入，只做了 C2C + 群
  6. 没有发布到 npm / pi.dev，仅本地软链安装

## 生态调研结论（先查了现成的）

现成实现 4 个主要 + 4 个单人项目，全部实测能在 Pi 1.4.0 加载：

| 项目 | 形态 | 取舍 |
|---|---|---|
| pi-agent-qqbot 1.0.4 | 绑定当前会话，仅 C2C 单人 | 最贴近本需求，但仅私聊、依赖 ws/unpdf、0★ |
| @xsqm/pi-qqbot 0.4.7 | 独立 AgentSession，群+私聊 | 功能全，但上下文与终端会话隔离 |
| pi-qq-integration 0.5.3 | 注入当前会话，群+私聊，多实例选主 | 6★，实现可参考 |
| pi-qq-bridge 0.1.3 | 隔离会话 + /workspace | 声明只支持 <1.0 |

结论：自用版取「绑定当前会话」的形态（pi-agent-qqbot / pi-qq-integration 路线），
砍掉多媒体上传、UI 桥、多实例选主，保留真正会踩的坑。

## 已核实的外部事实

- token：`POST https://bots.qq.com/app/getAppAccessToken` `{appId, clientSecret}` → `{access_token, expires_in(字符串)}`，有效期 7200s。
- 鉴权头：`Authorization: QQBot <token>`；WS identify 的 token 同样是 `QQBot <token>`。
- 网关：`GET /gateway` → `{url}`；op10 Hello（`d.heartbeat_interval` 毫秒）→ op2 Identify / op6 Resume；op1 心跳、op11 ACK；op7 重连、op9 会话失效；READY 里拿 `session_id`。
- 事件：`GROUP_AT_MESSAGE_CREATE` / `C2C_MESSAGE_CREATE`，intents `1<<25`；`d.id` 即被动回复 msg_id；群成员是 `author.member_openid`，单聊是 `author.user_openid`。
- 发送：群 `POST /v2/groups/{group_openid}/messages`、单聊 `POST /v2/users/{openid}/messages`，`{content, msg_type:0, msg_id, msg_seq}`。
- 主动消息 2025-04-21 下线，**只能被动回复**；群 5 分钟最多 5 次、单聊 60 分钟最多 4 次；`msg_id+msg_seq` 重复会失败（去重靠它）。
- Pi 侧：`session_start`/`agent_settled`/`message_end` 事件齐备；`pi.sendUserMessage()` 在 streaming 时会抛错，需要自己做串行队列；`pi --mode rpc` 只要 stdin 不关就常驻（已实测）。

## 设计

1. **一条队列**：QQ 消息进队列，Pi 空闲才注入下一条；`agent_start`/`agent_settled` 跟踪忙碌。保证「哪条消息的回话回到哪个会话」。
2. **回复预算**：每条入站消息一个预算（默认 4 条，文档上限 5，留 1 条余量），`msg_seq` 递增；超预算截断并提示去终端看完整结果。
3. **窗口兜底**：群 5 分钟 / 单聊 60 分钟；超时后若该会话有更新消息，用最新的 msg_id 回复。
4. **去重**：msg_id 内存表（TTL 10 分钟）。
5. **入站图片**：https 附件下载成 base64，作为 Pi 图片输入（上限 2 张 / 8MB），失败降级为文字占位。
6. **单实例锁**：`~/.pi/agent/pi-qqbot.lock` 存 pid；第二个 Pi 不抢网关，`/qq take` 强制接管。
7. **形态**：交互式（pi 开着即在）+ `bin/pi-qqbot.mjs` 拉起 `pi --mode rpc` 常驻会话。

## 文件

```
index.js  src/{config,log,auth,api,gateway,text,session,lock,index}.js
bin/pi-qqbot.mjs  index.js  examples/config.json  scripts/install.sh  scripts/uninstall.sh  packaging/pi-qqbot.service
test/{ws-server,mock-qq,harness,unit.test,e2e}.mjs
```

## 验证

1. 单测：配置解析、文本分片、回复预算、去重、窗口兜底、事件归一化。
2. 集成：假 pi API + mock QQ（HTTP+WS）走完「收到 QQ → 注入 → assistant 文本 → 发回」，断言 msg_id/msg_seq。
3. 端到端：真 `pi --mode rpc` 加载本扩展，mock 网关发「请只回复：pong」，断言 mock 收到含 pong 的被动回复。
4. 真 Pi 里 `/qq status` 可用、`/qq` 命令注册成功。

## 实现核对（2026-10-22）

已全部落地并跑通：

| 计划项 | 结果 |
|---|---|
| 串行队列 + agent_start/settled 跟踪 | ✅ 单测「流式期间注入失败会重排队」 |
| 被动回复按场景 4/5 条、重试复用 msg_seq | ✅ 单测「回复预算截断」「重试复用 seq」 |
| 群 5 分钟 / 单聊 60 分钟窗口兜底 | ✅ 单测「被动窗口过期后改用同会话最新 msg_id」 |
| msg_id 去重 | ✅ 单测「msg_id 去重」 |
| 入站图片转 Pi image content | ✅ 代码实现（https + 大小/数量上限，失败降级文字） |
| 单实例锁 + `/qq take` | ✅ 单测 + `/qq status` 显示锁持有者 |
| 零依赖 | ✅ 仅 node: 内置模块；`npm test` 无安装 |
| 交互式 + rpc 常驻 | ✅ 真 pi 加载通过；`bin/pi-qqbot.mjs` 保活 |
| 端到端 | ✅ 真 pi 回复 `pong`，mock 收到 `{content:"pong",msg_type:0,msg_id:"e2e-msg-1",msg_seq:1}` |

计划外补充：`before_agent_start` 判定「这轮是不是 QQ 发起的」（终端里输入的消息不会被误回给 QQ）、
Markdown 被拒自动降级纯文本、`ackAfterMs` 慢任务回执。

计划删减：webhook 模式（v2 计划已去掉，官方正向 WS 不需要公网回调）、
QQ 侧会话命令（`/new` `/resume` 属于 Pi 的命令上下文操作，事件回调里不能安全调用）。

## 第二轮：参考 Hermes QQ Bot 适配器补强

读了 `~/.hermes/hermes-agent/plugins/platforms/qqbot/`（adapter.py 1670 行、send.py、
`gateway/platforms/base.py: truncate_message`）与官方文档，补了 9 处：

| 改动 | 原因 |
|---|---|
| 图片下载带 `Authorization: QQBot <token>` | QQ 媒体 CDN 不带 token 会 403（原先必然失败） |
| 分片保住代码围栏 + `(i/n)` + 上限 4000 | 按 900 字硬切会把代码块切成两半 |
| `msg_seq` 改成时间+随机（0..65535） | 递增 seq 在重启/重发后会撞上 `(msg_id,msg_seq)` 去重 |
| 发送失败重试 3 次、每次换 seq，永久错误不重试 | 平台抖动不该直接丢回复 |
| 单聊「正在输入」`msg_type=6`，50s 去抖 | 长任务期间 QQ 侧完全没反馈 |
| 引用消息 `message_type=103` / `msg_elements` | 用户「回复某条再 @」时模型看不到上文 |
| 群聊 @ 前缀与 `<@!id>` 清理 | 正文带着残留 mention token |
| 4008 限流等 60s；4001/4002/4010-4014/4914/4915 判死；4006/4007/49xx 清 session；心跳取 80% | 原先一律退避，限流与不可恢复错误分不开 |
| 去重表上限 1000、定时器 `unref()` | 长跑不涨内存、不阻塞进程退出 |

验证：`npm test` 20 项全过；`npm run e2e` 真 pi 回复 `pong`，mock 同时收到
`正在输入` 提示与 `{content:"pong",msg_type:0,msg_id:"e2e-msg-1",msg_seq:38188}`。

## 第三轮：多轮审改（四轮，收敛到零发现）

| 轮次 | 发现 | 修复 |
|---|---|---|
| 1 并发/状态机 | `pump()` 在下载图片的 await 期间可重入，两条消息会互相覆盖 inflight；`stop()` 后仍可能注入或发送；`msg_seq` 位运算可能为负；网关并发 `#open` 会开出两条 socket；op9 的 `d=true` 被当成会话失效 | 加 `pumping` 闸门 + await 后重查 `stopped`；`#deliver` 检查 stopped；seq 用 `>>> 0`；`openGeneration` 代际取消旧连接；按 `d` 区分 op9 |
| 2 协议/Hermes 对照 | 发送前不检查网关在线（官方要求发消息时 WS 在线）；401/403 重试被测试开关意外禁用；识别/续接取 token 失败后干等 | 加 `#waitOnline()`（最多 10s）；去掉 gatewayOverride 判断；token 失败触发重连 |
| 3 安全/失败模式 | `void pump()` 的异常没人接；`/qq take` 只改锁文件，旧进程照旧抢消息；配置文件权限过宽无提醒；AppID 明文进日志 | pump 兜底 catch；锁看门狗 30s 检测被接管后自停；启动时检查 mode 并提醒；日志脱敏 |
| 4 收尾 | `/new` `/resume` 会触发 session_shutdown → 网关整条断掉重连；回执与重试会额外消耗被动回复额度；install/uninstall 对真实目录用 `ln -sfn`/`rm -rf` 有风险；文档计数过期 | 换会话时保留网关与锁；新增 `replyQuota`（默认 5）统一扣减；脚本遇到非软链目录拒绝操作；README/PLAN 同步 |

第 5 轮复读全部源码、脚本与文档：无新发现，收敛。`npm test` 23 项全过，
`npm run e2e` 真 pi 端到端通过。

## 第四轮：QQ 侧 `/qq new`

需求：在 QQ 里发 `/qq new` 等于终端 `/new`，开一个新的 Pi 会话。

调研发现（实测 1.4.0）：

1. `ctx.newSession()` 只存在于命令上下文，事件回调里没有；但它**可以**从扩展内部触发：
   `pi.sendUserMessage("/qq new", { expandPromptTemplates: true })` 会 dispatch 扩展命令，
   命令 handler 拿到的是新鲜的 `ExtensionCommandContext`，`newSession()` 返回 `{cancelled:false}`。
2. **Pi 换会话会重新执行扩展工厂**（探针里 `FACTORY RUN` 出现两次）。所以运行时状态必须是
   进程级单例（`globalThis[Symbol.for(...)]`），否则新工厂会再连一条网关、再抢一次锁。
3. `newSession()` 之后旧 `ctx` 立即失效，不能在新会话里继续用。

实现：

- 新增 `/qq new [名称]` 子命令，内部 `ctx.newSession()`（带名字时 `appendSessionInfo`）。
- QQ 的 `/qq new` 由桥拦截：不注入模型 → `requestNewSession()` dispatch 命令 → 6 秒内没收到
  `session_start(new)` 就回执失败。
- 会话切换后：`bridge.reset()` 丢掉旧队列与进行中的输出，`onSessionSwitched()` 给原会话回
  「✅ 已开新会话」；网关、锁、锁看门狗全部保留。

验证：`npm test` 25 项全过；`npm run e2e` 依次验证「pong → /qq new → 已开新会话 → 新会话里
继续对话 → 落出 2 个 session 文件 → 网关未重连」。

## 第五轮：后台常驻服务

需求：后台常驻一个 pi 承载 QQ 会话，TUI 只在需要时当控制面。

实现：

- `bin/pi-qqbot.mjs` 启动即写 `~/.pi/agent/pi-qqbot.service.json`（pid、会话、cwd），
  每 15 秒更新 `heartbeatAt`，退出时删掉自己的状态文件；给子 pi 注入
  `QQBOT_SERVICE_PID` 标识身份。
- 插件启动时先读状态：**服务在线且自己不是服务** → 只显示「服务在线」，不连网关、不抢锁。
- `/qq service status|start|stop|restart`：start 先让出本地网关与锁，再 detached 拉起
  `bin/pi-qqbot.mjs --session-id pi-qqbot-service`，最多等 8 秒确认心跳；stop 发 SIGTERM 并等退出。
- 心跳超过 45 秒或 pid 消失即判定掉线。

验证：

- `npm test` 27 项全过（新增服务心跳/过期、服务在线时本地不抢网关）。
- `npm run e2e:service`：状态文件 pid 与服务进程一致、心跳有效、SIGTERM 后清理、期间只 identify 一次。
- `npm run e2e:service-cmd`：真 pi 里 `/qq service start` 把 identify 从 1 变 2，`stop` 后状态清理。

## 第六轮：对 service 与 /qq new 的多轮审改

| 轮次 | 发现 | 修复 |
|---|---|---|
| 1 生命周期 | `/qq new` 超时只通知 TUI、QQ 侧没反馈；手动 `/resume` 会把待确认的 `/qq new` 误判成切换成功；桥在没接 handler 时也会吞掉 `/qq new`；启动服务失败没有错误信息 | 失败时给 QQ 回一条失败提示；只有 `reason==="new"` 才发「已开新会话」，`resume`/`fork` 清 pending + reset；拦截前检查 handler；`startService` 返回 error |
| 2 资源/异常 | 心跳已停但 pid 活着时 `stop` 会直接 SIGTERM（pid 复用风险）；残留状态会让 `start` 死锁；`--no-restart` 时 bin 空转、SIGTERM 只等 1.5 秒可能留孤儿 pi；日志无限增长 | `stopService` 默认拒绝并提示 `--force`；死进程的残留状态自动清理；bin 等子进程最多 8 秒并在 no-restart 时退出；启动前轮转 5MB 日志 |
| 3 并发/安全 | 两个窗口同时 `service start` 会拉起两个服务、心跳互相覆盖 | bin 启动时读状态，发现健康实例直接退出；e2e 验证第二个实例被拒且 identify 仍为 1 |

`npm test` 38 项全过；`npm run e2e`、`e2e:service`、`e2e:service-cmd` 全过。

## 第八轮：对照官方文档（2026-10）

已修：

1. **单聊被动回复上限是 4 次，不是 5 次**（官方《消息收发概述》）。`replyQuota` 改为按场景取上限：单聊 4、群 5，配置只能调低。
2. **API 统一域名**：2026-08-10 起生产环境为 `https://api.bot.qq.com`；token 接口同步切到 `api.bot.qq.com/app/getAppAccessToken`。沙箱仍用 `sandbox.api.sgroup.qq.com`（实测 READY）。
3. **错误码解析**：失败看 body 的 `err_code`/`trace_id`（官方明确不要依赖 `message`）；token 接口失败也是 HTTP 200 + `code`，现在会把 code 显示出来；429 不再被当成永久错误。

候选（按性价比）：

| 项 | 价值 | 成本 |
|---|---|---|
| 单聊流式回复 `stream_messages`（边生成边推） | 高：首字延迟大幅下降 | 中：需节流、分片、结束态 |
| ~~出站富媒体 `msg_type=7`（图片/文件）~~ | **已做并真机验证（2026-10-23）**：`[[file:/abs/path]]` 标记，最多 3 个；分片上传 + 场景隔离；QQ 已收到图片 | — |
| Markdown 回复实测并考虑默认开启 | 中：表格/代码块可读 | 低 |
| 群名/昵称缓存进信封 | 中：模型知道场景 | 低 |
| `GROUP_MESSAGE_CREATE`（群内非 @） | 中：可配置“所有消息都回” | 低 |
| 消息撤回（2 分钟内） | 低 | 低 |
| 素材管理 `qqbot-media://` | 低（与富媒体重叠） | 中 |
| 互动召回 `is_wakeup` | 低：跨窗口通知，易打扰 | 中 |
| 自定义菜单 / 指令面板 | 低：把 `/qq new` 放进 QQ 菜单 | 中 |

不做：Webhook/签名（WebSocket 够用）、Guild 频道、群管理/禁言接口、主动消息（已下线）。

## 第七轮：命令面精简

原则：日常只留「看状态、启停、开新会话、看日志」，其余降级或删除。

| 旧命令 | 新命令 | 处理 |
|---|---|---|
| `/qq status` | `/qq status` | 保留，并入后台服务那一行 |
| `/qq service start` | `/qq start` | 改名，语义更短 |
| `/qq service stop` | `/qq stop` | 改名；没有服务时改为断开本进程网关 |
| `/qq new [名称]` | `/qq new [名称]` | 保留（QQ 侧同样只认这条） |
| `/qq log [n]` | `/qq log [n]` | 保留 |
| `/qq service status` | — | 删除，`status` 已覆盖 |
| `/qq service restart` | — | 删除，`stop` + `start` |
| `/qq on` / `/qq off` | — | 删除，由 `start` / `stop` 覆盖 |
| `/qq reconnect` / `/qq fresh` | — | 删除，网关自动重连；极端情况重启服务 |
| `/qq take` | `/qq take` | 保留并写进帮助，标注“仅锁冲突时用”（不藏着） |

## 开机自启（0.2.4）

- systemd **用户级**单元：`packaging/pi-qqbot.service`，`WantedBy=default.target`；
- PATH 显式包含 `%h/.local/bin`（pi）和 `/usr/sbin`（node），不依赖登录 shell；
- `Restart=on-failure`：正常 `/qq stop`/`systemctl stop` 不会自动拉回，崩溃才重拉；
- `KillMode=mixed` + `TimeoutStopSec=20`：先让启动器把 SIGTERM 转给 pi，超时才整组杀；
- `loginctl enable-linger teacat`（本机已开）保证不登录也启动；
- 网络未就绪不阻塞：网关自己按 1s→60s 退避重连。

验证：`systemctl --user enable --now` 后 active、状态文件 0.2.3→0.2.4、网关 READY；
`systemctl stop` 后状态文件清理，`start` 后重新 READY；`is-enabled=enabled`、`Linger=yes`。

## 角色矩阵审改（0.2.3）

「服务进程 vs TUI 控制面」单独做一轮：

- 列出三种角色与判定条件，写进 `docs/ARCHITECTURE.md`；
- 角色判断加 `ppid === 状态文件 pid`，防止 `QQBOT_SERVICE_PID` 被服务里的工具子进程继承后，
  孙进程被误认成服务；
- 单测覆盖：TUI 控制面拒绝 `/qq new`、服务进程放行、伪造环境变量但 ppid 不对仍拒绝；
- `/qq start` 在服务已在线时先 `stop()` 本地网关；`/qq take` 只有 `state.gateway` 存在才报成功；
- 额度只剩 1 次时跳过回执。

## 修复：QQ 侧 /qq new 被误伤（0.2.2）

0.2.1 给终端 `/qq new` 加了「服务在线就拒绝」的保护，但 QQ 侧的 `/qq new` 也是通过
`sendUserMessage` dispatch 到同一 handler，并且执行者正是后台服务进程本身，于是被一起拒绝，
6 秒后回「开新会话失败」。修法：用 `QQBOT_SERVICE_PID` 判断当前进程是不是状态文件里的服务，
是服务就放行；TUI 控制面仍然拒绝。单测覆盖两种角色。

## 第十轮：多轮审改（0.2.1）

按「工程 → 并发/状态 → 协议 → 生命周期 → 资源 → 文档/测试」六轮逐项审，修掉的问题：

1. **终端 `/qq new` 调用不存在的 `switchSession`**（真实运行时报错）；补上 `ctx.newSession()` + 命名，测试覆盖。
2. **长回答 + 文件会挤爆额度**：单聊 4 次，原来先发最多 4 段文字，3 个文件必然失败；现在按「预留文件位」分配文字段数与文件数，上传前再检查剩余额度。
3. **分片上传无重试**：PUT / part_finish / 合并遇到网络、429、5xx 会整次失败；加 3 次退避重试，4xx 不重试。
4. **`/qq start` 早退留悬空锁**：未配置/服务接管/锁被占时旧锁不释放；改为先 `stop()` 释放自己的锁再重连。
5. **服务在线时 `/qq take` 假接管**：现在直接拒绝并提示；终端 `/qq new` 也提示改在 QQ 里发（避免只切 TUI 会话）。
6. **4008 限流被当成快速断开**：连续 3 次就停；现在 4008 不计入快速断开，按 60s 退避。
7. **启动器状态版本硬编码 0.1.0**：改为读 `package.json`（现 0.2.1）。
8. **工程细节**：`install.sh` 检测到 `pi install` 已安装时拒绝重复软链；CI 增加 `npm pack` 白名单检查；清理未使用的 import/变量。

验证：39 项单测、`e2e`、`e2e:service`、`e2e:service-cmd` 全过；真 pi 加载新路径 `/qq help`、服务在线提示正常；沙箱网关重启后 READY。

## 第九轮：工程化重构（GitHub / npm 发布）

目标：项目名、目录、包元数据统一为可发布形态；运行逻辑不变。

- 名称：`pi-qqbot`（npm 未占用；配置/锁/服务文件名已经是它）。
- 目录：开发副本 `~/Agent/Temp/pi-qqbot-dev`；正式版 `~/Agent/Core/系统/智能设定/Pi插件/pi-qqbot`。
- 结构：
  - 根：`index.js`（Pi 入口，软链安装兼容）、`package.json`、`README.md` / `README.en.md`、`LICENSE`、`CHANGELOG.md`、`AGENTS.md`、`.gitignore`
  - `bin/` 启动器；`src/` 运行模块；`test/` 测试
  - `examples/config.json`；`scripts/install.sh`、`scripts/uninstall.sh`、`scripts/publish-to-core.sh`
  - `packaging/pi-qqbot.service`；`docs/ARCHITECTURE.md`、`docs/DEVELOPMENT.md`、`docs/PLAN.md`
  - `.github/workflows/ci.yml`（Node 22 跑 `npm test`）
- `package.json`：去掉 `private`；`version 0.2.0`；加 `pi-package` 关键字、`bin`、`files` 白名单、
  `prepublishOnly: npm test`、`engines`；`repository/homepage` 等确认 GitHub 用户名后再补。
- 迁移：停服务 → `mv` 正式目录 → 重建软链 → 发布 → 重启服务 → 验证 READY；开发副本目录同步改名。
- 验证：`npm test` 38 项、`npm pack --dry-run` 24 个文件（40.1 kB）、真 pi `/qq help` 正常、
  后台服务从新路径 READY、软链指向 `Core/系统/智能设定/Pi插件/pi-qqbot`、旧中文目录已不存在、git 已初始化并打 `v0.2.0`。
- 未做：GitHub 远程仓库与 npm 发布（本机 `gh` 未登录、`npm` 未登录），命令写在 README/DEVELOPMENT。



