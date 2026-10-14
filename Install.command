#!/bin/bash
# Run this once (double-click it). It checks what the Process Log needs and sets it up.
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
echo "Process Log: setting up"
echo

# A zip downloaded from the internet is marked "from the internet", which makes macOS refuse to open
# its files the first time. This clears that mark on this folder only.
xattr -dr com.apple.quarantine . 2>/dev/null

problems=0

if command -v node >/dev/null; then
  echo "  ok   Node.js $(node -v)"
else
  echo "  MISSING  Node.js. Install it from https://nodejs.org (the LTS button), then run this again."
  problems=1
fi

if command -v ffmpeg >/dev/null; then
  echo "  ok   ffmpeg"
else
  echo "  MISSING  ffmpeg (the free tool that records and joins the video)."
  if command -v brew >/dev/null; then
    read -r -p "           Install it now with Homebrew? It takes a few minutes. [y/N] " answer
    if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
      brew install ffmpeg && echo "  ok   ffmpeg installed" || problems=1
    else
      echo "           Skipped. Run: brew install ffmpeg"; problems=1
    fi
  else
    echo "           Install Homebrew from https://brew.sh first, then run: brew install ffmpeg"; problems=1
  fi
fi

if [ ! -f config.json ]; then cp config.example.json config.json && echo "  ok   made config.json (your settings)"; else echo "  ok   config.json already there"; fi

if command -v swiftc >/dev/null; then
  if ./build-menu-button.sh >/dev/null 2>&1; then
    echo "  ok   built the menu-bar button (Process Log Menu.app)"
  else
    echo "  skip the menu-bar button could not be built (everything else still works)"
  fi
else
  echo "  skip the menu-bar button needs Apple's command line tools. To get them, run: xcode-select --install"
fi

echo
if [ "$problems" = "0" ]; then
  echo "All set. Double-click \"Start Process Log.command\" to begin."
  echo "The first time, macOS asks to let Terminal use the camera and record the screen. Say yes."
else
  echo "Fix the MISSING items above, then run this again."
fi
echo
echo "You can close this window."
