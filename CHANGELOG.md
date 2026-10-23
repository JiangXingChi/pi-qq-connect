# Changelog

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

- 服务角色判断加 `ppid`：`QQBOT_SERVICE_PID` 会被服务里的工具子进程继承，只看环境变量会把孙进程
  当成服务；现在必须是启动器直接拉起的那个 pi 子进程。
- `/qq new` 的角色矩阵补测试：TUI 控制面拒绝、服务进程放行、环境变量被继承的孙进程仍拒绝。
- 日志脱敏：API 错误里的 openid 和会话日志里的 chatId 都打码（之前会写完整 ID）。
- 额度只剩 1 次时不再发「收到，正在处理…」，避免回执吃掉唯一一次正文机会。
- `/qq take` 只有在网关真的起来后才报成功；服务已在运行时 `/qq start` 先停本地网关，确保单连接。
- 测试 39 项。

## 0.2.2 — 2026-10-23

- 修复 QQ 侧 `/qq new` 失败：0.2.1 的「服务在线时拒绝终端 /qq new」误伤了后台服务进程自己，
  命令被吞掉后 6 秒超时，QQ 收到「开新会话失败」。现在用 `QQBOT_SERVICE_PID` 区分服务进程。

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
