# 📦 APP MANIFEST
* **App Name:** fluxo-ai
* **Version:** 8.36.6
* **Stack:** Vanilla JS
* **Part:** 3
* **Generated At:** 2026-06-13T03:57:22.725Z

---

### 📁 FILE: `src\tools\UpdateMemoryTool\index.ts`
```typescript
import * as fs from 'fs';
import * as path from 'path';
import { NativeTool, ToolResult, safePath } from '../shared';

const MEMORY_RELATIVE = '.fluxo/memory.md';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'update_memory',
    description:
      'Append a Blameless Post-Mortem entry to .fluxo/memory.md. ' +
      'Use this tool ONLY after a failure or non-trivial recovery (Circuit Breaker, repeated build failures, ' +
      'tool misuse, corrupted imports, missed pre-step like get_repo_map, etc.). ' +
      'Do NOT use it to log generic success messages — the memory is a high-signal post-mortem log. ' +
      'You MUST explicitly document what_failed, why_it_failed, and the_fix. ' +
      'TIMING: Only call after npm run build is green — log the verified post-fix truth, never a hypothesis.',
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description:
            'Short identifier or description of the task context. ' +
            'Examples: "auth-refactor", "stripe-webhook-fix", "circuit-breaker-recovery".',
        },
        outcome: {
          type: 'string',
          enum: ['Success', 'Failure'],
          description:
            'Whether the task ultimately succeeded after recovery (Success) or had to be abandoned (Failure). ' +
            'A Success outcome is still allowed if the journey involved a failure that you recovered from — ' +
            'document the failure path in the other fields.',
        },
        what_failed: {
          type: 'string',
          description:
            'Concrete description of the error or blockage. Examples: "Corrupted imports during search_and_replace", ' +
            '"Forgot to call get_repo_map before delegating to coder", "search_and_replace returned MATCH ERROR ' +
            '3 times in a row on the same file", "Circuit Breaker fired after 3 consecutive failed builds".',
        },
        why_it_failed: {
          type: 'string',
          description:
            'Root cause analysis. Examples: "Tabs vs spaces drift in the source file caused fuzzy matcher to ' +
            'reject the snippet", "Skipped repo map so I guessed the wrong file path", "The library requires ' +
            'middleware registration BEFORE express.json() and the docs bury this fact".',
        },
        the_fix: {
          type: 'string',
          description:
            'Concrete technical solution applied. Examples: "Read the file with read_file then copied the ' +
            'snippet verbatim character by character", "Called get_repo_map first and confirmed the actual ' +
            'symbol location", "Re-ordered middleware: rawBody parser before express.json()".',
        },
      },
      required: ['task_id', 'outcome', 'what_failed', 'why_it_failed', 'the_fix'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const { task_id, outcome, what_failed, why_it_failed, the_fix } = args;

  if (typeof task_id !== 'string' || task_id.trim() === '') {
    return { success: false, output: 'CRITICAL ERROR: "task_id" is required and must be a non-empty string.' };
  }
  if (outcome !== 'Success' && outcome !== 'Failure') {
    return { success: false, output: 'CRITICAL ERROR: "outcome" must be either "Success" or "Failure".' };
  }
  if (typeof what_failed !== 'string' || what_failed.trim() === '') {
    return { success: false, output: 'CRITICAL ERROR: "what_failed" is required. Describe the concrete error or blockage encountered.' };
  }
  if (typeof why_it_failed !== 'string' || why_it_failed.trim() === '') {
    return { success: false, output: 'CRITICAL ERROR: "why_it_failed" is required. Provide the root cause analysis.' };
  }
  if (typeof the_fix !== 'string' || the_fix.trim() === '') {
    return { success: false, output: 'CRITICAL ERROR: "the_fix" is required. Describe the concrete technical solution applied.' };
  }

  let memoryFilePath: string;
  try {
    memoryFilePath = safePath(workspacePath, MEMORY_RELATIVE);
  } catch (e: any) {
    return { success: false, output: `[SYSTEM SHIELD] ${e.message}` };
  }

  fs.mkdirSync(path.dirname(memoryFilePath), { recursive: true });

  const now = new Date();
  const timestamp = now.toISOString().replace('T', ' ').substring(0, 19);

  const entry =
    `\n### [${timestamp}] - Task: ${task_id.trim()}\n` +
    `- **Outcome:** ${outcome}\n` +
    `- **What Failed:** ${what_failed.trim()}\n` +
    `- **Why it Failed:** ${why_it_failed.trim()}\n` +
    `- **The Fix:** ${the_fix.trim()}\n`;

  fs.appendFileSync(memoryFilePath, entry, 'utf-8');

  return {
    success: true,
    output: `Post-mortem entry appended to ${MEMORY_RELATIVE}. Timestamp: ${timestamp}. Outcome: ${outcome}.`,
  };
}

```

### 📁 FILE: `src\utils\agentMailbox.ts`
```typescript
interface MailboxEntry {
  fromAgentId: string;
  payload: string;
  sentAt: number;
}

class AgentMailboxClass {
  private inbox = new Map<string, MailboxEntry[]>();

  send(toAgentId: string, fromAgentId: string, payload: string): void {
    const key = toAgentId.toLowerCase().trim();
    if (!this.inbox.has(key)) { this.inbox.set(key, []); }
    this.inbox.get(key)!.push({ fromAgentId, payload, sentAt: Date.now() });
  }

  // Consume and return all messages for an agent (empties the inbox slot).
  drain(agentId: string): string[] {
    const key = agentId.toLowerCase().trim();
    const entries = this.inbox.get(key);
    if (!entries || entries.length === 0) { return []; }
    this.inbox.delete(key);
    return entries.map(e => `[FROM @${e.fromAgentId}]: ${e.payload}`);
  }

  hasPending(agentId: string): boolean {
    const entries = this.inbox.get(agentId.toLowerCase().trim());
    return !!(entries && entries.length > 0);
  }
}

export const AgentMailbox = new AgentMailboxClass();

```

### 📁 FILE: `src\utils\buildValidator.ts`
```typescript
import { exec } from 'child_process';

export function validateBuild(workspacePath: string): Promise<{ success: boolean; error?: string }> {
  return new Promise(resolve => {
    exec('npm run build', { cwd: workspacePath, timeout: 45000 }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ success: true });
      } else {
        resolve({ success: false, error: (stderr || stdout).trim().slice(0, 2000) });
      }
    });
  });
}

```

### 📁 FILE: `src\utils\cleanupRegistry.ts`
```typescript
// ─── Orphaned-Worktree Auto-Cleanup (v8.27.0 — Phase 3.3) ───────────────────
//
// Background janitor that runs once per VS Code activation. Scans
// .fluxo/worktrees/ and destroys any worktree directory that does NOT match
// the currently-active branch recorded in .fluxo/active_worktree.json.
//
// Why this exists: prior versions (v8.18.x onward) generally clean up worktrees
// on `exit_worktree(action='discard'|'merge')`, but the discard path can leave
// residue when:
//   • VS Code is killed mid-task (Ctrl+C, OS reboot, extension host crash) —
//     the worktree directory survives but the active_worktree.json was
//     overwritten by a newer task before cleanup ran.
//   • A `git worktree remove` failed silently because the worktree was locked
//     or contained uncommitted changes from a partial WIP commit.
//   • Two VS Code windows operated on the same repo and one of them created
//     a worktree the other never knew about (no DAG/mutex coordination
//     between processes outside merge.lock).
//
// Over time these orphans accumulate inside .fluxo/worktrees/ and consume
// disk + clutter `git worktree list` output. This routine is idempotent and
// silent: if there are no orphans, nothing happens; failures during cleanup
// are swallowed so a stuck worktree never blocks extension activation.
//
// Order of operations per orphan:
//   1. `git worktree remove --force <path>`   — releases the worktree slot
//                                                from git's bookkeeping.
//   2. `git worktree prune`                   — sweeps any stale entries
//                                                left by previous failed
//                                                removes.
//   3. `git branch -D <branch>`               — deletes the local branch
//                                                the orphan was attached to.
//   4. fs.rmSync(<path>, recursive, force)    — last-resort filesystem
//                                                cleanup if step 1 left the
//                                                directory behind.
// Each step's failure is logged to console.error but does NOT abort the
// loop — the next orphan still gets a try.

import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';

const STATE_FILE_RELATIVE  = path.join('.fluxo', 'active_worktree.json');
const WORKTREES_DIR_RELATIVE = path.join('.fluxo', 'worktrees');

interface ActiveWorktreeState {
  branchName?: string;
  worktreePath?: string;
  reason?: string;
  createdAt?: string;
}

function readActiveBranch(workspacePath: string): string | null {
  const stateFile = path.join(workspacePath, STATE_FILE_RELATIVE);
  if (!fs.existsSync(stateFile)) { return null; }
  try {
    const raw = fs.readFileSync(stateFile, 'utf-8');
    const parsed = JSON.parse(raw) as ActiveWorktreeState;
    return typeof parsed?.branchName === 'string' && parsed.branchName.trim()
      ? parsed.branchName.trim()
      : null;
  } catch {
    // Corrupt JSON — treat as "no active worktree" so cleanup proceeds for
    // all directories. A clean session start will rewrite the file.
    return null;
  }
}

function destroyWorktree(workspacePath: string, branchName: string, worktreePath: string): void {
  // Step 1 — git worktree remove --force. The --force flag is required
  // because the orphan typically has uncommitted residue from a crashed
  // session; without it git refuses with "contains modified or untracked
  // files".
  try {
    cp.execSync(`git worktree remove --force "${worktreePath}"`, {
      cwd: workspacePath,
      stdio: 'pipe',
      timeout: 15_000,
    });
  } catch (err: any) {
    console.error(`[Fluxo Cleanup] git worktree remove failed for "${branchName}": ${err?.message ?? err}`);
  }

  // Step 2 — git worktree prune. Sweeps stale .git/worktrees/<name>
  // entries that the remove may have left behind (or that an earlier
  // failed remove created).
  try {
    cp.execSync('git worktree prune', {
      cwd: workspacePath,
      stdio: 'pipe',
      timeout: 10_000,
    });
  } catch (err: any) {
    console.error(`[Fluxo Cleanup] git worktree prune failed: ${err?.message ?? err}`);
  }

  // Step 3 — git branch -D. The orphan branch is local-only (the engine
  // never publishes worktree branches to a remote); -D bypasses the
  // "branch not fully merged" check which would otherwise block deletion
  // because the branch contains the unmerged anchor commit.
  try {
    cp.execSync(`git branch -D "${branchName}"`, {
      cwd: workspacePath,
      stdio: 'pipe',
      timeout: 10_000,
    });
  } catch (err: any) {
    // Common path: branch already gone because `git worktree remove --force`
    // can take it with the worktree on some git versions. Not an error.
    if (!String(err?.message ?? '').includes('not found')) {
      console.error(`[Fluxo Cleanup] git branch -D failed for "${branchName}": ${err?.message ?? err}`);
    }
  }

  // Step 4 — defensive fs cleanup. If any of the above left the directory
  // on disk (which happens when git's bookkeeping recovered but the actual
  // tree didn't get unlinked, e.g. on Windows where a file handle is still
  // held), remove the tree directly. fs.rmSync with recursive+force does
  // not throw on missing.
  try {
    if (fs.existsSync(worktreePath)) {
      fs.rmSync(worktreePath, { recursive: true, force: true, maxRetries: 3 });
    }
  } catch (err: any) {
    console.error(`[Fluxo Cleanup] fs.rmSync fallback failed for "${worktreePath}": ${err?.message ?? err}`);
  }
}

/**
 * Scan .fluxo/worktrees/ and destroy every directory whose name does NOT
 * match the active worktree recorded in .fluxo/active_worktree.json.
 * Idempotent and silent: zero orphans → no-op; failures per orphan are
 * isolated so one stuck worktree never blocks the rest.
 *
 * Returns the list of destroyed orphan branch names so the caller can log
 * the event for telemetry. Returns [] when the workspace has no .fluxo
 * directory or no worktrees subdirectory yet.
 */
export function cleanupOrphanedWorktrees(workspacePath: string): string[] {
  if (!workspacePath) { return []; }
  const worktreesDir = path.join(workspacePath, WORKTREES_DIR_RELATIVE);
  if (!fs.existsSync(worktreesDir)) { return []; }

  // Sanity: only run if we are inside a git repo. Outside of one, all the
  // git commands below would fail and spam stderr — the activation hook
  // can fire on workspaces that have a stray .fluxo/ leftover from a copy.
  try {
    cp.execSync('git rev-parse --is-inside-work-tree', {
      cwd: workspacePath,
      stdio: 'pipe',
      timeout: 5_000,
    });
  } catch {
    return [];
  }

  const activeBranch = readActiveBranch(workspacePath);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const destroyed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) { continue; }
    const branchName = entry.name;
    if (activeBranch && branchName === activeBranch) { continue; }
    const worktreePath = path.join(worktreesDir, branchName);
    destroyWorktree(workspacePath, branchName, worktreePath);
    destroyed.push(branchName);
  }
  return destroyed;
}

```

### 📁 FILE: `src\utils\condenser.ts`
```typescript
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

```

### 📁 FILE: `src\utils\dagController.ts`
```typescript
// ─── DAG Controller (v8.17.0 — Phase 1) ─────────────────────────────────────
// Central state manager for the @manager's Directed Acyclic Graph orchestration.
// Replaces the legacy flat IMPLEMENTATION_PLAN.md with a structured task graph
// persisted at .fluxo/dag_state.json. Every task carries explicit dependencies,
// so the engine can resolve which tasks are unblocked at any iteration without
// asking the LLM to re-derive ordering on each turn.

import * as fs from 'fs';
import * as path from 'path';

export type TaskStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';

export interface Task {
  id: string;
  description: string;
  agent_type: string;          // e.g. '@coder', '@designer', '@manager'
  status: TaskStatus;
  depends_on: string[];        // parent task IDs that must be COMPLETED first
  result?: string;             // optional output / report from the executing agent
  started_at?: string;         // ISO timestamp set when status flips to IN_PROGRESS
  completed_at?: string;       // ISO timestamp set when status flips to COMPLETED/FAILED
}

export interface DagState {
  version: number;             // schema version, bumped on breaking changes
  created_at: string;          // ISO timestamp of graph initialization
  updated_at: string;          // ISO timestamp of last mutation
  tasks: Task[];
}

const DAG_DIR_NAME    = '.fluxo';
const DAG_FILE_NAME   = 'dag_state.json';
const SCHEMA_VERSION  = 1;

function dagFilePath(workspacePath: string): string {
  return path.join(workspacePath, DAG_DIR_NAME, DAG_FILE_NAME);
}

function ensureDir(workspacePath: string): void {
  fs.mkdirSync(path.join(workspacePath, DAG_DIR_NAME), { recursive: true });
}

// ─── Validation ─────────────────────────────────────────────────────────────

const VALID_STATUSES: TaskStatus[] = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED'];

export function validateTasks(tasks: any[]): { ok: true; tasks: Task[] } | { ok: false; error: string } {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { ok: false, error: 'tasks must be a non-empty array.' };
  }

  const seenIds = new Set<string>();
  const normalized: Task[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!t || typeof t !== 'object') {
      return { ok: false, error: `Task #${i} is not an object.` };
    }
    if (typeof t.id !== 'string' || !t.id.trim()) {
      return { ok: false, error: `Task #${i} is missing a non-empty 'id' string.` };
    }
    if (seenIds.has(t.id)) {
      return { ok: false, error: `Duplicate task id "${t.id}". Every task id must be unique.` };
    }
    seenIds.add(t.id);

    if (typeof t.description !== 'string' || !t.description.trim()) {
      return { ok: false, error: `Task "${t.id}" is missing a non-empty 'description'.` };
    }
    if (typeof t.agent_type !== 'string' || !t.agent_type.trim()) {
      return { ok: false, error: `Task "${t.id}" is missing a non-empty 'agent_type' (e.g. '@coder').` };
    }

    const status: TaskStatus = (t.status && VALID_STATUSES.includes(t.status))
      ? t.status as TaskStatus
      : 'PENDING';

    const depends_on = Array.isArray(t.depends_on) ? t.depends_on.filter((d: any) => typeof d === 'string') : [];

    normalized.push({
      id: t.id.trim(),
      description: t.description.trim(),
      agent_type: t.agent_type.trim(),
      status,
      depends_on,
    });
  }

  // Verify every dependency points to a known task id and there are no cycles.
  for (const t of normalized) {
    for (const dep of t.depends_on) {
      if (!seenIds.has(dep)) {
        return { ok: false, error: `Task "${t.id}" depends on unknown task id "${dep}".` };
      }
      if (dep === t.id) {
        return { ok: false, error: `Task "${t.id}" cannot depend on itself.` };
      }
    }
  }
  if (hasCycle(normalized)) {
    return { ok: false, error: 'Dependency graph contains a cycle. The DAG must be acyclic.' };
  }

  return { ok: true, tasks: normalized };
}

function hasCycle(tasks: Task[]): boolean {
  const adj = new Map<string, string[]>();
  for (const t of tasks) { adj.set(t.id, t.depends_on); }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const t of tasks) { color.set(t.id, WHITE); }

  function dfs(id: string): boolean {
    color.set(id, GRAY);
    for (const dep of adj.get(id) ?? []) {
      const c = color.get(dep) ?? WHITE;
      if (c === GRAY) { return true; }
      if (c === WHITE && dfs(dep)) { return true; }
    }
    color.set(id, BLACK);
    return false;
  }

  for (const t of tasks) {
    if ((color.get(t.id) ?? WHITE) === WHITE) {
      if (dfs(t.id)) { return true; }
    }
  }
  return false;
}

// ─── Persistence ────────────────────────────────────────────────────────────

export function initialize(workspacePath: string, tasks: Task[]): DagState {
  ensureDir(workspacePath);
  const now = new Date().toISOString();
  const state: DagState = {
    version: SCHEMA_VERSION,
    created_at: now,
    updated_at: now,
    tasks,
  };
  fs.writeFileSync(dagFilePath(workspacePath), JSON.stringify(state, null, 2), 'utf-8');
  return state;
}

export function read(workspacePath: string): DagState | null {
  const fp = dagFilePath(workspacePath);
  if (!fs.existsSync(fp)) { return null; }
  try {
    const raw = fs.readFileSync(fp, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.tasks)) { return null; }
    return parsed as DagState;
  } catch {
    return null;
  }
}

function write(workspacePath: string, state: DagState): void {
  state.updated_at = new Date().toISOString();
  fs.writeFileSync(dagFilePath(workspacePath), JSON.stringify(state, null, 2), 'utf-8');
}

export function updateTaskStatus(
  workspacePath: string,
  taskId: string,
  status: TaskStatus,
  result?: string
): boolean {
  const state = read(workspacePath);
  if (!state) { return false; }
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) { return false; }
  task.status = status;
  if (result !== undefined) { task.result = result; }
  const now = new Date().toISOString();
  if (status === 'IN_PROGRESS' && !task.started_at) { task.started_at = now; }
  if (status === 'COMPLETED' || status === 'FAILED') { task.completed_at = now; }
  write(workspacePath, state);
  return true;
}

// ─── Dispatch Resolution ────────────────────────────────────────────────────
// A task is "ready" when its status is PENDING and EVERY task listed in
// depends_on has reached the COMPLETED status. The dispatcher does not mutate
// the graph — it only reports which tasks are unblocked. The agentEngine is
// responsible for promoting them to IN_PROGRESS once it actually delegates.

export function getReadyTasks(workspacePath: string): Task[] {
  const state = read(workspacePath);
  if (!state) { return []; }
  const completed = new Set(state.tasks.filter(t => t.status === 'COMPLETED').map(t => t.id));
  return state.tasks.filter(t =>
    t.status === 'PENDING' && t.depends_on.every(dep => completed.has(dep))
  );
}

export function exists(workspacePath: string): boolean {
  return fs.existsSync(dagFilePath(workspacePath));
}

// ─── Dynamic Task Injection (v8.18.0 — Phase 4) ─────────────────────────────
// Phase 4 lets the engine append tasks to a live DAG (not just initialize a
// fresh graph). Used today by ExitWorktreeTool to queue a HIGH PRIORITY
// conflict-resolution task right after a merge collision. Generic enough to
// be reused by any future "react to runtime event" feature.

export interface AppendTaskInput {
  description: string;
  agent_type: string;
  depends_on?: string[];
  idPrefix?: string;        // optional — defaults to 'auto'
}

/**
 * Append a single task to the live DAG. Returns the new Task on success or
 * null if no DAG exists / the file is unreadable. The new task always starts
 * in PENDING status; the dispatcher will pick it up on the next iteration
 * tick once its depends_on parents are COMPLETED.
 */
export function appendTask(workspacePath: string, input: AppendTaskInput): Task | null {
  const state = read(workspacePath);
  if (!state) { return null; }

  const prefix = (input.idPrefix ?? 'auto').replace(/[^a-zA-Z0-9_-]/g, '');
  const existingIds = new Set(state.tasks.map(t => t.id));
  let n = state.tasks.length + 1;
  let id = `${prefix}-${n}`;
  while (existingIds.has(id)) { n++; id = `${prefix}-${n}`; }

  const newTask: Task = {
    id,
    description: input.description,
    agent_type: input.agent_type,
    status: 'PENDING',
    depends_on: Array.isArray(input.depends_on) ? input.depends_on.filter(d => existingIds.has(d)) : [],
  };
  state.tasks.push(newTask);
  write(workspacePath, state);
  return newTask;
}

/**
 * Find the most recently-started IN_PROGRESS task in the DAG. Used by
 * ExitWorktreeTool to identify which task "owns" the merge attempt that
 * just failed, so the auto-injected conflict-resolution task can list it as
 * a dependency. Returns null if the DAG is missing or no task is in flight.
 */
export function getCurrentInProgressTask(workspacePath: string): Task | null {
  const state = read(workspacePath);
  if (!state) { return null; }
  const inFlight = state.tasks.filter(t => t.status === 'IN_PROGRESS');
  if (inFlight.length === 0) { return null; }
  inFlight.sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''));
  return inFlight[0];
}

// ─── Human-readable rendering ───────────────────────────────────────────────
// Used by ProposePlanTool to keep IMPLEMENTATION_PLAN.md alive as a review
// surface for the user — the JSON is the source of truth, the markdown is the
// projection humans actually read.

export function renderMarkdown(state: DagState): string {
  const lines: string[] = [];
  lines.push('# 📋 Implementation Plan — DAG Orchestration');
  lines.push('');
  lines.push(`> Generated by @manager via the DAG Controller (v${state.version}).`);
  lines.push(`> Source of truth: \`.fluxo/dag_state.json\`. This document is a human-readable projection.`);
  lines.push(`> Created: ${state.created_at} · Updated: ${state.updated_at}`);
  lines.push('');
  lines.push(`**Total tasks:** ${state.tasks.length}`);
  lines.push('');
  lines.push('## Task Graph');
  lines.push('');

  for (const task of state.tasks) {
    const depList = task.depends_on.length > 0
      ? task.depends_on.map(d => `\`${d}\``).join(', ')
      : '_(no dependencies — root task)_';
    lines.push(`### \`${task.id}\` — ${task.description}`);
    lines.push('');
    lines.push(`- **Agent:** ${task.agent_type}`);
    lines.push(`- **Status:** ${task.status}`);
    lines.push(`- **Depends on:** ${depList}`);
    lines.push('');
  }

  return lines.join('\n');
}

```

### 📁 FILE: `src\utils\gitSafety.ts`
```typescript
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ─── Git Safety Utilities (v8.15.0 — The Time Machine) ───────────────────────

// ─── Sequential Merge Mutex (v8.18.0 — Phase 4) ─────────────────────────────
// Cross-process file lock that serializes worktree merges into the main
// branch. Multiple parallel agents (or multiple VS Code windows operating on
// the same repo) calling exit_worktree(merge) at the same time would race on
// git's index — partial merges, lost commits, half-applied refs. The mutex
// queues them: the first agent through holds the lock, the rest busy-wait
// (with bounded retry) until the holder releases or the lock is detected as
// stale.
//
// Why a sync busy-wait: the entire ExitWorktreeTool.execute() runs as a
// synchronous call from the engine. We cannot await — we must block until
// the lock is acquired or the deadline passes. execSync already blocks the
// event loop end-to-end, so a brief Atomics.wait inside the same tool call
// has identical scheduling impact.

const MERGE_LOCK_RELATIVE  = path.join('.fluxo', 'merge.lock');
const MERGE_LOCK_TIMEOUT   = 30_000; // ms — abandon if we cannot get the lock in 30 s
const MERGE_LOCK_STALE_MS  = 60_000; // ms — a lock older than 60 s is treated as orphaned
const MERGE_LOCK_POLL_MS   = 100;    // ms — sleep between acquisition retries

function syncSleep(ms: number): void {
  // Atomics.wait blocks the event loop without spin-burning CPU.
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

function ensureLockDir(workspacePath: string): void {
  fs.mkdirSync(path.join(workspacePath, '.fluxo'), { recursive: true });
}

function isStale(lockPath: string): boolean {
  try {
    const stat = fs.statSync(lockPath);
    return Date.now() - stat.mtimeMs > MERGE_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

export interface MergeMutexHandle {
  release: () => void;
  acquiredAt: number;
}

/**
 * Acquire a process-wide (and cross-process) merge mutex by atomically
 * creating .fluxo/merge.lock. Blocks for up to MERGE_LOCK_TIMEOUT ms.
 * On timeout, returns null so the caller can decide whether to fail or retry.
 */
export function acquireMergeMutex(workspacePath: string, holderId: string): MergeMutexHandle | null {
  ensureLockDir(workspacePath);
  const lockPath = path.join(workspacePath, MERGE_LOCK_RELATIVE);
  const deadline = Date.now() + MERGE_LOCK_TIMEOUT;
  const payload  = JSON.stringify({ holder: holderId, pid: process.pid, acquired_at: new Date().toISOString() });

  while (Date.now() < deadline) {
    try {
      // wx flag = create + exclusive — fails atomically if the file already exists.
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, payload);
      fs.closeSync(fd);
      return {
        acquiredAt: Date.now(),
        release: () => {
          try { fs.unlinkSync(lockPath); } catch { /* lock already cleaned */ }
        },
      };
    } catch (err: any) {
      if (err.code !== 'EEXIST') { return null; }
      // Stale lock: orphaned by a previous run. Force-remove and retry.
      if (isStale(lockPath)) {
        try { fs.unlinkSync(lockPath); } catch { /* race with another waker — re-loop */ }
        continue;
      }
      syncSleep(MERGE_LOCK_POLL_MS);
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────

export function hasUncommittedChanges(cwd: string): boolean {
  try {
    const out = execSync('git status --porcelain', { cwd, encoding: 'utf-8', timeout: 5000 });
    return out.trim().length > 0;
  } catch {
    return false; // not a git repo or git unavailable — treat as clean
  }
}

// Creates an empty anchor commit so rollbackToLastCheckpoint() has a fixed
// HEAD~1 to reset to, undoing all subsequent agent file edits in one atomic
// git reset --hard.
//
// v8.16.7 — Smart Auto-Commit: if the working tree has uncommitted human
// changes, we no longer abort. Instead we auto-save them as a "WIP" commit
// FIRST, then layer the agent's anchor commit on top. If the agent later
// fails and we reset --hard HEAD~1, the human's WIP commit remains intact —
// their work is preserved, only the agent's edits are discarded.
export function createSilentCheckpoint(taskId: string, cwd: string): void {
  // ── v8.16.2: Block checkpoints for invalid/analysis-only task IDs ────────────
  if (taskId.includes('MISSION-ANALYSIS-ONLY')) {
    return;
  }
  if (hasUncommittedChanges(cwd)) {
    execSync('git add .', { cwd, encoding: 'utf-8', timeout: 10000 });
    execSync(
      'git commit -m "WIP: Auto-saved human changes before agent task"',
      { cwd, encoding: 'utf-8', timeout: 10000 }
    );
  }
  const safe = taskId.replace(/['"\\]/g, '').slice(0, 60);
  execSync(`git commit --allow-empty -m "fluxo-auto-checkpoint: ${safe}"`, {
    cwd,
    encoding: 'utf-8',
    timeout: 10000,
  });
}

export function rollbackToLastCheckpoint(cwd: string): { success: boolean; output: string } {
  try {
    const out = execSync('git reset --hard HEAD~1', { cwd, encoding: 'utf-8', timeout: 15000 });
    return {
      success: true,
      output: `Rollback complete. Working tree restored to the state before the last agent checkpoint.\n${out.trim()}`,
    };
  } catch (err: any) {
    return {
      success: false,
      output: `Rollback failed: ${err.message ?? String(err)}`,
    };
  }
}

```

### 📁 FILE: `src\utils\lockfile.ts`
```typescript
interface LockEntry {
  agentId: string;
  acquiredAt: number;
}

class FileLockManagerClass {
  private locks = new Map<string, LockEntry>();

  // Returns true if the lock was acquired (or is already held by the same agent).
  // Returns false if the file is locked by a different agent.
  acquireLock(filePath: string, agentId: string): boolean {
    const key = filePath.toLowerCase();
    const existing = this.locks.get(key);
    if (existing) {
      return existing.agentId === agentId; // reentrant for same agent
    }
    this.locks.set(key, { agentId, acquiredAt: Date.now() });
    return true;
  }

  // Releases the lock only if the caller is the current holder.
  releaseLock(filePath: string, agentId: string): void {
    const key = filePath.toLowerCase();
    const existing = this.locks.get(key);
    if (existing && existing.agentId === agentId) {
      this.locks.delete(key);
    }
  }

  getHolder(filePath: string): string | undefined {
    return this.locks.get(filePath.toLowerCase())?.agentId;
  }
}

export const FileLockManager = new FileLockManagerClass();

```

### 📁 FILE: `src\utils\mcpConfigWriter.ts`
```typescript
// ─── MCP Config Writer (v8.20.0 — Zero-Config UX) ──────────────────────────
// File-level operations on .fluxo/mcp_servers.json. Single source of truth
// for both the boot-time auto-inject path (mcpClient.ts) and the user-facing
// CLI / VSCode commands (commands/mcp.ts, extension.ts). All ops are
// idempotent: re-running ensureStarterPack on a populated workspace is a
// no-op, addServer on an existing alias is a no-op, removeServer on a
// missing alias is a no-op.

import * as fs from 'fs';
import * as path from 'path';
import { OFFICIAL_REGISTRY, RegistryEntry, getStarterPack, getRegistryEntry } from './mcpRegistry';

const CONFIG_RELATIVE = path.join('.fluxo', 'mcp_servers.json');

export interface ServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  categories?: string[];
}

export interface ConfigShape {
  /** Header note rendered for humans editing the file by hand. */
  _comment?: string;
  /** When the registry generates a per-server note, it lands here keyed by alias. */
  _notes?: Record<string, string>;
  /** Active servers. Keys are aliases, values are the StdioClientTransport-compatible config. */
  mcpServers: Record<string, ServerEntry>;
}

function configPath(workspacePath: string): string {
  return path.join(workspacePath, CONFIG_RELATIVE);
}

function ensureDir(workspacePath: string): void {
  fs.mkdirSync(path.join(workspacePath, '.fluxo'), { recursive: true });
}

/**
 * Load the existing config or return an empty shape. Tolerant of legacy
 * formats: a root-level map { server: {...} } is auto-promoted to the
 * envelope { mcpServers: { server: {...} } } before being returned.
 */
export function readConfig(workspacePath: string): ConfigShape {
  const fp = configPath(workspacePath);
  if (!fs.existsSync(fp)) {
    return { mcpServers: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') {
      return { mcpServers: {} };
    }
    if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
      return parsed as ConfigShape;
    }
    // Legacy root-level map — promote to envelope.
    return { mcpServers: parsed as Record<string, ServerEntry> };
  } catch {
    // Corrupt JSON — return empty so callers can re-seed without losing
    // their workspace setup. The original file is left intact on disk for
    // the user to fix manually.
    return { mcpServers: {} };
  }
}

function writeConfig(workspacePath: string, cfg: ConfigShape): void {
  ensureDir(workspacePath);
  cfg._comment = cfg._comment ?? 'Generated by Fluxo AI v8.20.0. Edit by hand or use `Fluxo: Add MCP Server` from the command palette / `node out/commands/mcp.js add <alias>` from the CLI.';
  fs.writeFileSync(configPath(workspacePath), JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

function entryToServer(entry: RegistryEntry): ServerEntry {
  const server: ServerEntry = {
    command: entry.command,
    args: entry.args ? [...entry.args] : undefined,
    categories: entry.categories ? [...entry.categories] : undefined,
  };
  if (entry.env) {
    server.env = { ...entry.env };
  }
  return server;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * On first boot in a workspace that has never configured MCP, this drops a
 * starter pack JSON onto disk so the agent has something useful immediately
 * — no docs, no manual editing. Returns the list of aliases that were
 * actually written. If the file already exists, this is a no-op and returns
 * an empty array (we never overwrite user choices).
 */
export function ensureStarterPack(workspacePath: string): string[] {
  if (!workspacePath) { return []; }
  const fp = configPath(workspacePath);
  if (fs.existsSync(fp)) { return []; }

  const starters = getStarterPack();
  if (starters.length === 0) { return []; }

  const cfg: ConfigShape = { mcpServers: {}, _notes: {} };
  for (const entry of starters) {
    cfg.mcpServers[entry.alias] = entryToServer(entry);
    if (entry.note && cfg._notes) { cfg._notes[entry.alias] = entry.note; }
  }
  writeConfig(workspacePath, cfg);
  return starters.map(e => e.alias);
}

export interface AddResult {
  ok: boolean;
  alias: string;
  reason?: string;
}

/** Add a registry entry to the workspace config. Idempotent. */
export function addServer(workspacePath: string, alias: string): AddResult {
  if (!workspacePath) { return { ok: false, alias, reason: 'No workspace path provided.' }; }
  const entry = getRegistryEntry(alias);
  if (!entry) {
    const known = Object.keys(OFFICIAL_REGISTRY).sort().join(', ');
    return { ok: false, alias, reason: `Unknown server "${alias}". Known aliases: ${known}.` };
  }
  const cfg = readConfig(workspacePath);
  if (cfg.mcpServers[entry.alias]) {
    return { ok: true, alias: entry.alias, reason: `"${entry.alias}" is already configured. No changes written.` };
  }
  cfg.mcpServers[entry.alias] = entryToServer(entry);
  if (entry.note) {
    cfg._notes = { ...(cfg._notes ?? {}), [entry.alias]: entry.note };
  }
  writeConfig(workspacePath, cfg);
  return { ok: true, alias: entry.alias };
}

/** Remove a server from the workspace config. Idempotent. */
export function removeServer(workspacePath: string, alias: string): AddResult {
  if (!workspacePath) { return { ok: false, alias, reason: 'No workspace path provided.' }; }
  const cfg = readConfig(workspacePath);
  if (!cfg.mcpServers[alias]) {
    return { ok: true, alias, reason: `"${alias}" was not configured. No changes written.` };
  }
  delete cfg.mcpServers[alias];
  if (cfg._notes) { delete cfg._notes[alias]; }
  writeConfig(workspacePath, cfg);
  return { ok: true, alias };
}

export function listConfigured(workspacePath: string): Record<string, ServerEntry> {
  return readConfig(workspacePath).mcpServers;
}

```

### 📁 FILE: `src\utils\mcpRegistry.ts`
```typescript
// ─── Official MCP Registry (v8.20.0 — Zero-Config UX) ───────────────────────
// Curated catalog of well-known open-source MCP servers. Each entry pairs a
// short alias (what the user types in `fluxo mcp add <name>`) with a
// runnable command, default args, and pre-baked categories that feed straight
// into the v8.19.0 RBAC filter without requiring the user to author anything.
//
// Adding a new server here = supported out of the box. Project-specific
// overrides still go in .fluxo/mcp_servers.json (workspace JSON wins on
// collisions per v8.19.0 merge rules).

export interface RegistryEntry {
  /** Short alias users type, e.g. "memory", "sqlite", "brave-search". */
  alias: string;
  /** Friendly one-line description shown in pickers / CLI list output. */
  description: string;
  /** Executable to invoke. Default 'npx' — works on every Node platform. */
  command: string;
  /** Args forwarded to `command`. Use ${ARG:default} placeholders for runtime substitution. */
  args: string[];
  /** Env vars required by the server. ${ENV:VAR_NAME} placeholders are resolved at write time. */
  env?: Record<string, string>;
  /** Categories consumed by the v8.19.0 RBAC filter. Multi-tag is fine. */
  categories: string[];
  /** True when the server should ship in the auto-generated starter pack. */
  starter?: boolean;
  /** Human-readable note rendered into the JSON file as a sibling "_note" field for the user. */
  note?: string;
}

export const OFFICIAL_REGISTRY: Record<string, RegistryEntry> = {
  memory: {
    alias: 'memory',
    description: 'Persistent in-process knowledge graph for agent memory across sessions.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    categories: ['pm', 'database'],
    starter: true,
    note: 'No external setup. Stores entities & relations in-memory; restarts wipe state.',
  },

  sqlite: {
    alias: 'sqlite',
    description: 'Read/write access to a local SQLite database file.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite', '--db-path', '${ARG:db_path:./fluxo.db}'],
    categories: ['database'],
    starter: true,
    note: 'Override the db file by editing args[3] (defaults to ./fluxo.db at the workspace root).',
  },

  'brave-search': {
    alias: 'brave-search',
    description: 'Web search via the Brave Search API. Requires BRAVE_API_KEY.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: { BRAVE_API_KEY: '${ENV:BRAVE_API_KEY}' },
    categories: ['web'],
    starter: false,
    note: 'Set BRAVE_API_KEY in your shell or replace the ${ENV:...} placeholder with the literal key.',
  },

  filesystem: {
    alias: 'filesystem',
    description: 'Read-only filesystem access scoped to an allow-list of paths.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '${ARG:root:.}'],
    categories: ['filesystem'],
    starter: false,
    note: 'Replace args[2] with the absolute path you want to expose.',
  },

  github: {
    alias: 'github',
    description: 'GitHub repo, issue, and PR operations. Requires GITHUB_TOKEN.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${ENV:GITHUB_TOKEN}' },
    categories: ['git', 'github', 'pm'],
    starter: false,
    note: 'Set GITHUB_TOKEN with at least repo scope, or paste the literal token in env.',
  },
};

// ─── Public API ─────────────────────────────────────────────────────────────

/** All known aliases, sorted alphabetically. Used by CLI list output and quickPicks. */
export function listRegistry(): RegistryEntry[] {
  return Object.values(OFFICIAL_REGISTRY).sort((a, b) => a.alias.localeCompare(b.alias));
}

/** Lookup by alias (case-insensitive). Returns null if unknown. */
export function getRegistryEntry(alias: string): RegistryEntry | null {
  if (!alias) { return null; }
  const key = alias.trim().toLowerCase();
  return OFFICIAL_REGISTRY[key] ?? null;
}

/**
 * The default starter pack written into a fresh .fluxo/mcp_servers.json the
 * first time the engine boots in a workspace that has never configured MCP.
 * Returns the entries flagged starter:true. This guarantees a useful baseline
 * (memory + sqlite) without forcing the user to read docs.
 */
export function getStarterPack(): RegistryEntry[] {
  return listRegistry().filter(e => e.starter === true);
}

/**
 * Resolve placeholder syntax in a string.
 *   ${ENV:NAME[:default]} → process.env[NAME] ?? default ?? ''
 *   ${ARG:name:default}   → default
 * The ARG syntax is left intentionally as-is when no default is provided so
 * the user notices and edits the JSON before the server runs.
 */
export function resolvePlaceholders(input: string): string {
  return input.replace(/\$\{(ENV|ARG):([A-Za-z_][\w-]*)(?::([^}]*))?\}/g, (match, kind, name, def) => {
    if (kind === 'ENV') {
      const v = process.env[name];
      if (v !== undefined && v !== '') { return v; }
      return def ?? '';
    }
    // ARG: keep the placeholder when no default — signals the user to edit it.
    return def ?? match;
  });
}

```

### 📁 FILE: `src\utils\repoMap.ts`
```typescript
import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';

// ─── RepoMap Generator (v8.12.0 — Semantic Awareness Phase 2: AST Edition) ────
// Produces a compressed semantic map using the TypeScript compiler AST.
// Output is Aider-style: each file on its own header line, exported symbols indented below.
// Agents consume this as a codebase topography atlas — no shell commands needed.

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.fluxo', 'dist', 'out', 'build',
  'coverage', '.vscode', '.nyc_output', '__pycache__', '.next',
  '.nuxt', 'vendor', 'tmp', 'temp', '.turbo', '.cache',
]);

const TARGET_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);
// v8.17.3: extra languages get a regex-based fallback so the panoramic view
// covers polyglot repos. Aider-style: even an approximate symbol list gives
// the agent enough structure to pick the right file before reading it.
const REGEX_EXTS = new Set(['.py', '.go', '.rs', '.java', '.rb', '.cs', '.php', '.kt', '.swift']);
const MAX_REPO_MAP_CHARS = 15_000;
const MAX_TREE_ENTRIES   = 250;       // hard cap on directory tree summary lines
const MAX_TREE_DEPTH     = 6;

// ─── AST Helpers ─────────────────────────────────────────────────────────────

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) { return false; }
  return (ts.getModifiers(node) ?? []).some(m => m.kind === kind);
}

function paramNames(params: ts.NodeArray<ts.ParameterDeclaration>): string {
  if (params.length === 0) { return ''; }
  if (params.length > 4) { return '…'; }
  return params.map(p => {
    const name = ts.isIdentifier(p.name) ? p.name.text : p.name.getText();
    return p.dotDotDotToken ? `...${name}` : name;
  }).join(', ');
}

function retSuffix(node: { type?: ts.TypeNode }, src: ts.SourceFile): string {
  return node.type ? `: ${node.type.getText(src)}` : '';
}

// ─── Per-file Signature Extractor ────────────────────────────────────────────

function extractSignatures(filePath: string): string[] {
  let content: string;
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }

  // Skip minified files — single very long line with semicolons
  const sampleLine = content.slice(0, 500);
  if (sampleLine.length > 300 && sampleLine.indexOf('\n') === -1 && sampleLine.includes(';')) { return []; }

  let src: ts.SourceFile;
  try {
    src = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  } catch { return []; }

  const sigs: string[] = [];

  ts.forEachChild(src, (node) => {

    // ── export [async] [default] function Name(...): ReturnType ───────────────
    if (ts.isFunctionDeclaration(node) && hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
      const name   = node.name?.text ?? '(anonymous)';
      const async_ = hasModifier(node, ts.SyntaxKind.AsyncKeyword) ? 'async ' : '';
      const dflt   = hasModifier(node, ts.SyntaxKind.DefaultKeyword) ? 'default ' : '';
      const ps     = paramNames(node.parameters);
      const rt     = retSuffix(node, src);
      sigs.push(`  export ${dflt}${async_}function ${name}(${ps})${rt}`);
      return;
    }

    // ── export [default] class Name ──────────────────────────────────────────
    if (ts.isClassDeclaration(node) && hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
      const name = node.name?.text ?? '(anonymous)';
      const dflt = hasModifier(node, ts.SyntaxKind.DefaultKeyword) ? 'default ' : '';
      sigs.push(`  export ${dflt}class ${name}`);
      return;
    }

    // ── export interface Name ─────────────────────────────────────────────────
    if (ts.isInterfaceDeclaration(node) && hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
      sigs.push(`  export interface ${node.name.text}`);
      return;
    }

    // ── export type Name ──────────────────────────────────────────────────────
    if (ts.isTypeAliasDeclaration(node) && hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
      sigs.push(`  export type ${node.name.text}`);
      return;
    }

    // ── export enum Name ─────────────────────────────────────────────────────
    if (ts.isEnumDeclaration(node) && hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
      sigs.push(`  export enum ${node.name.text}`);
      return;
    }

    // ── export const/let/var Name = [arrow | value] ──────────────────────────
    if (ts.isVariableStatement(node) && hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
      const flags = node.declarationList.flags;
      const kind  = flags & ts.NodeFlags.Const ? 'const' : flags & ts.NodeFlags.Let ? 'let' : 'var';
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) { continue; }
        const name = decl.name.text;
        const init = decl.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          const ps = paramNames(init.parameters);
          const rt = init.type ? ` => ${init.type.getText(src)}` : ' => …';
          sigs.push(`  ${kind} ${name} = (${ps})${rt}`);
        } else {
          const typeAnn = decl.type ? `: ${decl.type.getText(src)}` : '';
          sigs.push(`  export ${kind} ${name}${typeAnn}`);
        }
      }
      return;
    }

    // ── export default SomeExpression ─────────────────────────────────────────
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      const expr = node.expression.getText(src);
      if (expr.length < 60) {
        sigs.push(`  export default ${expr}`);
      }
    }
  });

  return sigs;
}

// ─── Regex Extractors (v8.17.3 — Polyglot Fallback) ─────────────────────────
// Aider-style: when a file is not TypeScript/JavaScript we don't have an AST,
// but we can still surface top-level symbol names so the agent knows where to
// look BEFORE it reads the whole file. Regexes are intentionally permissive —
// false positives are far better than blind navigation.

const REGEX_BY_EXT: Record<string, RegExp[]> = {
  '.py':    [/^\s*(?:async\s+)?def\s+([a-zA-Z_][\w]*)\s*\(/gm,    /^\s*class\s+([a-zA-Z_][\w]*)\b/gm],
  '.go':    [/^func\s+(?:\([^)]*\)\s*)?([A-Z][\w]*)\s*\(/gm,       /^type\s+([A-Z][\w]*)\b/gm],
  '.rs':    [/^\s*pub\s+(?:async\s+)?fn\s+([a-zA-Z_][\w]*)/gm,     /^\s*pub\s+(?:struct|enum|trait)\s+([A-Z][\w]*)/gm],
  '.java':  [/^\s*public\s+(?:static\s+)?[\w<>\[\],\s]+\s+([a-zA-Z_][\w]*)\s*\(/gm, /^\s*public\s+(?:abstract\s+|final\s+)?(?:class|interface|enum)\s+([A-Z][\w]*)/gm],
  '.rb':    [/^\s*def\s+([a-zA-Z_][\w]*[!?=]?)/gm,                 /^\s*class\s+([A-Z][\w]*)/gm,                /^\s*module\s+([A-Z][\w]*)/gm],
  '.cs':    [/^\s*public\s+(?:static\s+|async\s+|virtual\s+|override\s+)*[\w<>\[\],\s?]+\s+([A-Z][\w]*)\s*\(/gm, /^\s*public\s+(?:abstract\s+|sealed\s+)?(?:class|interface|record|struct|enum)\s+([A-Z][\w]*)/gm],
  '.php':   [/^\s*(?:public|protected|private)?\s*function\s+([a-zA-Z_][\w]*)\s*\(/gm, /^\s*(?:abstract\s+|final\s+)?class\s+([A-Z][\w]*)/gm],
  '.kt':    [/^\s*(?:public\s+|internal\s+)?fun\s+([a-zA-Z_][\w]*)\s*\(/gm, /^\s*(?:public\s+|internal\s+)?(?:open\s+|sealed\s+|data\s+|abstract\s+)?class\s+([A-Z][\w]*)/gm],
  '.swift': [/^\s*(?:public\s+|internal\s+|open\s+)?func\s+([a-zA-Z_][\w]*)/gm, /^\s*(?:public\s+|internal\s+|open\s+)?(?:class|struct|protocol|enum|actor)\s+([A-Z][\w]*)/gm],
};

function extractSignaturesRegex(filePath: string, ext: string): string[] {
  const patterns = REGEX_BY_EXT[ext];
  if (!patterns) { return []; }
  let content: string;
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }
  if (content.length > 200_000) { return []; } // skip huge files

  const sigs = new Set<string>();
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(content)) !== null && sigs.size < 40) {
      sigs.add(`  ${m[0].trim()}`);
    }
  }
  return Array.from(sigs);
}

// ─── Directory Walker ─────────────────────────────────────────────────────────

interface FileEntry { relPath: string; signatures: string[]; }

function scanDir(dirPath: string, workspacePath: string, blocks: string[], tree: string[], depth: number): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { return; }

  // Stable order so the tree summary doesn't shuffle between calls
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) { return a.isDirectory() ? -1 : 1; }
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) { continue; }
    const fullPath = path.join(dirPath, entry.name);
    const relPath  = path.relative(workspacePath, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (tree.length < MAX_TREE_ENTRIES && depth <= MAX_TREE_DEPTH) {
        tree.push(`${'  '.repeat(depth)}${entry.name}/`);
      }
      scanDir(fullPath, workspacePath, blocks, tree, depth + 1);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      const isTarget = TARGET_EXTS.has(ext);
      const isRegex  = REGEX_EXTS.has(ext);
      if (!isTarget && !isRegex) { continue; }
      try {
        const sigs = isTarget ? extractSignatures(fullPath) : extractSignaturesRegex(fullPath, ext);
        if (tree.length < MAX_TREE_ENTRIES && depth <= MAX_TREE_DEPTH) {
          const tag = sigs.length > 0 ? ` (${sigs.length})` : '';
          tree.push(`${'  '.repeat(depth)}${entry.name}${tag}`);
        }
        if (sigs.length > 0) {
          blocks.push(`${relPath}:\n${sigs.join('\n')}`);
        } else {
          blocks.push(relPath);
        }
      } catch { /* skip unreadable entries silently */ }
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function buildRepoMap(workspacePath: string): string {
  if (!workspacePath) { return ''; }
  try {
    const blocks: string[] = [];
    const tree: string[]   = [];
    scanDir(workspacePath, workspacePath, blocks, tree, 0);
    if (blocks.length === 0 && tree.length === 0) { return ''; }

    // v8.17.3: Aider-style panoramic header — directory tree above the symbol
    // detail blocks. Agents reading just the first N chars still get a
    // navigable map of the whole codebase.
    const header = tree.length > 0
      ? `── DIRECTORY TREE (depth ≤ ${MAX_TREE_DEPTH}, parens = symbol count) ──\n${tree.join('\n')}\n\n── FILE SYMBOLS ──\n`
      : '';

    let result = header + blocks.join('\n');

    if (result.length > MAX_REPO_MAP_CHARS) {
      result = result.substring(0, MAX_REPO_MAP_CHARS) +
        '\n[repo_map truncated — showing partial structure]';
    }

    return result;
  } catch {
    return '';
  }
}

```

### 📁 FILE: `src\utils\syntaxValidator.ts`
```typescript
import * as ts from 'typescript';
import * as path from 'path';

// ─── AST Syntax Validator (v8.14.0 — Syntax Shield) ──────────────────────────
// Validates TS/JS/TSX/JSX content in-memory using the TypeScript compiler.
// No real filesystem access — uses a virtual CompilerHost.
// Returns immediately (ok: true) for non-JS/TS file types.

const CHECKABLE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);

export interface SyntaxCheckResult {
  ok: boolean;
  errors: string;
}

export function checkSyntax(filePath: string, content: string): SyntaxCheckResult {
  const ext = path.extname(filePath).toLowerCase();
  if (!CHECKABLE_EXTS.has(ext)) { return { ok: true, errors: '' }; }

  // Virtual path avoids Windows normalization issues and real-FS lookups.
  // The extension is preserved so the compiler applies correct JSX rules.
  const virtualPath = `__fluxo_virtual__${ext}`;

  const compilerHost: ts.CompilerHost = {
    getSourceFile: (name) => {
      if (name === virtualPath) {
        return ts.createSourceFile(virtualPath, content, ts.ScriptTarget.Latest, true);
      }
      return undefined;
    },
    writeFile: () => {},
    getDefaultLibFileName: () => 'lib.d.ts',
    useCaseSensitiveFileNames: () => false,
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => '',
    getNewLine: () => '\n',
    fileExists: (name) => name === virtualPath,
    readFile: () => '',
    directoryExists: () => false,
    getDirectories: () => [],
  };

  try {
    const program = ts.createProgram(
      [virtualPath],
      {
        noResolve: true,
        target: ts.ScriptTarget.Latest,
        allowJs: true,
        jsx: ts.JsxEmit.React,
        noLib: true,
      },
      compilerHost
    );
    const sourceFile = program.getSourceFile(virtualPath);
    if (!sourceFile) { return { ok: true, errors: '' }; }

    const diagnostics = program.getSyntacticDiagnostics(sourceFile);
    if (diagnostics.length === 0) { return { ok: true, errors: '' }; }

    const errors = [...diagnostics]
      .slice(0, 5) // cap output — avoid wall-of-text on catastrophic failures
      .map(d => {
        const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
        if (d.file && d.start !== undefined) {
          const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
          return `  Line ${line + 1}, Col ${character + 1}: ${msg}`;
        }
        return `  ${msg}`;
      })
      .join('\n');

    return { ok: false, errors };
  } catch {
    // Validator crash must never block a write — fail open
    return { ok: true, errors: '' };
  }
}

```

### 📁 FILE: `tsconfig.json`
```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2020",
    "outDir": "./out",
    "rootDir": "./src",
    "sourceMap": true,
    "strict": true,
    "lib": ["ES2020"],
    "types": ["node"],
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "out", "media"]
}

```

