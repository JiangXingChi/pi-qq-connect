# 开发与发布

这是 `pi-qqbot` 的开发副本流程。日常在 `~/Agent/Temp/pi-qqbot-dev` 改代码、跑测试，
确认后发布到 `~/Agent/Core/应用/pi-qqbot`，扩展软链始终指向正式目录。

| 目录 | 用途 |
|---|---|
| `~/Agent/Temp/pi-qqbot-dev` | 开发副本：随便改，跑测试 |
| `~/Agent/Core/应用/pi-qqbot` | 正式版：只由 `scripts/publish-to-core.sh` 写入 |
| `~/.pi/agent/extensions/pi-qqbot` | 软链 → 正式版，Pi 启动时加载 |

## 日常流程

```bash
cd ~/Agent/Temp/pi-qqbot-dev
npm test
./scripts/publish-to-core.sh          # 语法 + 单测 + 差异预览（不改文件）
./scripts/publish-to-core.sh --apply  # 备份正式版后发布
```

- `--e2e`：发布前额外跑真 pi 端到端（会调一次模型）。
- 发布前会把正式版备份到 `~/Agent/BackUp/pi-qqbot-<时间戳>/`。
- 发布用 `rsync --delete`：删除只发生在正式目录里、且开发副本没有的文件；
  `.git`、`.github`、日志、`sessions`、`test/tmp-*`、本文件、`publish-to-core.sh` 不参与同步。
- 发布后重启后台服务（`/qq start` 前先 `/qq stop`，或重启进程），否则旧进程仍加载旧模块。
- 回滚：`rsync -a --delete ~/Agent/BackUp/pi-qqbot-<时间戳>/ ~/Agent/Core/应用/pi-qqbot/`

## 本地加载

```bash
pi --extension ~/Agent/Temp/pi-qqbot-dev
/qq status ; /qq log 50 ; /qq take（锁被活进程占用时）
```

不要把 `~/.pi/agent/extensions/pi-qqbot` 改成指向开发副本：测试和正式会混在一起，
两个网关会互相抢锁。调试单个改动用 `--extension` 临时加载。

## 发布 npm

```bash
npm pack --dry-run        # 看 files 白名单，确认没有凭据/日志/.git
npm publish               # publishConfig.access=public；prepublishOnly 会跑 npm test
```

发布前检查：

- `package.json` 的 `version` 已递增，`CHANGELOG.md` 有对应条目；
- `pi` 字段仍指向 `./index.js`，`keywords` 含 `pi-package`（Pi 包市场收录）；
- README 的安装命令、配置表与实际一致；
- 没有把 `~/.pi/agent/pi-qqbot.json` 或任何真实 AppID/AppSecret 带进仓库。

## 注意

- 凭据永远只在 `~/.pi/agent/pi-qqbot.json`，两份代码都不含凭据。
- 测试不连真 QQ；全部用 `test/mock-qq.mjs`。`npm run e2e` 会花一次模型调用。
- 文件名、包名、配置名、锁/服务状态名已统一为 `pi-qqbot`；新增文件不要再用中文路径。
