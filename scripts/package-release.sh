#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${REPO_DIR}/dist"

MANIFEST_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${REPO_DIR}/plugin.json" | head -n 1)"
if [ -z "$MANIFEST_VERSION" ]; then
  echo "❌ Failed to read version from plugin.json" >&2
  exit 1
fi

TAG="${1:-v${MANIFEST_VERSION}}"
if [[ "$TAG" != v* ]]; then
  TAG="v${TAG}"
fi

STAGE_ROOT="${DIST_DIR}/staging"
PKG_DIR="${STAGE_ROOT}/agy-context"

rm -rf "$DIST_DIR"
mkdir -p "$PKG_DIR"

cp -R \
  "${REPO_DIR}/plugin.json" \
  "${REPO_DIR}/README.md" \
  "${REPO_DIR}/LICENSE" \
  "${REPO_DIR}/install.sh" \
  "${REPO_DIR}/assets" \
  "${REPO_DIR}/sidecars" \
  "${PKG_DIR}/"

chmod 755 "${PKG_DIR}/install.sh"
find "$PKG_DIR" -name '.DS_Store' -delete 2>/dev/null || true

# Verify required plugin files exist
for req in \
  "plugin.json" \
  "sidecars/context_monitor/sidecar.json" \
  "sidecars/context_monitor/main.mjs" \
  "sidecars/context_monitor/index.html" \
  "sidecars/context_monitor/web/js/app.js"; do
  if [ ! -f "${PKG_DIR}/${req}" ]; then
    echo "❌ Package validation failed: missing ${req}" >&2
    exit 1
  fi
done

TAR_VERSIONED="${DIST_DIR}/agy-context-${TAG}.tar.gz"
TAR_LATEST="${DIST_DIR}/agy-context.tar.gz"
ZIP_VERSIONED="${DIST_DIR}/agy-context-${TAG}.zip"

# Prevent macOS AppleDouble (._*) metadata files inside release tarballs
COPYFILE_DISABLE=1 tar -czf "$TAR_VERSIONED" -C "$STAGE_ROOT" agy-context
cp "$TAR_VERSIONED" "$TAR_LATEST"
cp "${REPO_DIR}/install.sh" "${DIST_DIR}/install.sh"
chmod 755 "${DIST_DIR}/install.sh"

if command -v zip >/dev/null 2>&1; then
  (cd "$STAGE_ROOT" && zip -qr "$ZIP_VERSIONED" agy-context)
fi

rm -rf "$STAGE_ROOT"

(
  cd "$DIST_DIR"
  FILES=("agy-context-${TAG}.tar.gz" "agy-context.tar.gz" "install.sh")
  if [ -f "agy-context-${TAG}.zip" ]; then
    FILES+=("agy-context-${TAG}.zip")
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${FILES[@]}" > SHA256SUMS.txt
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "${FILES[@]}" > SHA256SUMS.txt
  else
    echo "❌ Neither sha256sum nor shasum found" >&2
    exit 1
  fi
)

echo "✅ Packaged AGY Context ${TAG} into ${DIST_DIR}:"
ls -lh "$DIST_DIR"
