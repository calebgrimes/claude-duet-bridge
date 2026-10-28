#!/usr/bin/env node
// Stop hook for duet-code windows: a safety net for unanswered Duet messages.
// If the last prompt was a Duet channel event and the window did not call send_to_duet
// after it, the hook sends the window back once to answer. Duet cannot see terminal text.
// mac/duet-code loads this hook. Input: the Stop hook JSON on stdin.
import { readFileSync } from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
// Second stop after a block: let it end, so the hook can never loop.
if (input.stop_hook_active) process.exit(0);

let lines = [];
try {
  lines = readFileSync(input.transcript_path ?? "", "utf8").split("\n");
} catch {
  process.exit(0);
}

const entries = [];
for (const line of lines) {
  try { entries.push(JSON.parse(line)); } catch { /* skip partial lines */ }
}

const blocks = (e) => {
  const c = e.message?.content;
  return typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : [];
};
// A prompt is a user entry with text and no tool result (tool results are user entries too).
const isPrompt = (e) => e.type === "user" && blocks(e).some((b) => b.type === "text") && !blocks(e).some((b) => b.type === "tool_result");

let last = -1;
for (let i = entries.length - 1; i >= 0; i--) if (isPrompt(entries[i])) { last = i; break; }
if (last < 0) process.exit(0);

const fromDuet = blocks(entries[last]).some((b) => b.type === "text" && b.text.includes('<channel source="duet"'));
if (!fromDuet) process.exit(0);

const answered = entries.slice(last + 1).some(
  (e) => e.type === "assistant" && blocks(e).some((b) => b.type === "tool_use" && String(b.name).endsWith("send_to_duet")),
);
if (answered) process.exit(0);

console.log(JSON.stringify({
  decision: "block",
  reason: "The last message came from Claude Duet, and Duet cannot see this terminal. "
    + "Send your answer with the mcp__duet__send_to_duet tool (load it with ToolSearch if it is deferred).",
}));
