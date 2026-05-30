#!/usr/bin/env bash
# Quay macOS 签名 + 公证 + 打包(Developer ID,官网下载分发)。
#
# 🔑 凭据通过环境变量注入,不硬编码进仓库。把下面四个变量写进 scripts/.env.local
#    (该文件已 gitignore,不会提交),或在调用前自行 export:
#      export APPLE_SIGNING_IDENTITY="Developer ID Application: 你的名字 (TEAMID)"
#      export APPLE_API_KEY="<App Store Connect API Key ID>"
#      export APPLE_API_ISSUER="<Issuer ID>"
#      export APPLE_API_KEY_PATH="<AuthKey_xxxxxx.p8 的本地路径>"
# 流程(参考 skill tauri-macos-codesign-notarize-completeness):
#   1. Keychain 身份签 .app(unset .p12 env,走 Keychain 路径)
#   2. API Key(.p8)公证(unset Apple ID env)
#   3. (跳过)Quay 无 sidecar/.node,无需递归签名
#   4. tauri build:签 .app + 公证 .app.zip + staple,再打 .dmg
#   5. 单独给 .dmg 公证 + staple(Tauri 不会自动提交 dmg)
#   6. spctl + stapler 验证三层
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

# ---- 凭据:优先 scripts/.env.local(不进仓库),其次外部 env ----
# shellcheck disable=SC1091
[ -f "$SCRIPT_DIR/.env.local" ] && source "$SCRIPT_DIR/.env.local"
: "${APPLE_SIGNING_IDENTITY:?需设置 APPLE_SIGNING_IDENTITY(Developer ID Application 名称)}"
: "${APPLE_API_KEY:?需设置 APPLE_API_KEY(App Store Connect API Key ID)}"
: "${APPLE_API_ISSUER:?需设置 APPLE_API_ISSUER(Issuer ID)}"
: "${APPLE_API_KEY_PATH:?需设置 APPLE_API_KEY_PATH(.p8 路径)}"
export APPLE_SIGNING_IDENTITY APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH
# 走 Keychain + API Key 路径,清掉互斥的 env(否则 Tauri 可能选错)
unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_ID APPLE_PASSWORD || true

# ---- 前置检查 ----
echo "▶ 检查凭据…"
security find-identity -v -p codesigning | grep -q "Developer ID Application" \
  || { echo "✗ Keychain 无 Developer ID Application 身份"; exit 1; }
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
