// ─── Micro-Condenser (v8.22.0 → v8.23.1) ─────────────────────────────────────
// Inspired by the OpenHands "history condenser": when an agent burns the
// circuit breaker by failing the same tool N times consecutively, the raw
// stack traces from those failures are still living in the message history,
// silently inflating the context window and — worse — giving the LLM a
// detailed loop of its own past mistakes to re-read. Each retry it parses
// those errors fresh and convinces itself the next variation will work.
//
// v8.23.1 — Safe Compaction Patch — IMPORTANT API CONTRACT NOTE:
//
//   The OpenAI / OpenRouter Chat Completions schema requires a strict
//   one-to-one pairing between every `tool_call` emitted by an assistant
//   message and a subsequent `role: 'tool'` message carrying the matching
//   `tool_call_id`. Removing a tool message from the array (the v8.22.0 /
//   v8.23.0 splice approach) leaves the prior assistant's tool_call orphaned
//   and the next request fails with HTTP 400:
//     "An assistant message with 'tool_calls' must be followed by tool
//      messages responding to each 'tool_call_id'."
//
//   The fix: NEVER splice. Mutate the `content` string of the target tool
//   messages IN PLACE — replace the verbose payload with a short
//   `[COMPACTED MEMORY] ...` stub. The structural envelope (role, name,
//   tool_call_id) stays identical, so the API pairing constraint is honored
//   while we still drop the token weight of the stack traces. This mirrors
//   the `microCompact` pattern documented in production CLI agents
//   (Anthropic Claude Code, OpenHands runtime) where compaction is a payload
//   transformation, not a structural one.
//
//   Both `compactToolFailures` (reactive, fires on the per-tool circuit
//   breaker) and `proactiveCompact` (active, fires every iteration on
//   accumulated residue) follow the same in-place rule. The ONLY message
//   array length changes legal in this file are: zero. The array length on
//   exit always equals the array length on entry.

import type { ChatMessage } from '../agentEngine';

// ─── Compacted-payload stubs (kept short on purpose) ─────────────────────────
// Stubs occupy <100 tokens each. They start with the `[CONDENSER]` /
// `[COMPACTED MEMORY]` sentinel so the dedup checks below can short-circuit
// on a subsequent compaction pass without re-mutating an already-compacted
// message. The earliest mutation per batch carries a slightly richer summary
// (counts + distinct tools/files) so the LLM still has the high-level signal
// of "you tried this and it failed N times"; subsequent mutations carry the
// minimal stub. This keeps the most useful context near where the LLM
// actually reads it (right before the live working window) without paying
// the same summary token cost N times.

const REACTIVE_STUB_SHORT = '[CONDENSER] Tool output compressed to save tokens.';
const ACTIVE_STUB_SHORT = '[COMPACTED MEMORY] Tool output compressed to save tokens.';

function buildReactiveSummary(toolName: string, count: number): string {
  return (
    `[CONDENSER] You attempted to use ${toolName} ${count} times unsuccessfully. ` +
    `The raw errors have been compressed to save tokens. ` +
    `MANDATORY: You must change your strategy now.`
  );
}

function buildActiveSummary(
  failures: number,
  redundantEdits: number,
  failingTools: string[],
  files: string[],
): string {
  const filesNote = files.length > 0
    ? ` Affected files: ${files.slice(0, 5).join(', ')}${files.length > 5 ? `, +${files.length - 5} more` : ''}.`
    : '';
  const toolsNote = failingTools.length > 0
    ? ` Tools that previously failed: ${failingTools.join(', ')}.`
    : '';
  return (
    `[COMPACTED MEMORY] Earlier in this session ${failures} tool failure(s)` +
    (redundantEdits > 0 ? ` and ${redundantEdits} superseded edit result(s)` : '') +
    ` had their payloads compressed to save context.${toolsNote}${filesNote}` +
    ` Trust the current state of the files; do NOT re-declare symbols you have already created` +
    ` and do NOT retry the failed tool variants. Reason from the live working window only.`
  );
}

// ─── compactToolFailures (reactive, per-tool, runs at breaker activation) ────

export interface CondenserResult {
  compacted: number;
  insertedAt: number | null;
}

export function compactToolFailures(
  messages: ChatMessage[],
  toolName: string,
  count: number = 3,
): CondenserResult {
  if (count <= 0 || messages.length === 0) {
    return { compacted: 0, insertedAt: null };
  }

  // Walk backwards collecting indices of tool failures for this tool. Stop
  // once we have `count` of them. Skip anything already compacted so the
  // function is idempotent against repeated breaker hits.
  const indices: number[] = [];
  for (let i = messages.length - 1; i >= 0 && indices.length < count; i--) {
    const m = messages[i];
    if (m.role !== 'tool' || m.name !== toolName) { continue; }
    if (typeof m.content === 'string' && m.content.startsWith('[CONDENSER]')) {
      continue;
    }
    indices.push(i);
  }

  if (indices.length === 0) {
    return { compacted: 0, insertedAt: null };
  }

  // indices is descending (newest first). The "earliest" position — where the
  // richer summary lands — is the LAST entry in the array.
  const earliest = indices[indices.length - 1];

  // ── In-place payload mutation (v8.23.1) ──────────────────────────────────
  // Mutate `content` only. Do NOT splice. The tool_call_id pairing required
  // by the OpenAI/OpenRouter API stays intact because every tool message
  // remains at its original index with its original role/name/tool_call_id.
  for (const idx of indices) {
    const m = messages[idx];
    if (idx === earliest) {
      m.content = buildReactiveSummary(toolName, indices.length);
    } else {
      m.content = REACTIVE_STUB_SHORT;
    }
  }

  return { compacted: indices.length, insertedAt: earliest };
}

// ─── Active Auto-Condenser (v8.23.0 → v8.23.1 in-place) ──────────────────────
// The reactive condenser above only fires when the Circuit Breaker fires for a
// single tool. In long sessions the broader failure pattern is "Context Window
// Intoxication": dozens of stale tool messages — old failure traces, repeated
// search_and_replace results on the same file, redundant grep hits — pile up
// in the history and crowd out the live problem. Symptoms include the LLM
// re-declaring an existing function (it forgot it created the symbol earlier),
// re-reading the same file three times in a row, or re-trying a known-bad
// tool variant because the failure is buried 12 turns back.
//
// Same in-place mutation contract as compactToolFailures — never splice; only
// rewrite payloads.

const FAILURE_PREFIXES = [
  'MANAGER DIRECTIVE: The tool failed',
  'SYSTEM ERROR',
  'SYSTEM OVERRIDE',
  '[CIRCUIT',
  '[SOFT BLOCK',
  '[SYNTAX ERROR DETECTED]',
  '[SYSTEM ENGINE ERROR]',
  '[SYSTEM SHIELD]',
  '[SYSTEM BLOCK]',
  '[YIELD TO HUMAN',
  'CRITICAL ERROR',
  'CRITICAL AUDIT FAILURE',
  'FILE NOT FOUND',
  'ERROR:',
  'Error:',
];

function isFailureContent(content: unknown): boolean {
  if (typeof content !== 'string') { return false; }
  return FAILURE_PREFIXES.some(p => content.startsWith(p));
}

export interface ProactiveCompactOptions {
  // Number of messages at the tail to leave untouched. The live working
  // window. Defaults to 10.
  keepTail?: number;
  // Minimum total messages before compaction even runs. Below this size
  // there is nothing meaningful to compact. Defaults to 24.
  minMessages?: number;
}

export interface ProactiveCompactResult {
  compactedFailures: number;
  compactedRedundantEdits: number;
  insertedAt: number | null;
}

export function proactiveCompact(
  messages: ChatMessage[],
  opts: ProactiveCompactOptions = {},
): ProactiveCompactResult {
  const keepTail = opts.keepTail ?? 10;
  const minMessages = opts.minMessages ?? 24;

  if (messages.length < minMessages) {
    return { compactedFailures: 0, compactedRedundantEdits: 0, insertedAt: null };
  }

  const cutoff = Math.max(0, messages.length - keepTail);

  // Build the assistant tool_call → { name, path } map first so we can
  // resolve path metadata for redundant-edit detection. Tool result messages
  // do not carry args; the args live on the prior assistant message's
  // tool_calls and are paired by tool_call_id.
  const callArgsById = new Map<string, { name: string; path: string | null }>();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        let parsed: any = {};
        try { parsed = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore */ }
        const p = (parsed.path ?? parsed.file_path ?? parsed.absolute_path ?? null);
        callArgsById.set(tc.id, {
          name: tc.function.name,
          path: typeof p === 'string' ? p : null,
        });
      }
    }
  }

  // Pass 1 — scan the older portion [0, cutoff) walking backwards. Collect
  // (a) failure-payload indices and (b) superseded edit indices. The first
  // (newest) hit per (tool, path) tuple wins and is preserved; older hits
  // for the same tuple are stale and queued for compaction.
  const failureIndices: number[] = [];
  const redundantEditIndices: number[] = [];
  const seenLatestEdit = new Set<string>();
  const distinctFiles = new Set<string>();
  const distinctFailingTools = new Set<string>();

  const EDIT_TOOLS = new Set([
    'search_and_replace', 'replace_block', 'replace_lines',
    'replace_symbol', 'insert_lines', 'write_file',
  ]);

  for (let i = cutoff - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'tool') { continue; }
    if (typeof m.content === 'string' && m.content.startsWith('[COMPACTED MEMORY]')) {
      continue; // already compacted by a previous pass — skip (idempotent)
    }
    if (typeof m.content === 'string' && m.content.startsWith('[CONDENSER]')) {
      continue; // owned by the reactive condenser — leave intact
    }

    if (isFailureContent(m.content)) {
      failureIndices.push(i);
      if (m.name) { distinctFailingTools.add(m.name); }
      const meta = m.tool_call_id ? callArgsById.get(m.tool_call_id) : undefined;
      if (meta?.path) { distinctFiles.add(meta.path); }
      continue;
    }

    if (m.name && EDIT_TOOLS.has(m.name)) {
      const meta = m.tool_call_id ? callArgsById.get(m.tool_call_id) : undefined;
      const pathKey = meta?.path ?? null;
      if (pathKey) {
        const tupleKey = `${m.name}::${pathKey}`;
        if (seenLatestEdit.has(tupleKey)) {
          redundantEditIndices.push(i);
          distinctFiles.add(pathKey);
        } else {
          seenLatestEdit.add(tupleKey);
        }
      }
    }
  }

  const total = failureIndices.length + redundantEditIndices.length;
  if (total === 0) {
    return { compactedFailures: 0, compactedRedundantEdits: 0, insertedAt: null };
  }

  // Pass 2 — in-place payload mutation. Walk all targeted indices; the
  // earliest one (smallest index) gets the richer summary, the rest get the
  // 1-line stub. The array length stays exactly the same — every tool
  // message keeps its tool_call_id pairing intact.
  const allIndices = [...failureIndices, ...redundantEditIndices].sort((a, b) => a - b);
  const earliest = allIndices[0];

  const summary = buildActiveSummary(
    failureIndices.length,
    redundantEditIndices.length,
    [...distinctFailingTools],
    [...distinctFiles],
  );

  for (const idx of allIndices) {
    const m = messages[idx];
    if (idx === earliest) {
      m.content = summary;
    } else {
      m.content = ACTIVE_STUB_SHORT;
    }
  }

  return {
    compactedFailures: failureIndices.length,
    compactedRedundantEdits: redundantEditIndices.length,
    insertedAt: earliest,
  };
}
