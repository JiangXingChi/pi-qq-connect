# 发布清单

面向维护者。发布前按顺序走完，任何一步失败都不要继续。

## 0. 一次性准备

- GitHub 账号，且本机已登录：`gh auth login`
- npm 账号，且本机已登录：`npm login`
- Node.js ≥ 22.19
- 仓库地址确定后，把下面两处占位符替换成真实地址：
  - `README.md`、`README.en.md` 里的 `https://github.com/<you>/pi-qqbot.git`
  - `package.json` 增加 `repository`、`homepage`、`bugs`

`package.json` 建议字段（把 `<owner>` 换成 GitHub 用户名）：

```json
{
  "repository": {
    "type": "git",
    "url": "git+https://github.com/<owner>/pi-qqbot.git"
  },
  "homepage": "https://github.com/<owner>/pi-qqbot#readme",
  "bugs": {
    "url": "https://github.com/<owner>/pi-qqbot/issues"
  }
}
```

## 1. 本地验证

```bash
cd ~/Agent/Temp/pi-qqbot-dev
npm test
npm run e2e
npm run e2e:service
npm run e2e:service-cmd
node --check bin/pi-qqbot.mjs
deno lint --no-config src bin test index.js
```

期望：单测全过，三组 e2e 全过，lint 无 `no-undef` / `no-unused-vars`。

## 2. 检查发布内容

```bash
npm pack --dry-run --json > /tmp/pi-qqbot-pack.json
node -e '
const p = Object.values(require("/tmp/pi-qqbot-pack.json"))[0];
console.log(p.files.map((f) => f.path).join("\n"));
'
```

必须包含：`index.js`、`src/index.js`、`bin/pi-qqbot.mjs`、`README.md`、`docs/PLAN.md`、`packaging/pi-qqbot.service`。

不能包含：`test/`、`*.log`、`pi-qqbot.json`、`.git`、任何 AppSecret。

## 3. Git 与 GitHub

```bash
git status --short          # 应为空
git tag --list | tail -5    # 确认版本 tag
git push origin main --tags
```

如果还没有远端仓库：

```bash
gh repo create <owner>/pi-qqbot --public --source=. --remote=origin --push
```

## 4. npm 发布

```bash
npm publish --dry-run       # 先看文件名、大小、版本
npm publish                 # publishConfig.access=public，会跑 prepublishOnly
```

> 注意：`pi-qqbot` 这个名字在 npm 上曾有一个 `0.1.0`，已于 2026-09-16 被撤回。
> 如果 `npm publish` 返回 `E403` 或“name not available”，不要反复重试；改用
> scoped 包名（例如 `@<npm-user>/pi-qqbot`），并同步修改 README 的安装命令。

发布后验证：

```bash
npm view pi-qqbot version
npm view pi-qqbot dist.tarball
pi install npm:pi-qqbot
```

新开一个 Pi，执行 `/qq status`，确认扩展被加载、后台服务在线。

## 5. 发布后

- 在 GitHub 创建 Release，正文取 `CHANGELOG.md` 的当前版本段落
- 更新 README 顶部的版本徽章（npm 徽章会自动更新）
- 确认 `pi install npm:pi-qqbot` 与文档一致；若改了包名，三处都要改：
  `README.md`、`README.en.md`、`package.json`
- 记录发布结果：版本、tag、npm 包名、GitHub Release 地址
