# 开发

## 环境

- Node.js >= 22.19（用到全局 `fetch` / `WebSocket`）
- Pi >= 1.4（扩展 API）
- 零运行时依赖：`npm install` 不会安装任何包

## 本地加载

```bash
git clone https://github.com/<you>/pi-qqbot.git
cd pi-qqbot

# 方式一：临时加载，不写设置
pi --extension .

# 方式二：作为包安装（把当前目录复制进 Pi 的 npm 目录）
pi install .

# 方式三：开发软链
./scripts/install.sh
```

启动后终端输入 `/qq status`；配置在 `~/.pi/agent/pi-qqbot.json`（权限 600）。

## 测试

```bash
npm test                  # 36 项：配置、文本、分片、预算、额度、去重、锁、服务、媒体上传
npm run e2e               # 真 pi --mode rpc + mock QQ，会调一次模型
npm run e2e:service       # 后台服务进程生命周期，不调模型
npm run e2e:service-cmd   # 真 pi 里执行 /qq start|stop
```

`npm test` 全部走 `test/mock-qq.mjs`（本地 HTTP + 最小 WebSocket 服务端），不接触真实 QQ。
`npm run e2e` 会花一次模型调用，不要放进循环。

## 目录

```
index.js              Pi 入口（package.json 的 pi.extensions 指向它）
src/                  运行模块：网关、API、桥、配置、日志、媒体、服务、锁
bin/pi-qqbot.mjs      常驻启动器（pi --mode rpc）
examples/config.json  配置样例
scripts/install.sh    软链安装；uninstall.sh 只删软链
packaging/            systemd 单元示例
docs/                 架构、开发、决策记录
test/                 单测、mock 平台、端到端
```

## 发布 npm

```bash
npm version patch|minor   # 改版本并打 tag
npm pack --dry-run        # 检查 files 白名单：不应出现凭据、日志、.git、test/
npm publish               # prepublishOnly 会先跑 npm test
```

发布前确认：

- `package.json` 的 `version` 与 `CHANGELOG.md` 一致；
- `pi` 字段仍指向 `./index.js`，`keywords` 含 `pi-package`；
- README 的安装命令和配置表与实际一致；
- 仓库里没有任何真实 AppID/AppSecret。

## 约定

- 测试不连真 QQ，凭据只在 `~/.pi/agent/pi-qqbot.json`。
- 改网关/发送/会话切换要补对应测试；提交前 `npm test` 必须全过。
- 文件名、包名、配置/锁/服务状态统一用 `pi-qqbot`。
