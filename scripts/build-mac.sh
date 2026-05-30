#!/usr/bin/env bash
# Quay macOS 签名 + 公证 + 打包(本机 Developer ID,官网下载分发)。
#
# 复用 gyj-workflow 的 Apple 凭据(身份 YOUR_NAME YOUR_TEAM_ID · API Key YOUR_KEY_ID)。
# 流程(参考 skill tauri-macos-codesign-notarize-completeness):
#   1. Keychain 身份签 .app(unset .p12 env,走 Keychain 路径)
#   2. API Key(.p8)公证(unset Apple ID env)
#   3. (跳过)Quay 无 sidecar/.node,无需递归签名
#   4. tauri build:签 .app + 公证 .app.zip + staple,再打 .dmg
#   5. 单独给 .dmg 公证 + staple(Tauri 不会自动提交 dmg)
#   6. spctl + stapler 验证三层
set -euo pipefail

cd "$(dirname "$0")/.."

# ---- 凭据(可被外部 env 覆盖) ----
export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: YOUR_NAME (YOUR_TEAM_ID)}"
export APPLE_API_KEY="${APPLE_API_KEY:-YOUR_KEY_ID}"
export APPLE_API_ISSUER="${APPLE_API_ISSUER:-YOUR_ISSUER_ID}"
export APPLE_API_KEY_PATH="${APPLE_API_KEY_PATH:-$HOME/Desktop/apple/AuthKey_YOUR_KEY_ID.p8}"
# 走 Keychain + API Key 路径,清掉互斥的 env(否则 Tauri 可能选错)
unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_ID APPLE_PASSWORD || true

# ---- 前置检查 ----
echo "▶ 检查凭据…"
security find-identity -v -p codesigning | grep -q "YOUR_TEAM_ID" \
  || { echo "✗ Keychain 无 Developer ID 身份 YOUR_TEAM_ID"; exit 1; }
test -f "$APPLE_API_KEY_PATH" || { echo "✗ 找不到 API Key: $APPLE_API_KEY_PATH"; exit 1; }
echo "  身份: $APPLE_SIGNING_IDENTITY"
echo "  公证 Key: $APPLE_API_KEY · Issuer: $APPLE_API_ISSUER"

# ---- 构建(签名 .app + 公证 .app.zip + staple + 打 dmg) ----
echo "▶ tauri build(release · 签名 + 公证 .app · 较慢,含 Apple 公证等待)…"
pnpm tauri build

# ---- 定位 .dmg ----
BUNDLE_DIR="src-tauri/target/release/bundle"
DMG_PATH="$(find "$BUNDLE_DIR/dmg" -maxdepth 1 -name '*.dmg' | head -1)"
APP_PATH="$(find "$BUNDLE_DIR/macos" -maxdepth 1 -name '*.app' | head -1)"
test -n "$DMG_PATH" || { echo "✗ 没找到 .dmg"; exit 1; }
echo "  .app: $APP_PATH"
echo "  .dmg: $DMG_PATH"

# ---- Step 5:单独公证 + staple .dmg(Tauri 不会自动提交 dmg) ----
echo "▶ 提交 .dmg 到 notarytool(--wait,3-15 分钟)…"
xcrun notarytool submit "$DMG_PATH" \
  --key "$APPLE_API_KEY_PATH" \
  --key-id "$APPLE_API_KEY" \
  --issuer "$APPLE_API_ISSUER" \
  --wait
echo "▶ staple .dmg…"
xcrun stapler staple "$DMG_PATH"

# ---- 验证三层 ----
echo "▶ 验证(期望 source=Notarized Developer ID)…"
spctl --assess --type execute --verbose=2 "$APP_PATH" || true
spctl --assess --type install --verbose=2 "$DMG_PATH" || true
xcrun stapler validate "$APP_PATH" || true
xcrun stapler validate "$DMG_PATH" || true

echo ""
echo "✅ 完成:$DMG_PATH"
