# 第 2 轮审改说明（给审阅子代理）

仓库：`/home/teacat/Agent/Core/应用/pi-qq-connect`
上一轮 3 个审阅代理提了 20+ 条发现，已按下面清单改完。请**先核对每条是否真的改对、有没有引入新问题**，
再按你自己的角度找剩余缺陷。补丁见 `review/round2.patch`（`git diff` 同内容），背景见 `PLAN.md`、
`review/README.md`（pi 1.4 实测语义，不要当成 bug 报）。

## 上一轮发现 → 本轮处理

| # | 上一轮发现 | 处理 |
|---|---|---|
| 1 | `beginSwitch()` 重复调用清空 `deferred`（QQ 侧 /new 会调两次） | `beginSwitch()` 仅在 `!switching` 时初始化，重复调用只续 30s 看门狗 |
| 2 | `endSwitch()` 的 `reset()` 清掉 `queue`/`inflight`，与「接棒后重试」承诺矛盾 | `endSwitch()` 先取 `queue`/`deferred`/`inflight`，`reset()` 后经 `#restore()` 放回；in-flight 的回答丢弃并记 warn |
| 3 | `pump()` 切换中仍注入；`#failOnStale()` 提前清 `switching` | `pump()` 守卫加 `switching`；`#failOnStale()` 不再动 `switching`/`deferred`/`switchTimer` |
| 4 | 暂存的斜杠命令被当普通提问喂模型 | 新增 `#restore()`：重新 `parseCommand()`，命令走 `#runCommand()`，其余入队 |
| 5 | 20s 请求超时 < 30s 看门狗，且超时会误 `cancelSwitch` | 请求超时改 60s；`done()` 只在 `!bridge.switching` 时 `cancelSwitch()` |
| 6 | `start()` 重入丢新实例 `session_start`；桥用旧闭包 `pi` | `startPending` 排队重跑；`new QqBridge({ pi: state.extensionApi ?? pi })` |
| 7 | 未知 shutdown reason 一律 `stop()` | 只有 `quit/exit/shutdown` 收摊；未知 reason 记 warn 并按换会话处理 |
| 8 | `#pumpOnce` 里 `generation` 死代码吞消息 | 下载后统一 `queue.unshift(item)` 再返回；删掉不可达判断 |
| 9 | `#stopTyping(item)` 传错对象 | 改为对 `inflight` 停 typing |
| 10 | `WeakSet<pi>` 依赖对象身份（实测同一会话会拿到两个不同 `pi`） | 保留 WeakSet（同对象去重）+ 新增按 `session_start` 的同一 `ctx` 选举负责人，其它事件有 `state.owner !== pi` 守卫 |
| 11 | `ARCHITECTURE.md` / `README.en.md` / `README.md` 文档过时 | 已同步；测试项数改为 125 |
| 12 | `/qq status` 不显示 `stale` | 队列行加「已暂停，等新会话接棒」 |
| 13 | 5 分钟节流是死代码 | 删除节流与常量，语义改为「每个 stale 周期提示一次」，文档同步 |
| 14 | `adopt()` 不清 `injecting`，接棒后仍不流动 | `adopt()`/`#failOnStale()` 都清 `injecting` |
| 15 | 非 stale 注入失败每 2s 无限重试 | 退避 2s→4s→…→30s，成功注入后归零 |
| 16 | e2e 断言测不出 0.4.0 的 bug | 加时序断言（/new 回执 <10s）、断言日志无「换会话 30 秒内没有完成」、删掉恒真文案检查 |
| 17 | 测试恒真/固定 sleep/缺 fork | `harness` 加 `commandRegistrations`；新增 T2b/T5/T6/T8/T9/T10/T11/T12；改用 `waitFor` |

## 输出格式

```
## 核对上一轮
1. #1 已修对 / 未修好（原因）/ 引入新问题（说明）
## 新发现
1. [阻断/严重/一般/建议] 文件:行 — 问题
   为什么：…
   建议：…
## 未发现问题
（一句话）
```

只读，不要改文件。可以跑 `npm test`、`node test/e2e.mjs`、`npm run e2e:service`、`npm run e2e:service-cmd`。
