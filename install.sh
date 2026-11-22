#!/usr/bin/env bash
set -euo pipefail

REPO="${AGY_CONTEXT_REPO:-keleus/agy-context}"
TARGET_DIR="${AGY_CONTEXT_TARGET_DIR:-${HOME}/.gemini/config/plugins/agy-context}"
ARCHIVE_OVERRIDE="${AGY_CONTEXT_ARCHIVE_FILE:-}"

SCRIPT_PATH="${BASH_SOURCE[0]:-}"
REPO_DIR=""
IS_LOCAL_REPO=0
if [ -n "$SCRIPT_PATH" ] && [ -f "$SCRIPT_PATH" ]; then
  REPO_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
  if [ -f "${REPO_DIR}/plugin.json" ] && [ -f "${REPO_DIR}/sidecars/context_monitor/main.mjs" ]; then
    IS_LOCAL_REPO=1
  fi
fi

usage() {
  cat <<'EOF'
AGY Context Installer

Usage:
  # One-line CLI install (latest GitHub Release)
  curl -fsSL https://github.com/keleus/agy-context/releases/latest/download/install.sh | bash

  # Install a specific release version
  curl -fsSL https://github.com/keleus/agy-context/releases/latest/download/install.sh | bash -s -- --version v1.0.4

  # Local repository modes
  ./install.sh --link                 Symlink local repo into Antigravity plugins dir (default in repo)
  ./install.sh --copy                 Copy local repo runtime files into Antigravity plugins dir
  ./install.sh --release              Download and install latest GitHub Release
  ./install.sh --version <tag>        Download and install a specific GitHub Release (e.g. v1.0.4)
  ./install.sh --uninstall            Remove AGY Context from Antigravity plugins dir
  ./install.sh --help                 Show this help message
EOF
}

MODE=""
VERSION=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    link|--link)
      MODE="link"
      shift
      ;;
    copy|--copy)
      MODE="copy"
      shift
      ;;
    release|--release|remote|--remote)
      MODE="release"
      shift
      ;;
    -v|--version)
      if [ "$#" -lt 2 ] || [ -z "${2:-}" ]; then
        echo "❌ Missing value for $1 (e.g. --version v1.0.4)" >&2
        exit 1
      fi
      MODE="release"
      VERSION="$2"
      shift 2
      ;;
    --version=*)
      MODE="release"
      VERSION="${1#*=}"
      shift
      ;;
    uninstall|--uninstall)
      MODE="uninstall"
      shift
      ;;
    -h|--help|help)
      usage
      exit 0
      ;;
    *)
      echo "❌ Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ -z "$MODE" ]; then
  if [ "$IS_LOCAL_REPO" -eq 1 ]; then
    MODE="link"
  else
    MODE="release"
  fi
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo ""
  fi
}

read_manifest_version() {
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1/plugin.json" 2>/dev/null | head -n 1
}

stage_and_swap() {
  local src_root="$1"
  local parent_dir
  parent_dir="$(dirname "$TARGET_DIR")"
  mkdir -p "$parent_dir"

  local stage_dir="${TARGET_DIR}.install-tmp.$$"
  local backup_dir="${TARGET_DIR}.install-bak.$$"
  rm -rf "$stage_dir" "$backup_dir"
  mkdir -p "$stage_dir"

  for item in plugin.json README.md LICENSE assets sidecars; do
    if [ -e "${src_root}/${item}" ]; then
      cp -R "${src_root}/${item}" "${stage_dir}/"
    fi
  done
  if [ -f "${src_root}/install.sh" ]; then
    cp "${src_root}/install.sh" "${stage_dir}/install.sh"
    chmod 755 "${stage_dir}/install.sh"
  fi

  find "$stage_dir" -name '.DS_Store' -delete 2>/dev/null || true

  if [ ! -f "${stage_dir}/plugin.json" ] \
    || [ ! -f "${stage_dir}/sidecars/context_monitor/main.mjs" ] \
    || [ ! -f "${stage_dir}/sidecars/context_monitor/web/js/app.js" ]; then
    rm -rf "$stage_dir"
    echo "❌ 安装校验失败：缺少插件或 sidecar 核心文件。" >&2
    exit 1
  fi

  local had_target=0
  if [ -L "$TARGET_DIR" ]; then
    rm -f "$TARGET_DIR"
  elif [ -e "$TARGET_DIR" ]; then
    had_target=1
    mv "$TARGET_DIR" "$backup_dir"
  fi

  if mv "$stage_dir" "$TARGET_DIR"; then
    if [ "$had_target" -eq 1 ]; then
      rm -rf "$backup_dir"
    fi
  else
    rm -rf "$stage_dir"
    if [ "$had_target" -eq 1 ] && [ -e "$backup_dir" ] && [ ! -e "$TARGET_DIR" ]; then
      mv "$backup_dir" "$TARGET_DIR" || true
    fi
    echo "❌ 安装失败：无法替换目标目录 ${TARGET_DIR}" >&2
    exit 1
  fi
}

install_from_release() {
  if ! command -v tar >/dev/null 2>&1; then
    echo "❌ 缺少必要命令: tar" >&2
    exit 1
  fi

  local work_dir
  work_dir="$(mktemp -d "${TMPDIR:-/tmp}/agy-context-install.XXXXXX")"
  trap 'rm -rf "${work_dir:-}"' EXIT

  local archive_path="${work_dir}/agy-context.tar.gz"
  local checksums_path="${work_dir}/SHA256SUMS.txt"
  local expected_asset=""

  if [ -n "$ARCHIVE_OVERRIDE" ]; then
    if [ ! -f "$ARCHIVE_OVERRIDE" ]; then
      echo "❌ 指定的本地安装包不存在: ${ARCHIVE_OVERRIDE}" >&2
      exit 1
    fi
    cp "$ARCHIVE_OVERRIDE" "$archive_path"
  else
    if ! command -v curl >/dev/null 2>&1; then
      echo "❌ 缺少必要命令: curl" >&2
      exit 1
    fi

    local tag=""
    local downloaded=0

    if [ -n "$VERSION" ]; then
      tag="$VERSION"
      [[ "$tag" == v* ]] || tag="v${tag}"
      echo "⬇️  正在下载 AGY Context ${tag} (${REPO})..."

      if curl -fsSL -o "$archive_path" "https://github.com/${REPO}/releases/download/${tag}/agy-context-${tag}.tar.gz" 2>/dev/null; then
        expected_asset="agy-context-${tag}.tar.gz"
        downloaded=1
        curl -fsSL -o "$checksums_path" "https://github.com/${REPO}/releases/download/${tag}/SHA256SUMS.txt" 2>/dev/null || true
      elif curl -fsSL -o "$archive_path" "https://github.com/${REPO}/releases/download/${tag}/agy-context.tar.gz" 2>/dev/null; then
        expected_asset="agy-context.tar.gz"
        downloaded=1
        curl -fsSL -o "$checksums_path" "https://github.com/${REPO}/releases/download/${tag}/SHA256SUMS.txt" 2>/dev/null || true
      elif curl -fsSL -o "$archive_path" "https://codeload.github.com/${REPO}/tar.gz/refs/tags/${tag}" 2>/dev/null; then
        downloaded=1
      fi
    else
      echo "⬇️  正在下载 AGY Context 最新 Release (${REPO})..."
      if curl -fsSL -o "$archive_path" "https://github.com/${REPO}/releases/latest/download/agy-context.tar.gz" 2>/dev/null; then
        expected_asset="agy-context.tar.gz"
        downloaded=1
        curl -fsSL -o "$checksums_path" "https://github.com/${REPO}/releases/latest/download/SHA256SUMS.txt" 2>/dev/null || true
      else
        # Fallback for releases without pre-packaged CI tarball
        tag="$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/${REPO}/releases/latest" \
          | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1 || true)"
        if [ -n "$tag" ] && curl -fsSL -o "$archive_path" "https://codeload.github.com/${REPO}/tar.gz/refs/tags/${tag}" 2>/dev/null; then
          downloaded=1
        fi
      fi
    fi

    if [ "$downloaded" -ne 1 ] || [ ! -s "$archive_path" ]; then
      echo "❌ 下载失败，请检查网络连接或确认版本号是否存在 (${REPO})。" >&2
      exit 1
    fi

    if [ -n "$expected_asset" ] && [ -s "$checksums_path" ]; then
      local expected_sha actual_sha
      expected_sha="$(awk -v name="$expected_asset" '$2 == name || $2 == "*"name {print $1; exit}' "$checksums_path")"
      actual_sha="$(sha256_of "$archive_path")"
      if [ -n "$expected_sha" ] && [ -n "$actual_sha" ]; then
        if [ "$expected_sha" != "$actual_sha" ]; then
          echo "❌ SHA-256 校验失败！预期 ${expected_sha}，实际 ${actual_sha}" >&2
          exit 1
        fi
        echo "🔒 SHA-256 校验通过 (${expected_asset})"
      fi
    fi
  fi

  local extract_dir="${work_dir}/extract"
  mkdir -p "$extract_dir"
  tar -xzf "$archive_path" -C "$extract_dir"

  local src_root=""
  if [ -f "${extract_dir}/plugin.json" ]; then
    src_root="$extract_dir"
  else
    local candidate
    for candidate in "${extract_dir}"/*; do
      if [ -d "$candidate" ] && [ -f "${candidate}/plugin.json" ]; then
        src_root="$candidate"
        break
      fi
    done
  fi

  if [ -z "$src_root" ]; then
    echo "❌ 解压后的归档中未找到 plugin.json。" >&2
    exit 1
  fi

  stage_and_swap "$src_root"

  local installed_ver
  installed_ver="$(read_manifest_version "$TARGET_DIR")"
  echo "✅ 已安装 AGY Context ${installed_ver:+v${installed_ver} }到: ${TARGET_DIR}"
}

case "$MODE" in
  link)
    if [ "$IS_LOCAL_REPO" -ne 1 ]; then
      echo "❌ --link 模式仅支持在本地克隆的仓库目录中运行。" >&2
      exit 1
    fi
    mkdir -p "$(dirname "$TARGET_DIR")"
    if [ -L "$TARGET_DIR" ]; then
      rm "$TARGET_DIR"
    elif [ -e "$TARGET_DIR" ]; then
      echo "目标目录已存在且不是软链接: $TARGET_DIR" >&2
      echo "请先备份或删除后再运行，或使用 ./install.sh --uninstall 卸载。" >&2
      exit 1
    fi
    ln -s "$REPO_DIR" "$TARGET_DIR"
    echo "✅ 已软链接安装 AGY Context 到: $TARGET_DIR"
    echo "   修改本仓库代码后无需重新拷贝。"
    ;;
  copy)
    if [ "$IS_LOCAL_REPO" -ne 1 ]; then
      echo "❌ --copy 模式仅支持在本地克隆的仓库目录中运行。" >&2
      exit 1
    fi
    stage_and_swap "$REPO_DIR"
    installed_ver="$(read_manifest_version "$TARGET_DIR")"
    echo "✅ 已复制安装 AGY Context ${installed_ver:+v${installed_ver} }到: $TARGET_DIR"
    ;;
  release)
    install_from_release
    ;;
  uninstall)
    if [ -L "$TARGET_DIR" ] || [ -e "$TARGET_DIR" ]; then
      rm -rf "$TARGET_DIR"
      echo "✅ 已卸载 AGY Context ($TARGET_DIR)"
    else
      echo "ℹ️ 未找到已安装的插件目录: $TARGET_DIR"
    fi
    exit 0
    ;;
esac

echo ""
echo "接下来 / Next steps:"
echo "  1. 在 Antigravity 的 Skills & Customizations -> Plugins 中确认 AGY Context 已启用（若为覆盖升级，请先关闭再重新开启以重启后台 sidecar）。"
echo "  2. 在会话窗口右上角点击 '+' 菜单 -> 选择 'Context' 或 'Trace'（AGY Context）即可在右侧常驻打开。"
