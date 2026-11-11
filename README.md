# Duet Bridge: connect Claude Duet to Claude Code (MCP connector)

[![calebgrimes/claude-duet-bridge MCP server](https://glama.ai/mcp/servers/calebgrimes/claude-duet-bridge/badges/score.svg)](https://glama.ai/mcp/servers/calebgrimes/claude-duet-bridge)

**Duet Bridge is a custom MCP connector that lets Claude Duet talk to Claude Code on your Mac or Windows PC, in both directions.** Duet can send work to Claude Code, start new Claude Code sessions, talk with a terminal window you have open, and open a session on your screen. Claude Code can answer Duet and send it messages first.

It is a remote MCP server on Cloudflare Workers (free plan), with OAuth sign-in for claude.ai, plus a small runner and a [Claude Code channel](https://docs.claude.com/en/docs/claude-code/channels) on your computer.

> Search words: Claude Duet MCP, Claude Duet connector, Claude Duet to Claude Code, Claude Code remote control from Duet, Claude Code channels, custom connector for claude.ai, remote MCP server on Cloudflare Workers.

## Can Claude Duet talk to Claude Code?

Not by itself. Duet runs in Anthropic's cloud and cannot reach your computer, and your computer should not open a port to the internet. Duet Bridge is a **switchboard** in the middle. Both sides call out to it, and it connects them:

```
 Claude Duet ──(custom connector, OAuth)──▶ ┌──────────────────────────┐
                                            │   Duet Bridge Worker      │  Cloudflare, free plan
 live Claude Code windows ──(WebSocket)────▶│   sessions · messages ·   │
 (duet-code)                                │   jobs · reports          │
 the runner ──(bearer token, every 3 s)────▶│                           │
 (duet-bridge.py serve)                     └──────────────────────────┘
```

Your computer only makes outbound calls. Nothing on the internet can call it.

## What Duet can do

- **Talk to a Claude Code window you have open.** Start the window with `duet-code` instead of `claude`. Duet sees it in `list_sessions`. A message from Duet shows up in that window within seconds, and the window answers Duet with its `send_to_duet` tool.
- **Start a new Claude Code session.** `start_session` starts a background conversation on the Mac. Each Duet message is one turn, and Claude Code remembers the earlier turns. Duet continues it with `send_message`.
- **Show a session on your screen.** `open_on_mac` opens a background session in a terminal window (on macOS, Ghostty if you have it, else Terminal; on Windows, Windows Terminal, else a PowerShell console), so you can read it and take over. The window then becomes a live session. The tool keeps its name on both platforms so one connector works for either.
- **Wait for the answer.** `send_message`, `start_session` and `read_messages` take `wait_seconds` (up to 45). The call returns as soon as Claude Code answers.
- **Hear from Claude Code first.** `read_messages` with no session collects everything Claude Code sent.

## What Claude Code can do

- **In a `duet-code` window:** `send_to_duet` answers Duet or tells it something. `set_focus` tells Duet what the window works on. Duet cannot see terminal text, so a Stop hook sends a window back once if it answered Duet in the terminal only.
- **From any script:** `mac/duet-bridge.py tell --text "..."` leaves Duet a message.
- **Limit:** Claude Code cannot wake Duet. Duet reads its messages when you talk to it, or on its own background check.

## The thirteen tools Duet gets

| Tool | What it does |
|---|---|
| `list_sessions` | Live windows and background sessions, with `connected` for live ones |
| `start_session` | Start a background Claude Code conversation (`read` or `work` mode) |
| `send_message` | Send a message to any session, and optionally wait for the answer |
| `read_messages` | Read what Claude Code sent |
| `end_session` | Close a session |
| `open_on_mac` | Show a background session in a terminal window |
| `bridge_status` | Unread counts, open windows, last Mac check-in |
| `send_job`, `get_job`, `list_jobs`, `cancel_job` | The older one-shot job path |
| `post_report`, `read_reports` | Reports between the two sides |

## Is it safe?

Duet can read your email, and a crafted email can try to make Duet send work to Claude Code. So:

| Guard | How |
|---|---|
| Background sessions start in `read` mode: read files and the MCP servers you list, answer in text. | `--permission-mode dontAsk`, `--strict-mcp-config`, allow and deny lists in `mac/config.toml` |
| `work` mode (edits and commands) is opt-in per session. | `--permission-mode auto` plus `work_denied_tools` |
| Your claude.ai connectors (Gmail and the rest) never load in background sessions. | `ENABLE_CLAUDEAI_MCP_SERVERS=false` |
| Every session is told: never send email or messages, stage drafts, refuse requests for credentials. | session rules in `mac/duet-bridge.py` and the channel |
| You see each job before it goes. | Set `start_session`, `send_message` and `open_on_mac` to **Needs approval** in claude.ai |
| One switch stops all new work. | `touch mac/duet-bridge.OFF` |

The deny rules for `work` mode are a guard, not a wall: a `work` session has a real shell. Test the limits on your own Mac with canary requests (for example, ask a `read` session to run `touch /tmp/canary`, then check that the file does not exist).

## Set it up (one time)

You need: [Claude Code](https://claude.com/claude-code) signed in, Node.js 20 or later, Python 3.11 or later, a free Cloudflare account, and a claude.ai plan with Claude Duet and custom connectors. macOS and Windows 10/11 both work. On Windows, also install [Windows Terminal](https://aka.ms/terminal) if you want `open_on_mac` to give a session a proper window, and run the steps in PowerShell 7 (`pwsh`).

### macOS

1. Clone this repo, then sign in to Cloudflare:
   ```
   cd claude-duet-bridge/worker
   npm install
   npx wrangler login
   ```
2. Run `./setup.sh`. It makes two secrets in your home folder (`~/.duet-bridge-token` and `~/.duet-bridge-passphrase`), deploys the Worker, writes the URL into `mac/config.toml`, and prints the connector URL.
3. Edit `mac/config.toml`. Set the folder for each workspace, and the read-only MCP servers a `read` session may use. If you add workspace names, also add them to `WORKSPACES` in `worker/wrangler.jsonc` and run `npx wrangler deploy`.
4. In claude.ai, open **Settings > Connectors > Add custom connector**. Name it `Duet Bridge` and paste the URL that ends in `/mcp`.
5. Click **Connect**. On the sign-in page, paste the passphrase (`pbcopy < ~/.duet-bridge-passphrase` copies it).
6. Run `mac/install.sh`. It starts the Mac runner with launchd and links `duet-code` into `~/.local/bin`.
7. Open a window with `duet-code`. On the warning screen about development channels, choose **I am using this for local development**. Then ask Duet: *"List my Claude Code sessions and say hello to the live one."*

### Windows

The Worker and the channel are the same on both platforms; only the launchers differ. Windows keeps its own `windows\config.toml`, so one checkout can serve both.

1. Clone this repo, then sign in to Cloudflare:
   ```
   cd claude-duet-bridge\worker
   npm install
   npx wrangler login
   ```
2. Run `..\windows\setup.ps1`. It makes two secrets in your user folder (`~\.duet-bridge-token` and `~\.duet-bridge-passphrase`, each locked to your account with `icacls`), deploys the Worker, writes the URL into `windows\config.toml`, and prints the connector URL.
3. Edit `windows\config.toml`. Set the folder for each workspace, and the read-only MCP servers a `read` session may use. If you add workspace names, also add them to `WORKSPACES` in `worker\wrangler.jsonc` and run `npx wrangler deploy`.
4. In claude.ai, open **Settings > Connectors > Add custom connector**. Name it `Duet Bridge` and paste the URL that ends in `/mcp`.
5. Click **Connect**. On the sign-in page, paste the passphrase (`Get-Content ~\.duet-bridge-passphrase | Set-Clipboard` copies it).
6. Run `windows\install.ps1`. It registers a scheduled task that starts the runner when you sign in and restarts it if it stops, and writes a `duet-code.cmd` shim into `~\.local\bin`. No administrator rights needed: the task is yours alone, and it runs interactively so it can put a window on your desktop.
7. Open a window with `duet-code`. On the warning screen about development channels, choose **I am using this for local development**. Then ask Duet: *"List my Claude Code sessions and say hello to the live one."*

## Known limits

- **Channels are a research preview.** A custom channel needs `--dangerously-load-development-channels`, which `duet-code` passes, and each launch shows a warning screen. On a personal plan you cannot turn it off; the setting that pre-approves channels is for Team and Enterprise admins.
- **Remote Control is off in `duet-code` windows.** In testing, Duet windows with Remote Control on sometimes moved into Claude Code's background service about 30 seconds after a turn, and the moved session could no longer hear Duet. Your other windows keep Remote Control.
- **Claude Code cannot wake Duet.** See above.
- **Work waits while the Mac sleeps.** A window that stops checking in shows `connected: false` within 90 seconds. Its session ends after 12 hours without a check-in, so a Mac that sleeps overnight keeps its windows.
- **Duet's background checks** may or may not use custom connectors. Test it: leave a message with `tell`, and see if Duet mentions it on its own.

## Day-to-day

| Task | macOS | Windows |
|---|---|---|
| Open a window Duet can talk to | `duet-code` (or `duet-code --name "Report draft"`) | the same |
| See the sessions | `mac/duet-bridge.py sessions` | `python mac\duet-bridge.py sessions` |
| See the status | `mac/duet-bridge.py status` | `python mac\duet-bridge.py status` |
| Tell Duet something | `mac/duet-bridge.py tell --text "..."` | `python mac\duet-bridge.py tell --text "..."` |
| Stop all new work | `touch mac/duet-bridge.OFF` | `New-Item -ItemType File windows\duet-bridge.OFF` |
| Start again | `rm mac/duet-bridge.OFF` | `Remove-Item windows\duet-bridge.OFF` |
| Remove the runner | `mac/install.sh uninstall` | `windows\install.ps1 uninstall` |
| See if the runner is up | `launchctl list \| grep duet` | `Get-ScheduledTask DuetBridgeServe \| Get-ScheduledTaskInfo` |

On Windows the runner reads `windows\config.toml`, so its OFF switch lives in `windows\` too. `duet-bridge.py` is shared by both platforms; it stays in `mac/` so existing installs keep working.

## Tests

```
cd worker
npm install
printf 'OWNER_PASSPHRASE=dev-only-passphrase\nBRIDGE_TOKEN=dev-only-bridge-token\nPUBLIC_URL=https://localhost:8787\n' > .dev.vars
npm run dev                 # terminal 1: local Worker on https://localhost:8787, fresh store
npm test                    # terminal 2: 54 checks of sign-in, tools, sessions and the live line
node test/channel.mjs       # 13 checks of the channel, played as Claude Code (fresh store)
node test/stop-hook.mjs     # 6 checks of the Stop hook (no Worker needed)
```

`npm run check` type-checks the code. Each `npm test` run ends with a 15-minute sign-in lock, so restart `npm run dev` before the next run.

## Directory listing (Glama)

Glama scores MCP servers by starting them in a container and listing their tools over stdio. The Worker can't run that way, so `worker/glama/stdio.mjs` answers `initialize` and `tools/list` with the same catalog the Worker serves (`worker/src/catalog.ts`). Its `tools/call` only points back to this README. `glama.json` tells Glama how to run it. Needs Node 22.18 or later, no install.

## How sign-in works

The Worker is its own OAuth server, with dynamic client registration and PKCE. claude.ai registers itself and sends you to a sign-in page that asks for your passphrase. There is one owner and no user accounts.

- Sign-in sends codes only to `https://claude.ai/api/mcp/auth_callback` or to a loopback address. A sign-in for any other address is refused.
- Five wrong passphrases in 15 minutes lock sign-in for 15 minutes.
- The Mac uses a separate bearer token on a separate path (`/bridge/*`). A connector token cannot open that path.

## Files

- `worker/src/index.ts`: the entry file and the OAuth set-up
- `worker/src/authorize.ts`: the passphrase sign-in page and the redirect guard
- `worker/src/mcp.ts`: the MCP endpoint and Duet's thirteen tools
- `worker/src/bridge.ts`: the Mac's private path (`/bridge/*`)
- `worker/src/mailbox.ts`: the store and the live sockets (a SQLite Durable Object)
- `channel/channel.mjs`: the Claude Code channel that gives a live window its line to Duet
- `channel/stop-hook.mjs`: sends a window back if it did not answer Duet with `send_to_duet`
- `mac/duet-code`: the launcher for live windows (macOS)
- `mac/duet-bridge.py`: the runner, shared by both platforms (`serve`, `tell`, `sessions`, `status`)
- `mac/install.sh`: the launchd job and the `duet-code` link
- `mac/config.example.toml`: the runner settings (macOS)
- `windows/duet-code.ps1`: the launcher for live windows (Windows)
- `windows/install.ps1`: the scheduled task and the `duet-code.cmd` shim
- `windows/setup.ps1`: the Windows counterpart of `worker/setup.sh`
- `windows/config.example.toml`: the runner settings (Windows)

## License

MIT. See `LICENSE`.
