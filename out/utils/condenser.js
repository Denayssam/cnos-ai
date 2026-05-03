"use strict";
// ─── Micro-Condenser (v8.22.0) ───────────────────────────────────────────────
// Inspired by the OpenHands "history condenser": when an agent burns the
// circuit breaker by failing the same tool N times consecutively, the raw
// stack traces from those failures are still living in the message history,
// silently inflating the context window and — worse — giving the LLM a
// detailed loop of its own past mistakes to re-read. Each retry it parses
// those errors fresh and convinces itself the next variation will work.
//
// The condenser is a one-shot mutation on the conversation history that runs
// AT the moment the circuit breaker fires for a tool. It walks backwards
// through `messages`, finds the last `count` tool messages whose `name`
// matches the failing tool, removes them in place, and inserts a single
// system marker at the position of the earliest removed entry that tells the
// agent: stop re-reading raw errors, change your strategy now.
//
// The current iteration's failure (the one that just tripped the breaker)
// stays as-is — the LLM still sees ONE concrete error to react to. Only the
// PRIOR raw failures get compacted. This way the agent has signal (one fresh
// error + one condenser reminder) without noise (3 redundant stack traces).
//
// Notes:
//   • Only `role: 'tool'` messages with matching `name` are considered.
//   • Empty/cleared content is ignored — the condenser is idempotent: running
//     it twice on the same history is a no-op the second time.
//   • Returns the number of messages collapsed so the caller can log it.
Object.defineProperty(exports, "__esModule", { value: true });
exports.compactToolFailures = compactToolFailures;
function compactToolFailures(messages, toolName, count = 3) {
    if (count <= 0 || messages.length === 0) {
        return { compacted: 0, insertedAt: null };
    }
    // Walk backwards collecting indices of tool failures for this tool. Stop
    // once we have `count` of them OR we hit a non-tool message older than the
    // current burst — the goal is "the last N raw error responses for that
    // tool", not the entire history.
    const indices = [];
    for (let i = messages.length - 1; i >= 0 && indices.length < count; i--) {
        const m = messages[i];
        if (m.role !== 'tool' || m.name !== toolName) {
            continue;
        }
        // Skip anything already condensed (defensive against double-runs).
        if (typeof m.content === 'string' && m.content.startsWith('[CONDENSER]')) {
            continue;
        }
        indices.push(i);
    }
    if (indices.length === 0) {
        return { compacted: 0, insertedAt: null };
    }
    // indices is in descending order (newest first). The earliest we touch is
    // the LAST entry in the array; that index is where the condenser marker
    // gets inserted after the splice operations.
    const earliest = indices[indices.length - 1];
    // Splice in descending order so each removal does not shift later indices.
    for (const idx of indices) {
        messages.splice(idx, 1);
    }
    const condenserMessage = {
        role: 'system',
        content: `[CONDENSER] You attempted to use ${toolName} ${indices.length} times unsuccessfully. ` +
            `The raw errors have been compressed to save tokens. ` +
            `MANDATORY: You must change your strategy now.`,
    };
    messages.splice(earliest, 0, condenserMessage);
    return { compacted: indices.length, insertedAt: earliest };
}
//# sourceMappingURL=condenser.js.map