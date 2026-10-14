#!/bin/bash
# Builds "Process Log Menu.app", the button for the top menu bar, from menubar/ProcessLogMenu.swift.
# Run it once (and again if the Swift file changes):  ./build-menu-button.sh
cd "$(dirname "$0")"
APP="Process Log Menu.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
swiftc -O -swift-version 5 menubar/ProcessLogMenu.swift -o "$APP/Contents/MacOS/ProcessLogMenu" || exit 1
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Process Log Menu</string>
  <key>CFBundleIdentifier</key><string>local.processlog.menu</string>
  <key>CFBundleExecutable</key><string>ProcessLogMenu</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
echo "Built $APP"
