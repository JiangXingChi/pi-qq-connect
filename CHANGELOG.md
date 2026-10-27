# Changelog

## 0.4.0 — 2026-10-27

目标从「QQ 里能用」提到「QQ 里和终端一样」。

- 启动参数交给 Pi 自己发现：默认 `extensions: "auto"`，不再加 `--no-extensions`，也不再自己读
  `pi list` 拼白名单。内置扩展（`tool-search` / `codemode` / `mcp` / `llama.cpp`）、`pi config`
  里禁用过的包、`~/.pi/agent/extensions`、项目 `.pi/extensions`、技能、模板、主题、`AGENTS.md`
  现在与终端完全一致。`"none"` 仍可退回隔离模式，数组仍可显式点名（含 `builtin:` 透传）。
- QQ 里可以直接用桌面命令：`/new` `/model` `/thinking` `/compact` `/session` `/name` `/tools` `/help`。
  技能、提示模板和其它插件的命令（`/skill:xxx` 等）照原样转发给 Pi 执行。
- `/qq new` 并入 `/new`：删掉「注入一句 `/qq new` 再轮询 15 秒」的实现，改成命令通道直取结果，
  不再出现「开新会话失败：15 秒内没有切到新会话」这种假失败。
- 长回答不再丢尾：超过分片上限时把全文写成 Markdown 附件一起发（`overflow: "file"`，
  可用 `"truncate"` 回到旧行为）；落盘失败自动退回截断。
- 后台服务的 stdout 改为持续排空，扩展弹对话框（`select`/`confirm`/`input`/`editor`）时自动回
  「取消」并记一行日志，不会再让会话挂死或把管道写满。
- `/qq status` 增补模型、思考级别、上下文用量、会话名、启用的工具数。
- 新增 `--dry-run`：打印会用什么参数拉起 pi，排查「QQ 里为什么没有某个插件」用。
- 测试：`node --test test/`，29 项覆盖命令解析/回执、启动参数、切换暂存/取消、长回答落盘。

## 0.3.0 — 2026-10-26

修「QQ 里的 Pi 用不了其它插件」：后台服务用 `--no-extensions` 启动，只挂了本插件，
用户装的记忆、联网、子代理、定时任务在 QQ 里全部缺席，且从报错里看不出原因。

- 新增配置项 `extensions`（默认 `"all"`）：启动时读 `pi list`，把已安装的其它插件逐个
  `--extension` 挂上；支持 `"none"` 回到旧行为，或填包名/绝对路径数组按需挑选。
- `pi list` 读不到、路径解析失败时只加载自身并写日志，不让 QQ 起不来。
- 入口加幂等守卫（`shared.registered`）：同一进程里被加载两次时只注册一次命令与监听，
  避免一条 QQ 消息回复两遍。
- 文档：README 补「其它 Pi 插件」一节，说明默认行为、token 代价与回退方式。

## 0.2.9 — 2026-10-24

修「换会话后 QQ 桥静默失效」：`/qq new` 成功，但旧扩展实例拿旧句柄继续注入，失败后每 2 秒无限重试，
QQ 消息全丢、日志被刷到几百 KB。

根因：Pi 1.4 起换会话/重载会让旧 `pi`、旧 `ctx` 立即作废（`stale after session replacement`）；
原逻辑把这条永久性错误当成「Pi 正忙」，一直在重试。

- 桥注入命中 stale 时：只记一条 error、给 QQ 回一次「`/qq stop` 再 `/qq start`」、停桥并交上层收尾，
  不再安排重试；其它错误（如 Pi 正忙）保持原「放回队首 + 歇 2 秒」行为。
- `session_start(new|resume|fork)` 时若已没有活动桥，直接重建网关（自愈）。
- `switchSession()` 按 Pi 文档传 `withSession`，在回调里刷新 `ctx`，不再用已作废的命令上下文。
- `requestNewSession()` 命中 stale 时同样停桥并给出明确提示，避免留一条吞消息的网关。
- 新增 `test/stale-session.test.mjs`：19 项断言覆盖上述三处与「非 stale 仍重试」的防回归，
  `npm test` 共 64 项。
- 文档：说明后台服务的 `--extension` 必须用稳定路径（目录不存在时 Pi 会静默跳过扩展），
  并在架构文档补一节会话切换的失效处理。

## 0.2.8 — 2026-10-23

- `/qq new` 的切换等待从 6 秒放宽到 15 秒，长任务收尾时不再过早回「开新会话失败」。

## 0.2.7 — 2026-10-23

第二轮子代理复查后的修复：

- 锁文件改成“临时文件 + 硬链接”原子抢锁，EEXIST 后重新判活，避免并发时多个进程同时拿到锁。
- 注入的轮次未收到 `before_agent_start` 时，不再收集终端里其它轮次的输出；`/qq new` 切换期间到达的消息先暂存，切换完成后恢复。
- 看门狗在 Pi 正忙时只延后判定，不盲目重注；回执/重试的额度改为发送成功才扣。
- 网关握手超时从 `new WebSocket` 就开始计时；identify/resume 记住创建时的 socket，token 返回后跨连接则丢弃。
- 媒体：围栏按字符和长度配对（支持 `~~~`/四反引号），行内标记不再外发；分片不再夹到 16MB 造成边界错位；补 history/凭据拒绝项。
- `allowDirs` 类型错误时关闭文件外发，不再退化成“不限制”。
- `/qq take` 保留刚强占的锁；systemd 加 `StartLimitIntervalSec/Burst`，unit 内检测到已有服务时可见失败。
- 测试 45 项；CI 用 `npm pack --json` 断言 tarball 必需文件并禁止测试/日志/凭据。

## 0.2.6 — 2026-10-23

- `/qq start` 拉起的服务在锁被旧进程短暂占着时会等最多 4 秒重试，避免“心跳在线但网关没连上”。
- `/qq stop --force` 在 Linux 上校验 `/proc/<pid>/cmdline` 含 `pi-qq-connect`，pid 被无关进程复用时拒绝结束。
- `before_agent_start` 没有 prompt 时不误判为 QQ 轮次开始。
- 文档修正：`--session-id`（不是 `--no-session`）、`/qq new` 不会中断正在跑的轮次、npm tarball 包含 PLAN、systemd 单元路径说明。

## 0.2.5 — 2026-10-23

审改修复（不新增功能）：

- **注入 watchdog**：Pi 的 `sendUserMessage` 是 fire-and-forget，异步失败不会抛回；5 秒内没等到
  `before_agent_start` 就判定失败，重排一次并提示，避免队列永久卡死、typing 不停。
- `pump()` 被打断后补泵；`reset()` 不再清 `finishing`（避免两次投递交错）；重试改用独立
  `injecting` 标志，不再把正在跑的轮次误标空闲。
- 回执额度不再预留（`#finish` 已清定时器）；重试复用同一个 `msg_seq`，一条逻辑消息只扣一次额度，
  `40054005` 视为已送达。
- 网关加 Hello/READY 15 秒握手超时；心跳连续 3 个周期未 ACK 主动重连。
- 文件：分片短读直接报错、分片大小夹到 16MB、预上传也重试、业务码 40093001/850027 重试、
  图片流式下载按 `maxBytes` 截断、`[[file:]]` 只认围栏外独占一行、每个文件重算 `msg_id`。
- 配置：字符串布尔值不再反转（`"false"` 不再等于开启）、`allowDirs` 写成字符串按单个目录处理、
  符号链接目录/根目录边界修正；补敏感凭据文件拒绝项。
- 锁改为 `O_EXCL` 原子创建；`startService` 校验 cwd 并监听 spawn error；启动器 spawn 失败会重试、
  8 秒不退则 SIGKILL 子进程；已有服务时干净退出（systemd 不再每 5 秒重拉）。
- `/qq start` 在锁被活进程占用时直接拒绝，不再拉起注定连不上的服务。
- CI 加 `pipefail` 和必需文件断言；测试 42 项（watchdog、代码围栏标记、字符串布尔、mock 的
  `(msg_id,msg_seq)` 去重与 4/5 次额度）。

## 0.2.4 — 2026-10-23

- 开机自启：systemd 用户单元补齐 PATH、固定服务会话、`Restart=on-failure`、`KillMode=mixed`，
  配合 `loginctl enable-linger` 在登录前启动；网络未就绪由网关退避重连。
- 文档写明 systemd 与 `/qq start` 二选一的日常用法。

## 0.2.3 — 2026-10-23

- 服务角色判断加 `ppid`：`PIQQCONNECT_SERVICE_PID` 会被服务里的工具子进程继承，只看环境变量会把孙进程
  当成服务；现在必须是启动器直接拉起的那个 pi 子进程。
- `/qq new` 的角色矩阵补测试：TUI 控制面拒绝、服务进程放行、环境变量被继承的孙进程仍拒绝。
- 日志脱敏：API 错误里的 openid 和会话日志里的 chatId 都打码（之前会写完整 ID）。
- 额度只剩 1 次时不再发「收到，正在处理…」，避免回执吃掉唯一一次正文机会。
- `/qq take` 只有在网关真的起来后才报成功；服务已在运行时 `/qq start` 先停本地网关，确保单连接。
- 测试 39 项。

## 0.2.2 — 2026-10-23

- 修复 QQ 侧 `/qq new` 失败：0.2.1 的「服务在线时拒绝终端 /qq new」误伤了后台服务进程自己，
  命令被吞掉后 6 秒超时，QQ 收到「开新会话失败」。现在用 `PIQQCONNECT_SERVICE_PID` 区分服务进程。

## 0.2.1 — 2026-10-23

- 修复终端 `/qq new`：之前调用了不存在的 `switchSession`，会报错；现在正确调用 `ctx.newSession()` 并支持命名。
- 回复额度按文件预留：长回答 + 3 个文件时，优先保证 1 段文字 + 文件，不再出现上传完却发不出去。
- 分片 PUT / part_finish / 合并增加 3 次重试（网络、429、5xx），4xx 直接失败。
- `/qq start` 先释放旧锁，配置错误/服务接管等早退路径不再留下悬空锁；服务在线时 `/qq take` 拒绝抢锁。
- 启动器状态文件里的版本改为从 `package.json` 读取（之前硬编码 0.1.0）。
- `install.sh` 检测到 `pi install` 已安装时拒绝重复软链；CI 增加 `npm pack` 内容检查。
- 测试 38 项。

## 0.2.0 — 2026-10-23

- 出站图片/文件：回复末尾 `[[file:/绝对路径]]`，分片上传后以 `msg_type=7` 发送（最多 3 个，敏感路径拒绝）。
- 修正单聊被动回复上限：单聊 4 次、群聊 5 次（之前统一按 5 次计算）。
- API 域名切到 `https://api.bot.qq.com`，token 接口同步；沙箱仍用 `sandbox.api.sgroup.qq.com`。
- 错误日志带 `err_code` + `trace_id`；token 接口 HTTP 200 + `code` 的失败也能识别；429 可重试。
- 命令面精简为 `status` / `start` / `stop` / `new` / `log` / `take` 六条。
- 工程化：`src/` + `bin/` + `test/` + `docs/` + `examples/` + `scripts/` 结构，补齐 LICENSE、CI、npm 元数据。

## 0.1.0 — 2026-10-22

- 首个可用版本：QQ 官方机器人 WebSocket 网关 ⇄ 当前 Pi 会话。
- 私聊 / 群 @、引用消息、图片入站、语音转写、正在输入、代码围栏分片、被动回复预算、去重、单实例锁。
- `/qq new` 切会话；`/qq start|stop` 后台常驻服务。
