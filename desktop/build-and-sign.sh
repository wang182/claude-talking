#!/bin/bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="Claude桌面助手"
IDENTITY="ClaudeDesktopSigning"

# Build
cd "$DIR"
npm run build

# Sign the built app
APP="$DIR/dist/mac-arm64/$APP_NAME.app"
if [ -d "$APP" ]; then
  echo "Signing $APP_NAME..."
  find "$APP/Contents/Frameworks" -name "*.app" -d -exec codesign --force --sign "$IDENTITY" --options runtime --entitlements "$DIR/entitlements.plist" {} \; 2>/dev/null
  codesign --force --sign "$IDENTITY" --options runtime --entitlements "$DIR/entitlements.plist" "$APP"
  echo "Done! Installed at $APP"
fi
