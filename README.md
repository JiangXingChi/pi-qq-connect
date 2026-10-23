# pi-qqbot

[![npm](https://img.shields.io/npm/v/pi-qqbot)](https://www.npmjs.com/package/pi-qqbot)
[![license](https://img.shields.io/npm/l/pi-qqbot)](LICENSE)
[English](README.en.md)

把 **QQ 官方机器人**接到**当前 Pi 会话**的插件。零运行时依赖，只用 Node ≥22.19 自带的
`fetch` / `WebSocket` / `node:crypto` / `node:http`，安装后即可用。

- QQ 里发的文字 → `pi.sendUserMessage()` → Pi 干活 → 回答被动回复到 QQ
- 所有 QQ 消息进同一个 Pi 会话，上下文连续；终端里也能看到这些对话
- 私聊 + 群聊（群里必须 @机器人，平台只推这种事件）
- 入站图片下载后作为 Pi 图片输入；语音用 QQ 自带转写；引用消息带上下文
- 单聊「正在输入」；长回复按代码围栏切块；失败换新 `msg_seq` 重试
- 出站图片/文件：回复末尾 `[[file:/绝对路径]]`，分片上传后以图片/文件卡片发出
- 入站去重、串行队列、被动回复预算、窗口兜底、单实例锁、后台常驻服务
- `/new`、`/resume`、`/qq new` 都不会把网关断掉重连

## 前置：注册 QQ 机器人

1. 打开 <https://q.qq.com> → 用 QQ 扫码注册开发者（个人可注册）→ 创建机器人应用
2. 在「开发设置」里拿 **AppID**（纯数字）和 **AppSecret**
3. 开发期先用**沙箱**：在「沙箱配置」把自己测试用的 QQ 加进白名单；群聊需要把机器人拉进群，并把群加进沙箱
4. 正式环境需要在管理端提交上线/审核，通过后 `sandbox` 改 `false`

不需要公网 IP、不需要回调地址：插件主动连 QQ 的 WebSocket 网关（官方支持的正向接入）。

## 安装

三种方式**选一种**，不要叠加（同一扩展会被加载两次，两个网关会抢锁）。

从 npm（推荐）：

```bash
pi install npm:pi-qqbot
```

从源码作为包安装：

```bash
git clone https://github.com/<you>/pi-qqbot.git
cd pi-qqbot
pi install .
```

开发时只软链（不写 settings）：

```bash
./scripts/install.sh
```

已用 `pi install` 装过时，`install.sh` 会检测到并拒绝执行。

它会软链到 `~/.pi/agent/extensions/pi-qqbot`，并在不存在时生成一份
`~/.pi/agent/pi-qqbot.json`（权限 600）。填配置：

```json
{
  "appId": "1234567890",
  "clientSecret": "你的 AppSecret",
  "sandbox": true,
  "allowAll": false,
  "allowUsers": [],
  "allowGroups": []
}
```

完整字段见 [`examples/config.json`](examples/config.json) 和下面的配置表。重启 `pi`，
终端输入 `/qq status` 应显示网关在线。

## 使用

| 场景 | 操作 |
|---|---|
| 私聊 | 直接发消息 |
| 群聊 | @机器人 再说话（平台只推 @ 事件） |
| 看状态 | `/qq status`（网关、队列、最近入站、后台服务） |
| 启动后台 | `/qq start`：拉起常驻 pi，QQ 会话交给它 |
| 停止 | `/qq stop`：停后台服务；没有服务时断开本进程网关 |
| 看日志 | `/qq log 50` |
| 开新会话 | QQ 里发 `/qq new`（或 `/qq new 名字`），等同终端 `/new` |
| 网关被占用 | `/qq take`：强制接管锁（仅锁冲突时用，对方 30 秒内自停） |
| 发文件 | 让 Pi 在回复末尾写 `[[file:/绝对路径]]`，最多 3 个 |

命令共 6 条：`status` / `start` / `stop` / `new` / `log` / `take`。

后台服务在线时，终端里的 `/qq new` 不会切 QQ 会话（会提示你在 QQ 里发），终端 `/new`
也只切本地 TUI；QQ 会话由服务进程管理。

QQ 侧只认一个命令：`/qq new`（可选带名字）。其余内容都当普通任务交给 Pi。
`/qq new` 会清空待处理队列和旧输出；正在跑的那一轮不会被中断——流式期间发 `/qq new` 可能失败，等这轮结束再发。

### 发文件

在 QQ 里让 Pi 处理完文件后，Pi 会在回复末尾写 `[[file:/绝对路径]]`（插件已在每条 QQ 消息的
提示里告诉它）。插件会：

1. 摘掉标记，正常发文字；
2. 校验文件（存在、普通文件、非敏感路径、≤200MB）；
3. 分片上传 → `msg_type=7` 发出，QQ 里显示图片或文件卡片；
4. 每次最多 3 个，每个占一次被动回复额度。

敏感路径（`~/.ssh`、`~/.config`、`~/.pi/agent` 等）一律拒绝；可用 `files.allowDirs`
限定只允许某些目录。

### 后台常驻服务（推荐）

插件自己管一个后台 pi，QQ 会话固定落在 `pi-qqbot-service` 这条会话上，不用一直开着 TUI：

```bash
/qq start     # 拉起后台 pi（detached，父进程退出也不停）
/qq status    # 看 pid、心跳、会话、日志路径
/qq stop      # SIGTERM 并等它退出
```

- 后台服务在线时，TUI 里的插件只当控制面：不连网关、不抢锁，状态栏显示「QQ: 服务在线」。
- 状态文件 `~/.pi/agent/pi-qqbot.service.json`（15 秒一次心跳），日志
  `~/.pi/agent/pi-qqbot.service.log`。
- 心跳超过 45 秒没更新就判定掉线，可 `/qq start` 重拉。
- 已有健康服务时，第二个实例会自己退出，不会出现两个 pi 抢网关。
- 状态文件里的 pid 还活着但心跳已停（可能是 pid 被复用），`/qq stop` 会拒绝发信号；
  确认后加 `--force`。
- 想开机自启可以用 systemd（见下），两者选一个即可，不要同时开。

### 前台常驻 / systemd

```bash
./bin/pi-qqbot.mjs --cwd ~            # 前台跑
```

它拉起 `pi --mode rpc --session-id pi-qqbot-service --extension 本项目`，只要 stdin 不关 pi 就不退出。
需要开机自启（用户级服务 + linger，不用 sudo 装系统服务）：

```bash
cp packaging/pi-qqbot.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pi-qqbot
loginctl enable-linger $USER   # 已开启可跳过；不登录也会在开机时启动
```

- 单元里已把 `~/.local/bin` 和 `/usr/sbin` 加进 PATH，并固定 `--session-id pi-qqbot-service`。
- 单元默认指向本机源码路径；npm 全局安装的用户把 `ExecStart` 改成
  `%h/.npm-global/bin/pi-qqbot --cwd %h --session-id pi-qqbot-service`（路径以 `npm bin -g` 为准）。
- 网络没就绪也无需处理：网关会按 1s→60s 退避重连，联网后自动上线。
- 启用 systemd 后日常用 `systemctl --user start|stop|restart pi-qqbot`；
  `/qq stop` 也会停掉它（干净退出，`Restart=on-failure` 不会自动拉回），下次开机再启动。
- 开机自启与插件自己的 `/qq start` 不要同时管理：unit 在跑时 `/qq start` 只会提示已在运行。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关 |
| `appId` / `clientSecret` | — | 开放平台凭据（也可用 `QQBOT_APP_ID` / `QQBOT_CLIENT_SECRET`） |
| `sandbox` | false | 沙箱环境 |
| `allowAll` | false | 放开所有人（自用临时调试用） |
| `allowUsers` / `allowGroups` | [] | openid 白名单，支持 `*` 结尾前缀匹配 |
| `envelope` | true | 给消息加 `[QQ群聊 · 群 xxx · 成员 xxx]` 头 |
| `replyFormat` | plain | `plain` 清掉 Markdown；`markdown` 走 msg_type=2，被拒自动退回纯文本 |
| `maxChunks` | 4 | 一条回复最多分几段（平台上限 5，留 1 条余量） |
| `replyQuota` | 5 | 发送总次数上限（含回执；重试复用 seq）；实际按场景取小：单聊 4、群 5 |
| `files` | 开启 | `enabled` / `maxCount`（最多 3）/ `maxBytes`（200MB）/ `allowDirs` |
| `chunkChars` | 4000 | 每段字数 |
| `typing` | true | 单聊发「正在输入」（群聊 QQ 不支持） |
| `ackAfterMs` | 0 | >0 时长任务先回「收到，正在处理…」（占一次额度） |
| `passiveWindowSec` | 群 300 / 单聊 3600 | 被动回复窗口 |
| `images.maxCount/maxBytes` | 2 / 8MB | 入站图片限制 |
| `lock` | true | 单实例锁（`~/.pi/agent/pi-qqbot.lock`） |
| `log.file/level` | `~/.pi/agent/pi-qqbot.log` / info | 日志 |
| `endpoints` | 空 | 测试用：覆盖 token / api / 网关地址 |

环境变量：`QQBOT_CONFIG`、`QQBOT_APP_ID`、`QQBOT_CLIENT_SECRET`、`QQBOT_SANDBOX=1`、
`QQBOT_DISABLED=1`。

## 必须知道的限制

- **只能被动回复**：QQ 在 2025-04-21 下线了主动消息。群聊 5 分钟内最多 5 次、单聊 60 分钟内
  最多 4 次。插件按场景取上限、超时改用同会话最新消息的 `msg_id`。
- **等待太久会过期**：模型跑超过窗口（群 5 分钟）就可能发不回去；要么把模型调快，要么在群里再发一句。
- **一个会话**：所有 QQ 对话共用同一条 Pi 上下文，互相可见（所以有信封头）。
- **安全**：等于把这台机器上的 agent 交给拿到 openid 的人。`allowAll` 只用于调试，正式使用填
  `allowUsers`。配置里有明文密钥，文件权限务必 600。

## 排错

| 现象 | 处理 |
|---|---|
| `/qq status` 显示「未配置」 | 没填 appId/clientSecret，或 JSON 写坏了 |
| 「被占用 pid x」 | 另一个 pi 进程持有网关；关掉它，或 `/qq take` |
| 网关一直「重连中」 | `/qq log 50`：4004 凭据错、4008 限流、4013/4014 intents 没开、4914/4915 沙箱/封禁 |
| QQ 里没反应 | 群聊必须 @；确认 `allowUsers`/`allowGroups` 里有你的 openid |
| 回复「消息发送超频」 | 触发回复上限或窗口过期，等用户再发一条 |
| 文件发送失败 | 日志里有 `err_code` 和 `trace_id`；常见 40093006 是合并参数、850031 是超大小 |

## 开发

```bash
npm test                  # 42 项单测 + mock QQ
npm run e2e               # 真 pi --mode rpc + mock QQ（会调一次模型）
npm run e2e:service       # 后台服务进程生命周期
npm run e2e:service-cmd   # 真 pi 里 /qq start|stop
```

- 架构与协议细节：[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- 开发副本与发布流程：[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)
- 决策与历史：[`docs/PLAN.md`](docs/PLAN.md)

零运行时依赖；`npm install` 不会装任何东西。测试用 `test/mock-qq.mjs`（HTTP + 最小
WebSocket 服务端），不接触真实 QQ。

## 参考

协议与边界处理参考了 Hermes Agent 的 QQ Bot 适配器与本机实测：媒体 CDN 需带 QQBot token、
代码围栏分片、随机 `msg_seq`、typing、引用消息、限流/关闭码分类、入站去重。
QQ 官方文档：<https://bot.q.qq.com/wiki/develop/api-v2/>。

## License

MIT
