# 第 3 轮审改说明（给审阅子代理）

仓库：`/home/teacat/Agent/Core/应用/pi-qq-connect`（基线 `443a87d` = 0.4.0，工作树 = 0.4.1）
补丁：`review/round3.patch`（`git diff 443a87d`）。背景：`PLAN.md`、`review/README.md`（pi 1.4 实测语义）。

## 第 2 轮发现 → 本轮处理

| 上轮发现 | 处理 |
|---|---|
| **严重** `!state.bridge?.switching` 守卫恒假，`/new` 被取消/失败时永不 `cancelSwitch`，整桥停 30s | `session_shutdown` 给 `pendingExec.sawShutdown` 打标；`done()` 只在**没见过 shutdown** 时 `cancelSwitch`；请求超时 60s→35s（略长于 30s 看门狗），31~35 秒内 `/new` 不再被拒 |
| **严重** `session_shutdown` 清 `state.owner` 后若没有 `session_start`，存活实例被永久静默（`quit` 也不收摊） | 换会话分支**不再清 owner**；shutdown 守卫改为 `if (state.owner && state.owner !== pi) return`（无负责人时允许处理） |
| `#restore()` 命令并发跑、与提问抢序；stale 时静默丢命令 | 命令**串行**跑完再 `pump()`；stale/stopped 时把剩余命令 `unshift` 回队首并 warn |
| `deferred` 无上限、`#restore` 绕过 `maxQueue` | 暂存与恢复都按 `maxQueue` 截断并计数 |
| `retryCount` 接棒后不清零 | `adopt()` / `reset()` 归零 |
| `staleReported` 只写不读 | 删除 |
| `#failOnStale` 的 `switching` 分支不可达、typing 传错对象 | 删分支；`#pumpOnce` catch 里先取 `inflight` 再清空，传进 `#failOnStale` |
| 媒体 URL / `auth.describe()` 泄露 appid | 新增 `maskUrl()`（只留 origin）；`describe()` 打码 |
| `endSwitch()` 不幂等，重复 `session_start` 会重置健康会话 | 只有 `bridge.switching` 为真才 `endSwitch()`，否则只 `pump()` |
| `startPending` 重跑整个 `start()` 会断网关、丢队列 | 已有桥时只更新 `state.ctx` + `adopt()` + `pump()` |
| **命令在同会话两个实例里各注册一次** | 实测：pi 对同名命令重复注册的处理是「谁都别执行」。改为在 `session_start` 里由选中的实例 `registerCommands()` 一次（探针验证：session_start 内注册可用） |
| 文档/计数 | `AGENTS.md`、`docs/ARCHITECTURE.md`、`docs/DEVELOPMENT.md`、`docs/PLAN.md`、`PLAN.md`、`README.md`、`CHANGELOG.md` 同步为 131 项与新语义 |
| 测试 | e2e 去掉 `10s` 硬阈值（改为只打印耗时）；新增 T12（cancelSwitch 补跑命令）、T13（暂存上限）、T14（同会话命令只注册一次）；T8/T9/T10 改 `waitFor`；`unit.test` 的 `reset()` 用例改名 |

## 输出格式

```
## 核对上一轮
1. #1 已修对 / 未修好（原因）/ 引入新问题
## 新发现
1. [阻断/严重/一般/建议] 文件:行 — 问题
   为什么：…
   建议：…
## 未发现问题
（一句话）
```

只读，不要改文件。可跑 `npm test`、`node test/e2e.mjs`、`npm run e2e:service`、`npm run e2e:service-cmd`。
若某条**确实**无法在静态分析里判定，写「需实测：命令」。
