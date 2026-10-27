#!/bin/bash
# install.sh: run the checker every 5 minutes with launchd. Safe to run again.
#   ./install.sh            install and start
#   ./install.sh uninstall  stop and remove
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.duet-bridge.poll"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ "${1:-}" = "uninstall" ]; then
  launchctl unload -w "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✔ Removed $LABEL"
  exit 0
fi

CLAUDE_BIN="$(command -v claude || true)"
[ -n "$CLAUDE_BIN" ] || { echo "✖ claude is not on PATH. Install Claude Code first."; exit 1; }
PY_BIN="$(command -v python3)"
# launchd starts jobs with a bare PATH, so give it the folders that hold claude and python3.
JOB_PATH="$(dirname "$CLAUDE_BIN"):$(dirname "$PY_BIN"):/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p "$HOME/Library/Logs" "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PY_BIN</string>
        <string>$HERE/duet-bridge.py</string>
        <string>poll</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$JOB_PATH</string>
    </dict>
    <key>StartInterval</key>
    <integer>300</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$HOME/Library/Logs/duet-bridge.out</string>
    <key>StandardErrorPath</key>
    <string>$HOME/Library/Logs/duet-bridge.err</string>
</dict>
</plist>
EOF
plutil -lint "$PLIST" >/dev/null
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"
echo "✔ $LABEL runs every 5 minutes. Log: ~/Library/Logs/duet-bridge.log"
echo "  Pause it: touch $HERE/OFF    Resume: rm $HERE/OFF"
