#!/bin/bash
# setup.sh: deploy Duet Bridge to Cloudflare and wire the Mac to it. Safe to run again.
# Before the first run: `npx wrangler login` (opens the browser to sign in to Cloudflare).
set -euo pipefail
cd "$(dirname "$0")"
MAC_DIR="$(cd ../mac && pwd)"
CONFIG="$MAC_DIR/config.toml"
[ -f "$CONFIG" ] || cp "$MAC_DIR/config.example.toml" "$CONFIG"

TOKEN_FILE="$HOME/.duet-bridge-token"
PASS_FILE="$HOME/.duet-bridge-passphrase"

# 1. Secrets, made once and kept in private files. Never printed.
umask 077
[ -s "$TOKEN_FILE" ] || python3 -c "import secrets;print(secrets.token_urlsafe(32))" > "$TOKEN_FILE"
if [ ! -s "$PASS_FILE" ]; then
  python3 - "$PASS_FILE" <<'EOF'
import secrets, sys
words = [w.strip().lower() for w in open("/usr/share/dict/words") if 4 <= len(w.strip()) <= 7 and w.strip().isalpha()]
open(sys.argv[1], "w").write("-".join(secrets.choice(words) for _ in range(4)) + "\n")
EOF
fi
chmod 600 "$TOKEN_FILE" "$PASS_FILE"

# 2. Deploy once to learn the public URL, then record it in wrangler.jsonc.
npm install --silent
OUT="$(npx wrangler deploy 2>&1)"
echo "$OUT" | tail -5
URL="$(echo "$OUT" | grep -oE 'https://duet-bridge\.[a-z0-9-]+\.workers\.dev' | grep -v '\.example\.' | tail -1)"
[ -n "$URL" ] || { echo "✖ Could not read the Worker URL from the deploy output."; exit 1; }
sed -i '' -E "s#\"PUBLIC_URL\": \"[^\"]*\"#\"PUBLIC_URL\": \"$URL\"#" wrangler.jsonc

# 3. Secrets into Cloudflare, read from the files on stdin.
tr -d '\n' < "$TOKEN_FILE" | npx wrangler secret put BRIDGE_TOKEN >/dev/null
tr -d '\n' < "$PASS_FILE" | npx wrangler secret put OWNER_PASSPHRASE >/dev/null

# 4. Redeploy with the real URL, and tell the Mac checker where the bridge is.
npx wrangler deploy >/dev/null
sed -i '' -E "s#^url = \"[^\"]*\"#url = \"$URL\"#" "$CONFIG"

# 5. Check it answers.
curl -fsS "$URL/" >/dev/null && echo "✔ Duet Bridge is live at $URL/mcp" || echo "✖ $URL did not answer"
python3 "$MAC_DIR/duet-bridge.py" status >/dev/null && echo "✔ The Mac can reach the bridge" || echo "✖ The Mac checker could not reach the bridge"
echo
echo "Connector URL for claude.ai:  $URL/mcp"
echo "Passphrase is in $PASS_FILE. Copy it with:  pbcopy < $PASS_FILE"
echo "Next: edit $CONFIG (workspaces, MCP servers), then run mac/install.sh."
