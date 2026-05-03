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

import type { ChatMessage } from '../agentEngine';

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
  // once we have `count` of them OR we hit a non-tool message older than the
  // current burst — the goal is "the last N raw error responses for that
  // tool", not the entire history.
  const indices: number[] = [];
  for (let i = messages.length - 1; i >= 0 && indices.length < count; i--) {
    const m = messages[i];
    if (m.role !== 'tool' || m.name !== toolName) { continue; }
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

  const condenserMessage: ChatMessage = {
    role: 'system',
    content:
      `[CONDENSER] You attempted to use ${toolName} ${indices.length} times unsuccessfully. ` +
      `The raw errors have been compressed to save tokens. ` +
      `MANDATORY: You must change your strategy now.`,
  };

  messages.splice(earliest, 0, condenserMessage);

  return { compacted: indices.length, insertedAt: earliest };
}

// ─── Active Auto-Condenser (v8.23.0) ─────────────────────────────────────────
// The reactive condenser above only fires when the Circuit Breaker fires for a
// single tool. In long sessions the broader failure pattern is "Context Window
// Intoxication": dozens of stale tool messages — old failure traces, repeated
// search_and_replace results on the same file, redundant grep hits — pile up
// in the history and crowd out the live problem. Symptoms include the LLM
// re-declaring an existing function (it forgot it created the symbol earlier),
// re-reading the same file three times in a row, or re-trying a known-bad
// tool variant because the failure is buried 12 turns back.
//
// Inspired by the "compact" routine in Anthropic's own agent loop (the active
// auto-compactor that monitors history size between LLM calls), this routine
// runs ONCE PER ITERATION after the tool-result push. It leaves the most
// recent K messages untouched (the live working window) and walks the older
// portion looking for two specific kinds of stale residue:
//
//   1. Tool failures (role=tool, content starts with one of the well-known
//      engine-injected failure prefixes — MANAGER DIRECTIVE / SYSTEM ERROR /
//      [CIRCUIT / [SOFT BLOCK / [SYNTAX / etc).
//   2. Repeated successful edits on the same file via the same tool — only
//      the MOST RECENT successful edit per (tool, path) tuple matters; older
//      successes are stale because they describe an older state of the file.
//
// All matches in the older window are removed and replaced with a single
// `[COMPACTED MEMORY]` system message that summarizes counts + distinct files
// touched. Idempotent: re-running on a history that already has the marker is
// a no-op (the marker itself is excluded from compaction).

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

function pathKeyFromArgsLikeContent(_content: unknown): null {
  // Tool-result messages do not carry args — we read the path from the
  // adjacent assistant tool_call. Helper kept as a placeholder for future
  // when the engine threads structured metadata through the result.
  return null;
}

export interface ProactiveCompactOptions {
  // Number of messages at the tail to leave untouched. The live window the
  // LLM is actively working in. Defaults to 10.
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

  // Pass 1: scan the older portion (indices [0, cutoff)) for failure messages
  // and for the most-recent-per-(tool,path) edit successes.
  //
  // For redundant edit detection we walk backwards through the older portion
  // so that the FIRST entry we see for a given (tool, path) tuple is the most
  // recent and is preserved; everything older with the same tuple is marked
  // stale.
  const failureIndices: number[] = [];
  const redundantEditIndices: number[] = [];
  const seenLatestEdit = new Set<string>();
  const distinctFiles = new Set<string>();
  const distinctFailingTools = new Set<string>();

  // Collect the assistant tool_call args alongside their tool result indices.
  // The args carry the path; the tool result carries the success state.
  // Map: tool_call_id → { name, path }
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

  for (let i = cutoff - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'tool') { continue; }
    if (typeof m.content === 'string' && m.content.startsWith('[COMPACTED MEMORY]')) {
      continue; // never re-compact ourselves
    }
    if (typeof m.content === 'string' && m.content.startsWith('[CONDENSER]')) {
      continue; // never collide with the per-tool reactive condenser
    }
    if (isFailureContent(m.content)) {
      failureIndices.push(i);
      if (m.name) { distinctFailingTools.add(m.name); }
      const meta = m.tool_call_id ? callArgsById.get(m.tool_call_id) : undefined;
      if (meta?.path) { distinctFiles.add(meta.path); }
      continue;
    }
    // Redundant edit detection: only for known editing tools, success path.
    const EDIT_TOOLS = new Set(['search_and_replace', 'replace_block', 'replace_lines', 'replace_symbol', 'insert_lines']);
    if (m.name && EDIT_TOOLS.has(m.name)) {
      const meta = m.tool_call_id ? callArgsById.get(m.tool_call_id) : undefined;
      const pathKey = meta?.path || pathKeyFromArgsLikeContent(m.content);
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

  const totalToCompact = failureIndices.length + redundantEditIndices.length;
  if (totalToCompact === 0) {
    return { compactedFailures: 0, compactedRedundantEdits: 0, insertedAt: null };
  }

  // Splice everything in descending index order so removals don't shift
  // later indices. Combine and sort.
  const allIndices = [...failureIndices, ...redundantEditIndices].sort((a, b) => b - a);
  const earliestRemoved = allIndices[allIndices.length - 1];

  for (const idx of allIndices) {
    messages.splice(idx, 1);
  }

  const filesNote = distinctFiles.size > 0
    ? ` Affected files: ${[...distinctFiles].slice(0, 5).join(', ')}${distinctFiles.size > 5 ? `, +${distinctFiles.size - 5} more` : ''}.`
    : '';
  const toolsNote = distinctFailingTools.size > 0
    ? ` Tools that previously failed: ${[...distinctFailingTools].join(', ')}.`
    : '';

  const compactedMessage: ChatMessage = {
    role: 'system',
    content:
      `[COMPACTED MEMORY] Earlier in this session ${failureIndices.length} tool failure(s)` +
      (redundantEditIndices.length > 0 ? ` and ${redundantEditIndices.length} superseded edit result(s)` : '') +
      ` were removed from history to save context.${toolsNote}${filesNote}` +
      ` Trust the current state of the files; do NOT re-declare symbols you have already created` +
      ` and do NOT retry the failed tool variants. Reason from the live working window only.`,
  };

  messages.splice(earliestRemoved, 0, compactedMessage);

  return {
    compactedFailures: failureIndices.length,
    compactedRedundantEdits: redundantEditIndices.length,
    insertedAt: earliestRemoved,
  };
}
