# Changelog

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
