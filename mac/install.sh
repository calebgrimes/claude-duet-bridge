#!/bin/bash
# install.sh: keep the Duet Bridge runner on with launchd (it starts at login and restarts if it stops). Safe to run again.
#   ./install.sh            install and start
#   ./install.sh uninstall  stop and remove
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.duet-bridge.serve"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ "${1:-}" = "uninstall" ]; then
  launchctl unload -w "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✔ Removed $LABEL"
  echo "  The duet-code link in ~/.local/bin (if any) is left alone."
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
        <string>serve</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$JOB_PATH</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
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
echo "✔ $LABEL is running (duet-bridge.py serve). Log: ~/Library/Logs/duet-bridge.log"
echo "  Pause it: touch $HERE/duet-bridge.OFF    Resume: rm $HERE/duet-bridge.OFF"
# The old 5-minute poll job from v1, if it is still installed.
OLD="$HOME/Library/LaunchAgents/com.duet-bridge.poll.plist"
if [ -f "$OLD" ]; then
  launchctl unload -w "$OLD" 2>/dev/null || true
  rm -f "$OLD"
  echo "✔ Removed the old v1 job com.duet-bridge.poll"
fi
# duet-code on your PATH, so you can type it in place of `claude`.
if [ -d "$HOME/.local/bin" ]; then
  ln -sf "$HERE/duet-code" "$HOME/.local/bin/duet-code"
  echo "✔ Linked duet-code into ~/.local/bin"
else
  echo "  To type duet-code anywhere:  ln -sf $HERE/duet-code ~/.local/bin/duet-code"
fi
