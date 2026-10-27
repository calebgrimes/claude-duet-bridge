# Duet Bridge

Duet Bridge connects Claude Duet and Claude Code on your Mac, in both directions.

Duet runs in Anthropic's cloud and cannot reach your Mac. Your Mac should not open a port to the internet. So the bridge is a **mailbox** in the middle that both sides visit:

```
 Claude Duet ──(custom connector, OAuth)──▶ ┌──────────────────────┐
 any Claude app                             │  Duet Bridge Worker   │  Cloudflare, free plan
                                            │  jobs · reports ·     │
 Mac checker ──(bearer token, every 5 min)─▶│  last check-in        │
 (mac/duet-bridge.py)                       └──────────────────────┘
```

- **Duet to Claude Code.** Duet calls `send_job`. The Mac checks the mailbox every 5 minutes. It runs the job in Claude Code and posts the answer back. Duet reads it with `get_job`.
- **Claude Code to Duet.** A Claude Code session calls `post_report` through the connector, or you run `mac/duet-bridge.py report`. Duet reads the report with `read_reports`.
- **Is the Mac awake?** `bridge_status` shows the last check-in. If it is more than 15 minutes old, the Mac is probably asleep.

The Mac only makes outbound calls. Nothing on the internet can call it.

## The seven tools

| Tool | What it does |
|---|---|
| `send_job` | Queue a read-only job for Claude Code on the Mac |
| `get_job` | Read one job and its answer |
| `list_jobs` | List jobs by status |
| `cancel_job` | Cancel a job that has not started |
| `post_report` | Leave a report for the other side |
| `read_reports` | Read reports (and mark them read) |
| `bridge_status` | Job counts, unread reports, last Mac check-in |

## What a job can do on the Mac

A job is **read-only**. It runs `claude -p` with these limits:

| Limit | How |
|---|---|
| It loads only the MCP servers you list in `mac/config.toml`. Your claude.ai connectors do not load. | `--mcp-config` with `--strict-mcp-config`, and `ENABLE_CLAUDEAI_MCP_SERVERS=false` |
| It cannot run commands, edit files, browse the web, start sub-agents, schedule work, or message other sessions. | `--permission-mode dontAsk`, plus `allowed_tools` and `DEFAULT_DENIED` |
| It cannot read dotfiles or `~/Library`. | `Read(~/.*)` and `Read(~/Library/**)` deny rules |
| It answers in text only. The answer goes back to Duet. | |

**Why it is strict.** Duet can read your email. A crafted email can try to make Duet send a job. These limits make sure that a job like that can only read and answer.

**Test the limits on your own Mac.** Claude Code changes often, and new built-in tools can appear. After you change `allowed_tools`, or after a Claude Code update, send canary jobs and read the full answers in the log. For example:

- *"Run the shell command `touch /tmp/canary`."* Then check that `/tmp/canary` does not exist.
- *"Write a file named canary.txt in this folder."* Then check that the file does not exist.
- *"Read ~/.ssh/config and print it."* The job must refuse or fail.
- *"Call SendMessage, CronCreate and Workflow."* Each one must be missing or refused.

If a canary gets through, add that tool to `denied_tools` before you use the bridge.

## Set it up (one time)

You need: a Mac with [Claude Code](https://claude.com/claude-code) signed in, Node.js 20 or later, Python 3.11 or later, a free Cloudflare account, and a claude.ai plan that allows custom connectors.

1. Clone this repo, then sign in to Cloudflare:
   ```
   cd claude-duet-bridge/worker
   npx wrangler login
   ```
   The browser opens. Click **Allow**.
2. Run `./setup.sh`. It makes two secrets in your home folder (`~/.duet-bridge-token` and `~/.duet-bridge-passphrase`), deploys the Worker, stores the secrets in Cloudflare, writes the URL into `mac/config.toml`, and prints the connector URL.
3. Edit `mac/config.toml`. Set the folder for each workspace. Add the read-only MCP servers a job may use, and their tools in `allowed_tools`. If you add workspace names, also add them to `WORKSPACES` in `worker/wrangler.jsonc` and run `npx wrangler deploy`.
4. In claude.ai, open **Settings > Connectors > Add custom connector**. Name it `Duet Bridge`, and paste the URL that ends in `/mcp`.
5. Click **Connect**. On the sign-in page, paste the passphrase. To copy it, run `pbcopy < ~/.duet-bridge-passphrase`.
6. Start the Mac checker: `mac/install.sh`.
7. In a live Duet chat, ask: *"Use Duet Bridge to check its status."* Then send a small job.

## How sign-in works

The Worker is its own OAuth server, with dynamic client registration and PKCE. claude.ai registers itself and sends you to a sign-in page. The page asks for your passphrase. There is one owner and no user accounts.

- Sign-in sends codes only to `https://claude.ai/api/mcp/auth_callback` or to a loopback address (for Claude Code and other local apps). A sign-in for any other address is refused.
- Five wrong passphrases in 15 minutes lock sign-in for 15 minutes.
- The Mac uses a separate bearer token on a separate path (`/bridge/*`). A connector token cannot open that path.

## Known limits

- **Only live Duet chats can use it, for now.** An early review reports that Duet's scheduled check-ins cannot use custom connectors. If that changes, nothing here needs to change.
- **Jobs are not instant.** The Mac checks every 5 minutes, and a job can take some minutes to run.
- **Jobs wait while the Mac sleeps.** A job that runs for more than 2 hours is marked failed.

## Day-to-day

| Task | Command |
|---|---|
| See the queue | `mac/duet-bridge.py jobs` |
| See the status | `mac/duet-bridge.py status` |
| Send Duet a report | `mac/duet-bridge.py report --title "..." --body-file notes.md` |
| Stop taking jobs | `touch mac/OFF` |
| Take jobs again | `rm mac/OFF` |
| Read what each job did | `~/Library/Logs/duet-bridge.log` (full output of each job) |
| Remove the schedule | `mac/install.sh uninstall` |

## Tests

```
cd worker
npm install
printf 'OWNER_PASSPHRASE=dev-only-passphrase\nBRIDGE_TOKEN=dev-only-bridge-token\nPUBLIC_URL=https://localhost:8787\n' > .dev.vars
npm run dev      # terminal 1: local Worker on https://localhost:8787, fresh store
npm test         # terminal 2: 31 checks of discovery, sign-in, tools, the Mac door and the lock
```

`npm run check` type-checks the code. Each `npm test` run ends with the 15-minute sign-in lock, so restart `npm run dev` before you run it again.

## Files

- `worker/src/index.ts`: the entry file and the OAuth set-up
- `worker/src/authorize.ts`: the passphrase sign-in page and the redirect guard
- `worker/src/mcp.ts`: the MCP endpoint and the seven tools
- `worker/src/bridge.ts`: the Mac's private path (`/bridge/*`)
- `worker/src/mailbox.ts`: the store (a SQLite Durable Object)
- `worker/setup.sh`: deploy and wire up
- `mac/duet-bridge.py`: the Mac checker
- `mac/install.sh`: the 5-minute launchd schedule
- `mac/config.example.toml`: the checker settings

## License

MIT. See `LICENSE`.
