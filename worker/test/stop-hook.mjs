// Stop hook test: node test/stop-hook.mjs [real-transcript.jsonl]
// Feeds made-up transcripts to channel/stop-hook.mjs and checks when it sends a window back.
// With a path, it also checks one real transcript that ended without send_to_duet.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = new URL("../../channel/stop-hook.mjs", import.meta.url).pathname;
let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "✔ PASS" : "✖ FAIL"}  ${label}${ok || !detail ? "" : `  -> ${detail}`}`);
  if (!ok) failures++;
}

const duet = { type: "user", message: { role: "user", content: '<channel source="duet" message_id="m1" sent_at="x">\nHello\n</channel>' } };
const typed = { type: "user", message: { role: "user", content: "What is on my calendar?" } };
const say = { type: "assistant", message: { content: [{ type: "text", text: "Hi from this window." }] } };
const reply = { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__duet__send_to_duet", input: { text: "Hi" } }] } };
const other = { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Read", input: {} }] } };
const result = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "file text" }] } };

function run(entries, extra = {}) {
  const path = join(tmpdir(), `stop-hook-test-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return runPath(path, extra);
}
function runPath(path, extra = {}) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ transcript_path: path, ...extra }) });
  const out = r.stdout.toString().trim();
  return { code: r.status, blocked: out ? JSON.parse(out).decision === "block" : false };
}

check("a terminal-only answer to Duet is sent back", run([duet, say]).blocked);
check("an answer through send_to_duet ends normally", !run([duet, reply, say]).blocked);
check("a prompt the user typed ends normally", !run([duet, reply, typed, say]).blocked);
check("a tool result is not taken as a new prompt", run([duet, other, result, say]).blocked);
check("the second stop always ends (no loop)", !run([duet, say], { stop_hook_active: true }).blocked);
check("a missing transcript ends normally", runPath("/nonexistent.jsonl").code === 0 && !runPath("/nonexistent.jsonl").blocked);

const real = process.argv[2];
if (real) check("the real 2026-10-27 window would have been sent back", runPath(real).blocked);

console.log(failures ? `\n✖ ${failures} check(s) failed` : "\n✔ all stop-hook checks passed");
process.exit(failures ? 1 : 0);
