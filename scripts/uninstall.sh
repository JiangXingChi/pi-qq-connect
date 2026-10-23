#!/usr/bin/env bash
# 只卸载扩展挂载点；配置、日志、会话都保留。
set -euo pipefail

DEST="$HOME/.pi/agent/extensions/pi-qqbot"
CONF="$HOME/.pi/agent/pi-qqbot.json"

if [ -L "$DEST" ]; then
	rm -f "$DEST"
	echo "已移除扩展软链：$DEST"
elif [ -d "$DEST" ]; then
	# 不是软链说明是手工拷贝，路径里可能有你自己的改动，不自动删
	echo "注意：$DEST 是真实目录（不是本项目建的软链），未删除。" >&2
	echo "确认后自行处理。" >&2
	exit 1
else
	echo "扩展未安装：$DEST"
fi

echo "保留：$CONF（含凭据）、$HOME/.pi/agent/pi-qqbot.log、$HOME/.pi/agent/pi-qqbot.lock"
echo "确实不再需要时再手动删除。"
