#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${HOME}/.gemini/config/plugins/agy-context"
MODE="${1:-link}"

case "$MODE" in
  link|--link)
    mkdir -p "$(dirname "$TARGET_DIR")"
    if [ -L "$TARGET_DIR" ]; then
      rm "$TARGET_DIR"
    elif [ -e "$TARGET_DIR" ]; then
      echo "目标目录已存在且不是软链接: $TARGET_DIR"
      echo "请先备份或删除后再运行，或使用 ./install.sh --uninstall 卸载。"
      exit 1
    fi
    ln -s "$REPO_DIR" "$TARGET_DIR"
    echo "✅ 已软链接安装 AGY Context 到: $TARGET_DIR"
    echo "   修改本仓库代码后无需重新拷贝。"
    ;;
  copy|--copy)
    mkdir -p "$(dirname "$TARGET_DIR")"
    rm -rf "$TARGET_DIR"
    mkdir -p "$TARGET_DIR"
    cp -R "$REPO_DIR/plugin.json" "$REPO_DIR/hooks.json" "$REPO_DIR/hooks" "$REPO_DIR/README.md" "$REPO_DIR/LICENSE" "$REPO_DIR/assets" "$REPO_DIR/sidecars" "$TARGET_DIR/"
    echo "✅ 已复制安装 AGY Context 到: $TARGET_DIR"
    ;;
  uninstall|--uninstall)
    if [ -L "$TARGET_DIR" ] || [ -e "$TARGET_DIR" ]; then
      rm -rf "$TARGET_DIR"
      echo "✅ 已卸载 AGY Context ($TARGET_DIR)"
    else
      echo "ℹ️ 未找到已安装的插件目录: $TARGET_DIR"
    fi
    ;;
  *)
    echo "用法: ./install.sh [--link | --copy | --uninstall]"
    exit 1
    ;;
esac

echo ""
echo "接下来："
echo "  1. 在 Antigravity 的 Skills & Customizations -> Plugins 中确认 AGY Context 已启用。"
echo "  2. 在会话窗口右上角点击 '+' 菜单 -> 选择 'Context'（AGY Context）即可在右侧常驻打开。"
