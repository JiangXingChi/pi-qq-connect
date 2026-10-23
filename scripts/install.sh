#!/usr/bin/env bash
# 把本项目挂到 Pi 扩展目录，并生成一份初始配置。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$HOME/.pi/agent/extensions"
DEST="$EXT_DIR/pi-qq-connect"
CONF="$HOME/.pi/agent/pi-qq-connect.json"

# 已经通过 `pi install` 装过时不要再软链，否则同一扩展会被加载两次、两个网关抢锁。
SETTINGS="$HOME/.pi/agent/settings.json"
if [ -f "$SETTINGS" ] && node -e '
const fs=require("fs");const p=process.argv[1];
try{const s=JSON.parse(fs.readFileSync(p,"utf8"));const list=Array.isArray(s.packages)?s.packages:[];
const hit=list.some((x)=>{const src=typeof x==="string"?x:(x&&x.source)||"";return /pi-qq-connect/.test(src);});
process.exit(hit?0:1);}catch{process.exit(1);}
' "$SETTINGS"; then
	echo "检测到 settings.json 里已经用 pi install 安装过 pi-qq-connect。" >&2
	echo "不要再跑本脚本，否则扩展会被加载两次。用 pi list / pi update --extensions 管理。" >&2
	exit 1
fi

mkdir -p "$EXT_DIR"
if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
	echo "错误：$DEST 已存在且不是软链接（可能是旧的手工拷贝）。" >&2
	echo "先确认里面的内容，手动移走后再运行本脚本。" >&2
	exit 1
fi
ln -sfn "$ROOT" "$DEST"
echo "扩展已挂载：$DEST -> $ROOT"

if [ ! -f "$CONF" ]; then
	cat > "$CONF" <<'JSON'
{
  "enabled": true,
  "appId": "",
  "clientSecret": "",
  "sandbox": true,
  "allowAll": false,
  "allowUsers": [],
  "allowGroups": [],
  "envelope": true,
  "replyFormat": "plain",
  "maxChunks": 4,
  "replyQuota": 5,
  "chunkChars": 4000,
  "typing": true,
  "log": { "file": "~/.pi/agent/pi-qq-connect.log", "level": "info" }
}
JSON
	chmod 600 "$CONF"
	echo "已生成配置：$CONF"
	echo "请填入 appId / clientSecret（QQ 开放平台 → 开发设置）；改完重启 pi。"
else
	chmod 600 "$CONF" || true
	echo "配置已存在：$CONF（未覆盖）"
fi

echo
echo "验证：重启 pi，终端输入 /qq status"
echo "常驻：$ROOT/bin/pi-qq-connect.mjs --cwd ~ （或参考 packaging/pi-qq-connect.service）"
