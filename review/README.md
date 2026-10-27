# 第 1 轮审改说明（给审阅子代理）

仓库：`/home/teacat/Agent/Core/应用/pi-qq-connect`（pi 扩展：把 QQ 官方机器人接到 Pi 会话）
本次改动：0.4.0 → 0.4.1，修「QQ 里发一次 `/new`，桥就废掉」。
完整背景与设计见同目录 `PLAN.md`；补丁见 `review/round1.patch`（`git diff` 同内容）。

## 已实测的 pi 1.4 语义（不要当成 bug 来报）

用探针扩展在 `pi --mode rpc` 下实测：

1. `/new` 在实例 I1 的命令 ctx 里执行 → I1 收到 `session_shutdown(new)`，**I1 的 `pi` 句柄立刻永久作废**
   （任何 `pi.xxx()` 都抛 `stale after session replacement or reload`）。
2. 模块被缓存但**扩展工厂会重跑**，得到实例 I2（新的 `pi` 对象，`globalThis` 单例仍在）。
3. I2 收到 `session_start(new)`。
4. I1 的 `withSession(next)` 在这之后才执行，`ctx.newSession()` 才 resolve。
5. 旧实例之后不再收到任何 `session_start`；`/reload` 也会：`session_shutdown(reload)` → 工厂重跑（真正重新 import）→ `session_start(reload)`。
6. `pi.sendUserMessage("/cmd", { expandPromptTemplates: true })` 会**当作命令执行**（不加该选项则当普通提示词喂模型）。

## 本次修复要点

- `src/index.js`：`state.registered` 布尔量 → `WeakSet<pi>` 按实例注册；`session_shutdown` 的
  `new/resume/fork/reload` 调 `bridge.beginSwitch()`；`session_start` 调 `bridge.adopt(pi)` 并按 reason 收尾。
- `src/session.js`：新增 `adopt(pi)`；`#failOnStale()` 从「停桥 + onFatal」改为「标记 stale + 暂停 + 保留队列/网关」，
  接棒后恢复；`pump()` 增加 stale 短路。
- `test/`：新增 `session-adopt.test.mjs`；改写 `stale-session.test.mjs` 的 P1/P2；`e2e.mjs` 改用真实 `/new`
  并断言换会话后 `/qq status` 仍可用、日志无 stale。

## 请按指定角度只做只读审阅（不要改文件）

输出格式（简洁）：

```
## 发现
1. [阻断/严重/一般/建议] 文件:行 — 问题一句话
   为什么：…
   建议：…
## 未发现问题
（一句话）
```

要求：
- 只报真实缺陷或明确的改进点，不要复述改动、不要给「整体不错」之类空话。
- 每条必须能指到 `文件:行`，并说明触发条件（尤其是并发/时序）。
- 你所在的轮次如果没找到任何**阻断/严重**问题，也要把「一般/建议」列全。
