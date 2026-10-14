#!/bin/bash
# Double-click this to start the Process Log. Leave this window open while logging.
# Close it (or press Control-C) to stop.
cd "$(dirname "$0")"
# Make sure programs installed with Homebrew (like ffmpeg) are found.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null; then
  echo "The Process Log needs Node.js. Install it from https://nodejs.org (the LTS button), then double-click this again."
  exit 1
fi
if ! command -v ffmpeg >/dev/null; then
  echo "The Process Log needs ffmpeg. Double-click \"Install.command\" first (it will help you add it)."
  exit 1
fi
(sleep 1.5; open "http://localhost:3002") &
exec node server.js
