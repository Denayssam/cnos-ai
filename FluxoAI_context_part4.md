# 📦 APP MANIFEST
* **App Name:** fluxo-ai
* **Version:** 8.24.0
* **Stack:** Vanilla JS
* **Part:** 4
* **Generated At:** 2026-05-03T16:33:59.101Z

---

### 📁 FILE: `src\tools\ExitWorktreeTool\index.ts`
```typescript
// Powered by Fluxo Tech AI — https://fluxotechai.com
import * as fs   from 'fs';
import * as path from 'path';
import * as cp   from 'child_process';
import { NativeTool, ToolResult } from '../shared';
import { acquireMergeMutex } from '../../utils/gitSafety';
import { appendTask, getCurrentInProgressTask } from '../../utils/dagController';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'exit_worktree',
    description: `Finalize the active git worktree created by enter_worktree.

action='merge'  → Commits all changes in the worktree and merges them into the main branch.
                  Use this when npm run build passes and the work is verified complete.
action='discard'→ Forcefully deletes the worktree branch without touching main.
                  Use this when the worktree is broken or the task is aborted.
                  The user's production code on main is NEVER affected by a discard.`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: "'merge' to integrate changes into main, 'discard' to delete the worktree cleanly.",
        },
        commit_message: {
          type: 'string',
          description: "Commit message summarising the changes. Required when action='merge'.",
        },
      },
      required: ['action'],
    },
  },
};

const STATE_RELATIVE = path.join('.fluxo', 'active_worktree.json');

// ─── Canonical Repo Root Resolver (v8.18.1) ─────────────────────────────────
// In Phase 4 dogfooding, dagController.appendTask returned null because the
// resolved root was the worktree directory (which has no .fluxo/dag_state.json).
// `git rev-parse --show-toplevel` returns the canonical absolute path of the
// repository root from any subdirectory, including worktrees. We use it to
// guarantee that DAG operations (.fluxo/dag_state.json) always target the
// real project root, never a sandboxed worktree.
function resolveRepoRoot(cwdPath: string): string {
  try {
    const out = cp.execSync('git rev-parse --show-toplevel', { cwd: cwdPath, stdio: ['pipe', 'pipe', 'ignore'] })
      .toString().trim();
    return out || cwdPath;
  } catch {
    return cwdPath;
  }
}
// ───────────────────────────────────────────────────────────────────────────

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const action = String(args.action || '').toLowerCase();
  if (action !== 'merge' && action !== 'discard') {
    return { success: false, output: "ExitWorktree: 'action' must be 'merge' or 'discard'." };
  }

  // ── Load state ────────────────────────────────────────────────────────────
  const stateFilePath = path.join(workspacePath, STATE_RELATIVE);
  if (!fs.existsSync(stateFilePath)) {
    return {
      success: false,
      output: 'ExitWorktree: No active worktree found. Call enter_worktree first.',
    };
  }

  let state: { branchName: string; worktreePath: string };
  try {
    state = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8'));
  } catch {
    return {
      success: false,
      output: 'ExitWorktree: Corrupted worktree state. Run "git worktree list" manually to inspect.',
    };
  }

  const { branchName, worktreePath } = state;

  // ── DISCARD ────────────────────────────────────────────────────────────────
  if (action === 'discard') {
    try {
      cp.execSync(`git worktree remove --force "${worktreePath}"`, { cwd: workspacePath, stdio: 'pipe' });
    } catch { /* worktree dir may already be missing — continue to prune */ }
    try { cp.execSync('git worktree prune',          { cwd: workspacePath, stdio: 'pipe' }); } catch { /* non-fatal */ }
    try { cp.execSync(`git branch -D "${branchName}"`, { cwd: workspacePath, stdio: 'pipe' }); } catch { /* non-fatal */ }
    try { fs.unlinkSync(stateFilePath); } catch { /* non-fatal */ }

    return {
      success: true,
      output:
        `🗑️ WORKTREE DISCARDED — Sandbox deleted cleanly.\n\n` +
        `Branch '${branchName}' and its worktree have been removed.\n` +
        `The main workspace is UNTOUCHED — production code is safe.`,
    };
  }

  // ── MERGE ─────────────────────────────────────────────────────────────────
  const commitMsg = String(args.commit_message || `Fluxo worktree: ${branchName}`)
    .replace(/"/g, "'"); // sanitise for shell

  // Step 1 — stage & commit inside the worktree
  try {
    cp.execSync('git add -A', { cwd: worktreePath, stdio: 'pipe' });
    const dirty = cp.execSync('git status --porcelain', { cwd: worktreePath, stdio: 'pipe' }).toString().trim();
    if (dirty) {
      cp.execSync(`git commit -m "${commitMsg}"`, { cwd: worktreePath, stdio: 'pipe' });
    }
  } catch (e: any) {
    const stderr = (e.stderr?.toString() || e.message || '').slice(0, 400);
    return {
      success: false,
      output:
        `ExitWorktree (merge): Failed to commit changes in worktree:\n${stderr}\n\n` +
        `Fix the issue inside the worktree, then retry. Or call exit_worktree with action='discard' to abort.`,
    };
  }

  // Step 2 — merge worktree branch into the main workspace's current branch
  // v8.18.0 (Phase 4): Sequential Merge Mutex + DAG Conflict Auto-Resolution.
  // The merge attempt now runs under a process-wide file lock (.fluxo/merge.lock)
  // so concurrent agents serialize at the git controller. On conflict failure
  // the engine still auto-aborts and discards (v8.17.4), but instead of just
  // telling the agent "task FAILED, manager reschedule", it dynamically injects
  // a HIGH PRIORITY conflict-resolution task into the live DAG with the
  // captured conflict context — the dispatcher will pick it up on the next
  // tick.
  const mutex = acquireMergeMutex(workspacePath, `worktree:${branchName}`);
  if (!mutex) {
    return {
      success: false,
      output:
        `ExitWorktree (merge): could not acquire .fluxo/merge.lock within 30s — ` +
        `another agent is currently merging. Wait for the in-flight merge to complete, ` +
        `then retry exit_worktree(action='merge').`,
    };
  }

  try {
    cp.execSync(
      `git merge "${branchName}" --no-ff -m "Merge worktree '${branchName}': ${commitMsg}"`,
      { cwd: workspacePath, stdio: 'pipe' }
    );
  } catch (e: any) {
    const stderr = (e.stderr?.toString() || e.message || '').slice(0, 400);

    // (a) Capture conflict context BEFORE we abort. Once the merge is aborted
    // the conflict markers vanish from main — we need the file list and a
    // snippet of the marker block while the workspace is still in MERGING.
    let conflictFiles: string[] = [];
    try {
      conflictFiles = cp.execSync('git diff --name-only --diff-filter=U', { cwd: workspacePath, stdio: 'pipe' })
        .toString().trim().split(/\r?\n/).filter(Boolean);
    } catch { /* no unmerged files reported — fall back to empty list */ }

    const conflictSnippets: string[] = [];
    for (const rel of conflictFiles.slice(0, 6)) {
      try {
        const raw = fs.readFileSync(path.join(workspacePath, rel), 'utf-8');
        const start = raw.indexOf('<<<<<<<');
        if (start >= 0) {
          const slice = raw.slice(start, start + 1500);
          conflictSnippets.push(`---\n**${rel}** (first conflict block):\n\`\`\`\n${slice}\n\`\`\``);
        }
      } catch { /* unreadable file — skip */ }
    }

    // (b) Abort the in-flight merge so the workspace is no longer in MERGING state.
    try { cp.execSync('git merge --abort',                  { cwd: workspacePath, stdio: 'pipe' }); } catch { /* nothing to abort */ }
    // (c) Auto-discard the worktree — same operations the action='discard' branch runs.
    try { cp.execSync(`git worktree remove --force "${worktreePath}"`, { cwd: workspacePath, stdio: 'pipe' }); } catch { /* worktree dir may already be gone */ }
    try { cp.execSync('git worktree prune',                  { cwd: workspacePath, stdio: 'pipe' }); } catch { /* non-fatal */ }
    try { cp.execSync(`git branch -D "${branchName}"`,       { cwd: workspacePath, stdio: 'pipe' }); } catch { /* non-fatal */ }
    try { fs.unlinkSync(stateFilePath); } catch { /* non-fatal */ }

    // (d) Release mutex BEFORE we touch the DAG — keep the critical section tight.
    mutex.release();

    // (e) Dynamically inject a HIGH PRIORITY conflict-resolution task. The
    // dispatcher (Phase 2) will pick it up on the next tick once its parent
    // task has reached a terminal status (the dispatcher's lifecycle hook
    // marks the failed task FAILED right after this tool returns).
    // v8.18.1 — resolve the canonical repo root for DAG operations. In Phase 4
    // dogfooding, appendTask returned null because the path passed to it
    // resolved to a directory without .fluxo/dag_state.json (the worktree
    // sandbox or a relocated cwd). git rev-parse --show-toplevel always
    // returns the real repo root from anywhere inside the worktree tree.
    const repoRoot   = resolveRepoRoot(workspacePath);
    const failedTask = getCurrentInProgressTask(repoRoot);
    const fileList   = conflictFiles.length > 0 ? conflictFiles.join(', ') : 'unknown files';
    // depends_on is intentionally EMPTY so the dispatcher picks the conflict
    // task up on the next tick. Listing the failed parent here would block
    // the task forever — getReadyTasks only unblocks when parents are
    // COMPLETED, and the parent will be marked FAILED by the dispatcher's
    // lifecycle hook moments after this tool returns. The causal/audit link
    // to the parent is preserved verbatim in the description below.
    const dagInjected = appendTask(repoRoot, {
      idPrefix: 'conflict',
      agent_type: '@coder',
      depends_on: [],
      description:
        `URGENT: Resolve Git Merge Conflict in ${fileList}\n\n` +
        `[PRIORITY: HIGH — auto-injected by ExitWorktreeTool v8.18.0]\n\n` +
        (failedTask
          ? `Parent task: ${failedTask.id} (${failedTask.description}) — its worktree branch '${branchName}' could not be merged into main due to codebase collisions. The engine has already aborted the merge and discarded the broken worktree. You are now starting from a clean main.\n\n`
          : `A worktree merge for branch '${branchName}' failed due to codebase collisions. The engine has already aborted the merge and discarded the broken worktree. You are now starting from a clean main.\n\n`) +
        `RESOLUTION PROTOCOL — DO NOT skip steps:\n` +
        `1. Call get_repo_map first to regain spatial awareness of the workspace (the panoramic shield will block other tools until you do).\n` +
        `2. For EACH file listed above, call read_file to see its current state on main.\n` +
        `3. Reconstruct the changes from the parent task using the conflict snippets captured below — they show exactly which lines collided and what the parent task tried to introduce. The HEAD side (above =======) is what main has now; the branch side (below =======) is what the parent task wanted.\n` +
        `4. Mathematically resolve the logic: keep the side whose semantics are correct, or merge both if they are independent (different functions, different keys, etc.). Never just delete a side.\n` +
        `5. Apply each resolution as a unified-diff-precise search_and_replace (see UDIFF rule v8.17.3). Read each file before editing, copy verbatim.\n` +
        `6. Run npm run build (or the project's build command) to verify the resolution compiles.\n` +
        `7. End your turn cleanly — do NOT enter a worktree for this task; the resolution applies directly on main.\n\n` +
        (conflictSnippets.length > 0
          ? `── CAPTURED CONFLICT SNIPPETS (pre-abort) ──\n${conflictSnippets.join('\n')}\n`
          : `── No conflict snippets could be captured — inspect the files in the list directly. ──\n`) +
        `\n── git stderr (first 400 chars) ──\n${stderr}\n`,
    });

    const queuedNote = dagInjected
      ? ` New task '${dagInjected.id}' was queued in .fluxo/dag_state.json${failedTask ? ` (depends on ${failedTask.id})` : ''}.`
      : ' (DAG was not active — no follow-up task was queued; surface the conflict to the @manager directly.)';

    return {
      success: false,
      output:
        `[MERGE CONFLICT] A collision occurred. A priority conflict-resolution task ` +
        `has been queued in the DAG. Exit your turn immediately.${queuedNote}\n\n` +
        `Files in conflict: ${fileList}\n\n` +
        `Underlying git output (first 400 chars):\n${stderr}`,
    };
  } finally {
    // Belt-and-suspenders: if the merge succeeded we drop the mutex here too.
    // The catch path above already released it before injecting the DAG task.
    try { mutex.release(); } catch { /* already released */ }
  }

  // Step 3 — cleanup worktree & branch
  try { cp.execSync(`git worktree remove "${worktreePath}"`,  { cwd: workspacePath, stdio: 'pipe' }); } catch { /* non-fatal */ }
  try { cp.execSync('git worktree prune',                      { cwd: workspacePath, stdio: 'pipe' }); } catch { /* non-fatal */ }
  try { cp.execSync(`git branch -d "${branchName}"`,           { cwd: workspacePath, stdio: 'pipe' }); } catch { /* non-fatal */ }
  try { fs.unlinkSync(stateFilePath); } catch { /* non-fatal */ }

  return {
    success: true,
    output:
      `✅ WORKTREE MERGED — Changes integrated into main.\n\n` +
      `Branch '${branchName}' merged and cleaned up.\n` +
      `All changes are now live in the workspace. Run npm run build to confirm.`,
  };
}

```

### 📁 FILE: `src\tools\FetchDocumentationTool\index.ts`
```typescript
// Powered by Fluxo Tech AI — https://fluxotechai.com
import { NativeTool, ToolResult } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'fetch_documentation',
    description:
      'Fetches the content of an external URL (e.g. a GitHub README, npm package page, or official documentation) ' +
      'and returns it as clean plain text. Use this BEFORE writing any code that depends on an external library, ' +
      'to read the real, up-to-date API instead of relying on training memory. ' +
      'Ideal for: GitHub raw README files, npm package pages, official docs sites. ' +
      'The response is automatically cleaned (scripts, nav, and styles removed) and truncated to 20,000 characters.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'The full URL to fetch. Prefer raw content URLs when available ' +
            '(e.g. https://raw.githubusercontent.com/user/repo/main/README.md). ' +
            'For npm packages use https://www.npmjs.com/package/<name>.',
        },
      },
      required: ['url'],
    },
  },
};

/**
 * Sync stub — this tool requires an async HTTP fetch.
 * The actual execution is handled in agentEngine.ts via the fetchDocumentationCallback path.
 * This stub is only reached if the engine falls through to executeTool() unexpectedly.
 */
export function execute(_args: Record<string, any>, _workspacePath: string): ToolResult {
  return {
    success: false,
    output:
      '[SYSTEM ERROR] fetch_documentation requires async execution. ' +
      'This stub should never be called directly — the engine routes it via fetchDocumentationCallback.',
  };
}

```

### 📁 FILE: `src\tools\FileEditTool\index.ts`
```typescript
import * as fs from 'fs';
import { NativeTool, ToolResult, safePath } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'edit_file',
    description: 'Surgically find and replace a specific string in a file. CRITICAL RULE: You MUST provide BOTH old_string AND new_string. NEVER omit old_string. If inserting new code, old_string must be the exact existing text (e.g., an import statement) that you will use as an anchor to replace with the anchor + the new code. PREFER MICRO-EDITS: If the change is complex, do multiple small edit_file calls instead of one large block to avoid syntax errors. WORKFLOW: (1) read_file to see exact text. (2) Copy the exact old_string from the output. (3) Provide new_string. Never use write_file on existing files.',
    parameters: {
      type: 'object',
      properties: {
        path:       { type: 'string', description: 'File path relative to workspace root.' },
        old_string: { type: 'string', description: 'REQUIRED — plain string only. The exact text to find. Must match the file exactly — copy from read_file output. NEVER omit. NEVER pass an object.' },
        new_string: { type: 'string', description: 'REQUIRED — plain string only. The replacement text. Use empty string to delete the matched block. NEVER omit. NEVER pass an object.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const fp = safePath(workspacePath, args.path);
  if (!fs.existsSync(fp)) {
    return { success: false, output: `File not found: ${args.path}. Use list_dir to verify the path.` };
  }

  // Alias resolution — accept old_value/new_value but correct the model
  const aliasWarnings: string[] = [];
  const rawOld = args.old_string ?? args.old_value;
  const rawNew = args.new_string ?? args.new_value;

  if (args.old_string === undefined && typeof args.old_value === 'string') {
    aliasWarnings.push(`⚠ ALIAS USADO: Enviaste 'old_value' en lugar de 'old_string'. Por favor usa siempre 'old_string' en el futuro para mayor precisión.`);
  }
  if (args.new_string === undefined && typeof args.new_value === 'string') {
    aliasWarnings.push(`⚠ ALIAS USADO: Enviaste 'new_value' en lugar de 'new_string'. Por favor usa siempre 'new_string' en el futuro para mayor precisión.`);
  }

  if (typeof rawOld !== 'string' || !rawOld) {
    return { success: false, output: 'CRITICAL ERROR: "old_string" is required and must be a plain string. Call read_file first to get the exact text to replace. NEVER pass an object or omit this field.' };
  }
  if (typeof rawNew !== 'string') {
    return { success: false, output: 'CRITICAL ERROR: "new_string" is required and must be a plain string. Pass an empty string "" to delete, or the replacement text. NEVER pass an object or omit this field.' };
  }

  const oldString = rawOld;
  const newString = rawNew;

  const original = fs.readFileSync(fp, 'utf-8');
  if (!original.includes(oldString)) {
    const preview = oldString.slice(0, 120).replace(/\r?\n/g, '↵');
    return {
      success: false,
      output: [
        `FIND FAILED — old_string not found in ${args.path}.`,
        `Searched for: "${preview}"`,
        `Call read_file first to get the exact text. Do NOT guess whitespace or indentation.`,
      ].join('\n'),
    };
  }

  const updated = original.replace(oldString, newString);

  if (updated.trim() === '') {
    return { success: false, output: 'SAFETY ABORT: replacement would produce an empty file. Check your old_string.' };
  }

  fs.writeFileSync(fp, updated, 'utf-8');
  const preview = oldString.slice(0, 60).replace(/\r?\n/g, '↵');
  const correctionNote = aliasWarnings.length > 0 ? '\n\n' + aliasWarnings.join('\n') : '';
  return {
    success: true,
    output: `edit_file: ${args.path} — replaced "${preview}..."\n\nEDICION EXITOSA — Si la tarea no esta completa, llama la SIGUIENTE herramienta ahora.${correctionNote}`,
  };
}

```

### 📁 FILE: `src\tools\FileReadTool\index.ts`
```typescript
import * as fs from 'fs';
import { NativeTool, ToolResult, safePath, rejectIfAbsolutePath } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read the full contents of a file. Each line is prefixed with its 1-based line number. Use this before edit_file to see the exact text to replace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file relative to the workspace root.' },
      },
      required: ['path'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  // v8.18.1 — block hallucinated absolute paths (e.g. C:/Users/erick/source/repos/...)
  // before they hit safePath / fs. The agent must use repo-relative paths.
  const absShield = rejectIfAbsolutePath(args.path);
  if (absShield) { return absShield; }

  const fp = safePath(workspacePath, args.path);
  if (!fs.existsSync(fp)) {
    const parentDir = (args.path as string || '.').split('/').slice(0, -1).join('/') || '.';
    return {
      success: false,
      output: [
        `FILE NOT FOUND: "${args.path}"`,
        ``,
        `MANDATORY NEXT STEP: Call list_dir BEFORE any further read_file attempts.`,
        `  Suggested target: list_dir on "${parentDir}"`,
        `DO NOT retry read_file on guessed paths. Discover the actual structure first.`,
      ].join('\n'),
    };
  }

  const buffer = fs.readFileSync(fp);
  let content: string;

  // Detect UTF-16LE (BOM: FF FE) or generic binary with null bytes
  if (buffer.length > 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    content = buffer.toString('utf16le');
  } else if (buffer.indexOf(0) !== -1) {
    // Strip null bytes from other encodings to avoid API errors
    content = buffer.toString('utf-8').replace(/\0/g, '');
  } else {
    content = buffer.toString('utf-8');
  }

  const truncated = content.length > 60_000
    ? content.slice(0, 60_000) + '\n...[truncated at 60KB]'
    : content;
  const numbered = truncated.split('\n').map((line, i) => `${i + 1} | ${line}`).join('\n');
  return { success: true, output: numbered };
}

```

### 📁 FILE: `src\tools\FileWriteTool\index.ts`
```typescript
import * as fs from 'fs';
import * as path from 'path';
import { NativeTool, ToolResult, safePath } from '../shared';
import { FileLockManager } from '../../utils/lockfile';
import { checkSyntax } from '../../utils/syntaxValidator';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Create a new file or fully overwrite an existing markdown/JSON/config artifact. REQUIRED for: new source files, .md documents (plans, reports, docs), JSON config, and any file inside .fluxo/. The planner MUST use this tool to produce .fluxo/IMPLEMENTATION_PLAN.md. For modifying existing source code (.ts/.tsx/.js/.jsx/.py), prefer edit_file or replace_symbol to avoid overwriting unrelated code.',
    parameters: {
      type: 'object',
      properties: {
        path:     { type: 'string', description: 'File path relative to workspace root.' },
        content:  { type: 'string', description: 'Complete file content to write.' },
        agent_id: { type: 'string', description: 'Unique identifier of the calling agent (e.g. "coder-1", "designer-2"). Used by the File Lock Manager to track ownership. Required when running in parallel orchestration mode.' },
        healing_mode: { type: 'boolean', description: 'Set to true ONLY when intentionally writing a file that may have syntax issues, e.g., a partial template or already-broken file being repaired. Bypasses AST syntax validation.' },
      },
      required: ['path', 'content'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  if (typeof args.content !== 'string' || args.content.trim() === '') {
    return { success: false, output: 'CRITICAL ERROR: "content" is missing or empty.' };
  }
  const fp = safePath(workspacePath, args.path);
  const agentId = typeof args.agent_id === 'string' ? args.agent_id : 'agent';

  // ── AST Syntax Validation (v8.14.0 — Syntax Shield) ─────────────────────────
  // Runs before lock acquisition — no point locking if the content is broken.
  // Skipped for non-TS/JS extensions (markdown, JSON, CSS, etc.) automatically.
  if (!args.healing_mode) {
    const _syntaxCheck = checkSyntax(fp, args.content);
    if (!_syntaxCheck.ok) {
      return {
        success: false,
        output:
          `[SYNTAX ERROR DETECTED] The proposed change breaks the file syntax. Write aborted.\n` +
          `Error details:\n${_syntaxCheck.errors}\n\n` +
          `You MUST review your code block and fix the syntax before retrying.`,
      };
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  if (!FileLockManager.acquireLock(fp, agentId)) {
    return {
      success: false,
      output: `SYSTEM LOCK: El archivo ${args.path} está siendo editado actualmente por otro agente de tu equipo. Tienes prohibido forzar la edición. Por favor, usa la herramienta sleep por 5 segundos o trabaja en otro archivo mientras se libera el cerrojo.`,
    };
  }
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, args.content, 'utf-8');
    const size = Buffer.byteLength(args.content, 'utf-8');
    return { success: true, output: `Written: ${args.path} (${size} bytes)` };
  } finally {
    FileLockManager.releaseLock(fp, agentId);
  }
}

```

### 📁 FILE: `src\tools\GetCodeStructureTool\index.ts`
```typescript
import { NativeTool, ToolResult, rejectIfAbsolutePath } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'get_code_structure',
    description:
      'Uses VS Code\'s Language Server Protocol to extract all symbols (functions, classes, variables, methods) from a file, with their exact start/end line numbers. ' +
      'Use this BEFORE reading or editing a large file to get a precise structural map — so you know exactly which line range to target without reading the entire file.',
    parameters: {
      type: 'object',
      properties: {
        absolute_path: {
          type: 'string',
          description:
            'Path to the file relative to the workspace root (e.g., src/components/App.tsx). ' +
            'v8.18.1: despite the legacy parameter name, drive-letter and root-slash absolute ' +
            'paths are blocked. Pass the repository-relative path — the engine resolves it ' +
            'against the active workspace.',
        },
      },
      required: ['absolute_path'],
    },
  },
};

// Actual execution is handled by the getCodeStructureCallback in extension.ts (requires VS Code API).
// v8.18.1: defensive absolute-path shield mirrors the engine's intercept guard so the rejection
// is uniform whether the tool runs through the executeTool fallback or the engine's special branch.
export function execute(args: Record<string, any>, _workspacePath: string): ToolResult {
  const absShield = rejectIfAbsolutePath(args.absolute_path);
  if (absShield) { return absShield; }
  return {
    success: false,
    output: '[SYSTEM]: get_code_structure requires the VS Code extension host. This tool cannot run outside of VS Code.',
  };
}

```

### 📁 FILE: `src\tools\GetRepoMapTool\index.ts`
```typescript
import { buildRepoMap } from '../../utils/repoMap';
import { NativeTool, ToolResult } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'get_repo_map',
    description:
      'Generate a panoramic, Aider-style map of the active workspace (or worktree, when one is open). ' +
      'Output is two-tiered: (1) a directory TREE up to depth 6 with a per-file symbol count in parentheses, ' +
      'followed by (2) per-file symbol blocks — TS/JS exports via TypeScript AST, plus regex-extracted ' +
      'top-level functions/classes for Python, Go, Rust, Java, Ruby, C#, PHP, Kotlin, Swift. ' +
      'MANDATORY USE: call this BEFORE editing any file you have not already read in this session. ' +
      'Skipping it leads to MATCH ERRORS, ghost imports, and panicked grep loops. ' +
      'After calling, navigate directly with read_file (verbatim) or replace_symbol (AST-bounded).',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
};

export function execute(_args: Record<string, any>, workspacePath: string): ToolResult {
  const map = buildRepoMap(workspacePath);
  if (!map) {
    return {
      success: false,
      output: 'No mappable source files found. Try list_dir(".") to explore the workspace structure manually.',
    };
  }
  return { success: true, output: `REPO MAP:\n\n${map}` };
}

```

### 📁 FILE: `src\tools\GlobTool\index.ts`
```typescript
import * as fs from 'fs';
import * as path from 'path';
import { NativeTool, ToolResult } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'glob',
    description: `Find files in the workspace matching a glob pattern. Use this INSTEAD OF 'ls', 'find', or 'dir' in run_command.
Patterns: ** = any depth, * = any chars (no slash), ? = single char.
Examples:
  "src/**/*.tsx"     → all TSX files under src/
  "**/*.test.ts"     → all test files
  "components/*.jsx" → JSX files in one folder
  "**/*.{ts,tsx}"    → TS and TSX files anywhere`,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern relative to workspace root. Use forward slashes.' },
        cwd:     { type: 'string', description: 'Optional subdirectory to search within (relative to workspace root). Defaults to workspace root.' },
      },
      required: ['pattern'],
    },
  },
};

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '__pycache__', '.fluxo']);

function globToRegex(pattern: string): RegExp {
  let r = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      r += '.*';
      i++;
      if (pattern[i + 1] === '/') { i++; } // consume the slash after **
    } else if (c === '*') {
      r += '[^/]*';
    } else if (c === '?') {
      r += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      r += '\\' + c;
    } else {
      r += c;
    }
  }
  return new RegExp(`^${r}$`, 'i'); // case-insensitive for Windows compat
}

function walkAndMatch(dir: string, root: string, regex: RegExp, results: string[], depth: number): void {
  if (depth > 12 || results.length >= 300) { return; }
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) { continue; }
    const full = path.join(dir, entry.name);
    const rel  = path.relative(root, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      walkAndMatch(full, root, regex, results, depth + 1);
    } else if (regex.test(rel)) {
      results.push(rel);
    }
  }
}

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const pattern = String(args.pattern || '').trim();
  if (!pattern) {
    return { success: false, output: 'CRITICAL ERROR: "pattern" is required. Example: "src/**/*.tsx".' };
  }

  let searchRoot = workspacePath;
  if (typeof args.cwd === 'string' && args.cwd.trim()) {
    searchRoot = path.join(workspacePath, args.cwd.trim());
    if (!fs.existsSync(searchRoot)) {
      return { success: false, output: `Directory not found: "${args.cwd}". Use list_dir('.') to verify the workspace structure.` };
    }
  }

  let regex: RegExp;
  try { regex = globToRegex(pattern); }
  catch { return { success: false, output: `Invalid glob pattern: "${pattern}".` }; }

  const results: string[] = [];
  walkAndMatch(searchRoot, workspacePath, regex, results, 0);

  if (results.length === 0) {
    return {
      success: false,
      output: `No files matched "${pattern}". Try a broader pattern (e.g. "**/*.tsx") or verify the directory with list_dir('.').`,
    };
  }

  const truncated = results.length >= 300;
  return {
    success: true,
    output: `glob("${pattern}"): ${results.length} file(s) found${truncated ? ' — first 300 shown' : ''}:\n\n${(truncated ? results.slice(0, 300) : results).join('\n')}`,
  };
}

```

### 📁 FILE: `src\tools\GrepTool\index.ts`
```typescript
import * as fs from 'fs';
import * as path from 'path';
import { NativeTool, ToolResult } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'grep',
    description: `Search for a string or regex pattern across project files. Use this INSTEAD OF 'grep', 'findstr', or 'rg' in run_command.
Returns: file_path:line_number: matching_line for every match.
WHEN TO USE: Finding where a function is called, locating imports, tracking variable usage across the project.
RESTRICTION: Do NOT use grep to parse entire HTML/React structures or look for complex multi-line blocks. Use it only for simple string/variable searches. For structural analysis of components, use read_file or get_code_structure instead.
Examples:
  pattern: "handleSubmit"         → finds all usages of handleSubmit
  pattern: "import.*useAuth"      → finds all useAuth import lines
  pattern: "useState\\("          → finds all useState hooks`,
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Search string or JavaScript regex pattern. Strings are matched literally; regex metacharacters are supported (e.g. "import.*from", "const.*=.*useState").',
        },
        path_filter: {
          type: 'string',
          description: 'Optional glob pattern to limit which files to search (e.g. "src/**/*.ts", "**/*.jsx"). Omit to search all files.',
        },
        case_sensitive: {
          type: 'boolean',
          description: 'Whether the match is case-sensitive. Defaults to false.',
        },
      },
      required: ['pattern'],
    },
  },
};

const SKIP_DIRS  = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '__pycache__', '.fluxo']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.pdf', '.zip', '.gz', '.tar', '.bak', '.vsix']);

// Inline glob-to-regex so GrepTool has no shared dependency on GlobTool
function globToRegex(pattern: string): RegExp {
  let r = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      r += '.*'; i++;
      if (pattern[i + 1] === '/') { i++; }
    } else if (c === '*') {
      r += '[^/]*';
    } else if (c === '?') {
      r += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      r += '\\' + c;
    } else {
      r += c;
    }
  }
  return new RegExp(`^${r}$`, 'i');
}

interface GrepMatch { file: string; line: number; content: string; }

function searchFile(filePath: string, relPath: string, rx: RegExp, results: GrepMatch[]): void {
  if (BINARY_EXT.has(path.extname(filePath).toLowerCase())) { return; }
  let text: string;
  try { text = fs.readFileSync(filePath, 'utf-8'); } catch { return; }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && results.length < 500; i++) {
    if (rx.test(lines[i])) {
      results.push({ file: relPath, line: i + 1, content: lines[i].trim().slice(0, 200) });
    }
  }
}

function walkAndGrep(
  dir: string, root: string,
  fileFilter: RegExp | null, searchRx: RegExp,
  results: GrepMatch[], depth: number
): void {
  if (depth > 12 || results.length >= 500) { return; }
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) { continue; }
    const full = path.join(dir, entry.name);
    const rel  = path.relative(root, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      walkAndGrep(full, root, fileFilter, searchRx, results, depth + 1);
    } else if (!fileFilter || fileFilter.test(rel)) {
      searchFile(full, rel, searchRx, results);
    }
  }
}

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const patternStr = String(args.pattern || '').trim();
  if (!patternStr) {
    return { success: false, output: 'CRITICAL ERROR: "pattern" is required.' };
  }

  const flags = args.case_sensitive === true ? '' : 'i';
  let searchRx: RegExp;
  try {
    searchRx = new RegExp(patternStr, flags);
  } catch {
    // Not valid regex — escape and treat as literal string
    const escaped = patternStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    searchRx = new RegExp(escaped, flags);
  }

  let fileFilter: RegExp | null = null;
  if (typeof args.path_filter === 'string' && args.path_filter.trim()) {
    try { fileFilter = globToRegex(args.path_filter.trim()); } catch { /* ignore bad filter */ }
  }

  const results: GrepMatch[] = [];
  walkAndGrep(workspacePath, workspacePath, fileFilter, searchRx, results, 0);

  if (results.length === 0) {
    return {
      success: false,
      output: `No matches for "${patternStr}"${args.path_filter ? ` in "${args.path_filter}"` : ''}. Try a broader pattern or remove the path_filter.`,
    };
  }

  const truncated = results.length >= 500;
  const lines = (truncated ? results.slice(0, 500) : results)
    .map(r => `${r.file}:${r.line}: ${r.content}`)
    .join('\n');

  return {
    success: true,
    output: `grep("${patternStr}"): ${results.length} match(es)${truncated ? ' — first 500 shown' : ''}:\n\n${lines}`,
  };
}

```

### 📁 FILE: `src\tools\index.ts`
```typescript
import * as FileReadTool      from './FileReadTool';
import * as FileWriteTool     from './FileWriteTool';
import * as ReplaceLinesTool  from './ReplaceLinesTool';
import * as ReplaceBlockTool  from './ReplaceBlockTool';
import * as InsertLinesTool   from './InsertLinesTool';
import * as CreateDirTool     from './CreateDirTool';
import * as ListDirTool       from './ListDirTool';
import * as RunCommandTool    from './RunCommandTool';
import * as DeleteFileTool    from './DeleteFileTool';
import * as DeleteDirTool     from './DeleteDirTool';
import * as ProposePlanTool   from './ProposePlanTool';
import * as SearchInFilesTool from './SearchInFilesTool';
import * as SearchImagesTool  from './SearchImagesTool';
import * as AskApprovalTool    from './AskApprovalTool';
import * as SearchReplaceTool  from './SearchReplaceTool';
import * as UpdateMemoryTool      from './UpdateMemoryTool';
import * as GetCodeStructureTool       from './GetCodeStructureTool';
import * as FetchDocumentationTool from './FetchDocumentationTool';
import * as EnterWorktreeTool     from './EnterWorktreeTool';
import * as ExitWorktreeTool      from './ExitWorktreeTool';
import * as TeamCreateTool        from './TeamCreateTool';
import * as SendMessageTool       from './SendMessageTool';
import * as ReplaceSymbolTool     from './ReplaceSymbolTool';
import * as GlobTool              from './GlobTool';
import * as GrepTool              from './GrepTool';
import * as EnterPlanModeTool     from './EnterPlanModeTool';
import * as SkillTool             from './SkillTool';
import * as GetRepoMapTool        from './GetRepoMapTool';
import * as AbortAndRollbackTool  from './AbortAndRollbackTool';
import { ToolResult, NativeTool } from './shared';

export { ToolResult, NativeTool };

// ─── Tool Registry ────────────────────────────────────────────────────────────

const ALL_TOOLS = [
  FileReadTool,
  FileWriteTool,
  SearchReplaceTool,
  ReplaceLinesTool,
  ReplaceBlockTool,
  InsertLinesTool,
  CreateDirTool,
  ListDirTool,
  RunCommandTool,
  DeleteFileTool,
  DeleteDirTool,
  ProposePlanTool,
  SearchInFilesTool,
  SearchImagesTool,
  AskApprovalTool,
  UpdateMemoryTool,
  GetCodeStructureTool,
  FetchDocumentationTool,
  EnterWorktreeTool,
  ExitWorktreeTool,
  TeamCreateTool,
  SendMessageTool,
  ReplaceSymbolTool,
  GlobTool,
  GrepTool,
  EnterPlanModeTool,
  SkillTool,
  GetRepoMapTool,
  AbortAndRollbackTool,
];

export const TOOL_DEFINITIONS: NativeTool[] = ALL_TOOLS.map(t => t.TOOL_DEF);

type ToolExecutor = (args: Record<string, any>, workspacePath: string) => ToolResult;

const TOOL_MAP: Record<string, ToolExecutor> = Object.fromEntries(
  ALL_TOOLS.map(t => [t.TOOL_DEF.function.name, t.execute])
);

export function executeTool(
  name: string,
  args: Record<string, any>,
  workspacePath: string
): ToolResult {
  const fn = TOOL_MAP[name];
  if (!fn) { return { success: false, output: `[SYSTEM ENGINE ERROR]: Unknown tool: ${name}` }; }
  try {
    return fn(args, workspacePath);
  } catch (err: any) {
    return { success: false, output: `[SYSTEM ENGINE ERROR]: ${err.message ?? String(err)}` };
  }
}

export function getNativeTools(toolNames: string[]): NativeTool[] {
  return TOOL_DEFINITIONS.filter(t => toolNames.includes(t.function.name));
}

```

### 📁 FILE: `src\tools\InsertLinesTool\index.ts`
```typescript
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeTool, ToolResult, safePath } from '../shared';
import { FileLockManager } from '../../utils/lockfile';
import { checkSyntax } from '../../utils/syntaxValidator';

// ─── insert_lines (v8.16.8 — The Precision Scalpel) ──────────────────────────
// Pure insertion tool: drops new content BEFORE a target line without removing
// or rewriting any existing code. Designed for "drop a fresh component into the
// file" workflows where replace_block / replace_lines fail because the LLM
// miscounts brackets in 50+ line JSX payloads.
//
// Use `at_line: <N+1>` (where N is the file's last line) to append at EOF, or
// `at_line: 1` to prepend. The tool still runs through the AST Syntax Shield
// so it cannot smuggle broken code into the file.

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'insert_lines',
    description: `Insert new lines into a file at a specific 1-based line number WITHOUT removing or rewriting any existing content. The new content is placed BEFORE the target line — every original line stays intact.
PRIMARY USE CASE: dropping a fresh component, function, or import block into a file when replace_block / replace_lines would force you to count brackets across a huge JSX payload. Pure insertion never miscounts because nothing is being deleted.
WORKFLOW: (1) Call read_file to get the current line count. (2) Pick at_line — use 1 to prepend, or (last_line + 1) to append at EOF, or any specific anchor line. (3) Call insert_lines with content.
The tool runs through the AST Syntax Shield, so the resulting file must still parse — but because nothing is removed, balanced inserts almost always pass on the first try.`,
    parameters: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'File path relative to workspace root.' },
        at_line: { type: 'number', description: '1-based line number BEFORE which the content is inserted. Use 1 to prepend, or (totalLines + 1) to append at EOF. Must come from a preceding read_file call — line numbers shift after every edit.' },
        content: { type: ['string', 'array'], description: 'The code to insert. May be a string or an Array of strings (one element per line) — the engine joins arrays with \\n. Do NOT add a trailing newline; the engine handles line endings. Empty content is rejected.' },
        healing_mode: { type: 'boolean', description: 'Set to true ONLY if you are inserting into an already-broken file as part of a syntax repair. Disables the AST Syntax Shield for this call.' },
        agent_id: { type: 'string', description: 'Unique identifier of the calling agent (e.g. "coder-1"). Used by the File Lock Manager.' },
      },
      required: ['path', 'at_line', 'content'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const fp = safePath(workspacePath, args.path);
  if (!fs.existsSync(fp)) {
    return { success: false, output: `File not found: ${args.path}. Use list_dir or glob to verify the path.` };
  }

  const atLine = Number(args.at_line);
  if (!Number.isInteger(atLine) || atLine < 1) {
    return { success: false, output: `CRITICAL ERROR: at_line must be a positive integer >= 1 (received: ${args.at_line}). Call read_file first to get the current line count.` };
  }

  // ── Payload Normalizer (mirrors ReplaceLinesTool) ───────────────────────────
  if (Array.isArray(args.content)) {
    args.content = (args.content as unknown[]).join('\n');
  } else if (args.content === null || args.content === undefined) {
    args.content = '';
  } else if (typeof args.content === 'object') {
    const vals = Object.values(args.content as Record<string, unknown>);
    args.content = vals.length > 0 ? vals.map(String).join('\n') : JSON.stringify(args.content);
  }

  if (typeof args.content !== 'string' || args.content === '') {
    return { success: false, output: 'CRITICAL ERROR: content must be a non-empty string or Array of strings. To delete lines instead of inserting, use replace_lines with new_content="".' };
  }

  const original   = fs.readFileSync(fp, 'utf-8');
  const lines      = original.split('\n');
  const totalLines = lines.length;

  if (atLine > totalLines + 1) {
    return { success: false, output: `CRITICAL ERROR: at_line (${atLine}) is past EOF + 1 (file has ${totalLines} lines, max valid at_line is ${totalLines + 1}). Call read_file to get the current line count.` };
  }

  // Backup to temp dir — never touches workspace or git tree
  try {
    const backupDir  = path.join(os.tmpdir(), 'fluxo-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const timestamp  = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `${path.basename(fp)}_${timestamp}.bak`;
    fs.writeFileSync(path.join(backupDir, backupName), original, 'utf-8');
  } catch {
    // Non-fatal
  }

  const insertLines = (args.content as string).replace(/\n$/, '').split('\n');
  const resultLines = [
    ...lines.slice(0, atLine - 1),
    ...insertLines,
    ...lines.slice(atLine - 1),
  ];
  const updated = resultLines.join('\n');

  // ── AST Syntax Validation — prevents inserting unparseable code ─────────────
  if (!args.healing_mode) {
    const _syntaxCheck = checkSyntax(fp, updated);
    if (!_syntaxCheck.ok) {
      return {
        success: false,
        output:
          `[SYNTAX ERROR DETECTED] The proposed insertion breaks the file syntax. Insert aborted.\n` +
          `Error details:\n${_syntaxCheck.errors}\n\n` +
          `Your inserted block is unbalanced (missing brace, broken JSX tag, unterminated string, etc.). ` +
          `Review your content and retry. If the file was already broken before your insert, pass healing_mode: true.`,
      };
    }
  }

  const agentId = typeof args.agent_id === 'string' ? args.agent_id : 'agent';
  if (!FileLockManager.acquireLock(fp, agentId)) {
    return {
      success: false,
      output: `SYSTEM LOCK: El archivo ${args.path} está siendo editado actualmente por otro agente de tu equipo. Espera o trabaja en otro archivo mientras se libera el cerrojo.`,
    };
  }
  try {
    fs.writeFileSync(fp, updated, 'utf-8');
  } finally {
    FileLockManager.releaseLock(fp, agentId);
  }

  return {
    success: true,
    output: `insert_lines: ${args.path} — inserted ${insertLines.length} line${insertLines.length !== 1 ? 's' : ''} before line ${atLine} (file grew from ${totalLines} → ${resultLines.length} lines). No existing lines were modified or removed. If the task is not complete, call the NEXT tool now.`,
  };
}

```

### 📁 FILE: `src\tools\ListDirTool\index.ts`
```typescript
import * as fs from 'fs';
import { NativeTool, ToolResult, safePath } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'list_dir',
    description: 'List files and folders in a directory.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to list. Use "." for workspace root.' },
      },
      required: ['path'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const dp = safePath(workspacePath, args.path || '.');
  if (!fs.existsSync(dp)) {
    return { success: false, output: `Directory not found: ${args.path}` };
  }
  const stat = fs.statSync(dp);
  if (stat.isFile()) {
    const parentDir = (args.path as string || '.').split(/[\\/]/).slice(0, -1).join('/') || '.';
    return {
      success: false,
      output: `ERROR: Has intentado listar un archivo ("${args.path}"). ` +
        `list_dir solo opera sobre carpetas.\n` +
        `• Para ver el contenido del archivo → usa read_file("${args.path}")\n` +
        `• Para listar la carpeta que lo contiene → usa list_dir("${parentDir}")`,
    };
  }
  const entries = fs.readdirSync(dp, { withFileTypes: true });
  const lines = entries.map(e => `${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`);
  return { success: true, output: lines.join('\n') || '(empty)' };
}

```

### 📁 FILE: `src\tools\ProposePlanTool\index.ts`
```typescript
import * as fs from 'fs';
import * as path from 'path';
import { NativeTool, ToolResult, safePath } from '../shared';
import { initialize, validateTasks, renderMarkdown, Task } from '../../utils/dagController';

// ─── propose_plan (v8.17.0 — DAG Orchestrator) ──────────────────────────────
// The @manager no longer hands off a flat markdown string. It must structure
// its intent as a Directed Acyclic Graph of Task objects with explicit
// dependencies. The tool persists the graph to .fluxo/dag_state.json (the new
// source of truth) and projects a human-readable IMPLEMENTATION_PLAN.md from
// it for the user to review before execution starts.

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'propose_plan',
    description:
      'Propose a structured Directed Acyclic Graph (DAG) of tasks for a complex assignment. ' +
      'Each task declares its target agent, description, and parent dependencies. The engine ' +
      'persists the graph to .fluxo/dag_state.json and renders a human-readable IMPLEMENTATION_PLAN.md ' +
      'so the user can review the plan before execution begins. Use this BEFORE any major change.',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description:
            'Ordered list of tasks that form the DAG. Each task must have a unique id and may declare ' +
            'depends_on with the ids of tasks that must be COMPLETED before it can run.',
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'Stable, unique identifier for this task (e.g. "T1", "setup-db").',
              },
              description: {
                type: 'string',
                description: 'Imperative description of what the assigned agent must accomplish.',
              },
              agent_type: {
                type: 'string',
                description: 'Target agent (e.g. "@coder", "@designer", "@manager", "@planner").',
              },
              depends_on: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of task ids that must be COMPLETED before this task is dispatched. Empty array for root tasks.',
              },
            },
            required: ['id', 'description', 'agent_type', 'depends_on'],
          },
        },
      },
      required: ['tasks'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const rawTasks = args.tasks;
  if (!Array.isArray(rawTasks)) {
    return {
      success: false,
      output:
        'propose_plan requires a "tasks" array of structured Task objects (DAG v8.17.0). ' +
        'Each task must declare id, description, agent_type, and depends_on.',
    };
  }

  const validation = validateTasks(rawTasks);
  if (!validation.ok) {
    return { success: false, output: `[DAG VALIDATION ERROR] ${validation.error}` };
  }

  const tasks: Task[] = validation.tasks;
  const state = initialize(workspacePath, tasks);

  // Project the JSON graph into IMPLEMENTATION_PLAN.md so the user keeps a
  // human-readable surface to review and approve before execution.
  const planPath = safePath(workspacePath, path.join('.fluxo', 'IMPLEMENTATION_PLAN.md'));
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, renderMarkdown(state), 'utf-8');

  const rootTasks = tasks.filter(t => t.depends_on.length === 0).map(t => t.id);
  return {
    success: true,
    output:
      `DAG initialized successfully. ${tasks.length} task(s) persisted to .fluxo/dag_state.json. ` +
      `IMPLEMENTATION_PLAN.md generated for human review. ` +
      `Root tasks (no dependencies): ${rootTasks.length > 0 ? rootTasks.join(', ') : '(none)'}. ` +
      `Please review the plan and confirm if I should proceed.`,
  };
}

```

### 📁 FILE: `src\tools\ReplaceBlockTool\index.ts`
```typescript
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeTool, ToolResult, safePath } from '../shared';
import { FileLockManager } from '../../utils/lockfile';
import { checkSyntax } from '../../utils/syntaxValidator';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'replace_block',
    description: `Replace a text block in a file using semantic string-based targeting — no line numbers required.
MANDATORY WORKFLOW: (1) Call read_file to get the current content. (2) Copy the exact block you want to replace as search_snippet — include 2-3 lines of surrounding context to guarantee uniqueness. (3) Call replace_block with your new replace_snippet.
MATCHING: Tries exact match first; if whitespace/indentation differs, automatically falls back to fuzzy line-by-line matching that ignores leading/trailing spaces.
FAIL-SAFE: If search_snippet is not found (hallucinated character, wrong indentation), the tool does NOTHING and returns an error — the file is never corrupted. Call read_file again and re-copy the block verbatim.
STRICT RULES:
  • search_snippet must be unique in the file — fails if it matches more than once (add more surrounding lines).
  • Use replace_snippet = "" to delete the block without inserting anything.
  • Does NOT bypass guards unless healing_mode: true is set.`,
    parameters: {
      type: 'object',
      properties: {
        path:           { type: 'string',  description: 'File path relative to workspace root.' },
        search_snippet: { type: 'string',  description: 'The exact current code block to find and replace. Copy verbatim from read_file output. Include 2-3 lines of context above and below the change to ensure uniqueness. Whitespace differences are tolerated via fuzzy matching.' },
        replace_snippet: { type: 'string', description: 'Your new version of the block. Use empty string "" to delete without inserting anything.' },
        agent_id:       { type: 'string',  description: 'Your agent ID (e.g. "coder", "designer"). Used by the FileLockManager to prevent race conditions in parallel execution.' },
        healing_mode:   { type: 'boolean', description: 'Set to true ONLY when fixing an already-broken file (syntax error, unbalanced braces, AST corruption). Disables brace-balance and AST guards.' },
      },
      required: ['path', 'search_snippet', 'replace_snippet'],
    },
  },
};

// ─── Fuzzy Matching ───────────────────────────────────────────────────────────

function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

type BlockMatch =
  | { kind: 'strict' }
  | { kind: 'fuzzy'; start: number; end: number }
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number };

/**
 * Locate target_snippet inside fileContent.
 * Fast path: exact string match (1 occurrence).
 * Fuzzy path: line-by-line comparison after whitespace normalization.
 * Returns 'ambiguous' if > 1 strict matches are found (don't fall through to fuzzy).
 */
function findBlock(fileContent: string, snippet: string): BlockMatch {
  // Normalize CRLF in both so mixed line-endings don't break matching
  const content = fileContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const snip    = snippet.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Fast path — exact string match
  const strictOccurrences = content.split(snip).length - 1;
  if (strictOccurrences === 1) { return { kind: 'strict' }; }
  if (strictOccurrences > 1)  { return { kind: 'ambiguous', count: strictOccurrences }; }

  // Fuzzy path — line-by-line normalized comparison
  const fileLines = content.split('\n');
  const rawSnipLines = snip.split('\n');

  // Strip leading/trailing blank-only lines from snippet (LLM multiline string artifacts)
  let si = 0, ei = rawSnipLines.length - 1;
  while (si <= ei && rawSnipLines[si].trim() === '') { si++; }
  while (ei >= si && rawSnipLines[ei].trim() === '') { ei--; }
  const snippetLines = rawSnipLines.slice(si, ei + 1);

  if (snippetLines.length === 0) { return { kind: 'none' }; }

  const snipNorm = snippetLines.map(normalizeLine);
  const n = snippetLines.length;
  const matches: number[] = [];

  outer: for (let i = 0; i <= fileLines.length - n; i++) {
    for (let j = 0; j < n; j++) {
      if (normalizeLine(fileLines[i + j]) !== snipNorm[j]) {
        continue outer;
      }
    }
    matches.push(i);
  }

  if (matches.length === 0) { return { kind: 'none' }; }
  if (matches.length > 1)  { return { kind: 'ambiguous', count: matches.length }; }

  return { kind: 'fuzzy', start: matches[0], end: matches[0] + n - 1 };
}

// ─── Tool Executor ────────────────────────────────────────────────────────────

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const fp = safePath(workspacePath, args.path);
  if (!fs.existsSync(fp)) {
    return { success: false, output: `File not found: ${args.path}. Use list_dir to verify the path.` };
  }

  // Accept both new param names (search_snippet/replace_snippet) and legacy names (target_snippet/new_content)
  const searchSnippet  = typeof args.search_snippet  === 'string' ? args.search_snippet  : (args.target_snippet  ?? '');
  const replaceSnippet = typeof args.replace_snippet === 'string' ? args.replace_snippet : (args.new_content     ?? '');

  if (typeof searchSnippet !== 'string' || searchSnippet === '') {
    return { success: false, output: 'Snippet exacto no encontrado. Usa read_file para copiar el bloque literal antes de reemplazar.' };
  }
  if (typeof replaceSnippet !== 'string') {
    return { success: false, output: 'CRITICAL ERROR: replace_snippet must be a string. Use empty string "" to delete the block.' };
  }

  const original = fs.readFileSync(fp, 'utf-8');
  const match = findBlock(original, searchSnippet);

  if (match.kind === 'none') {
    return {
      success: false,
      output: `Snippet exacto no encontrado. Usa read_file para copiar el bloque literal antes de reemplazar.\n` +
              `(${args.path}: exact match failed and fuzzy whitespace-normalization also found no match.\n` +
              `The snippet content differs from the file — not just whitespace. Re-copy verbatim from read_file.)`,
    };
  }

  if (match.kind === 'ambiguous') {
    return {
      success: false,
      output: `AMBIGUOUS MATCH: search_snippet appears ${match.count} times in ${args.path}.\n` +
              `Your snippet is too generic. Expand it — add the function signature above or the closing brace below to make the block unique.`,
    };
  }

  // Build updated file content
  let updated: string;
  let removedPreviewText: string;
  let removedLineCount: number;
  let matchStartLine: number;
  let matchEndLine: number;

  if (match.kind === 'strict') {
    // Exact replacement — preserve all original formatting outside the matched block
    const snipNormalized = searchSnippet.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    updated = original.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
                      .replace(snipNormalized, replaceSnippet.replace(/\n$/, ''));

    const before = original.replace(/\r\n/g, '\n').indexOf(snipNormalized);
    matchStartLine = original.slice(0, before).split('\n').length;
    removedLineCount = snipNormalized.split('\n').length;
    matchEndLine = matchStartLine + removedLineCount - 1;
    removedPreviewText = snipNormalized.length > 300 ? snipNormalized.slice(0, 300) + '\n…(truncated)' : snipNormalized;
  } else {
    // Fuzzy replacement — line-based reconstruction
    const fileLines = original.replace(/\r\n/g, '\n').split('\n');
    const newLines = replaceSnippet === '' ? [] : replaceSnippet.replace(/\n$/, '').split('\n');
    const resultLines = [
      ...fileLines.slice(0, match.start),
      ...newLines,
      ...fileLines.slice(match.end + 1),
    ];
    updated = resultLines.join('\n');

    matchStartLine = match.start + 1;
    matchEndLine = match.end + 1;
    removedLineCount = match.end - match.start + 1;
    const removedText = fileLines.slice(match.start, match.end + 1).join('\n');
    removedPreviewText = removedText.length > 300 ? removedText.slice(0, 300) + '\n…(truncated)' : removedText;
  }

  if (updated.trim() === '' && original.trim() !== '') {
    return { success: false, output: 'SAFETY ABORT: replacement would produce an empty file. Verify your search_snippet and replace_snippet.' };
  }

  // ── Guards (skipped in healing_mode) ─────────────────────────────────────
  if (!args.healing_mode) {
    const JS_EXTENSIONS  = ['.ts', '.tsx', '.js', '.jsx'];
    const JSX_EXTENSIONS = ['.tsx', '.jsx'];
    const fileExt        = path.extname(fp).toLowerCase();

    if (JS_EXTENSIONS.includes(fileExt)) {
      const openCount  = (updated.match(/\{/g) || []).length;
      const closeCount = (updated.match(/\}/g) || []).length;
      if (openCount !== closeCount) {
        return {
          success: false,
          output: `CRITICAL SYNTAX ERROR: Llaves desequilibradas (${openCount} "{" vs ${closeCount} "}"). El archivo NO fue modificado. ANTI-PANIC DIRECTIVE: STOP USING REPLACE_LINES/REPLACE_BLOCK FOR MASSIVE INJECTIONS. You MUST use the 'insert_lines' tool to inject this code cleanly.`,
        };
      }
    }

    if (JSX_EXTENSIONS.includes(fileExt)) {
      const jsxBalance = (code: string): number => {
        const opens     = (code.match(/<[A-Za-z]/g) || []).length;
        const closes    = (code.match(/<\/[A-Za-z]/g) || []).length;
        const selfClose = (code.match(/\/>/g) || []).length;
        return opens - closes - selfClose;
      };
      if (jsxBalance(original) !== jsxBalance(updated)) {
        return {
          success: false,
          output: `CRITICAL SYNTAX ERROR: AST/JSX Corruption detected. Etiquetas HTML/JSX desbalanceadas. El archivo NO fue modificado. ANTI-PANIC DIRECTIVE: STOP USING REPLACE_LINES/REPLACE_BLOCK FOR MASSIVE INJECTIONS. You MUST use the 'insert_lines' tool to inject this code cleanly.`,
        };
      }
    }

    // ── AST Syntax Validation (v8.14.0 — Syntax Shield) ─────────────────────
    // Full TypeScript compiler parse — catches broken strings, unexpected tokens,
    // unclosed brackets, and other errors the regex guards above cannot detect.
    const _syntaxCheck = checkSyntax(fp, updated);
    if (!_syntaxCheck.ok) {
      return {
        success: false,
        output:
          `[SYNTAX ERROR DETECTED] The proposed change breaks the file syntax. Write aborted.\n` +
          `Error details:\n${_syntaxCheck.errors}\n\n` +
          `You MUST review your code block and fix the syntax before retrying.`,
      };
    }
    // ─────────────────────────────────────────────────────────────────────────
  }

  // Zero-footprint auto-backup — written to OS temp dir, never to the workspace or git tree
  try {
    const backupDir = path.join(os.tmpdir(), 'fluxo-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(backupDir, `${path.basename(fp)}_${timestamp}.bak`), original, 'utf-8');
  } catch { /* non-fatal */ }

  // ── FileLockManager Mutex (v8.3.2) ───────────────────────────────────────────
  const agentId = typeof args.agent_id === 'string' ? args.agent_id : 'agent';
  if (!FileLockManager.acquireLock(fp, agentId)) {
    return {
      success: false,
      output: `SYSTEM LOCK: El archivo ${args.path} está siendo editado actualmente por otro agente de tu equipo. Tienes prohibido forzar la edición. Por favor, usa la herramienta sleep por 5 segundos o trabaja en otro archivo mientras se libera el cerrojo.`,
    };
  }
  try {
    fs.writeFileSync(fp, updated, 'utf-8');
  } finally {
    FileLockManager.releaseLock(fp, agentId);
  }
  // ─────────────────────────────────────────────────────────────────────────────

  const matchNote = match.kind === 'fuzzy'
    ? ` [fuzzy match: whitespace-normalized, lines ${matchStartLine}–${matchEndLine}]`
    : ` [exact match, lines ${matchStartLine}–${matchEndLine}]`;

  return {
    success: true,
    output: `replace_block: ${args.path} — 1 block replaced (${removedLineCount} line${removedLineCount !== 1 ? 's' : ''}).${matchNote}\n\nBLOCK REMOVED:\n${removedPreviewText}\n\nEDICIÓN EXITOSA — Verifica que el bloque eliminado es el correcto. Si la tarea no está completa, llama la SIGUIENTE herramienta ahora.`,

  };
}

```

### 📁 FILE: `src\tools\ReplaceLinesTool\index.ts`
```typescript
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeTool, ToolResult, safePath } from '../shared';
import { FileLockManager } from '../../utils/lockfile';
import { checkSyntax } from '../../utils/syntaxValidator';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'replace_lines',
    description: `Replace an exact range of lines in a file using coordinate-based targeting.
MANDATORY WORKFLOW: (1) Call read_file to get current line numbers. (2) Identify start_line and end_line for the block to replace. (3) Call replace_lines with new_content.
CRITICAL: Line numbers shift after every edit — always call read_file again before a subsequent replace_lines on the same file.
Use new_content = "" to delete the line range without inserting anything.
NEVER skip read_file — guessing line numbers without reading first is PROHIBITED.
TO INSERT NEW LINES WITHOUT DELETING: Set start_line and end_line to the exact same number (the line you want to target). In new_content, write the original text of that line, add a newline character (\\n), and then write your new code.`,
    parameters: {
      type: 'object',
      properties: {
        path:        { type: 'string', description: 'File path relative to workspace root.' },
        start_line:  { type: 'number', description: '1-based line number where the replacement begins (inclusive). Must come from a preceding read_file call.' },
        end_line:    { type: 'number', description: '1-based line number where the replacement ends (inclusive). Must be >= start_line.' },
        new_content: { type: ['string', 'array'], description: 'El código a insertar en lugar de las líneas eliminadas. IMPORTANTE: Para evitar errores de escape JSON en bloques grandes de JSX/TSX, tienes PERMITIDO enviar este parámetro como un Array de strings (una línea de código por elemento). El motor lo unirá automáticamente con \\n. Pasa "" o [] para eliminar el rango sin insertar nada. Do NOT add a trailing newline — the engine handles line endings.' },
        healing_mode: { type: 'boolean', description: 'Set to true ONLY if you are fixing a syntax error, unbalanced brace, or AST corruption. This temporarily disables the syntax and AST guards to allow surgical fixes on already broken files.' },
        agent_id: { type: 'string', description: 'Unique identifier of the calling agent (e.g. "coder-1", "designer-2"). Used by the File Lock Manager to track ownership. Required when running in parallel orchestration mode.' },
      },
      required: ['path', 'start_line', 'end_line', 'new_content'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const fp = safePath(workspacePath, args.path);
  if (!fs.existsSync(fp)) {
    return { success: false, output: `File not found: ${args.path}. Use list_dir to verify the path.` };
  }

  const startLine = Number(args.start_line);
  const endLine   = Number(args.end_line);

  if (!Number.isInteger(startLine) || startLine < 1) {
    return { success: false, output: `CRITICAL ERROR: start_line must be a positive integer >= 1 (received: ${args.start_line}). Call read_file first to get correct line numbers.` };
  }
  if (!Number.isInteger(endLine) || endLine < startLine) {
    return { success: false, output: `CRITICAL ERROR: end_line (${endLine}) must be an integer >= start_line (${startLine}). Call read_file to verify current line numbers.` };
  }
  // ── Payload Normalizer (v7.21.0) ─────────────────────────────────────────────
  // The LLM sometimes sends new_content as an Array (one element per line) when
  // JSON-escaping large JSX blocks, or as null/undefined when the payload breaks.
  // Coerce silently before the strict check so those payloads still succeed.
  if (Array.isArray(args.new_content)) {
    args.new_content = (args.new_content as unknown[]).join('\n');
  } else if (args.new_content === null || args.new_content === undefined) {
    args.new_content = '';
  } else if (typeof args.new_content === 'object') {
    // Object from a malformed parse — best-effort: join values or full JSON fallback
    const vals = Object.values(args.new_content as Record<string, unknown>);
    args.new_content = vals.length > 0 ? vals.map(String).join('\n') : JSON.stringify(args.new_content);
  }
  // ─────────────────────────────────────────────────────────────────────────────

  if (typeof args.new_content !== 'string') {
    return { success: false, output: 'CRITICAL ERROR: new_content must be a string or Array of strings. Use an empty string "" to delete lines without inserting anything.' };
  }

  const original   = fs.readFileSync(fp, 'utf-8');

  // Zero-footprint auto-backup — written to OS temp dir, never to the workspace or git tree
  try {
    const backupDir  = path.join(os.tmpdir(), 'fluxo-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const timestamp  = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `${path.basename(fp)}_${timestamp}.bak`;
    fs.writeFileSync(path.join(backupDir, backupName), original, 'utf-8');
  } catch {
    // Backup failure is non-fatal — edit proceeds regardless
  }

  const lines      = original.split('\n');
  const totalLines = lines.length;

  if (startLine > totalLines) {
    return { success: false, output: `CRITICAL ERROR: start_line (${startLine}) exceeds file length (${totalLines} lines). Call read_file to get updated line numbers.` };
  }

  const clampedEnd  = Math.min(endLine, totalLines);
  const clampNote   = endLine > totalLines ? ` (end_line ${endLine} clamped to file length ${totalLines})` : '';

  // Split new_content into lines. Strip trailing \n to avoid phantom blank line.
  const newLines = args.new_content === '' ? [] : args.new_content.replace(/\n$/, '').split('\n');

  const resultLines = [
    ...lines.slice(0, startLine - 1),
    ...newLines,
    ...lines.slice(clampedEnd),
  ];

  const updated = resultLines.join('\n');

  if (updated.trim() === '' && original.trim() !== '') {
    return { success: false, output: 'SAFETY ABORT: replacement would produce an empty file. Verify your line range and new_content.' };
  }

  const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];
  const fileExt = path.extname(fp).toLowerCase();

  if (!args.healing_mode) {
    // Deterministic brace-balance guard — runs before writing to disk
    if (JS_EXTENSIONS.includes(fileExt)) {
      const openCount  = (updated.match(/\{/g) || []).length;
      const closeCount = (updated.match(/\}/g) || []).length;
      if (openCount !== closeCount) {
        return {
          success: false,
          output: `CRITICAL SYNTAX ERROR: Tu 'new_content' tiene llaves desequilibradas (${openCount} "{" vs ${closeCount} "}"). El archivo NO fue modificado. ANTI-PANIC DIRECTIVE: STOP USING REPLACE_LINES/REPLACE_BLOCK FOR MASSIVE INJECTIONS. You MUST use the 'insert_lines' tool to inject this code cleanly.`,
        };
      }
    }

    // JSX/AST integrity guard — prevents orphaned or crossed tags in React files
    const JSX_EXTENSIONS_AST = ['.tsx', '.jsx'];
    if (JSX_EXTENSIONS_AST.includes(fileExt)) {
      const jsxBalance = (code: string): number => {
        const opens     = (code.match(/<[A-Za-z]/g) || []).length;
        const closes    = (code.match(/<\/[A-Za-z]/g) || []).length;
        const selfClose = (code.match(/\/>/g) || []).length;
        return opens - closes - selfClose;
      };
      const origBalance    = jsxBalance(original);
      const updatedBalance = jsxBalance(updated);
      if (origBalance !== updatedBalance) {
        return {
          success: false,
          output: `CRITICAL SYNTAX ERROR: AST/JSX Corruption detected. Etiquetas HTML/JSX desbalanceadas. El archivo NO fue modificado. ANTI-PANIC DIRECTIVE: STOP USING REPLACE_LINES/REPLACE_BLOCK FOR MASSIVE INJECTIONS. You MUST use the 'insert_lines' tool to inject this code cleanly.`,
        };
      }
    }

    // ── AST Syntax Validation (v8.14.0 — Syntax Shield) ─────────────────────
    // Full TypeScript compiler parse — catches broken strings, unexpected tokens,
    // unclosed brackets, and other errors the regex guards above cannot detect.
    const _syntaxCheck = checkSyntax(fp, updated);
    if (!_syntaxCheck.ok) {
      return {
        success: false,
        output:
          `[SYNTAX ERROR DETECTED] The proposed change breaks the file syntax. Write aborted.\n` +
          `Error details:\n${_syntaxCheck.errors}\n\n` +
          `You MUST review your code block and fix the syntax before retrying.`,
      };
    }
    // ─────────────────────────────────────────────────────────────────────────
  }

  const removedLines = lines.slice(startLine - 1, clampedEnd);
  const linesRemoved = clampedEnd - startLine + 1;
  const linesAdded   = newLines.length;

  // Anti-Mass-Deletion guard — blocks accidental truncation before the file is written
  if (linesRemoved > 50 && linesAdded < linesRemoved * 0.2) {
    return {
      success: false,
      output: `CRITICAL WARNING: ANTI-MASS-DELETION GUARD. Estás intentando eliminar ${linesRemoved} líneas pero solo insertando ${linesAdded}. ` +
              `Esto suele ser un error de truncamiento del modelo. Si realmente deseas hacer este borrado masivo, ` +
              `el motor requiere que lo dividas en bloques más pequeños o confirmes la acción. ` +
              `(Nota: la herramienta falla, no escribe el archivo, y obliga al agente a reconsiderar).`,
    };
  }

  const agentId = typeof args.agent_id === 'string' ? args.agent_id : 'agent';
  if (!FileLockManager.acquireLock(fp, agentId)) {
    return {
      success: false,
      output: `SYSTEM LOCK: El archivo ${args.path} está siendo editado actualmente por otro agente de tu equipo. Tienes prohibido forzar la edición. Por favor, usa la herramienta sleep por 5 segundos o trabaja en otro archivo mientras se libera el cerrojo.`,
    };
  }
  try {
    fs.writeFileSync(fp, updated, 'utf-8');
  } finally {
    FileLockManager.releaseLock(fp, agentId);
  }

  // Build a compact preview of removed content for auto-verification
  const removedText  = removedLines.join('\n');
  const removedPreview = removedText.length > 300
    ? removedText.slice(0, 300) + '\n…(truncated)'
    : removedText;

  return {
    success: true,
    output: `replace_lines: ${args.path} — replaced lines ${startLine}–${clampedEnd} (${linesRemoved} line${linesRemoved !== 1 ? 's' : ''} → ${linesAdded} line${linesAdded !== 1 ? 's' : ''})${clampNote}.\n\nLINES REMOVED:\n${removedPreview}\n\nEDICIÓN EXITOSA — Verifica que las líneas eliminadas son las correctas. Si la tarea no está completa, llama la SIGUIENTE herramienta ahora.`,
  };
}

```

### 📁 FILE: `src\tools\ReplaceSymbolTool\index.ts`
```typescript
import { NativeTool, ToolResult } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'replace_symbol',
    description: `Replace a complete logical block (function, class, variable, React component) by looking up its exact name in the Abstract Syntax Tree (AST) via the VS Code Language Server.

WHEN TO USE: Any time you need to rewrite an entire function, class, or named component. The LSP finds the exact code boundaries — you never count lines or copy snippets.

MANDATORY WORKFLOW:
1. Call get_code_structure or read_file to confirm the exact symbol name (case-sensitive).
2. Call replace_symbol with: file_path, symbol_name, and new_code (your complete replacement).
3. The Language Server locates the AST node, extracts its precise Range, and replaces it atomically.

FAIL-SAFE: If symbol_name is not found, the tool returns an error and the file is NEVER modified.
  → Use get_code_structure to list available symbol names before retrying.

FALLBACK: For files without LSP support (plain text, config files, unsupported languages),
  use replace_block with search_snippet + replace_snippet instead.`,
    parameters: {
      type: 'object',
      properties: {
        file_path:   { type: 'string', description: 'File path relative to workspace root (e.g. "src/components/Dashboard.tsx").' },
        symbol_name: { type: 'string', description: 'Exact name of the function, class, or variable to replace (case-sensitive, e.g. "handleDelete" or "AdminDashboard"). Must match the AST node name exactly.' },
        new_code:    { type: 'string', description: 'Complete replacement code for the symbol. Include the full function/class signature and body. The engine will replace the old node boundaries with this text exactly.' },
      },
      required: ['file_path', 'symbol_name', 'new_code'],
    },
  },
};

// Real execution is intercepted by agentEngine.ts (replaceSymbolCallback from extension.ts).
// This path is a safety fallback only — in production the engine never reaches it.
export function execute(_args: Record<string, any>, _workspacePath: string): ToolResult {
  return {
    success: false,
    output: '[SYSTEM ENGINE ERROR]: replace_symbol must be intercepted by the LSP callback in extension.ts. Ensure the extension host is active.',
  };
}

```

### 📁 FILE: `src\tools\RunCommandTool\index.ts`
```typescript
import { execSync } from 'child_process';
import { NativeTool, ToolResult } from '../shared';

// ─── Strengthened Windows Spawn (v8.24.0) ────────────────────────────────────
// Single source of truth for the `shell` option passed to every execSync call
// in this module. The original spec called for
// `shell: process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : true`,
// but execSync's typed contract only accepts `string | undefined` (the boolean
// `true` form is documented for `spawn`/`spawnSync`, not `execSync`). To honor
// the spec's INTENT (force Windows to find the terminal explicitly so a missing
// %ComSpec% never silently spawns nothing), we resolve to a concrete shell
// path on Windows and fall back to `undefined` on POSIX — which Node documents
// as "execSync will use /bin/sh", the default we want there. The behavior is
// platform-deterministic and the v8.24.0 Financial Killswitch in the engine
// can rely on a clean one-shot [YIELD TO HUMAN] payload when the shell is
// genuinely unreachable.
function resolveShellOption(): string | undefined {
  return process.platform === 'win32'
    ? (process.env.ComSpec || process.env.COMSPEC || 'cmd.exe')
    : undefined;
}
// ─────────────────────────────────────────────────────────────────────────────

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'run_command',
    description:
      'Execute a shell command in the workspace directory. ' +
      'CRITICAL: DO NOT use this tool to read files (e.g., cat, type, Get-Content). You MUST use read_file instead. Bypassing this will result in instant failure. ' +
      'On Windows use Windows commands (dir, del, move, copy) — never Linux commands (ls, rm -rf, mv, cp). ' +
      'Always quote paths that contain spaces. ' +
      'WORKTREE NOTE: If a Git Worktree is active, do NOT use "cd" to navigate into it. ' +
      'All native tools (read_file, run_command, replace_block) already operate on the correct ' +
      'workspace context automatically — attempting "cd <worktree-path>" will break the working directory. ' +
      'WINDOWS ENOENT RULE (v8.16.8): If npm run build (or any command) fails with ENOENT related to cmd.exe ' +
      'or spawnSync, do NOT try to use PowerShell, node -e, or any hacking script as a workaround. ' +
      'It is a Node environment error — the OS shell is unreachable. Yield to human and stop the task. ' +
      'MICRO-ROLLBACK ALLOWED (v8.16.13): "git restore <path>" is explicitly permitted and is your CTRL+Z ' +
      'when an edit catastrophically breaks a single file. Use it before attempting any further fixes.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute.' },
      },
      required: ['command'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const cmd = args.command as string;
  const timeout = (args.timeout as number) || 30_000;

  // ── Terminal Path Hallucination Guard (v8.21.0) ──────────────────────────────
  // The agent already executes inside a worktree dynamically — the engine routes
  // every native tool to the correct sandbox automatically. Yet under recovery
  // pressure the LLM hallucinates `cd .fluxo/worktrees/<id>` to "navigate" into
  // its own sandbox, which (a) breaks the working directory because the path is
  // nested twice, and (b) is the trigger that pushes turns into the 25-iteration
  // ceiling. Intercept BEFORE every other shield so the false-positive surface
  // of downstream regexes (vite panic, evasion, persistent server) cannot mask
  // this specific failure mode. Match both POSIX and Windows separators.
  const WORKTREE_CD_PATTERN = /\bcd\s+["']?\.fluxo[\\\/]worktrees[\\\/]/i;
  if (WORKTREE_CD_PATTERN.test(cmd)) {
    return {
      success: false,
      output:
        '[SYSTEM SHIELD] You are already executing inside the worktree dynamically. ' +
        "DO NOT use 'cd' to navigate to .fluxo paths. " +
        'Use relative paths from the root of your current sandbox.',
    };
  }

  // ── Explicit Allowlist: Micro-Rollback (v8.16.13) ────────────────────────────
  // `git restore <path>` is the agent's CTRL+Z when an edit catastrophically
  // breaks a single file. It must NEVER be intercepted by any blocker downstream
  // (Vite panic, evasion shield, persistent server, etc.) since the patterns
  // below could otherwise false-positive on filenames or flags. We short-circuit
  // here and route directly to execution.
  const GIT_RESTORE_ALLOW = /^\s*git\s+restore\s+\S+/i;
  if (GIT_RESTORE_ALLOW.test(cmd)) {
    try {
      const output = execSync(cmd, {
        cwd: workspacePath,
        encoding: 'utf-8',
        timeout,
        maxBuffer: 1024 * 1024 * 4,
        shell: resolveShellOption(),
        env: { ...process.env },
      });
      return { success: true, output: output || '(git restore completed — file reverted to last committed state)' };
    } catch (err: any) {
      const stderr = err?.stderr ? String(err.stderr).trim() : '';
      const stdout = err?.stdout ? String(err.stdout).trim() : '';
      return { success: false, output: [stdout, stderr].filter(Boolean).join('\n') || String(err?.message ?? err) };
    }
  }

  // ── Raw Git Branching/Merging Block (v8.17.4) ────────────────────────────────
  // The v8.17.1 RAW_GIT_WORKFLOW_BLOCK was a prompt-level rule. Under merge
  // conflict pressure the LLM ignored it and panicked with raw `git checkout`
  // / `git merge`, fighting the worktree engine and corrupting MERGING state.
  // Promote to a tool-level physical block: any segment of the command (split
  // on |, ;, &) that starts with `git checkout` or `git merge` fails fast.
  // `git restore` is already short-circuited above so file-level rollback is
  // unaffected. `git merge --abort` is allowed because it is a recovery path,
  // not a branching/merging operation.
  const RAW_GIT_BLOCK_PATTERN = /^\s*git\s+(checkout|merge)\b/i;
  const MERGE_ABORT_ALLOW     = /^\s*git\s+merge\s+--abort\b/i;
  const _gitSegments = cmd.split(/\s*[|;&]+\s*/);
  if (_gitSegments.some(seg => RAW_GIT_BLOCK_PATTERN.test(seg) && !MERGE_ABORT_ALLOW.test(seg))) {
    return {
      success: false,
      output: '[SYSTEM BLOCK] Raw git branching/merging is physically disabled. Use exit_worktree.',
    };
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // ── Vite Panic Blocker (v8.16.12) ────────────────────────────────────────────
  // When npm run build fails, the LLM tends to panic and try to delete dist/,
  // .vite cache, node_modules/.cache, or pass --force to bypass "stale cache".
  // None of these fix syntax errors — the bug is in the code, not the cache.
  // Intercept these commands BEFORE anything else and force the agent back to
  // reading the compiler error and fixing the actual file.
  const VITE_PANIC_PATTERNS = [
    /--force\b/i,
    /\bdel\s+(?:\/[a-z]\s+)*["']?dist["']?\b/i,
    /\brmdir\b/i,
    /\bcopy\s+\/b\b/i,
    /\brm\s+-rf?\s+["']?(?:\.\/)?(?:dist|\.vite|\.cache|node_modules[\\\/]\.cache)/i,
    /\bRemove-Item\b.*\b(?:dist|\.vite|\.cache|node_modules)/i,
  ];
  if (VITE_PANIC_PATTERNS.some(p => p.test(cmd))) {
    return {
      success: false,
      output:
        "[SYSTEM ERROR] Comando denegado. Vite NO está cacheando tu error. " +
        "El error de sintaxis sigue en el código. No intentes borrar 'dist' ni usar '--force'. " +
        "Encuentra el error real en el archivo, arréglalo y vuelve a ejecutar 'npm run build'.",
    };
  }

  // ── Destructive command block ────────────────────────────────────────────────
  const BLOCKED = [/rm\s+-rf\s+[/\\~]/, /format\s+[a-z]:/, /del\s+\/[fs]/i, /mkfs/, /dd\s+if=/];
  if (BLOCKED.some(b => b.test(cmd))) {
    return { success: false, output: `Blocked dangerous command: ${cmd}` };
  }

  // ── Anti-Hacker Shield: block CLI direct file-reading ───────────────────────
  // Only the FIRST segment (before any pipe) is checked — this allows legitimate
  // pipeline filtering like "npm run build | head -50" or "tsc 2>&1 | grep error".
  // The filter in those cases processes STDIN (stdout from the prior command),
  // not a file on disk. Direct usage as first command IS blocked.
  //
  // BLOCKED: grep "error" src/file.ts  |  head -100 src/file.ts  |  cat file.js
  // ALLOWED: npm run build | grep error |  tsc | head -50         |  git log | tail -20
  const CLI_FILE_READ = /^\s*(cat|tail|head|less|more|type|Get-Content|findstr|grep|wc)\b/i;
  const cmdSegments = cmd.split(/\s*[|;&]+\s*/);
  const firstSegment = cmdSegments[0] ?? '';
  if (CLI_FILE_READ.test(firstSegment)) {
    return {
      success: false,
      output:
        'SYSTEM ERROR: Intento de lectura de archivo por terminal bloqueado. ' +
        'NO uses comandos de consola (cat, type, grep, head, etc.) para leer código directamente. ' +
        'Usa read_file o search_in_files. ' +
        'Para filtrar OUTPUT de otro comando, usa el pipe: "npm run build | grep error" es VÁLIDO.',
    };
  }

  // ── Evasion Block: prevent sed, awk, node -e, perl, python -c ───────────────
  const EVASION_TOOLS = /^\s*(sed|awk|node\s+-e|perl|python\s+-c)\b/i;
  if (cmdSegments.some(seg => EVASION_TOOLS.test(seg))) {
    return {
      success: false,
      output:
        'SYSTEM SECURITY ALERT: Intento de evasión detectado. Tienes PROHIBIDO usar ' +
        'herramientas de CLI (sed, awk, node -e, etc.) para manipular código. ' +
        'Usa read_file y replace_block o replace_symbol inmediatamente.',
    };
  }

  // ── Persistent dev-server block ──────────────────────────────────────────────
  const PERSISTENT_PATTERNS = [
    /\bnpm\s+run\s+dev\b/,
    /\bnpm\s+start\b/,
    /\bnpm\s+run\s+start\b/,
    /\byarn\s+dev\b/,
    /\byarn\s+start\b/,
    /\bpnpm\s+dev\b/,
    /\bpnpm\s+start\b/,
    /\bnodemon\b/,
    /\bnext\s+dev\b/,
    /\bvite\b(?!\s+build)/,
    /\bwebpack\s+--watch\b/,
    /\bng\s+serve\b/,
  ];
  if (PERSISTENT_PATTERNS.some(p => p.test(cmd))) {
    return {
      success: false,
      output:
        'CRITICAL: Persistent servers like "npm run dev" hang the swarm. ' +
        'DIRECTIVE: Do not panic. Use "npm run build" instead to verify your changes and continue.',
    };
  }

  // ── Execute ──────────────────────────────────────────────────────────────────
  // v8.24.0 — Windows Spawn Strengthening: shell selection is centralized in
  // resolveShellOption() at the top of the module. Windows resolves to
  // %ComSpec% (typically C:\WINDOWS\system32\cmd.exe) with a `cmd.exe`
  // fallback for empty/detached env; POSIX gets explicit `shell: true` rather
  // than `undefined` so the execSync behavior is platform-deterministic. The
  // engine's Financial Killswitch (v8.24.0) depends on a clean one-shot
  // [YIELD TO HUMAN] payload when the OS shell genuinely cannot be reached —
  // making the spawn behavior implicit invited subtle differences across Node
  // versions and VS Code reload contexts.
  try {
    const output = execSync(cmd, {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout,
      maxBuffer: 1024 * 1024 * 4,
      shell: resolveShellOption(),
      env: { ...process.env },
    });
    return { success: true, output: output || '(command completed with no output)' };
  } catch (err: any) {
    // ── ENOENT cmd.exe detection (v8.16.8 → v8.24.0) ───────────────────────────
    // Surface a clear "yield to human" message instead of letting the LLM panic
    // and try to evade with PowerShell or sed/awk hacks. The engine's Financial
    // Killswitch breaks the loop on the [YIELD TO HUMAN sentinel before the
    // payload reaches the LLM, preventing API-credit drain on a problem that
    // lives outside the process. Detection broadened in v8.24.0 to also catch
    // the EPERM and EACCES variants seen on locked-down Windows hosts where
    // cmd.exe exists but is inaccessible to the spawned child.
    const errMsg = String(err?.message ?? err ?? '');
    const errCode = err?.code ?? '';
    const isShellMissing =
      (errCode === 'ENOENT' || errCode === 'EPERM' || errCode === 'EACCES') &&
      (/cmd\.exe/i.test(errMsg) || /spawnSync/i.test(errMsg) || /system32/i.test(errMsg) || /comspec/i.test(errMsg));
    if (isShellMissing) {
      return {
        success: false,
        output:
          '[YIELD TO HUMAN — Node Environment Error] spawnSync could not locate cmd.exe ' +
          '(ENOENT). This is NOT a code problem and NOT a tool problem — Node lost its ' +
          'reference to the system shell, usually because the ComSpec environment variable ' +
          'is empty or System32 is missing from PATH in this VS Code session. ' +
          'DO NOT retry this command. DO NOT switch to PowerShell, node -e, or any other ' +
          'evasion script. Stop the task and ask the user to: (1) restart VS Code from a ' +
          'fresh terminal so the environment is reloaded, or (2) verify that ' +
          '%ComSpec% points to C:\\Windows\\System32\\cmd.exe and that System32 is on PATH.',
      };
    }
    // execSync throws on non-zero exit — capture both stdout and stderr from the error object
    const stdout = err.stdout ? String(err.stdout).trim() : '';
    const stderr = err.stderr ? String(err.stderr).trim() : '';
    const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
    return { success: false, output: combined || errMsg || 'Command failed with no output' };
  }
}

```

### 📁 FILE: `src\tools\SearchImagesTool\index.ts`
```typescript
import { NativeTool, ToolResult } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'search_images',
    description: 'Get free stock image URLs for a given subject from Lorem Picsum.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Subject or keywords for the image search.' },
        count: { type: 'number', description: 'Number of URLs to return (1-10, default 5).' },
      },
      required: ['query'],
    },
  },
};

export function execute(args: Record<string, any>, _workspacePath: string): ToolResult {
  const query = encodeURIComponent(String(args.query || 'nature'));
  const count = Math.min(Math.max(Number(args.count) || 5, 1), 10);
  const urls: string[] = [];
  for (let i = 1; i <= count; i++) {
    urls.push(`https://picsum.photos/seed/${query}${i}/1400/900`);
  }
  return {
    success: true,
    output: [
      `Free image URLs for "${args.query}":`,
      ...urls.map((u, i) => `${i + 1}. ${u}`),
      '',
      'Usage: <img src="URL_HERE" alt="description" />',
    ].join('\n'),
  };
}

```

### 📁 FILE: `src\tools\SearchInFilesTool\index.ts`
```typescript
import { NativeTool, ToolResult, safePath, searchRecursive } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'search_in_files',
    description: 'Search for a text pattern across workspace files. Returns matching file:line results.',
    parameters: {
      type: 'object',
      properties: {
        pattern:   { type: 'string', description: 'The text pattern to search for (case-insensitive).' },
        directory: { type: 'string', description: 'Subdirectory to restrict the search. Defaults to workspace root.' },
      },
      required: ['pattern'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const searchRoot = safePath(workspacePath, args.directory || '.');
  const results: string[] = [];
  searchRecursive(searchRoot, workspacePath, String(args.pattern || ''), results, 0);
  if (results.length === 0) {
    return { success: true, output: 'No matches found.' };
  }
  return { success: true, output: results.slice(0, 60).join('\n') };
}

```

### 📁 FILE: `src\tools\SearchReplaceTool\index.ts`
```typescript
import * as fs from 'fs';
import * as path from 'path';
import { NativeTool, ToolResult, safePath } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'search_and_replace',
    description: `Replace a specific block of code in a file using contextual search — no line numbers required.
PREFERRED EDITING TOOL: Use this for small, surgical edits guided by the Verbatim Rule.

⚠️ SCOPE LIMIT (v8.16.18): If you need to inject a massive new React component, DO NOT use this tool. Use insert_lines instead.

⚠️ UDIFF-STYLE PRECISION (v8.17.3 — read this before every call):
  Guessing whitespace IS THE #1 cause of MATCH ERRORS in this tool. Tabs vs.
  spaces, trailing whitespace, CRLF vs. LF, indentation drift — all of them
  silently break the match even when the code "looks right" in your context.
  HARD RULE:
    1. ALWAYS call read_file (or get_repo_map → read_file) immediately before
       this tool to capture the file in its current state. Reading from memory
       of a previous turn is NOT allowed — files mutate.
    2. Copy the search_snippet VERBATIM from the read_file output, character
       for character, including every space and tab. Do NOT retype.
    3. Format the replace_snippet like a unified diff hunk: keep the SAME
       indentation level as the search_snippet's leading whitespace, preserve
       the SAME line-ending style, and leave NO trailing whitespace on new
       lines you add.
    4. If the previous call returned MATCH ERROR, do NOT retry with a guessed
       snippet — re-read the file and copy verbatim again. Your guess is wrong.

STRATEGY: In 'search_snippet', include enough context (2–3 lines before and after the target change) to ensure the match is unique in the file. Minor indentation differences are tolerated via fuzzy whitespace-normalization, but the fuzzy fallback is a safety net — it is NOT a license to improvise indentation.
WORKFLOW:
  1. Call read_file to get the current file content (MANDATORY — see UDIFF rule above).
  2. Copy the exact block you want to replace as search_snippet (include surrounding context for uniqueness).
  3. Call search_and_replace — the engine applies the change in the VS Code editor (file stays unsaved for review).
  4. After the call, tell the user: "Cambio aplicado en el editor. Revísalo y presiona Ctrl+S para guardar."
RULES:
  • search_snippet must match a unique block — add more surrounding lines if ambiguous.
  • No AST guards: the edit appears in VS Code for visual review before saving.
  • Use replace_snippet = "" to delete a block.
  • Do NOT call further edit tools on the same file before the user confirms with Ctrl+S.`,
    parameters: {
      type: 'object',
      properties: {
        path:            { type: 'string', description: 'File path relative to workspace root.' },
        search_snippet:  { type: 'string', description: 'The EXACT code currently in the file that you want to replace. Include 2–3 surrounding lines of context to guarantee uniqueness.' },
        replace_snippet: { type: 'string', description: 'The NEW code that will replace search_snippet. Use empty string "" to delete the block.' },
      },
      required: ['path', 'search_snippet', 'replace_snippet'],
    },
  },
};

// ─── Fuzzy Matching (mirrors ReplaceBlockTool logic) ─────────────────────────

function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

type MatchResult =
  | { kind: 'strict' }
  | { kind: 'fuzzy'; start: number; end: number }
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number };

function findMatch(fileContent: string, snippet: string): MatchResult {
  const content = fileContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const snip    = snippet.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const strictCount = content.split(snip).length - 1;
  if (strictCount === 1) { return { kind: 'strict' }; }
  if (strictCount > 1)  { return { kind: 'ambiguous', count: strictCount }; }

  // Fuzzy: line-by-line normalized comparison
  const fileLines = content.split('\n');
  const rawSnip = snip.split('\n');

  let si = 0, ei = rawSnip.length - 1;
  while (si <= ei && rawSnip[si].trim() === '') { si++; }
  while (ei >= si && rawSnip[ei].trim() === '') { ei--; }
  const snippetLines = rawSnip.slice(si, ei + 1);
  if (snippetLines.length === 0) { return { kind: 'none' }; }

  const snipNorm = snippetLines.map(normalizeLine);
  const n = snippetLines.length;
  const matches: number[] = [];

  outer: for (let i = 0; i <= fileLines.length - n; i++) {
    for (let j = 0; j < n; j++) {
      if (normalizeLine(fileLines[i + j]) !== snipNorm[j]) { continue outer; }
    }
    matches.push(i);
  }

  if (matches.length === 0) { return { kind: 'none' }; }
  if (matches.length > 1)  { return { kind: 'ambiguous', count: matches.length }; }
  return { kind: 'fuzzy', start: matches[0], end: matches[0] + n - 1 };
}

// ─── Diff Builder ─────────────────────────────────────────────────────────────

const MAX_DIFF_LINES = 25;

function buildDiffBlock(search: string, replace: string): string {
  const norm = (s: string) => s.replace(/\r\n/g, '\n').trimEnd();
  const remLines = norm(search).split('\n');
  const addLines = replace === '' ? [] : norm(replace).split('\n');

  const remSection = remLines.length > MAX_DIFF_LINES
    ? [...remLines.slice(0, MAX_DIFF_LINES).map(l => `- ${l}`), `- … (+${remLines.length - MAX_DIFF_LINES} lines not shown)`]
    : remLines.map(l => `- ${l}`);
  const addSection = addLines.length > MAX_DIFF_LINES
    ? [...addLines.slice(0, MAX_DIFF_LINES).map(l => `+ ${l}`), `+ … (+${addLines.length - MAX_DIFF_LINES} lines not shown)`]
    : addLines.map(l => `+ ${l}`);

  return '```diff\n' + [...remSection, ...addSection].join('\n') + '\n```';
}

// ─── Disk-based fallback executor (used when VS Code native edit is unavailable) ─

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const fp = safePath(workspacePath, args.path);
  if (!fs.existsSync(fp)) {
    return { success: false, output: `File not found: ${args.path}. Use list_dir to verify the path.` };
  }
  if (typeof args.search_snippet !== 'string' || args.search_snippet === '') {
    return { success: false, output: 'CRITICAL ERROR: search_snippet must be a non-empty string.' };
  }
  if (typeof args.replace_snippet !== 'string') {
    return { success: false, output: 'CRITICAL ERROR: replace_snippet must be a string. Use "" to delete.' };
  }

  const original = fs.readFileSync(fp, 'utf-8');
  const match = findMatch(original, args.search_snippet);

  if (match.kind === 'none') {
    return {
      success: false,
      output: `ERROR: El bloque exacto no se encontró (posible problema de indentación o archivo corrupto). Tienes PROHIBIDO volver a intentar search_and_replace en esta zona con un snippet adivinado. DEBES llamar read_file primero para copiar el texto VERBATIM, o usar insert_lines si vas a inyectar un bloque nuevo masivo.`,
    };
  }
  if (match.kind === 'ambiguous') {
    return {
      success: false,
      output: `AMBIGUOUS MATCH: search_snippet appears ${match.count} times in ${args.path}.\n` +
              `Expand the snippet — add more surrounding lines to make the block unique.`,
    };
  }

  let updated: string;
  let removedPreview: string;
  let removedLines: number;
  let startLine: number;

  if (match.kind === 'strict') {
    const snip = args.search_snippet.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    updated = original.replace(/\r\n/g, '\n').replace(snip, args.replace_snippet.replace(/\n$/, ''));
    const before = original.replace(/\r\n/g, '\n').indexOf(snip);
    startLine = original.slice(0, before).split('\n').length;
    removedLines = snip.split('\n').length;
    removedPreview = snip.length > 300 ? snip.slice(0, 300) + '\n…(truncated)' : snip;
  } else {
    const fileLines = original.replace(/\r\n/g, '\n').split('\n');
    const newLines = args.replace_snippet === '' ? [] : args.replace_snippet.replace(/\n$/, '').split('\n');
    updated = [...fileLines.slice(0, match.start), ...newLines, ...fileLines.slice(match.end + 1)].join('\n');
    startLine = match.start + 1;
    removedLines = match.end - match.start + 1;
    const removed = fileLines.slice(match.start, match.end + 1).join('\n');
    removedPreview = removed.length > 300 ? removed.slice(0, 300) + '\n…(truncated)' : removed;
  }

  if (updated.trim() === '' && original.trim() !== '') {
    return { success: false, output: 'SAFETY ABORT: replacement would produce an empty file.' };
  }

  // Auto-backup
  try {
    const backupDir = path.join(workspacePath, '.fluxo', 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(backupDir, `${path.basename(fp)}_${ts}.bak`), original, 'utf-8');
  } catch { /* non-fatal */ }

  fs.writeFileSync(fp, updated, 'utf-8');

  const matchNote = match.kind === 'fuzzy' ? ` [fuzzy match, line ${startLine}]` : ` [exact match, line ${startLine}]`;
  const diffBlock = buildDiffBlock(args.search_snippet, args.replace_snippet);
  return {
    success: true,
    output: `${diffBlock}\n\n**${args.path}** — ${removedLines} line${removedLines !== 1 ? 's' : ''} replaced.${matchNote}\n\nCambio aplicado en el editor. Revisa el Diff arriba y presiona Ctrl+S en el archivo para guardar.\n\nEDICIÓN EXITOSA — Si la tarea no está completa, llama la siguiente herramienta.`,
  };
}

```

### 📁 FILE: `src\tools\SendMessageTool\index.ts`
```typescript
import { NativeTool, ToolResult } from '../shared';
import { AgentMailbox } from '../../utils/agentMailbox';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'send_message',
    description: `Send a context payload to another agent running in a parallel thread.
The payload is delivered silently — it does NOT appear as raw content in the user's chat UI.
The recipient will receive it as an injected context message on their next iteration.
Use this to share API schemas, file paths, partial results, or any structured data between agents.`,
    parameters: {
      type: 'object',
      properties: {
        to_agent:   { type: 'string', description: 'ID of the recipient agent (e.g. "designer", "coder", "manager").' },
        from_agent: { type: 'string', description: 'Your own agent ID — so the recipient knows who sent the message.' },
        payload:    { type: 'string', description: 'The data or context to deliver. Can be JSON, plain text, or structured notes.' },
      },
      required: ['to_agent', 'from_agent', 'payload'],
    },
  },
};

export function execute(args: Record<string, any>, _workspacePath: string): ToolResult {
  const toAgent   = String(args.to_agent   ?? '').trim();
  const fromAgent = String(args.from_agent ?? 'unknown').trim();
  const payload   = String(args.payload    ?? '').trim();

  if (!toAgent) {
    return { success: false, output: 'send_message: "to_agent" is required.' };
  }
  if (!payload) {
    return { success: false, output: 'send_message: "payload" cannot be empty.' };
  }

  AgentMailbox.send(toAgent, fromAgent, payload);
  // The output here is the LLM's tool result AND the UI tooltip — keep it short.
  // The actual payload is stored silently in the mailbox, not echoed here.
  return {
    success: true,
    output: `Message queued for @${toAgent}. It will be injected into their context on the next iteration.`,
  };
}

```

### 📁 FILE: `src\tools\shared.ts`
```typescript
import * as fs from 'fs';
import * as path from 'path';

// ─── Shared Types ─────────────────────────────────────────────────────────────

export interface ToolResult {
  success: boolean;
  output: string;
}

export interface NativeTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      // Permissive to support array schemas (items, enum, etc.) alongside simple { type, description } entries.
      properties: Record<string, any>;
      required: string[];
    };
  };
}

// ─── Shared Helpers ───────────────────────────────────────────────────────────

// ─── Worktree Prefix Sanitizer (v8.22.0) ────────────────────────────────────
// The engine routes every file-tool call into the active worktree dynamically
// (the agent's "current sandbox"). Under recovery pressure the LLM still
// hallucinates the explicit worktree path on the front of its arguments —
// e.g. `.fluxo/worktrees/fluxo-wt-abc123/src/components/App.jsx` — which
// double-nests the path and produces a fatal FILE NOT FOUND. v8.21.0 already
// blocks `cd .fluxo/worktrees/...` at the run_command level (terminal vector);
// this helper closes the same hole on the file-tool vector by silently
// stripping the prefix in-place rather than failing. The agent is auto-
// corrected without spending an iteration on an error message it would only
// retry incorrectly.
//
// Pattern matches: optional leading slash/backslash + `.fluxo` + sep(s) +
// `worktrees` + sep(s) + one path segment (the worktree id) + sep(s).
// Case-insensitive (Windows). Tolerates both `/` and `\`.
const WORKTREE_PREFIX_REGEX = /^[\\/]?\.fluxo[\\/]+worktrees[\\/]+[^\\/]+[\\/]+/i;

export interface WorktreeStripResult {
  cleaned: string;
  stripped: boolean;
}

export function stripWorktreePrefix(rawPath: unknown): WorktreeStripResult {
  if (typeof rawPath !== 'string' || !rawPath) {
    return { cleaned: rawPath as string, stripped: false };
  }
  const trimmed = rawPath.trimStart();
  if (!WORKTREE_PREFIX_REGEX.test(trimmed)) {
    return { cleaned: rawPath, stripped: false };
  }
  const cleaned = trimmed.replace(WORKTREE_PREFIX_REGEX, '');
  // Edge case: bare `.fluxo/worktrees/<id>/` with no tail — nothing to do,
  // return original so downstream "missing path" errors stay legible.
  if (!cleaned) { return { cleaned: rawPath, stripped: false }; }
  return { cleaned, stripped: true };
}
// ────────────────────────────────────────────────────────────────────────────

// ─── Absolute Path Shield (v8.18.1) ─────────────────────────────────────────
// Phase 4 dogfooding revealed the LLM hallucinating Windows-absolute paths
// like C:/Users/erick/source/repos/... when reading or analyzing files. The
// guard rejects ANY path that starts with a drive letter (Windows: C:/ or
// C:\) or with a leading slash (POSIX: /home/...) BEFORE the tool reaches
// any filesystem call. Returns null when the path is acceptable, or a
// ToolResult error when it must be rejected. Tools call this at the very
// top of execute() so the rejection is uniform and the error message is
// the verbatim user-spec string.
const ABSOLUTE_PATH_REGEX = /^(?:[A-Za-z]:[\\/]|\/)/;

export function rejectIfAbsolutePath(rawPath: unknown): ToolResult | null {
  if (typeof rawPath !== 'string') { return null; }
  const trimmed = rawPath.trim();
  if (!trimmed) { return null; }
  if (ABSOLUTE_PATH_REGEX.test(trimmed)) {
    return {
      success: false,
      output:
        '[SYSTEM SHIELD] Absolute paths are strictly forbidden. ' +
        "You MUST use relative paths from the repository root (e.g., 'src/components/App.jsx').",
    };
  }
  return null;
}
// ────────────────────────────────────────────────────────────────────────────

export function safePath(workspacePath: string, p: string): string {
  if (!p) { throw new Error('Path is required'); }

  // ── Robust Path Sanitization (v7.14.0) ──────────────────────────────
  // Handles ALL known LLM path hallucinations:
  //   1. Docker-bias:   /workspace/src/file.tsx
  //   2. Overlap:       /workspace/d:\real\path\file.tsx  (Docker prefix + Windows absolute)
  //   3. Pure relative: src/file.tsx
  //   4. Pure absolute: d:\real\path\file.tsx (valid if inside workspace)
  let clean = p;
  if (clean.startsWith('/workspace/'))     { clean = clean.substring(11); }
  else if (clean.startsWith('workspace/')) { clean = clean.substring(10); }
  else if (clean.startsWith('\\workspace\\')) { clean = clean.substring(11); }

  const driveIndex = clean.search(/[a-zA-Z]:/);
  if (driveIndex > 0) {
    clean = clean.substring(driveIndex);
  }

  clean = path.normalize(clean);

  // Resolve to an absolute path
  const resolvedWs    = path.resolve(workspacePath);
  const resolvedClean = path.resolve(workspacePath, clean);

  // Case-insensitive comparison on Windows to ensure we are within the workspace root
  if (!resolvedClean.toLowerCase().startsWith(resolvedWs.toLowerCase())) {
    throw new Error(`Path traversal blocked or outside workspace: ${p}`);
  }

  return resolvedClean;
}

export function searchRecursive(
  dir: string,
  root: string,
  pattern: string,
  results: string[],
  depth: number
): void {
  if (depth > 6 || results.length > 100) { return; }
  const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '__pycache__']);

  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    if (SKIP.has(entry.name)) { continue; }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      searchRecursive(full, root, pattern, results, depth + 1);
    } else {
      try {
        const content = fs.readFileSync(full, 'utf-8');
        const lowerContent = content.toLowerCase();
        const lowerPattern = pattern.toLowerCase();
        if (lowerContent.includes(lowerPattern)) {
          const lines = content.split('\n');
          lines.forEach((line, i) => {
            if (line.toLowerCase().includes(lowerPattern)) {
              results.push(`${path.relative(root, full)}:${i + 1}: ${line.trim().slice(0, 120)}`);
            }
          });
        }
      } catch { /* binary file */ }
    }
  }
}

```

### 📁 FILE: `src\tools\SkillTool\index.ts`
```typescript
import { ToolResult, NativeTool } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'skill',
    description:
      'Access the Community Skills library — pre-built implementation recipes for common integrations. ' +
      'Use action="list" to see available skills. ' +
      'Use action="apply" with a skill_name to inject the recipe into .fluxo/IMPLEMENTATION_PLAN.md ' +
      'and skip manual planning for well-known tasks (e.g. stripe-payment-flow, firebase-auth, etc.).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'apply'],
          description: '"list" returns all available skills. "apply" injects a skill recipe into the implementation plan.',
        },
        skill_name: {
          type: 'string',
          description: 'The skill name to apply (required when action="apply"). Use the exact name returned by action="list".',
        },
      },
      required: ['action'],
    },
  },
};

export function execute(_args: Record<string, any>, _workspacePath: string): ToolResult {
  return {
    success: false,
    output: '[SYSTEM]: skill is intercepted by the engine. This execute() body should never run.',
  };
}

```

### 📁 FILE: `src\tools\TeamCreateTool\index.ts`
```typescript
import { NativeTool, ToolResult } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'create_team',
    description: `Launch a parallel team of sub-agents to work on INDEPENDENT tasks concurrently.
WHEN TO USE: Only when tasks have NO shared files and NO data dependencies between them.
Each sub-agent receives a fresh, isolated context — be explicit and self-contained in each task description.
The engine will run all agents with Promise.all and the FileLockManager will prevent file collisions.
EXAMPLE: { "team": [{"agent":"coder","task":"Build REST endpoints in src/api/..."},{"agent":"designer","task":"Create UI components in src/components/..."}] }`,
    parameters: {
      type: 'object',
      properties: {
        team: {
          type: 'array',
          description: 'Array of delegation entries. Each entry assigns one agent to one task.',
          items: {
            type: 'object',
            properties: {
              agent: { type: 'string', description: 'Agent ID to delegate to (e.g. "coder", "designer", "dashboard", "payments").' },
              task:  { type: 'string', description: 'Complete, self-contained task description for this agent. Include all context it needs — it has no memory of the current conversation.' },
            },
            required: ['agent', 'task'],
          },
        },
      },
      required: ['team'],
    },
  },
};

// The real execution is intercepted by agentEngine.ts (similar to ask_user_approval).
// This path is a safety fallback only and should never be reached in production.
export function execute(_args: Record<string, any>, _workspacePath: string): ToolResult {
  return {
    success: false,
    output: '[SYSTEM ENGINE ERROR]: create_team must be intercepted by the Parallel Swarm engine. This fallback should never execute.',
  };
}

```

### 📁 FILE: `src\tools\UpdateMemoryTool\index.ts`
```typescript
import * as fs from 'fs';
import * as path from 'path';
import { NativeTool, ToolResult } from '../shared';

const MEMORY_PATH = '.fluxo/memory.md';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'update_memory',
    description:
      'Create or overwrite the workspace memory file (.fluxo/memory.md). ' +
      'Use this tool when the user explicitly asks you to "remember" a rule, preference, or convention, ' +
      'OR when you and the user agree on an important architectural decision that should persist across sessions. ' +
      'Always include the full desired memory content — this overwrites the file completely. ' +
      'Read the existing memory first (if any) so you can merge old rules with new ones before writing.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description:
            'Full markdown content for .fluxo/memory.md. Use headings (##) to organize rules by category. ' +
            'Example sections: ## Coding Conventions, ## Architecture Decisions, ## User Preferences.',
        },
      },
      required: ['content'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  if (typeof args.content !== 'string' || args.content.trim() === '') {
    return { success: false, output: 'CRITICAL ERROR: "content" is missing or empty.' };
  }
  const memoryFilePath = path.join(workspacePath, MEMORY_PATH);
  fs.mkdirSync(path.dirname(memoryFilePath), { recursive: true });
  fs.writeFileSync(memoryFilePath, args.content, 'utf-8');
  const size = Buffer.byteLength(args.content, 'utf-8');
  return {
    success: true,
    output: `Workspace memory updated: ${MEMORY_PATH} (${size} bytes). Rules will be injected into all agents on the next session.`,
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

