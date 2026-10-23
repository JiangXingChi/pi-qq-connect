#!/usr/bin/env bash
# 把 Temp 下的开发副本发布回正式目录（默认 ~/Agent/Core/应用/pi-qqbot）。
#
#   ./scripts/publish-to-core.sh              # 只检查 + 预览差异，不改任何文件
#   ./scripts/publish-to-core.sh --apply      # 备份正式版后真正发布
#   ./scripts/publish-to-core.sh --e2e        # 额外跑真 pi 端到端（会调一次模型）
#
# 环境变量：PUBLISH_TARGET 覆盖发布目标，PUBLISH_BACKUP_ROOT 覆盖备份目录（测试用）。
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${PUBLISH_TARGET:-$HOME/Agent/Core/应用/pi-qqbot}"
BACKUP_ROOT="${PUBLISH_BACKUP_ROOT:-$HOME/Agent/BackUp}"
STAMP="$(date +%Y%m%d-%H%M%S)"
APPLY=0
RUN_E2E=0

for arg in "$@"; do
	case "$arg" in
		--apply) APPLY=1 ;;
		--e2e) RUN_E2E=1 ;;
		-h|--help)
			sed -n '2,10p' "$0"
			exit 0
			;;
		*)
			echo "未知参数：$arg（可用 --apply / --e2e）" >&2
			exit 2
			;;
	esac
done

EXCLUDES=(
	--exclude=.git
	--exclude=node_modules
	--exclude=.github
	--exclude='*.log'
	--exclude=sessions
	--exclude='test/tmp-*'
	--exclude=scripts/publish-to-core.sh
	--exclude=docs/DEVELOPMENT.md
)

echo "源：   $SRC"
echo "目标： $TARGET"
echo

if [ ! -d "$TARGET" ]; then
	echo "目标目录不存在：$TARGET" >&2
	echo "首次发布可先 mkdir -p 该目录，或从 BackUp 恢复一份。" >&2
	exit 1
fi

echo "== 1/4 语法检查 =="
while IFS= read -r -d '' f; do
	node --check "$f"
done < <(find "$SRC" -type f \( -name '*.js' -o -name '*.mjs' \) ! -path '*/node_modules/*' -print0)
echo "语法 OK"
echo

echo "== 2/4 单元测试 =="
(cd "$SRC" && npm test --silent)
echo

if [ "$RUN_E2E" -eq 1 ]; then
	echo "== 端到端（真 pi，会调模型） =="
	(cd "$SRC" && npm run e2e --silent)
	echo
fi

echo "== 3/4 差异预览 =="
DIFF="$(rsync -ain --delete "${EXCLUDES[@]}" "$SRC/" "$TARGET/" | grep -vE "^\.d" || true)"
if [ -z "$DIFF" ]; then
	echo "没有差异，无需发布"
	exit 0
fi
echo "$DIFF"
echo

if [ "$APPLY" -ne 1 ]; then
	echo "== 预览模式：以上是将会发生的改动 =="
	echo "确认无误后运行：./scripts/publish-to-core.sh --apply"
	exit 0
fi

echo "== 4/4 发布 =="
BACKUP="$BACKUP_ROOT/pi-qqbot-$STAMP"
mkdir -p "$BACKUP"
rsync -a "$TARGET/" "$BACKUP/"
echo "已备份正式版：$BACKUP"

rsync -a --delete "${EXCLUDES[@]}" "$SRC/" "$TARGET/"

if diff -rq --exclude=.git --exclude=.github --exclude=publish-to-core.sh --exclude=DEVELOPMENT.md \
	--exclude='*.log' --exclude=sessions --exclude='tmp-*' "$SRC" "$TARGET" >/dev/null; then
	echo "校验通过：开发副本与正式目录一致"
else
	echo "警告：发布后仍有差异，请检查" >&2
	diff -rq --exclude=.git --exclude=.github --exclude=publish-to-core.sh --exclude=DEVELOPMENT.md \
		--exclude='*.log' --exclude=sessions --exclude='tmp-*' "$SRC" "$TARGET" >&2 || true
	exit 1
fi

echo
echo "发布完成。生效方式：重启后台服务或 pi（扩展是软链，已指向正式目录）。"
echo "如需回滚：rsync -a --delete '$BACKUP/' '$TARGET/'"
