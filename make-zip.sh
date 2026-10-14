#!/bin/bash
# Makes dist/process-log.zip: a copy of the tool to give to someone else.
# It leaves out YOUR recordings (captures/), your captions (log.json), your settings (config.json) and
# the built menu-bar app (Install.command builds that on the other person's Mac).
cd "$(dirname "$0")"
mkdir -p dist
rm -f dist/process-log.zip
cd ..
zip -r -X process-log/dist/process-log.zip process-log \
  -x "process-log/captures/*" "process-log/log.json" "process-log/config.json" \
     "process-log/dist/*" "process-log/Process Log Menu.app/*" "process-log/.git/*" "*.DS_Store" >/dev/null
echo "Made process-log/dist/process-log.zip ($(du -h process-log/dist/process-log.zip | cut -f1))"
