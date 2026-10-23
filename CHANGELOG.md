# Changelog

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
