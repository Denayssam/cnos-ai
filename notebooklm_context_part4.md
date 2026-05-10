# 📦 APP MANIFEST
* **App Name:** fluxo-ai
* **Version:** 8.33.0
* **Stack:** Vanilla JS
* **Part:** 4
* **Generated At:** 2026-05-06T00:32:33.630Z

---

### 📁 FILE: `FluxoAI_context_part4.md`
```text
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


```

### 📁 FILE: `gitcommands.md`
```text
git add .github/workflows/release.yml
git commit -m "fix: grant write permissions for gh release"
git push origin main

git push --delete origin v8.16.1
git tag -d v8.16.1

git tag v8.16.1
git push origin v8.16.1
Si prefieres la terminal en lugar de hacer clics, puedes usar: git reset --hard HEAD~N (donde N es la cantidad de commits de fluxo-auto-checkpoint que quieres retroceder)
git reset --hard HEAD~N
---

# 🛠️ Cheat-sheet: comandos que uso al desarrollar Fluxo AI

Todo se ejecuta desde la raíz del proyecto:
`d:\CNOS_Mirror\03_EXPERIMENTAL\cnos-extension`

## 1. Compilar TypeScript

Convierte `src/*.ts` en `out/*.js`. Es el paso obligatorio antes de empacar o probar.

```bash
npm run compile
```

Modo continuo (recompila al guardar — útil cuando estás iterando código):

```bash
npm run watch
```

Si compile falla, lee los errores `TSxxxx` y corrige; nunca empaques con errores de compilación.

## 2. Empacar el VSIX

Genera el archivo instalable `fluxo-ai-X.Y.Z.vsix`:

```bash
npx vsce package
```

Para regenerar limpio borra antes el VSIX viejo (sintaxis bash de Git Bash / VS Code terminal):

```bash
rm -f fluxo-ai-*.vsix && npx vsce package
```

En PowerShell:

```powershell
Remove-Item fluxo-ai-*.vsix -Force; npx vsce package
```

## 3. Instalar el VSIX en VS Code

### Opción A — Desde tu máquina local (más rápido)

El VSIX se genera en la raíz del proyecto. Instálalo así:

- **GUI:** `Ctrl+Shift+P` → *Extensions: Install from VSIX…* → selecciona `fluxo-ai-8.16.11.vsix`
- **Terminal:**
  ```bash
  code --install-extension fluxo-ai-8.16.11.vsix
  ```
  (reemplaza el número de versión por el que acabas de empacar)

### Opción B — Descargar desde GitHub Releases (el día que el VSIX local no exista)

Cuando se hace `git push origin vX.Y.Z`, el workflow de GitHub Actions compila
y publica el VSIX automáticamente como un GitHub Release con el archivo como Asset.

1. Ve a `https://github.com/Denayssam/cnos-ai/releases`
2. Encuentra el release `vX.Y.Z`
3. Descarga `fluxo-ai-X.Y.Z.vsix` desde la sección **Assets**
4. Instala con `Ctrl+Shift+P → Extensions: Install from VSIX…`

> Si el release no aparece todavía, el workflow puede tardar 1–2 minutos.
> Ve a `https://github.com/Denayssam/cnos-ai/actions` para ver el progreso.

## 4. Bumpear versión

Edita manualmente `package.json` línea `"version": "X.Y.Z"`.
Convención que venimos usando:

* **patch** (último número) — bug fix o ajuste pequeño: `8.16.7 → 8.16.8`
* **minor** (medio) — feature nueva o herramienta nueva: `8.16.x → 8.17.0`
* **major** (primero) — cambio arquitectónico grande: `8.x → 9.0.0`

Después del bump, **siempre** actualiza `CHANGELOG.md` con una entrada nueva al tope siguiendo el formato `## [vX.Y.Z] - Título` + `**Objetivo:**` + bullets.

## 5. Commit + push a main

```bash
git status --short
git add <archivos específicos>
git commit -m "feat(vX.Y.Z): descripción corta"
git push origin main
```

Evita `git add .` o `git add -A` — pueden colar binarios o archivos contextuales (notebooklm_*.md, gitcommands.md). Mejor stage explícito:

```bash
git add CHANGELOG.md package.json src/agents.ts out/agents.js out/agents.js.map src/tools/...
```

> **Nota:** `out/` está en `.gitignore` pero los archivos compilados ya están trackeados desde el historial legacy.
> Usa `git add -f out/agents.js out/agents.js.map` si git rechaza el add sin `-f`.

## 6. Tag + release automático (GitHub Actions)

El workflow en `.github/workflows/release.yml` se dispara con cualquier tag `v*` y publica el VSIX como GitHub Release automáticamente.

```bash
git tag v8.16.11
git push origin v8.16.11
```

Verificar el release una vez que GitHub Actions termina:

* Ve a `https://github.com/Denayssam/cnos-ai/actions` para ver el progreso del build.
* Ve a `https://github.com/Denayssam/cnos-ai/releases` para descargar el VSIX publicado.

## 7. Borrar y rehacer un tag (si te equivocaste)

```bash
git push --delete origin v8.16.11
git tag -d v8.16.11

git tag v8.16.11
git push origin v8.16.11
```

## 8. Flujo completo end-to-end

Esta es la secuencia exacta que ejecuto cuando termino una versión:

```bash
# 1. Verificar que compila limpio
npm run compile

# 2. Empacar el VSIX
rm -f fluxo-ai-*.vsix && npx vsce package

# 3. Stage explícito + commit
git add CHANGELOG.md package.json src/agents.ts src/tools/...
git add -f out/agents.js out/agents.js.map
git commit -m "feat(v8.16.11): descripción"

# 4. Push a main
git push origin main

# 5. Tag + push del tag (dispara el release)
git tag v8.16.11
git push origin v8.16.11

# 6. Instalar el VSIX local para probar
code --install-extension fluxo-ai-8.16.11.vsix
```

## 9. Inspeccionar estado y diff

```bash
git status --short            # qué archivos cambiaron
git diff                      # ver diff sin stagear
git diff --staged             # ver diff de lo ya stageado
git log --oneline -10         # últimos 10 commits
git show HEAD                 # último commit completo
git show --stat HEAD          # último commit con resumen de archivos
```

## 10. Recuperación / rollback

Si algo se rompe en main y necesitas volver al commit anterior **sin perder el código actual**:

```bash
git revert HEAD               # crea un commit que deshace el último — seguro
```

Si necesitas borrar cambios sin commitear (¡destructivo!):

```bash
git restore <archivo>         # descarta cambios de un archivo
git stash                     # guarda los cambios para después
git stash pop                 # los restaura
```

`git reset --hard HEAD~1` — **NO usar** salvo emergencia. Borra el último commit y todos los cambios. Si lo usas, asegúrate de que no hay trabajo sin pushear.

## 11. Ver qué hay en el VSIX antes de publicar

```bash
npx vsce ls --tree
```

Si ves archivos sensibles (`.env`, `credentials.json`, `notebooklm_*`), añádelos a `.vscodeignore` antes de empacar.

## 12. Limpieza ocasional

```bash
rm -rf out                    # borra el directorio compilado
npm run compile               # recompila desde cero
```

Útil cuando TypeScript se queda con artefactos viejos y los tipos parecen romperse sin razón.

---

## Notas rápidas

* `notebooklm_context_part*.md` y `gitcommands.md` están en `.gitignore` o los ignoramos manualmente — nunca van al repo.
* `out/` está en `.gitignore` pero los archivos compilados ya están trackeados desde antes (legacy). Cuando hagas `git add` específico, está bien incluirlos para mantener consistencia con el historial.
* El VSIX final pesa ~7.8 MB. Si crece mucho, revisa `.vscodeignore`.
* Los releases de GitHub Actions tardan 1–2 minutos. Si no aparecen, revisa que el workflow tenga permisos `contents: write`.

```

### 📁 FILE: `INSTALL.md`
```text
# Installation & Setup Guide — Fluxo AI (v7.8.2)

Follow these steps to deploy your autonomous agent swarm in VS Code.

## 1. Prerequisites

- **Node.js** v18 or higher
- **Visual Studio Code** 1.85+
- **Git**
- An API key from at least one supported provider:
  - [OpenRouter](https://openrouter.ai/keys) — access to Gemini, Claude, GPT-4o, DeepSeek via one key
  - [Google AI Studio](https://aistudio.google.com/apikey) — direct Gemini 2.5 Flash/Pro (faster, cheaper)
  - [DeepSeek](https://platform.deepseek.com/api_keys) — direct DeepSeek Chat/Reasoner

---

## 2. Build & Package

```bash
# Navigate to the extension folder
cd cnos-extension

# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Package as VSIX
npm run package
# → produces: fluxo-ai-7.8.2.vsix
```

---

## 3. Install to VS Code

```bash
code --install-extension fluxo-ai-7.8.2.vsix --force
```

Restart VS Code after installation so the extension host initializes correctly.

---

## 4. Configuration

1. Open VS Code Settings (`Ctrl+,`)
2. Search for **Fluxo AI**
3. Configure at minimum one API key:

| Setting | Description |
|---|---|
| `fluxo.openrouterApiKey` | OpenRouter key — access to all models via `/` prefix |
| `fluxo.geminiApiKey` | Google AI Studio key — enables bare `gemini-*` model names |
| `fluxo.deepseekApiKey` | DeepSeek direct key — enables bare `deepseek-*` model names |
| `fluxo.defaultModel` | Default model (recommended: `google/gemini-2.5-flash`) |
| `fluxo.maxTokens` | Max tokens per response (recommended: `16384` for coding tasks) |

**Recommended model for coding tasks:** `google/gemini-2.5-flash` (AI Studio key) — best balance of speed, cost and context window.

---

## 5. Launch

- Press `Ctrl+Alt+C` to open the Fluxo AI panel
- Or use the Command Palette: `Fluxo: Open AI Panel`
- The sidebar launcher also auto-opens the panel on click

---

## 6. Key Features & Tips

### Visual Diff (Fase 8)
When the agent uses `search_and_replace`, the file opens in your editor marked `●` (unsaved). Review the change and press `Ctrl+S` to save, or tell the agent to correct it.

### Hard Brake
If the agent generates an `IMPLEMENTATION_PLAN.md`, it pauses automatically. Review the plan file, edit it if needed, then tell the agent to proceed.

### Sentinel Auto-Heal
Click the 👁 **Guard** button in the header to activate real-time terminal monitoring. When a TypeScript/build error is detected, the Manager agent auto-intervenes.

### Model Persistence
Your last selected model is remembered across sessions — no need to re-select after reload.

### Developer: Reload Window
The Fluxo panel survives `Ctrl+Shift+P → Developer: Reload Window` — it reopens automatically.

### Context Compression
Click the **Token Wheel** (circular gauge in the header) when the conversation gets long. It summarizes history and frees up context window.

---

## 7. Building from Source (Development)

```bash
# Watch mode for TypeScript (auto-recompile on save)
npm run watch

# Press F5 in VS Code to launch Extension Development Host
```

---

## 8. Contributing

1. Follow the `search_and_replace` workflow — never use `write_file` on existing files
2. Run `npm run compile` before any PR to verify types pass
3. Bump `"version"` in `package.json` and all version strings before packaging
4. Check [CNOS_MANIFESTO.md](CNOS_MANIFESTO.md) for binding agent rules

---

*Fluxo Tech AI · [fluxotechai.com](https://fluxotechai.com)*

```

### 📁 FILE: `media\main.js`
```javascript
/* global acquireVsCodeApi */
// ─── Fluxo AI v8.3.0 — Native Visual Diff & Parallel Swarm ─────────────────────
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  // ─── DOM ────────────────────────────────────────────────────────────────────
  const messagesEl      = document.getElementById('messages');
  const promptInput     = document.getElementById('prompt-input');
  const sendBtn         = document.getElementById('send-btn');
  const cancelBtn       = document.getElementById('cancel-btn');
  const managerModelSelect = document.getElementById('manager-model-select');
  const workerModelSelect  = document.getElementById('worker-model-select');
  const agentBadge      = document.getElementById('agent-badge');
  const agentPills      = document.getElementById('agent-pills');
  const statusBar       = document.getElementById('status-bar');
  const statusText      = document.getElementById('status-text');
  const statusSpinner   = document.getElementById('status-spinner');
  const apiKeyWarning   = document.getElementById('api-key-warning');
  const workspaceLabel  = document.getElementById('workspace-label');
  const wheelProgress   = document.getElementById('wheel-progress');
  const wheelContainer  = document.getElementById('token-wheel-container');
  const sentinelBtn     = document.getElementById('sentinel-btn');
  const restoreBtn      = document.getElementById('restore-btn');
  const contextBar      = document.getElementById('context-bar');
  const contextBarFile  = document.getElementById('context-bar-file');
  const contextBarAction = document.getElementById('context-bar-action');

  // ─── State ─────────────────────────────────────────────────────────────────
  let isStreaming = false;
  let isUserScrolling = false;   // true when user scrolled up to read; suppresses auto-scroll
  let currentBubble = null;
  let currentStreamText = '';    // full accumulated text for history
  let currentBubbleText = '';    // text for the currently active visual bubble
  let currentResponseWrapper = null;
  let currentToolActivityItems = null;
  let hasToolCalls = false;
  let agents = [];
  let currentAgentId = 'coder';
  let chatHistory = [];
  let visualEvents = [];         // ordered visual log: persisted via vscode.setState for reload recovery
  const CONTEXT_LIMIT = 120000;

  // ─── Init ──────────────────────────────────────────────────────────────────
  vscode.postMessage({ type: 'ready' });

  // ─── Messages from Extension Host ─────────────────────────────────────────
  window.addEventListener('message', ({ data }) => {
    switch (data.type) {
      case 'config':           handleConfig(data);                                        break;
      case 'historySync':      handleHistorySync(data);                                   break;
      case 'workspaceInfo':    handleWorkspaceInfo(data);                                 break;
      case 'streamStart':      handleStreamStart();                                       break;
      case 'streamChunk':      handleStreamChunk(data.text || '');                        break;
      case 'streamEnd':        handleStreamEnd();                                         break;
      case 'streamCancelled':  handleStreamCancelled();                                   break;
      case 'error':            handleError(data.message || data.text || 'Unknown error'); break;
      case 'chatCleared':      handleChatCleared();                                       break;
      case 'prefillPrompt':    prefillPrompt(data.text || '');                            break;
      case 'status':           showStatus(data.text || '', false);                        break;
      case 'agentSelected':    handleAgentSelected(data);                                 break;
      case 'thinking':         handleThinking(data.text || '');                           break;
      case 'toolCall':         handleToolCall(data);                                      break;
      case 'toolResult':       handleToolResult(data);                                    break;
      case 'iterationCount':   handleIterationCount(data);                                break;
      case 'sentinelStatus':   handleSentinelStatus(data);                                break;
      case 'sentinelAlert':    handleSentinelAlert(data);                                 break;
      case 'modelsUpdate':     populateModels(data.models, data.model, data.workerModel); break;
      case 'worktreeReview':   handleWorktreeReview(data);                                break;
    }
  });

  // ─── Config & History ───────────────────────────────────────────────────────

  const MODEL_LABELS = {
    // Google AI Studio (direct key)
    'gemini-2.5-flash':           'Gemini 2.5 Flash (AI Studio)',
    'gemini-2.5-flash-lite':      'Gemini 2.5 Flash Lite (AI Studio)',
    'gemini-2.5-pro':             'Gemini 2.5 Pro (AI Studio)',
    'gemini-2.0-flash':           'Gemini 2.0 Flash (AI Studio)',
    'gemini-2.0-pro':             'Gemini 2.0 Pro (AI Studio)',
    // Google via OpenRouter
    'google/gemini-2.5-flash':      'Gemini 2.5 Flash (OpenRouter)',
    'google/gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite (OpenRouter)',
    'google/gemini-2.5-pro':        'Gemini 2.5 Pro (OpenRouter)',
    // DeepSeek direct
    'deepseek-chat':     'DeepSeek Chat (Direct)',
    'deepseek-reasoner': 'DeepSeek Reasoner (Direct)',
    // DeepSeek via OpenRouter
    'deepseek/deepseek-v3.2': 'DeepSeek V3.2 (OpenRouter)',
    // Anthropic via OpenRouter
    'anthropic/claude-3.7-sonnet': 'Claude 3.7 Sonnet (OpenRouter)',
    'anthropic/claude-3.5-haiku':  'Claude 3.5 Haiku (OpenRouter)',
    // OpenAI via OpenRouter
    'openai/gpt-4o':      'GPT-4o (OpenRouter)',
    'openai/gpt-4o-mini': 'GPT-4o Mini (OpenRouter)',
  };

  function populateModels(models, managerModel, workerModel) {
    if (!models || !models.length) { return; }
    const options = models.map(m => `<option value="${m}">${MODEL_LABELS[m] || m}</option>`).join('');

    const curManager = managerModelSelect.value;
    managerModelSelect.innerHTML = options;
    const pickManager = models.includes(managerModel) ? managerModel : (models.includes(curManager) ? curManager : models[0]);
    if (pickManager) { managerModelSelect.value = pickManager; }

    const curWorker = workerModelSelect.value;
    workerModelSelect.innerHTML = options;
    const pickWorker = models.includes(workerModel) ? workerModel : (models.includes(curWorker) ? curWorker : pickManager || models[0]);
    if (pickWorker) { workerModelSelect.value = pickWorker; }
  }

  function handleConfig(data) {
    if (data.models) { populateModels(data.models, data.model, data.workerModel); }
    else {
      if (data.model && managerModelSelect) { managerModelSelect.value = data.model; }
      if (data.workerModel && workerModelSelect) { workerModelSelect.value = data.workerModel; }
    }
    apiKeyWarning.classList.toggle('hidden', !!data.hasApiKey);
    if (data.agents) { agents = data.agents; buildAgentPills(); }

    // Try to restore full visual state (tool cards + messages) from webview storage first.
    // vscode.setState persists across Developer: Reload Window via the WebviewPanelSerializer.
    let restoredFromState = false;
    try {
      const saved = vscode.getState();
      if (saved && saved.visualEvents && saved.visualEvents.length) {
        visualEvents = saved.visualEvents;
        chatHistory = saved.chatHistory || [];
        renderVisualHistory();
        updateTokenWheel();
        restoredFromState = true;
      }
    } catch {}

    if (!restoredFromState) {
      if (data.history && data.history.length) {
        chatHistory = data.history;
        renderHistory();
        updateTokenWheel();
      } else {
        renderWelcome();
      }
    }
  }

  function handleHistorySync(data) {
    chatHistory = data.history || [];
    visualEvents = []; // compression replaces history — old tool cards are stale
    saveState();
    renderHistory();
    updateTokenWheel();
    hideStatus(); // clear any pending status (e.g. "Compressing context…")
  }

  function renderHistory() {
    messagesEl.innerHTML = '';
    chatHistory.forEach(msg => {
      const el = document.createElement('div');
      el.className = `message ${msg.role === 'user' ? 'user' : 'assistant'}`;
      const roleDiv = document.createElement('div');
      roleDiv.className = 'message-role';
      roleDiv.textContent = msg.role === 'user' ? 'You' : 'Fluxo';
      el.appendChild(roleDiv);
      if (msg.role === 'user') {
        el.appendChild(createUserBubble(msg.content));
      } else {
        const bbl = document.createElement('div');
        bbl.className = 'message-bubble';
        bbl.innerHTML = renderMarkdown(msg.content);
        el.appendChild(bbl);
      }
      messagesEl.appendChild(el);
      attachCodeListeners(el);
      attachFileLinkListeners(el);
    });
    scrollToBottom();
  }

  // ─── Visual State Persistence ────────────────────────────────────────────────

  function saveState() {
    try { vscode.setState({ visualEvents, chatHistory }); } catch {}
  }

  function renderVisualHistory() {
    messagesEl.innerHTML = '';
    visualEvents.forEach(evt => {
      if (evt.type === 'user') {
        const el = document.createElement('div');
        el.className = 'message user';
        el.innerHTML = '<div class="message-role">You</div>';
        el.appendChild(createUserBubble(evt.content));
        messagesEl.appendChild(el);

      } else if (evt.type === 'assistant') {
        const el = document.createElement('div');
        el.className = 'message assistant';
        el.innerHTML = '<div class="message-role">Fluxo</div>';
        const bbl = document.createElement('div');
        bbl.className = 'message-bubble';
        bbl.innerHTML = renderMarkdown(evt.content);
        el.appendChild(bbl);
        messagesEl.appendChild(el);
        attachCodeListeners(el);
        attachFileLinkListeners(el);

      } else if (evt.type === 'agentDivider') {
        const div = document.createElement('div');
        div.className = 'agent-divider';
        div.style.setProperty('--agent-color', evt.color);
        div.innerHTML = `<span>${evt.emoji} ${escapeHtml(evt.agentName)}</span>`;
        messagesEl.appendChild(div);

      } else if (evt.type === 'tool') {
        const statusIcon = evt.status === 'success' ? '✅' : evt.status === 'failed' ? '❌' : '⟳';
        const dur = evt.duration ? parseFloat(evt.duration) : 0;
        const timeStr = evt.duration ? (dur < 0.1 ? `${Math.round(dur * 1000)}ms` : `${evt.duration}s`) : '';
        const statusText = evt.status === 'pending' ? 'Working…' : `Worked (${timeStr})`;
        const el = document.createElement('div');
        el.className = `tool-call-card ${evt.status === 'success' ? 'success' : evt.status === 'failed' ? 'failed' : 'pending'} collapsed`;
        el.innerHTML = `
          <div class="tool-header">
            <span class="tool-name">${escapeHtml(evt.title || evt.name)}</span>
            <span class="tool-status-text">${statusText}</span>
            <span class="tool-status-icon">${statusIcon}</span>
          </div>
          <div class="tool-details"></div>
        `;
        const details = el.querySelector('.tool-details');
        if (evt.diffLines && evt.diffLines.length) {
          const diffEl = document.createElement('pre');
          diffEl.className = 'tool-diff-block';
          evt.diffLines.forEach(line => {
            const span = document.createElement('span');
            span.className = (line.startsWith('+ ') || line === '+') ? 'diff-add'
                           : (line.startsWith('- ') || line === '-') ? 'diff-remove'
                           : 'diff-ctx';
            span.textContent = line + '\n';
            diffEl.appendChild(span);
          });
          details.appendChild(diffEl);
          if (evt.restOutput) {
            const restEl = document.createElement('div');
            restEl.className = 'tool-output';
            restEl.textContent = evt.restOutput;
            details.appendChild(restEl);
          }
        } else if (evt.restOutput) {
          const outEl = document.createElement('div');
          outEl.className = 'tool-output';
          outEl.textContent = evt.restOutput;
          details.appendChild(outEl);
        }
        el.querySelector('.tool-header').addEventListener('click', () => el.classList.toggle('collapsed'));
        messagesEl.appendChild(el);
      }
    });
    scrollToBottom();
  }

  // ─── UI: Token Wheel ────────────────────────────────────────────────────────
  function updateTokenWheel(pendingChars = 0) {
    if (!wheelProgress) return;
    const historyChars = chatHistory.reduce((sum, m) => sum + (m.content?.length || 0), 0);
    const totalChars   = historyChars + pendingChars;
    const percentage   = Math.min(Math.round((totalChars / CONTEXT_LIMIT) * 100), 100);
    wheelProgress.setAttribute('stroke-dasharray', `${percentage}, 100`);
    wheelContainer.classList.toggle('warning',       percentage > 60 && pendingChars === 0);
    wheelContainer.classList.toggle('critical',      percentage > 85 && pendingChars === 0);
    wheelContainer.classList.toggle('input-preview', pendingChars > 0 && percentage <= 60);
    const tokenEst = `~${Math.round(totalChars / 4)} tokens`;
    const pendingNote = pendingChars > 0 ? ` (+${Math.round(pendingChars/4)} typed)` : '';
    wheelContainer.title = `Context: ${percentage}% (${tokenEst}${pendingNote}). Click to compress.`;
  }

  // ─── UI: Context Bar ────────────────────────────────────────────────────────
  const FILE_TOOL_ACTIONS = {
    read_file:          'leyendo',
    write_file:         'escribiendo',
    search_and_replace: 'editando',
    replace_lines:      'editando',
    replace_block:      'editando',
    edit_file:          'editando',
    delete_file:        'eliminando',
  };

  function setContextFile(toolName, filePath) {
    if (!contextBar || !contextBarFile || !filePath) return;
    const filename = filePath.split(/[\\/]/).pop() || filePath;
    contextBarFile.textContent  = filename;
    if (contextBarAction) contextBarAction.textContent = FILE_TOOL_ACTIONS[toolName] ? `[${FILE_TOOL_ACTIONS[toolName]}]` : '';
    contextBar.classList.remove('hidden');
  }

  function clearContextBar() {
    if (!contextBar) return;
    contextBar.classList.add('hidden');
    if (contextBarFile)   contextBarFile.textContent = '';
    if (contextBarAction) contextBarAction.textContent = '';
  }

  wheelContainer.addEventListener('click', () => {
    if (isStreaming) return;
    showStatus('Compressing context…', true);
    vscode.postMessage({ type: 'compressHistory' });
    wheelContainer.style.transform = 'scale(0.8)';
    setTimeout(() => { wheelContainer.style.transform = ''; }, 300);
  });

  // ─── Workspace Info ─────────────────────────────────────────────────────────
  function handleWorkspaceInfo(data) {
    workspaceLabel.textContent = (data.workspaceName ? `📂 ${data.workspaceName}` : '') + (data.fileName ? ` / ${data.fileName}` : '');
  }

  // ─── Stream Lifecycle ────────────────────────────────────────────────────────

  function handleStreamStart() {
    isStreaming = true;
    currentStreamText = '';
    currentBubbleText = '';
    currentBubble = null;
    hasToolCalls = false;
    sendBtn.disabled = true;
    cancelBtn.classList.remove('hidden');
    sendBtn.classList.add('hidden');
    document.querySelector('.input-wrapper')?.classList.add('swarm-active');
    messagesEl.querySelector('.welcome-card')?.remove();

    // Sequential wrapper — tools and text bubbles are appended in arrival order
    currentResponseWrapper = document.createElement('div');
    currentResponseWrapper.className = 'response-wrapper';
    messagesEl.appendChild(currentResponseWrapper);
    currentToolActivityItems = currentResponseWrapper;
    showStatus('Working…', true);
    scrollToBottom();
  }

  function handleStreamChunk(text) {
    document.getElementById('thinking-bubble')?.remove();
    currentStreamText += text;

    if (!currentBubble) {
      // Lazily create a text bubble in the sequential flow (after any tool cards)
      currentBubbleText = '';
      const msgEl = document.createElement('div');
      msgEl.className = 'message assistant';
      msgEl.innerHTML = '<div class="message-role">Fluxo</div><div class="message-bubble" id="streaming-bubble"></div>';
      (currentResponseWrapper || messagesEl).appendChild(msgEl);
      currentBubble = msgEl.querySelector('#streaming-bubble');
    }

    currentBubbleText += text;
    currentBubble.innerHTML = renderMarkdown(currentBubbleText) + '<span class="streaming-cursor"></span>';
    scrollToBottom();
  }

  function handleStreamEnd() {
    isStreaming = false;
    isUserScrolling = false;  // reset: response complete, snap to bottom
    document.getElementById('thinking-bubble')?.remove();

    if (currentBubble) {
      currentBubble.innerHTML = renderMarkdown(currentBubbleText);
      attachCodeListeners(currentBubble);
      attachFileLinkListeners(currentBubble);
      currentBubble.removeAttribute('id');
      chatHistory.push({ role: 'assistant', content: currentStreamText });
      visualEvents.push({ type: 'assistant', content: currentStreamText });
      saveState();
      updateTokenWheel();
    }

    currentResponseWrapper = null;
    currentToolActivityItems = null;
    currentBubble = null;
    currentBubbleText = '';

    sendBtn.disabled = false;
    sendBtn.classList.remove('hidden');
    cancelBtn.classList.add('hidden');
    document.querySelector('.input-wrapper')?.classList.remove('swarm-active');
    hideStatus();
    clearContextBar();
    scrollToBottom();
  }

  function handleStreamCancelled() {
    isStreaming = false;
    document.getElementById('thinking-bubble')?.remove();
    currentResponseWrapper = null;
    currentToolActivityItems = null;
    currentBubble = null;
    currentBubbleText = '';
    sendBtn.disabled = false;
    sendBtn.classList.remove('hidden');
    cancelBtn.classList.add('hidden');
    document.querySelector('.input-wrapper')?.classList.remove('swarm-active');
    hideStatus();
    clearContextBar();
  }

  function createUserBubble(text) {
    const MAX = 280;
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    const escaped = escapeHtml(text).replace(/\n/g, '<br>');
    if (text.length <= MAX) { bubble.innerHTML = escaped; return bubble; }
    const preview = escapeHtml(text.slice(0, MAX)).replace(/\n/g, '<br>');
    bubble.innerHTML = `<span class="msg-preview">${preview}<span class="msg-ellipsis"> …</span></span><span class="msg-full" style="display:none">${escaped}</span><button class="msg-expand-btn">Ver más ↓</button>`;
    bubble.querySelector('.msg-expand-btn').addEventListener('click', function() {
      const isExpanded = this.textContent === 'Ver menos ↑';
      bubble.querySelector('.msg-preview').style.display = isExpanded ? '' : 'none';
      bubble.querySelector('.msg-full').style.display = isExpanded ? 'none' : '';
      this.textContent = isExpanded ? 'Ver más ↓' : 'Ver menos ↑';
    });
    return bubble;
  }

  function sendMessage() {
    const text = promptInput.value.trim();
    if (!text || isStreaming) return;

    messagesEl.querySelector('.welcome-card')?.remove();
    const userEl = document.createElement('div');
    userEl.className = 'message user';
    const roleDiv = document.createElement('div');
    roleDiv.className = 'message-role';
    roleDiv.textContent = 'You';
    userEl.appendChild(roleDiv);
    userEl.appendChild(createUserBubble(text));
    messagesEl.appendChild(userEl);

    chatHistory.push({ role: 'user', content: text });
    visualEvents.push({ type: 'user', content: text });
    saveState();
    updateTokenWheel();

    promptInput.value = '';
    autoResize();
    scrollToBottom();
    vscode.postMessage({ type: 'sendMessage', text, managerModel: managerModelSelect.value, workerModel: workerModelSelect.value });
  }

  // ─── Agent UI & Pills ──────────────────────────────────────────────────────
  function buildAgentPills() {
    if (!agentPills) return;
    agentPills.innerHTML = agents.map(a =>
      `<button class="agent-pill ${a.id === currentAgentId ? 'active' : ''}" data-id="${a.id}" style="--agent-color:${a.color}">${a.emoji} ${a.name}</button>`
    ).join('');
    agentPills.querySelectorAll('.agent-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        currentAgentId = btn.dataset.id;
        agentPills.querySelectorAll('.agent-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        promptInput.placeholder = `Asking @${btn.dataset.id}...`;
      });
    });
  }

  function handleAgentSelected(data) {
    currentAgentId = data.agentId;
    agentBadge.textContent = `${data.emoji} ${data.agentName}`;
    agentBadge.style.setProperty('--agent-color', data.color);
    agentBadge.classList.remove('hidden');

    const div = document.createElement('div');
    div.className = 'agent-divider';
    div.style.setProperty('--agent-color', data.color);
    div.innerHTML = `<span>${data.emoji} ${data.agentName}</span>`;
    messagesEl.appendChild(div);
    visualEvents.push({ type: 'agentDivider', emoji: data.emoji, agentName: data.agentName, color: data.color });
    saveState();
    scrollToBottom();
  }

  function handleThinking(text) {
    document.getElementById('thinking-bubble')?.remove();
    const el = document.createElement('div');
    el.id = 'thinking-bubble';
    el.className = 'thinking-indicator';
    el.innerHTML = `<div class="loading-dots"><span></span><span></span><span></span></div> <em>${escapeHtml(text)}</em>`;
    (currentToolActivityItems || messagesEl).appendChild(el);
    scrollToBottom();
  }

  function getToolTitle(name, args) {
    switch (name) {
      case 'read_file':       return `• Read   ${args.path || ''}`;
      case 'write_file':      return `• Write  ${args.path || ''}`;
      case 'edit_file':       return `• Edit   ${args.path || ''}`;
      case 'replace_lines':   return `• Edit   ${args.path || ''} [L${args.start_line || '?'}–${args.end_line || '?'}]`;
      case 'replace_block':   return `• Block  ${args.path || ''}`;
      case 'run_command':     return `• $  ${(args.command || '').slice(0, 60)}`;
      case 'list_dir':        return `• ls     ${args.path || '.'}`;
      case 'search_in_files': return `• search "${(args.pattern || '').slice(0, 40)}"`;
      case 'delete_file':     return `• rm     ${args.path || ''}`;
      case 'delete_dir':      return `• rmdir  ${args.path || ''}`;
      case 'create_dir':      return `• mkdir  ${args.path || ''}`;
      case 'propose_plan':    return `• plan   IMPLEMENTATION_PLAN.md`;
      case 'search_images':   return `• img    "${(args.query || '').slice(0, 40)}"`;
      case 'enter_worktree':  return `• worktree  enter`;
      case 'exit_worktree':   return `• worktree  ${args.action || '?'}`;
      case 'create_team':     return `• team   [${(args.team || []).map(m => m.agent).join(', ')}]`;
      case 'send_message':    return `• msg  → @${args.to_agent || '?'}`;
      case 'replace_symbol':  return `• symbol  ${args.file_path || args.path || ''} :: ${args.symbol_name || '?'}`;
      case 'glob':            return `• glob   ${(args.pattern || '').slice(0, 50)}`;
      case 'grep':            return `• grep   "${(args.pattern || '').slice(0, 40)}"${args.path_filter ? ` in ${args.path_filter}` : ''}`;
      case 'enter_plan_mode': return `• plan   ${(args.task_description || '').slice(0, 50)}…`;
      case 'skill':           return args.action === 'apply' ? `• skill  apply → ${args.skill_name || '?'}` : `• skill  list`;
      default:                return `• ${name}`;
    }
  }

  function handleToolCall(data) {
    document.getElementById('thinking-bubble')?.remove();
    hasToolCalls = true;
    // Nullify current bubble — next streamChunk will create a new one below this tool card
    currentBubble = null;
    currentBubbleText = '';

    const args = data.args || {};
    const title = getToolTitle(data.name, args);

    // Register in visual state (pending — result will update it)
    visualEvents.push({ type: 'tool', name: data.name, title, status: 'pending', duration: null, diffLines: null, restOutput: null });
    saveState();

    // Update context bar for file-touching tools
    if (FILE_TOOL_ACTIONS[data.name] && args.path) {
      setContextFile(data.name, args.path);
    }

    // Native Diff (v8.3.0): simulated green-line preview removed.
    // File edits are reviewed via VS Code's native diff viewer (vscode.diff) in the Worktree Review card.
    let argsHtml = '';
    argsHtml = `<div class="tool-args">${escapeHtml(data.displayArgs || '')}</div>`;

    const el = document.createElement('div');
    el.className = 'tool-call-card pending collapsed';
    el.innerHTML = `
      <div class="tool-header">
        <span class="tool-name">${escapeHtml(title)}</span>
        <span class="tool-status-text">Working…</span>
        <span class="tool-status-icon spin">⟳</span>
      </div>
      <div class="tool-details">${argsHtml}</div>
    `;
    el.querySelector('.tool-header').addEventListener('click', () => el.classList.toggle('collapsed'));
    if (args.path) { el.dataset.filePath = args.path; }

    (currentToolActivityItems || messagesEl).appendChild(el);
    scrollToBottom();
  }

  function handleToolResult(data) {
    const container = currentToolActivityItems || messagesEl;
    const cards = container.querySelectorAll('.tool-call-card');
    const card = cards[cards.length - 1];
    if (card) {
      card.classList.remove('pending');
      card.classList.add(data.success ? 'success' : 'failed');
      card.querySelector('.tool-status-icon').textContent = data.success ? '✅' : '❌';
      card.querySelector('.tool-status-icon').classList.remove('spin');

      const duration = parseFloat(data.duration);
      const timeStr = duration < 0.1 ? `${Math.round(duration * 1000)}ms` : `${duration}s`;
      card.querySelector('.tool-status-text').textContent = `Worked (${timeStr})`;

      const details = card.querySelector('.tool-details');
      const isEngineError = typeof data.output === 'string' && data.output.startsWith('[SYSTEM ENGINE ERROR]:');

      // Detect LINES REMOVED / BLOCK REMOVED sections — render as collapsible
      const removedMarker = typeof data.output === 'string'
        ? (data.output.includes('\n\nLINES REMOVED:\n') ? '\n\nLINES REMOVED:\n'
         : data.output.includes('\n\nBLOCK REMOVED:\n') ? '\n\nBLOCK REMOVED:\n'
         : null)
        : null;

      // Detect ```diff block — render with syntax-colored lines
      const diffBlockMatch = (data.success && typeof data.output === 'string')
        ? data.output.match(/^```diff\n([\s\S]*?)```\n\n([\s\S]*)/)
        : null;

      if (diffBlockMatch) {
        const diffLines = diffBlockMatch[1].split('\n');
        const rest = diffBlockMatch[2].trim();
        const diffEl = document.createElement('pre');
        diffEl.className = 'tool-diff-block';
        diffLines.forEach(line => {
          const span = document.createElement('span');
          span.className = (line.startsWith('+ ') || line === '+') ? 'diff-add'
                         : (line.startsWith('- ') || line === '-') ? 'diff-remove'
                         : 'diff-ctx';
          span.textContent = line + '\n';
          diffEl.appendChild(span);
        });
        details.appendChild(diffEl);
        if (rest) {
          const restEl = document.createElement('div');
          restEl.className = 'tool-output';
          restEl.textContent = rest;
          details.appendChild(restEl);
        }
        // Working Tree button — opens VS Code's native git diff for this file
        const filePath = card.dataset.filePath;
        if (filePath) {
          const wtBtn = document.createElement('button');
          wtBtn.className = 'working-tree-btn';
          wtBtn.textContent = '🔍 Ver Working Tree';
          wtBtn.addEventListener('click', () => vscode.postMessage({ type: 'open_git_diff', path: filePath }));
          details.appendChild(wtBtn);
        }
      } else if (removedMarker && !isEngineError) {
        const markerIdx   = data.output.indexOf(removedMarker);
        const summaryText = data.output.slice(0, markerIdx).trim();
        const removedText = data.output.slice(markerIdx + removedMarker.length)
          .replace(/\n\nEDICIÓN EXITOSA.*$/, '').trim();

        const outputEl = document.createElement('div');
        outputEl.className = 'tool-output';
        outputEl.textContent = summaryText;
        details.appendChild(outputEl);

        const removedDetails = document.createElement('details');
        removedDetails.className = 'tool-removed-details';
        removedDetails.innerHTML = `
          <summary class="tool-removed-summary">👁 Ver líneas eliminadas</summary>
          <pre class="tool-removed-content">${escapeHtml(removedText)}</pre>
        `;
        details.appendChild(removedDetails);
      } else {
        const outputEl = document.createElement('div');
        outputEl.className = isEngineError ? 'tool-output tool-output-error' : 'tool-output';
        outputEl.textContent = data.output;
        details.appendChild(outputEl);
      }

      if (data.name === 'write_file' && data.success) {
        const pathMatch = data.output.match(/Written: (.+?) \(/);
        if (pathMatch) {
          const link = document.createElement('div');
          link.className = 'tool-file-link';
          link.innerHTML = `<span class="file-link">📄 Open File</span>`;
          link.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: pathMatch[1] }));
          details.appendChild(link);
        }
      }

      // Persist tool result — update the last pending tool in visualEvents
      const lastPendingTool = [...visualEvents].reverse().find(m => m.type === 'tool' && m.status === 'pending');
      if (lastPendingTool) {
        lastPendingTool.status = data.success ? 'success' : 'failed';
        lastPendingTool.duration = data.duration || null;
        if (diffBlockMatch) {
          lastPendingTool.diffLines = diffBlockMatch[1].split('\n');
          lastPendingTool.restOutput = (diffBlockMatch[2] || '').trim().slice(0, 300);
        } else if (typeof data.output === 'string') {
          lastPendingTool.restOutput = data.output.slice(0, 300);
        }
        saveState();
      }
    }
    scrollToBottom();
  }

  // ─── Worktree Human Review Card (v8.3.0) ────────────────────────────────────
  // Shown when exit_worktree(merge) is intercepted before execution.
  // The agent loop is suspended until the user clicks Approve or Discard.
  function handleWorktreeReview(data) {
    document.getElementById('thinking-bubble')?.remove();

    const changedFiles = Array.isArray(data.changedFiles) ? data.changedFiles : [];
    const filesHtml = changedFiles.slice(0, 20).map(f =>
      `<button class="wt-file-btn" data-file="${escapeHtml(f)}">${escapeHtml(f)}</button>`
    ).join('');
    const filesSection = changedFiles.length > 0
      ? `<div class="wt-files-list"><span class="wt-files-label">Archivos modificados:</span>${filesHtml}</div>`
      : '';

    const el = document.createElement('div');
    el.className = 'worktree-review-card';
    el.innerHTML = `
      <div class="wt-review-header">
        <span class="wt-icon">🔀</span>
        <strong>Worktree listo para revisión</strong>
        <span class="wt-branch-badge">${escapeHtml(data.branch || '')}</span>
      </div>
      <p class="wt-hint">Revisa los cambios en la pestaña de Diff de VS Code antes de decidir.</p>
      ${filesSection}
      <div class="wt-actions">
        <button class="wt-btn wt-approve">✅ Aprobar Merge</button>
        <button class="wt-btn wt-discard">🗑️ Descartar Worktree</button>
      </div>
    `;

    el.querySelectorAll('.wt-file-btn').forEach(btn => {
      btn.addEventListener('click', () =>
        vscode.postMessage({ type: 'open_worktree_diff', filePath: btn.dataset.file })
      );
    });

    const approveBtn = el.querySelector('.wt-approve');
    const discardBtn = el.querySelector('.wt-discard');

    approveBtn.addEventListener('click', () => {
      approveBtn.disabled = true;
      discardBtn.disabled = true;
      approveBtn.textContent = '⏳ Merging…';
      vscode.postMessage({ type: 'worktree_decision', action: 'merge' });
    });

    discardBtn.addEventListener('click', () => {
      approveBtn.disabled = true;
      discardBtn.disabled = true;
      discardBtn.textContent = '⏳ Discarding…';
      vscode.postMessage({ type: 'worktree_decision', action: 'discard' });
    });

    (currentToolActivityItems || messagesEl).appendChild(el);
    scrollToBottom();
  }
  // ─────────────────────────────────────────────────────────────────────────────

  function handleIterationCount(data) {
    if (!statusBar || !statusText) { return; }
    statusBar.classList.remove('hidden');
    statusText.textContent = `Iter. ${data.count} / ${data.max}`;
  }

  function handleSentinelStatus(data) {
    if (!sentinelBtn) { return; }
    const active = !!data.active;
    sentinelBtn.classList.toggle('sentinel-active', active);
    sentinelBtn.title = active
      ? '🟢 Sentinel activo — click para desactivar'
      : '👁 Sentinel inactivo — click para activar auto-curación';
    const label = sentinelBtn.querySelector('.sentinel-label');
    if (label) { label.textContent = active ? 'ON' : 'Guard'; }
  }

  function handleSentinelAlert(data) {
    messagesEl.querySelector('.welcome-card')?.remove();

    const el = document.createElement('div');
    el.className = 'message sentinel-alert';
    el.innerHTML = `
      <div class="message-role">🔴 Sentinel</div>
      <div class="message-bubble">
        <strong>Error detectado en la terminal:</strong>
        <details class="tool-result-details" style="margin-top:8px">
          <summary>📋 Ver error completo</summary>
          <pre class="tool-result-content"><code>${escapeHtml(data.errorText || '')}</code></pre>
        </details>
        <em style="font-size:11px;opacity:0.7">Analizando y preparando solución…</em>
      </div>
    `;
    messagesEl.appendChild(el);

    // Track in local chatHistory for token-wheel accuracy
    chatHistory.push({ role: 'user', content: `Sentinel error:\n${data.errorText || ''}` });
    updateTokenWheel();
    scrollToBottom();
  }

  function handleChatCleared() {
    chatHistory = [];
    visualEvents = [];
    saveState();
    messagesEl.innerHTML = '';
    renderWelcome();
    updateTokenWheel();
    hideStatus();
    agentBadge.classList.add('hidden');
    clearContextBar();
  }

  // ─── Error Handler ──────────────────────────────────────────────────────────
  function handleError(text) {
    isStreaming = false;
    document.getElementById('thinking-bubble')?.remove();

    // Clean up any open response wrapper
    if (currentResponseWrapper) {
      const details = currentResponseWrapper.querySelector('.tool-activity');
      if (details && !hasToolCalls) details.remove();
      currentResponseWrapper = null;
      currentToolActivityItems = null;
    }

    sendBtn.disabled = false;
    sendBtn.classList.remove('hidden');
    cancelBtn.classList.add('hidden');
    hideStatus();
    currentBubble = null;

    const el = document.createElement('div');
    el.className = 'message-error';
    el.innerHTML = `<strong>Error:</strong> ${escapeHtml(text)}`;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  // ─── Helpers (Markdown/UI) ──────────────────────────────────────────────────
  function renderWelcome() {
    messagesEl.innerHTML = `
      <div class="welcome-card">
        <div class="welcome-logo">🐾</div>
        <h2 class="welcome-title">Fluxo AI <span class="welcome-version">v8.33.0</span></h2>
        <div class="welcome-tips">
          <div class="tip"><span class="tip-key">↵</span> Send</div>
          <div class="tip-sep">·</div>
          <div class="tip"><span class="tip-key">@agent</span> Switch</div>
        </div>
        <a class="welcome-watermark" href="https://fluxotechai.com" target="_blank">⚡ Powered by Fluxo Tech AI</a>
      </div>`;
  }

  function renderMarkdown(text) {
    const reasoningBlocks = [];
    const thinkingBlocks  = [];
    const toolResultBlocks = [];
    let html = escapeHtml(text);

    // 0a. Extract <reasoning> blocks → collapsible (rendered as markdown)
    html = html.replace(/&lt;reasoning&gt;([\s\S]*?)&lt;\/reasoning&gt;/gi, (_, content) => {
      const placeholder = `{{REASONING_BLOCK_${reasoningBlocks.length}}}`;
      reasoningBlocks.push(`
        <details class="reasoning-details">
          <summary>• Thought ></summary>
          <div class="reasoning-content">${renderMarkdownInner(content)}</div>
        </details>
      `);
      return placeholder;
    });

    // 0b. Extract <tool_result> blocks → collapsible pre/code (never markdown-rendered)
    html = html.replace(/&lt;tool_result&gt;([\s\S]*?)&lt;\/tool_result&gt;/gi, (_, content) => {
      const placeholder = `{{TOOL_RESULT_BLOCK_${toolResultBlocks.length}}}`;
      toolResultBlocks.push(`
        <details class="tool-result-details">
          <summary>📥 Resultado del sistema</summary>
          <pre class="tool-result-content"><code>${content.trim()}</code></pre>
        </details>
      `);
      return placeholder;
    });

    // 0c. Extract complete <thinking> blocks → collapsible accordion (v8.7.1 Clean Output)
    html = html.replace(/&lt;thinking&gt;([\s\S]*?)&lt;\/thinking&gt;/gi, (_, content) => {
      const placeholder = `{{THINKING_BLOCK_${thinkingBlocks.length}}}`;
      thinkingBlocks.push(`
        <details class="thinking-details">
          <summary>💭 Ver proceso de pensamiento</summary>
          <div class="thinking-content">${renderMarkdownInner(content.trim())}</div>
        </details>
      `);
      return placeholder;
    });

    // 0d. Strip incomplete (still-open) <thinking> blocks — the closing tag hasn't
    // arrived yet mid-stream. Prevents partial CoT leaking into the bubble.
    html = html.replace(/&lt;thinking&gt;[\s\S]*$/gi, '');

    html = renderMarkdownInner(html);

    reasoningBlocks.forEach((block, i) => {
      html = html.replace(`{{REASONING_BLOCK_${i}}}`, block);
    });
    thinkingBlocks.forEach((block, i) => {
      html = html.replace(`{{THINKING_BLOCK_${i}}}`, block);
    });
    toolResultBlocks.forEach((block, i) => {
      html = html.replace(`{{TOOL_RESULT_BLOCK_${i}}}`, block);
    });

    return html;
  }

  function renderMarkdownInner(text) {
    const codeBlocks = [];
    let html = text;

    // 1. Protect code blocks (```)
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const c = code.trimEnd();
      const placeholder = `{{CODE_BLOCK_${codeBlocks.length}}}`;
      const rawC = c.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

      let innerHtml;
      if (lang === 'diff') {
        innerHtml = c.split('\n').map(line => {
          if (line.startsWith('+ ') || line === '+') return `<span class="diff-add">${line}</span>`;
          if (line.startsWith('- ') || line === '-') return `<span class="diff-remove">${line}</span>`;
          return `<span class="diff-ctx">${line}</span>`;
        }).join('\n');
      } else {
        innerHtml = c;
      }

      codeBlocks.push(`<div class="code-block"><div class="code-header"><span class="code-lang">${lang || 'txt'}</span><button class="code-btn copy-btn" data-code="${encodeURIComponent(rawC)}">Copy</button></div><pre><code>${innerHtml}</code></pre></div>`);
      return placeholder;
    });

    // 2. Protect inline code (`)
    html = html.replace(/`([^`]+)`/g, (_, code) => {
      const placeholder = `{{CODE_BLOCK_${codeBlocks.length}}}`;
      codeBlocks.push(`<code>${code}</code>`);
      return placeholder;
    });

    // 2.5. Magic Links — detect file paths and render as clickable buttons
    // Matches: src/foo/bar.ts · .fluxo/memory.md · path/to/file.ext
    // Skipped: already-protected {{CODE_BLOCK_N}} placeholders, URLs (http://)
    const FILE_PATH_RE = /(?<![/"'`(\\:])(?:\.?\/?[\w-][\w.-]*\/)+[\w-][\w.-]*\.(?:ts|tsx|js|jsx|mjs|cjs|md|json|css|scss|html|py|txt|env|svg|png|jpg|vue|yaml|yml|toml)\b/g;
    html = html.replace(FILE_PATH_RE, match =>
      `<button class="file-link-btn" data-path="${match}" title="Open ${match}">${match}</button>`
    );

    // 3. Render other markdown
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // 4. Handle line breaks
    html = html.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>');

    // 5. Re-inject protected blocks
    codeBlocks.forEach((block, i) => {
      html = html.replace(`{{CODE_BLOCK_${i}}}`, block);
    });

    return html;
  }

  function escapeHtml(str) { return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function scrollToBottom() {
    if (isUserScrolling) return;
    const container = document.getElementById('chat-container');
    if (!container) return;
    if (isStreaming) {
      container.scrollTop = container.scrollHeight;
    } else {
      container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    }
  }

  function autoResize() {
    // Measure without transition, then animate to new height
    promptInput.style.transition = 'none';
    promptInput.style.height = 'auto';
    const newH = Math.min(promptInput.scrollHeight, 150) + 'px';
    requestAnimationFrame(() => {
      promptInput.style.transition = 'height 0.14s cubic-bezier(0.4, 0, 0.2, 1)';
      promptInput.style.height = newH;
    });
  }

  // ─── Status Bar ─────────────────────────────────────────────────────────────
  function showStatus(text, spinner = false) {
    statusBar.classList.remove('hidden');
    statusText.textContent = text;
    statusSpinner.classList.toggle('hidden', !spinner);
  }

  function hideStatus() {
    statusBar.classList.add('hidden');
  }

  // ─── Misc ───────────────────────────────────────────────────────────────────
  function prefillPrompt(text) {
    promptInput.value = text;
    autoResize();
    promptInput.focus();
  }

  function attachCodeListeners(el) {
    el.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'copyCode', code: decodeURIComponent(btn.dataset.code) });
        btn.textContent = '✓';
        setTimeout(() => btn.textContent = 'Copy', 1500);
      });
    });
  }

  function attachFileLinkListeners(el) {
    el.querySelectorAll('.file-link-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'open_file', path: btn.dataset.path });
      });
    });
  }

  // ─── Listeners ─────────────────────────────────────────────────────────────
  sendBtn.addEventListener('click', sendMessage);
  promptInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
  promptInput.addEventListener('input', () => {
    autoResize();
    updateTokenWheel(promptInput.value.length);
  });
  document.getElementById('settings-btn').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
  cancelBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancelStream' }));
  sentinelBtn?.addEventListener('click', () => vscode.postMessage({ type: 'sentinelToggle' }));
  // North Star v8.25.0 — Restore Workspace Only (Cline-style atomic rollback).
  // Confirmation dialog lives extension-side (vscode.window.showWarningMessage)
  // because git reset --hard HEAD~1 is destructive; we just signal intent here.
  restoreBtn?.addEventListener('click', () => vscode.postMessage({ type: 'restoreWorkspace' }));
  document.getElementById('streaming-info-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'showStreamingInfo' }));
  managerModelSelect.addEventListener('change', () => vscode.postMessage({ type: 'saveModel', managerModel: managerModelSelect.value }));
  workerModelSelect.addEventListener('change', () => vscode.postMessage({ type: 'saveModel', workerModel: workerModelSelect.value }));

  // ─── Smart Scroll ────────────────────────────────────────────────────────────
  // If the user scrolls up while the agent is working, pause auto-scroll.
  // Resume as soon as they return to the bottom (within 120 px threshold).
  const chatContainer = document.getElementById('chat-container');
  if (chatContainer) {
    chatContainer.addEventListener('scroll', () => {
      const { scrollTop, clientHeight, scrollHeight } = chatContainer;
      isUserScrolling = (scrollHeight - scrollTop - clientHeight) > 120;
    });
  }

})();

```

### 📁 FILE: `media\style.css`
```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

:root {
  --bg: #020617;
  --bg-elevated: rgba(255,255,255,0.04);
  --bg-hover: rgba(255,255,255,0.07);
  --border: rgba(255,255,255,0.08);
  --border-strong: rgba(255,255,255,0.15);
  --accent: #4f46e5;
  --accent-light: #818cf8;
  --accent-glow: rgba(79, 70, 229, 0.25);
  --accent-bg: rgba(79, 70, 229, 0.08);
  --text-primary: var(--vscode-foreground, #f8fafc);
  --text-secondary: rgba(248, 250, 252, 0.7);
  --text-muted: rgba(232,232,237,0.35);
  --user-bg: rgba(255, 255, 255, 0.03);
  --user-border: rgba(79, 70, 229, 0.4);
  --assistant-bg: rgba(79, 70, 229, 0.05);
  --assistant-border: #4f46e5;
  --success: #10b981;
  --warning: #f59e0b;
  --danger: #ef4444;
  --code-bg: rgba(0,0,0,0.35);
  --diff-add-bg: rgba(16, 185, 129, 0.12);
  --diff-add-text: #6ee7b7;
  --diff-rem-bg: rgba(239, 68, 68, 0.12);
  --diff-rem-text: #fca5a5;
  --radius: 4px; --radius-sm: 2px;
  --font: 'Inter', var(--vscode-font-family, sans-serif);
  --font-mono: 'JetBrains Mono', var(--vscode-editor-font-family, monospace);
  --font-size: 13px;
  --transition: 0.15s ease;
  --agent-color: var(--accent);
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: hidden; font-family: var(--font); font-size: var(--font-size); color: var(--text-primary); background: #020617 !important; line-height: 1.6; }

body { display: flex; flex-direction: column; height: 100vh; }

/* ─── Header ─────────────────────────────────────────────────────────────── */
.header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; border-bottom: 1px solid var(--border);
  background: var(--bg); flex-shrink: 0; gap: 8px;
}
.header-title { font-size: 13px; font-weight: 600; letter-spacing: 0.05em; color: var(--text-primary); font-family: 'Inter', 'Geist', var(--vscode-font-family, sans-serif); text-shadow: 0 0 12px rgba(79, 70, 229, 0.7), 0 0 28px rgba(79, 70, 229, 0.35); }

/* ─── Token Wheel ───────────────────────────────────────────────────────────── */
.token-wheel-container {
  position: relative; width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: transform 0.2s;
}
.token-wheel-container:hover { transform: scale(1.1); }
.token-wheel { width: 100%; height: 100%; transform: rotate(-90deg); }
.wheel-bg { fill: none; stroke: var(--border); stroke-width: 2.8; }
.wheel-progress {
  fill: none; stroke: var(--accent); stroke-width: 2.8;
  stroke-linecap: round; transition: stroke-dasharray 0.5s ease;
}
.token-wheel-container .logo-dot {
  position: absolute; width: 6px; height: 6px; z-index: 1;
}

.token-wheel-container.critical .wheel-progress { stroke: var(--danger); filter: drop-shadow(0 0 4px var(--danger)); }
.token-wheel-container.warning .wheel-progress { stroke: var(--warning); }
.token-wheel-container.input-preview .wheel-progress { stroke: var(--accent-light); filter: drop-shadow(0 0 3px rgba(129,140,248,0.5)); transition: stroke 0.15s, filter 0.15s; }

.agent-badge {
  font-size: 10px; font-weight: 600;
  background: rgba(var(--agent-color), 0.15);
  border: 1px solid var(--agent-color);
  border-color: var(--agent-color);
  color: var(--agent-color);
  padding: 2px 8px; border-radius: 20px;
  animation: fadeSlideIn 0.2s ease;
}
.agent-badge.hidden { display: none; }

.model-select {
  font-family: var(--font); font-size: 10.5px;
  background: var(--bg-elevated); color: var(--text-secondary);
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: 3px 6px; cursor: pointer; outline: none; max-width: 130px;
  transition: border-color var(--transition);
}
.model-select:hover { border-color: var(--border-strong); }
.model-select:focus { border-color: var(--accent); }
.model-select option { background: #020617; }

.header-right { display: flex; align-items: center; gap: 6px; }

.header-btn {
  display: flex; align-items: center; justify-content: center;
  background: transparent; color: var(--text-muted);
  border: 1px solid transparent; border-radius: 4px;
  padding: 4px; cursor: pointer; transition: all var(--transition);
}
.header-btn:hover { background: var(--bg-hover); color: var(--text-primary); border-color: var(--border); }

/* ─── Agent Bar ────────────────────────────────────────────────────────────── */
.agent-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 12px; border-bottom: 1px solid var(--border);
  background: rgba(0,0,0,0.1); flex-shrink: 0; overflow-x: auto;
}
.agent-bar::-webkit-scrollbar { height: 2px; }
.agent-bar-label { font-size: 10px; color: var(--text-muted); flex-shrink: 0; }

.agent-pills { display: flex; gap: 5px; }

.agent-pill {
  font-family: var(--font); font-size: 10.5px;
  background: var(--bg-elevated); color: var(--text-secondary);
  border: 1px solid var(--border); border-radius: 20px;
  padding: 3px 10px; cursor: pointer; white-space: nowrap;
  transition: all var(--transition);
}
.agent-pill:hover { border-color: var(--agent-color); color: var(--agent-color); background: rgba(var(--agent-color), 0.1); }
.agent-pill.active {
  background: rgba(0,0,0,0.2);
  border-color: var(--agent-color);
  color: var(--agent-color);
  font-weight: 600;
}

/* ─── Context Bar ────────────────────────────────────────────────────────────── */
.context-bar {
  display: flex; align-items: center; gap: 5px;
  padding: 3px 12px; flex-shrink: 0;
  background: rgba(255,255,255,0.025);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid rgba(255,255,255,0.045);
  font-size: 10px; font-family: var(--font-mono);
  color: var(--text-muted);
  animation: fadeSlideIn 0.18s ease;
}
.context-bar.hidden { display: none !important; }
.context-bar-label { opacity: 0.45; letter-spacing: 0.03em; }
.context-bar-file {
  color: var(--accent-light); font-weight: 500;
  letter-spacing: 0.02em;
  text-shadow: 0 0 8px rgba(129,140,248,0.3);
}
.context-bar-action {
  opacity: 0.38; font-size: 9.5px; margin-left: 2px;
}
.context-bar::before {
  content: '◈'; font-size: 8px; opacity: 0.4;
  color: var(--accent-light); margin-right: 2px;
}

/* ─── Status Bar ────────────────────────────────────────────────────────────── */
.status-bar {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 12px; font-size: 10.5px; color: var(--text-muted);
  border-bottom: 1px solid var(--border); background: var(--bg-elevated); flex-shrink: 0;
}
.status-bar.hidden { display: none; }

.status-spinner { display: flex; gap: 3px; align-items: center; }
.status-spinner span {
  width: 4px; height: 4px; border-radius: 50%; background: var(--accent-light);
  animation: dotBounce 1.2s ease-in-out infinite;
}
.status-spinner span:nth-child(2) { animation-delay: 0.2s; }
.status-spinner span:nth-child(3) { animation-delay: 0.4s; }
.status-spinner.hidden { display: none; }

@keyframes dotBounce {
  0%,60%,100% { transform: translateY(0); opacity: 0.5; }
  30% { transform: translateY(-4px); opacity: 1; }
}

/* ─── API Warning ────────────────────────────────────────────────────────────── */
.api-warning {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; background: rgba(245,158,11,0.08);
  border-bottom: 1px solid rgba(245,158,11,0.2);
  font-size: 11px; color: #f59e0b; flex-shrink: 0;
}
.api-warning.hidden { display: none; }
.api-warning em { opacity: 0.75; font-style: normal; }

/* ─── Chat ───────────────────────────────────────────────────────────────────── */
.chat-container { flex: 1; overflow-y: auto; overflow-x: hidden; }
.chat-container::-webkit-scrollbar { width: 3px; }
.chat-container::-webkit-scrollbar-track { background: transparent; }
.chat-container::-webkit-scrollbar-thumb { background: #94a3b8; border-radius: 2px; }

.messages { display: flex; flex-direction: column; padding: 10px 10px 8px; gap: 6px; }

.welcome-agents {
  display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
  width: 100%; margin-bottom: 20px;
}
.welcome-agent-card {
  display: flex; flex-direction: column; align-items: flex-start;
  gap: 4px; padding: 12px;
  background: linear-gradient(145deg, rgba(255,255,255,0.05), rgba(255,255,255,0.01));
  border: 1px solid var(--border);
  border-radius: 12px; cursor: pointer;
  backdrop-filter: blur(8px);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); text-align: left;
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
}
.welcome-agent-card:hover {
  border-color: var(--agent-color); background: rgba(var(--agent-color), 0.1);
  transform: translateY(-3px); box-shadow: 0 8px 24px rgba(0,0,0,0.2);
}
.wa-emoji { font-size: 18px; margin-bottom: 2px; }
.wa-name { font-size: 12px; font-weight: 600; color: var(--agent-color); letter-spacing: 0.05em; }
.wa-desc { font-size: 10.5px; color: var(--text-muted); line-height: 1.4; }

.welcome-tips { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: center; }
.tip { display: flex; align-items: center; gap: 4px; font-size: 10.5px; color: var(--text-muted); }
.tip-key {
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: 4px; padding: 1px 5px;
  font-family: var(--font-mono); font-size: 9.5px; color: var(--text-secondary);
}
.tip-sep { color: var(--text-muted); font-size: 10px; }
.welcome-watermark { display: block; margin-top: 14px; font-size: 10px; color: var(--text-muted); text-decoration: none; opacity: 0.5; transition: opacity 0.2s; letter-spacing: 0.04em; }
.welcome-watermark:hover { opacity: 1; color: var(--accent-light); }
.welcome-version { font-size: 10px; font-weight: 500; color: var(--text-muted); opacity: 0.7; letter-spacing: 0.04em; vertical-align: middle; }

/* ─── Messages ────────────────────────────────────────────────────────────────── */
.message { display: flex; flex-direction: column; animation: fadeSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards; margin-bottom: 12px; }
@keyframes fadeSlideIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
.message.user { align-items: flex-end; }
.message.assistant { align-items: flex-start; }
.message-role { font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 5px; padding: 0 4px; opacity: 0.8; }
.message.user .message-role { color: var(--accent-light); }
.message.assistant .message-role { color: var(--text-muted); }
.message-bubble {
  padding: 12px 16px; border-radius: 14px; font-size: 13.5px;
  line-height: 1.6; max-width: 95%; word-break: break-word;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}
.message.user .message-bubble {
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(79, 70, 229, 0.35);
  color: var(--text-primary);
  border-radius: var(--radius);
  border-bottom-right-radius: 0;
}
.message.assistant .message-bubble {
  background: rgba(79, 70, 229, 0.05);
  border: none;
  border-left: 3px solid #4f46e5;
  border-radius: 0;
  padding-left: 14px;
  box-shadow: none;
}

/* ─── Agent Divider ───────────────────────────────────────────────────────────── */
.agent-divider {
  display: flex; align-items: center; gap: 8px;
  font-size: 10px; font-weight: 600; color: var(--agent-color);
  padding: 4px 0; letter-spacing: 0.05em;
}
.agent-divider::before, .agent-divider::after {
  content: ''; flex: 1; height: 1px;
  background: linear-gradient(90deg, transparent, var(--agent-color), transparent);
  opacity: 0.3;
}

/* ─── Thinking Indicator ─────────────────────────────────────────────────────── */
.thinking-indicator {
  display: flex; align-items: center; gap: 8px;
  color: var(--text-muted); font-size: 11px; font-style: italic;
  padding: 4px 2px; animation: fadeSlideIn 0.2s ease;
}

/* ─── Reasoning Blocks ───────────────────────────────────────────────────────── */
.reasoning-details {
  margin: 4px 0;
  background: transparent;
  border: none;
  border-left: 2px solid var(--border);
  overflow: hidden;
  font-size: 11px;
  transition: border-color 0.2s;
}
.reasoning-details:hover { border-color: var(--border-strong); }
.reasoning-details summary {
  padding: 5px 10px;
  background: transparent;
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-muted);
  user-select: none;
  list-style: none;
  display: flex; align-items: center; gap: 4px;
  transition: color 0.15s;
  letter-spacing: 0.03em;
  line-height: 1.4;
}
.reasoning-details summary:hover { color: var(--text-secondary); }
.reasoning-details summary::after {
  content: '↓'; font-size: 9px; opacity: 0.4; margin-left: 4px;
}
.reasoning-details[open] summary::after { content: '↑'; }
.reasoning-details summary::-webkit-details-marker { display: none; }
.reasoning-content {
  padding: 5px 10px 7px;
  color: rgba(255,255,255,0.4);
  line-height: 1.55;
  font-style: italic;
  font-size: 10.5px;
  font-family: var(--font-mono);
}

/* ─── Thinking Blocks (v8.7.1 — Clean Output) ───────────────────────────────── */
.thinking-details {
  margin: 6px 0;
  background: transparent;
  border: none;
  border-left: 2px solid rgba(99, 102, 241, 0.35);
  overflow: hidden;
  font-size: 11px;
  transition: border-color 0.2s;
}
.thinking-details:hover { border-color: rgba(99, 102, 241, 0.65); }
.thinking-details summary {
  padding: 5px 10px;
  background: transparent;
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 10px;
  color: rgba(99, 102, 241, 0.7);
  user-select: none;
  list-style: none;
  display: flex; align-items: center; gap: 4px;
  transition: color 0.15s;
  letter-spacing: 0.03em;
  line-height: 1.4;
}
.thinking-details summary:hover { color: rgba(99, 102, 241, 1); }
.thinking-details summary::after {
  content: '↓'; font-size: 9px; opacity: 0.5; margin-left: 4px;
}
.thinking-details[open] summary::after { content: '↑'; }
.thinking-details summary::-webkit-details-marker { display: none; }
.thinking-content {
  padding: 5px 10px 7px;
  color: rgba(99, 102, 241, 0.55);
  line-height: 1.55;
  font-style: italic;
  font-size: 10.5px;
  font-family: var(--font-mono);
}

/* ─── Tool Result Blocks ─────────────────────────────────────────────────────── */
.tool-result-details {
  margin: 8px 0 4px;
  background: rgba(16, 185, 129, 0.03);
  border: 1px solid rgba(16, 185, 129, 0.12);
  border-left: 3px solid var(--success);
  border-radius: var(--radius-sm);
  overflow: hidden;
  font-size: 11.5px;
  backdrop-filter: blur(4px);
  transition: border-color 0.2s;
}
.tool-result-details:hover {
  border-color: rgba(16, 185, 129, 0.25);
}
.tool-result-details summary {
  padding: 6px 12px;
  background: rgba(16, 185, 129, 0.06);
  cursor: pointer;
  font-weight: 600;
  font-size: 10.5px;
  color: var(--success);
  user-select: none;
  list-style: none;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: background 0.2s;
  letter-spacing: 0.02em;
}
.tool-result-details summary:hover {
  background: rgba(16, 185, 129, 0.1);
}
.tool-result-details summary::after {
  content: 'expandir ↓';
  font-size: 9px;
  font-weight: 400;
  opacity: 0.45;
  margin-left: auto;
  font-style: italic;
}
.tool-result-details[open] summary::after {
  content: 'contraer ↑';
}
.tool-result-details summary::-webkit-details-marker { display: none; }
.tool-result-content {
  margin: 0;
  padding: 10px 14px;
  color: rgba(255, 255, 255, 0.65);
  background: rgba(0, 0, 0, 0.2);
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1.55;
  border-top: 1px solid rgba(16, 185, 129, 0.1);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow-y: auto;
}
.tool-result-content::-webkit-scrollbar { width: 3px; }
.tool-result-content::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 2px; }

/* ─── Tool Call Cards (Compact) ──────────────────────────────────────────────── */
.tool-call-card {
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: rgba(0,0,0,0.15); overflow: hidden;
  animation: fadeSlideIn 0.2s ease; font-size: 10.5px;
  margin: 4px 0;
}
.tool-call-card.pending { border-color: rgba(148,163,184,0.15); }
.tool-call-card.success { border-color: rgba(16,185,129,0.2); }
.tool-call-card.failed { border-color: rgba(239,68,68,0.2); }

.tool-header { 
  display: flex; align-items: center; gap: 6px; padding: 4px 10px; 
  cursor: pointer; user-select: none;
}
.tool-header:hover { background: rgba(255,255,255,0.02); }
.tool-icon { font-size: 11px; flex-shrink: 0; opacity: 0.7; }
.tool-name { font-family: var(--font-mono); font-size: 10px; font-weight: 600; color: var(--accent-light); }
.tool-status-text { font-size: 9px; color: var(--text-muted); flex: 1; text-align: right; margin-right: 4px; }
.tool-args { font-family: var(--font-mono); font-size: 9px; color: var(--text-muted); padding: 3px 10px 6px; border-top: 1px solid var(--border); }
.tool-status-icon { flex-shrink: 0; font-size: 11px; width: 14px; text-align: center; }

.tool-details {
  max-height: 1000px;
  overflow: hidden;
  transition: max-height 0.3s ease-out;
  border-top: 1px solid var(--border);
}
.collapsed .tool-details {
  max-height: 0;
  border-top: none;
}
.tool-status-icon.spin { display: inline-block; animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

.tool-file-link { padding: 3px 10px 6px; }
.file-link {
  font-family: var(--font-mono); font-size: 9.5px; color: var(--accent-light);
  cursor: pointer; text-decoration: underline; text-underline-offset: 2px;
}
.file-link:hover { color: white; }

.tool-output {
  padding: 4px 10px; background: var(--code-bg);
  font-family: var(--font-mono); font-size: 9.5px; color: var(--text-secondary);
  border-top: 1px solid var(--border); max-height: 60px; overflow: hidden;
  white-space: pre; text-overflow: ellipsis;
}
.tool-output-error {
  color: #fca5a5; background: rgba(239,68,68,0.08);
  border-top-color: rgba(239,68,68,0.3); max-height: 120px;
}

/* ─── Error & Dividers ────────────────────────────────────────────────────────── */
.message-error {
  background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.25);
  border-radius: var(--radius); padding: 9px 12px; color: #fca5a5;
  font-size: var(--font-size); animation: fadeSlideIn 0.2s ease forwards;
}
.message-divider {
  text-align: center; color: var(--text-muted); font-size: 10.5px;
  padding: 6px 0; display: flex; align-items: center; gap: 8px;
}
.message-divider::before, .message-divider::after { content: ''; flex: 1; height: 1px; background: var(--border); }

/* ─── Streaming Cursor ────────────────────────────────────────────────────────── */
.streaming-cursor {
  display: inline-block; width: 2px; height: 13px; background: var(--accent-light);
  border-radius: 1px; margin-left: 2px; vertical-align: middle;
  animation: blink 0.9s ease-in-out infinite;
}
@keyframes blink { 0%,100% { opacity:1; } 50% { opacity:0; } }

/* ─── Markdown ────────────────────────────────────────────────────────────────── */
.message-bubble p { margin: 0 0 8px; }
.message-bubble p:last-child { margin-bottom: 0; }
.message-bubble strong { font-weight: 600; }
.message-bubble em { color: var(--text-secondary); }
.message-bubble ul, .message-bubble ol { margin: 6px 0 6px 18px; }
.message-bubble li { margin-bottom: 3px; }
.message-bubble code:not(pre code) {
  font-family: var(--font-mono); font-size: 11px;
  background: var(--code-bg); border: 1px solid var(--border);
  border-radius: 3px; padding: 1px 5px; color: #c792ea;
}

/* ─── Code Blocks ─────────────────────────────────────────────────────────────── */
.code-block {
  margin: 8px 0; background: var(--code-bg);
  border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden;
}
.code-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 5px 10px; border-bottom: 1px solid var(--border); background: rgba(0,0,0,0.2);
}
.code-lang { font-size: 10px; font-family: var(--font-mono); color: var(--accent-light); }
.code-actions { display: flex; gap: 4px; }
.code-btn {
  font-family: var(--font); font-size: 9.5px;
  background: none; border: 1px solid var(--border); border-radius: 4px;
  color: var(--text-muted); padding: 2px 7px; cursor: pointer; transition: all var(--transition);
}
.code-btn:hover { border-color: var(--border-strong); color: var(--text-primary); background: var(--bg-hover); }
.code-btn.copied { border-color: var(--success); color: var(--success); }
.code-block pre { margin: 0; padding: 10px; overflow-x: auto; font-family: var(--font-mono); font-size: 12px; line-height: 1.6; }

/* ─── Loading Dots ────────────────────────────────────────────────────────────── */
.loading-dots { display: inline-flex; gap: 4px; align-items: center; }
.loading-dots span {
  width: 5px; height: 5px; border-radius: 50%; background: var(--accent-light);
  animation: dotBounce 1.2s ease-in-out infinite;
}
.loading-dots span:nth-child(2) { animation-delay: 0.2s; }
.loading-dots span:nth-child(3) { animation-delay: 0.4s; }

/* ─── Input Area ──────────────────────────────────────────────────────────────── */
.input-area {
  padding: 12px; flex-shrink: 0; background: linear-gradient(to top, var(--bg) 80%, transparent);
  position: relative; z-index: 10;
}
.input-wrapper {
  display: flex; align-items: flex-end; gap: 8px;
  background: rgba(20, 20, 25, 0.7); border: 1px solid var(--border-strong);
  border-radius: 14px; padding: 10px 10px 10px 14px;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  backdrop-filter: blur(12px); box-shadow: 0 4px 20px rgba(0,0,0,0.3);
}
.input-wrapper:focus-within {
  border-color: rgba(79, 70, 229, 0.6);
  box-shadow: 0 4px 20px rgba(0,0,0,0.3), 0 0 0 1px rgba(79, 70, 229, 0.2), 0 0 16px rgba(79, 70, 229, 0.1);
}
.prompt-input {
  flex: 1; background: none; border: none; outline: none;
  font-family: var(--font); font-size: 12.5px; color: var(--text-primary);
  resize: none; line-height: 1.5; max-height: 150px; overflow-y: auto; padding: 0;
  transition: height 0.14s cubic-bezier(0.4, 0, 0.2, 1);
}
.prompt-input::placeholder { color: var(--text-muted); }
.input-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.char-count { font-size: 9.5px; color: var(--text-muted); }
.char-count.over-limit { color: var(--danger); }

.action-btn { 
  display: flex; align-items: center; justify-content: center; 
  width: 32px; height: 32px; border-radius: 10px; border: none; 
  cursor: pointer; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); 
}
.send-btn {
  background: rgba(79, 70, 229, 0.15);
  color: var(--accent-light);
  border: 1px solid rgba(79, 70, 229, 0.35);
  box-shadow: none;
}
.send-btn:hover { background: linear-gradient(135deg, #4f46e5, #a855f7); border-color: transparent; color: white; transform: none; }
.send-btn:disabled { background: var(--bg-elevated); color: var(--text-muted); cursor: not-allowed; transform: none; }
.cancel-btn { background: rgba(239,68,68,0.15); color: var(--danger); border: 1px solid rgba(239,68,68,0.3); }
.cancel-btn:hover { background: rgba(239,68,68,0.25); }
.cancel-btn.hidden { display: none; }
.send-btn.hidden { display: none; }

.input-footer { padding-top: 4px; min-height: 16px; display: flex; justify-content: space-between; align-items: center; }
.workspace-label { font-size: 10px; color: var(--text-muted); }
.powered-by { font-size: 9.5px; color: var(--text-muted); text-decoration: none; letter-spacing: 0.03em; opacity: 0.6; transition: opacity 0.2s; }
.powered-by:hover { opacity: 1; color: var(--accent-light); }

.msg-expand-btn { display: block; margin-top: 6px; background: none; border: none; color: var(--accent-light); font-size: 10.5px; cursor: pointer; padding: 0; opacity: 0.65; transition: opacity 0.2s; font-family: var(--font); letter-spacing: 0.02em; }
.msg-expand-btn:hover { opacity: 1; }

/* ─── Swarm Activity Pulse ───────────────────────────────────────────────────── */
@keyframes glowPulse {
  0%, 100% { box-shadow: 0 4px 20px rgba(0,0,0,0.3), 0 0 0 1px rgba(79,70,229,0), 0 0 12px rgba(79,70,229,0); }
  50%       { box-shadow: 0 4px 20px rgba(0,0,0,0.3), 0 0 0 1px rgba(79,70,229,0.35), 0 0 28px rgba(79,70,229,0.18); }
}
.input-wrapper.swarm-active {
  border-color: rgba(79, 70, 229, 0.55);
  animation: glowPulse 2s ease-in-out infinite;
}

/* ─── Restore Workspace Only Button (North Star v8.25.0) ───────────────────── */
/* Atomic rollback to the last fluxo-auto-checkpoint — destructive in spirit  */
/* (git reset --hard HEAD~1) but safe by design (the v8.16.7 Smart Auto-Commit */
/* preserves any human WIP as its own commit before the agent's anchor lands).  */
/* Tinted amber to telegraph "this undoes the last agent run" without using a   */
/* full danger red, which is reserved for the Sentinel active state.            */
.restore-btn {
  font-size: 16px;
  line-height: 1;
  color: rgba(245, 158, 11, 0.85);
}
.restore-btn:hover {
  color: rgb(245, 158, 11);
  border-color: rgba(245, 158, 11, 0.35);
  background: rgba(245, 158, 11, 0.08);
}

/* ─── Sentinel Button ────────────────────────────────────────────────────────── */
.sentinel-btn {
  position: relative;
  font-size: 14px;
}
.sentinel-btn.sentinel-active {
  color: var(--danger);
  border-color: rgba(239, 68, 68, 0.3);
  background: rgba(239, 68, 68, 0.08);
}
.sentinel-btn.sentinel-active::after {
  content: '';
  position: absolute;
  top: 4px; right: 4px;
  width: 5px; height: 5px;
  background: var(--danger);
  border-radius: 50%;
  animation: sentinelPulse 1.5s ease-in-out infinite;
}
@keyframes sentinelPulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50%       { transform: scale(1.6); opacity: 0.5; }
}

/* ─── Sentinel Alert Bubble ──────────────────────────────────────────────────── */
.sentinel-alert {
  align-items: flex-start;
  animation: fadeSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  margin-bottom: 12px;
}
.sentinel-alert .message-role {
  font-size: 10px; font-weight: 700; letter-spacing: 0.1em;
  text-transform: uppercase; margin-bottom: 5px; padding: 0 4px;
  color: var(--danger);
}
.sentinel-alert .message-bubble {
  padding: 12px 16px; border-radius: 14px; border-bottom-left-radius: 4px;
  font-size: 13.5px; line-height: 1.6; max-width: 95%; word-break: break-word;
  background: rgba(239, 68, 68, 0.05);
  border: 1px solid rgba(239, 68, 68, 0.2);
  backdrop-filter: blur(10px);
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

/* ─── Lines/Block Removed (collapsible) ─────────────────────────────────────── */
.tool-removed-details {
  margin-top: 4px; border-top: 1px solid rgba(148,163,184,0.1);
}
.tool-removed-summary {
  padding: 3px 10px; font-family: var(--font); font-size: 9.5px;
  color: var(--text-muted); cursor: pointer; user-select: none;
  list-style: none; display: flex; align-items: center; gap: 4px;
  transition: color 0.15s;
}
.tool-removed-summary::-webkit-details-marker { display: none; }
.tool-removed-summary:hover { color: var(--text-secondary); }
.tool-removed-details[open] .tool-removed-summary { color: var(--text-secondary); }
.tool-removed-content {
  padding: 4px 10px 6px; margin: 0;
  font-family: var(--font-mono); font-size: 9.5px; line-height: 1.5;
  color: rgba(252,165,165,0.7); background: rgba(239,68,68,0.04);
  white-space: pre-wrap; word-break: break-word; max-height: 180px; overflow-y: auto;
}
.tool-removed-content::-webkit-scrollbar { width: 3px; }
.tool-removed-content::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 2px; }

/* ─── Utility ────────────────────────────────────────────────────────────────── */
.hidden { display: none !important; }

/* ─── Response Wrapper ────────────────────────────────────────────────────────── */
.response-wrapper {
  display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px;
  animation: fadeSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}
.response-wrapper .message { animation: none; margin-bottom: 0; }

/* ─── Tool Activity Block ─────────────────────────────────────────────────────── */
.tool-activity {
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: rgba(0,0,0,0.1); overflow: hidden; font-size: 10.5px;
}
.tool-activity-summary {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 10px; cursor: pointer; user-select: none;
  color: var(--text-muted); background: rgba(0,0,0,0.15);
  list-style: none; transition: background var(--transition);
}
.tool-activity-summary::-webkit-details-marker { display: none; }
.tool-activity-summary::before {
  content: '›'; font-size: 12px; opacity: 0.5; transition: transform 0.2s;
}
.tool-activity[open] .tool-activity-summary::before { transform: rotate(90deg); }
.tool-activity[open] .tool-activity-icon { display: inline-block; animation: spin 2s linear infinite; }
.tool-activity-summary:hover { background: rgba(255,255,255,0.03); }
.tool-activity-icon { font-size: 11px; }
.tool-activity-label { font-size: 10px; font-weight: 500; }
.tool-activity-items { padding: 4px 4px 6px 20px; display: flex; flex-direction: column; gap: 4px; position: relative; }
.tool-activity-items::before { content: ''; position: absolute; left: 9px; top: 10px; bottom: 10px; width: 1px; background: linear-gradient(to bottom, rgba(79,70,229,0.5), transparent); pointer-events: none; }
.tool-activity-items .tool-call-card { margin: 0; }

/* ─── Diff Rendering ─────────────────────────────────────────────────────────── */
.tool-diff {
  display: flex; flex-direction: column;
  padding: 4px 0; overflow-x: auto;
  border-top: 1px solid var(--border); max-height: 200px; overflow-y: auto;
}
.tool-diff::-webkit-scrollbar { width: 3px; height: 3px; }
.tool-diff::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 2px; }

/* Precise terminal-style diff lines — prefix injected via ::before, not JS */
.diff-line-added {
  display: block;
  position: relative;
  font-family: var(--font-mono);
  font-size: 11px; line-height: 1.6;
  padding: 0 12px 0 26px;
  background: rgba(16, 185, 129, 0.06);
  color: #86efac;
  white-space: pre;
}
.diff-line-added::before {
  content: '+';
  position: absolute; left: 8px;
  color: #4ade80; font-weight: 700;
  user-select: none;
}
.diff-line-removed {
  display: block;
  position: relative;
  font-family: var(--font-mono);
  font-size: 11px; line-height: 1.6;
  padding: 0 12px 0 26px;
  background: rgba(239, 68, 68, 0.06);
  color: #fca5a5;
  white-space: pre;
}
.diff-line-removed::before {
  content: '-';
  position: absolute; left: 8px;
  color: #f87171; font-weight: 700;
  user-select: none;
}

/* ─── Magic File Links ──────────────────────────────────────────────────────── */
.file-link-btn {
  display: inline;
  background: none;
  border: none;
  padding: 0 2px;
  margin: 0;
  font-family: var(--font-mono);
  font-size: 0.82em;
  color: #60a5fa;
  text-decoration: underline;
  text-underline-offset: 2px;
  text-decoration-color: rgba(96, 165, 250, 0.5);
  cursor: pointer;
  border-radius: 3px;
  transition: color 0.15s, background 0.15s;
}
.file-link-btn:hover {
  color: #93c5fd;
  background: rgba(96, 165, 250, 0.1);
  text-decoration-color: #93c5fd;
}

/* ─── Chat Diff Rendering ────────────────────────────────────────────────────── */
.diff-add  { display: block; background: var(--diff-add-bg); color: var(--diff-add-text); white-space: pre; padding: 0 8px; margin: 0; }
.diff-remove { display: block; background: var(--diff-rem-bg); color: var(--diff-rem-text); white-space: pre; padding: 0 8px; margin: 0; }
.diff-ctx  { display: block; color: inherit; white-space: pre; padding: 0 8px; margin: 0; opacity: 0.65; }
.tool-diff-block { font-family: var(--font-mono); font-size: 11px; line-height: 1.5; background: var(--code-bg); border-radius: 6px; overflow: hidden; margin: 6px 0; padding: 4px 0; }

/* ─── Working Tree Button ────────────────────────────────────────────────────── */
.working-tree-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin: 8px 0 2px;
  padding: 4px 12px;
  background: rgba(96, 165, 250, 0.1);
  border: 1px solid rgba(96, 165, 250, 0.28);
  border-radius: 5px;
  color: #60a5fa;
  font-size: 11px;
  font-family: var(--font-sans, sans-serif);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.working-tree-btn:hover {
  background: rgba(96, 165, 250, 0.2);
  border-color: rgba(96, 165, 250, 0.5);
  color: #93c5fd;
}

/* ─── Multi-Brain Model Selectors ───────────────────────────────────────────── */
.brain-selectors { display: flex; align-items: center; gap: 3px; }
.brain-label { font-size: 12px; opacity: 0.75; user-select: none; cursor: default; }

/* ─── Worktree Human Review Card (v8.3.0) ───────────────────────────────────── */
.worktree-review-card {
  margin: 8px 0;
  padding: 14px 16px;
  background: rgba(79, 70, 229, 0.07);
  border: 1px solid rgba(79, 70, 229, 0.3);
  border-left: 3px solid #4f46e5;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.wt-review-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.wt-icon { font-size: 15px; }
.wt-branch-badge {
  margin-left: auto;
  font-size: 10px;
  font-family: var(--font-mono);
  font-weight: 500;
  padding: 2px 8px;
  background: rgba(79, 70, 229, 0.15);
  border: 1px solid rgba(79, 70, 229, 0.35);
  border-radius: 20px;
  color: #818cf8;
  white-space: nowrap;
}
.wt-hint {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}
.wt-files-list {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  align-items: center;
}
.wt-files-label {
  font-size: 11px;
  color: var(--text-muted);
  width: 100%;
  margin-bottom: 2px;
}
.wt-file-btn {
  display: inline-block;
  padding: 2px 8px;
  background: rgba(0,0,0,0.25);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: #60a5fa;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
  text-align: left;
}
.wt-file-btn:hover {
  background: rgba(96,165,250,0.12);
  border-color: rgba(96,165,250,0.4);
  color: #93c5fd;
}
.wt-actions {
  display: flex;
  gap: 8px;
  margin-top: 2px;
}
.wt-btn {
  flex: 1;
  padding: 7px 14px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background 0.15s, opacity 0.15s;
}
.wt-btn:disabled { opacity: 0.45; cursor: default; }
.wt-approve {
  background: rgba(16, 185, 129, 0.15);
  border-color: rgba(16, 185, 129, 0.4);
  color: #34d399;
}
.wt-approve:hover:not(:disabled) {
  background: rgba(16, 185, 129, 0.25);
  border-color: rgba(16, 185, 129, 0.6);
}
.wt-discard {
  background: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.3);
  color: #f87171;
}
.wt-discard:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.2);
  border-color: rgba(239, 68, 68, 0.5);
}
.brain-sep { color: rgba(255,255,255,0.2); font-size: 10px; padding: 0 2px; user-select: none; }

```

### 📁 FILE: `package.json`
```json
{
  "name": "fluxo-ai",
  "displayName": "Fluxo AI — Agent Swarm",
  "description": "Autonomous AI coding agent powered by OpenRouter. Writes files, runs commands, routes to specialized agents (Coder, Designer, Dashboard, Payments).",
  "version": "8.33.0",
  "publisher": "fluxotechai",
  "repository": {
    "type": "git",
    "url": "https://github.com/fluxotechai/fluxo-ai"
  },
  "icon": "media/icon.png",
  "engines": {
    "vscode": "^1.85.0"
  },
  "categories": [
    "AI",
    "Chat",
    "Programming Languages"
  ],
  "keywords": [
    "ai",
    "agent",
    "openrouter",
    "code assistant",
    "autonomous",
    "fluxo"
  ],
  "activationEvents": [
    "onStartupFinished",
    "onWebviewPanel:fluxo.chatPanel"
  ],
  "main": "./out/extension.js",
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        {
          "id": "fluxo-ai-sidebar",
          "title": "Fluxo AI",
          "icon": "media/sidebar-icon.svg"
        }
      ]
    },
    "views": {
      "fluxo-ai-sidebar": [
        {
          "type": "webview",
          "id": "fluxo.sidebar",
          "name": "Launcher"
        }
      ]
    },
    "commands": [
      {
        "command": "fluxo.openPanel",
        "title": "Fluxo: Open AI Panel",
        "icon": "$(robot)"
      },
      {
        "command": "fluxo.newChat",
        "title": "Fluxo: New Chat",
        "icon": "$(add)"
      },
      {
        "command": "fluxo.clearChat",
        "title": "Fluxo: Clear Chat",
        "icon": "$(clear-all)"
      },
      {
        "command": "fluxo.askAboutSelection",
        "title": "Fluxo: Ask About Selection",
        "icon": "$(comment)"
      },
      {
        "command": "fluxo.openSettings",
        "title": "Fluxo: Settings",
        "icon": "$(settings-gear)"
      },
      {
        "command": "fluxo.toggleSentinel",
        "title": "Fluxo: Toggle Sentinel",
        "icon": "$(eye)"
      },
      {
        "command": "fluxo.mcp.add",
        "title": "Fluxo: Add MCP Server",
        "icon": "$(plug)"
      },
      {
        "command": "fluxo.mcp.remove",
        "title": "Fluxo: Remove MCP Server",
        "icon": "$(debug-disconnect)"
      },
      {
        "command": "fluxo.mcp.list",
        "title": "Fluxo: List MCP Servers",
        "icon": "$(list-tree)"
      }
    ],
    "menus": {
      "editor/context": [
        {
          "command": "fluxo.askAboutSelection",
          "when": "editorHasSelection",
          "group": "fluxo@1"
        }
      ],
      "editor/title": [
        {
          "command": "fluxo.openPanel",
          "group": "navigation",
          "when": "true"
        }
      ]
    },
    "keybindings": [
      {
        "command": "fluxo.openPanel",
        "key": "ctrl+alt+c",
        "mac": "cmd+alt+c"
      },
      {
        "command": "fluxo.askAboutSelection",
        "key": "ctrl+shift+a",
        "mac": "cmd+shift+a",
        "when": "editorHasSelection"
      }
    ],
    "configuration": {
      "title": "Fluxo AI",
      "properties": {
        "fluxo.openrouterApiKey": {
          "type": "string",
          "default": "",
          "description": "OpenRouter API Key. Get yours free at https://openrouter.ai/keys",
          "order": 1
        },
        "fluxo.defaultModel": {
          "type": "string",
          "default": "google/gemini-2.5-flash",
          "description": "Default AI model (e.g., google/gemini-2.5-flash)",
          "order": 2
        },
        "fluxo.customModels": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "default": [
            "google/gemini-2.5-flash",
            "google/gemini-2.5-flash-lite",
            "google/gemini-2.5-pro",
            "deepseek/deepseek-v3.2",
            "anthropic/claude-3.7-sonnet",
            "anthropic/claude-3.5-haiku"
          ],
          "description": "List of available models. OpenRouter models use google/, anthropic/, openai/ prefixes. Use gemini-* for direct Gemini AI Studio. Use deepseek/* for direct DeepSeek API.",
          "order": 3
        },
        "fluxo.maxTokens": {
          "type": "number",
          "default": 16384,
          "description": "Max tokens per AI response. Use 16384+ for coding tasks — too low (e.g. 4096) causes the model to truncate tool calls and omit required parameters like old_string.",
          "order": 4
        },
        "fluxo.streamingEnabled": {
          "type": "boolean",
          "default": true,
          "description": "Enable streaming for final responses",
          "order": 5
        },
        "fluxo.deepseekApiKey": {
          "type": "string",
          "default": "",
          "description": "DeepSeek API Key for direct access to deepseek-chat / deepseek-coder (bypasses OpenRouter). Get yours at https://platform.deepseek.com/api_keys",
          "order": 6
        },
        "fluxo.geminiApiKey": {
          "type": "string",
          "default": "",
          "description": "Google AI Studio API Key for direct Gemini access (gemini-2.5-flash, gemini-2.5-pro). Get yours at https://aistudio.google.com/apikey",
          "order": 7
        },
        "fluxo.mcpServers": {
          "type": "object",
          "default": {},
          "description": "Configuración de Servidores MCP. Ejemplo: { \"sqlite\": { \"command\": \"uvx\", \"args\": [\"mcp-server-sqlite\", \"--db-path\", \"test.db\"] } }",
          "order": 8
        }
      }
    }
  },
  "scripts": {
    "compile": "tsc -p ./",
    "watch": "tsc -watch -p ./",
    "package": "vsce package",
    "vscode:prepublish": "npm run compile"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/vscode": "^1.85.0",
    "@vscode/vsce": "^2.24.0"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "typescript": "^5.3.0"
  }
}

```

### 📁 FILE: `README.md`
```text
# 🌊 Fluxo Tech AI — VS Code Agent Extension

Fluxo AI no es solo otro autocompletador de código. Es un **Motor Cognitivo (Tier-1)** integrado nativamente en Visual Studio Code, diseñado para Managers, Arquitectos y Tech Leads que requieren una colaboración segura y guiada (Human-in-the-Loop) con modelos de lenguaje.

![Version](https://img.shields.io/badge/version-v8.33.0-blue)
![Architecture](https://img.shields.io/badge/architecture-Structural_Isolation-orange)
![Status](https://img.shields.io/badge/status-Active_Development-success)
![License](https://img.shields.io/badge/license-MIT-green)

---

## ✨ Filosofía Core: "Human-in-the-Loop"

Los LLMs actuales son brillantes creando código desde cero, pero deficientes haciendo cirugías a ciegas en bases de código complejas. Fluxo AI resuelve esto actuando como un "Pair Programmer" disciplinado: **La IA propone, el Arquitecto dispone.**

---

## 🚀 Características Principales (Motor v8.20.0 — Seamless UX & MCP Registry)

| Característica | Descripción |
|---|---|
| 🧭 **Parallel Agent Swarm** | `@manager` orquesta `@coder`, `@designer`, `@planner` en paralelo vía `create_team`. FileLockManager previene colisiones de escritura en multi-agente. |
| 📋 **Planning Gate (v8.5.3)** | El `@manager` tiene PROHIBIDO delegar sin un plan. `enter_plan_mode` spawna un `@planner` que analiza el repo y produce `.fluxo/IMPLEMENTATION_PLAN.md` antes de cualquier edición. |
| 🧩 **Community Skills (v8.6.0)** | Biblioteca de recetas JSON en `skills/`. El `@manager` detecta integraciones conocidas (Stripe, Firebase…) y aplica el blueprint completo con un solo `skill(action='apply')`. |
| 🖥️ **OS Awareness (v8.7.0)** | Detección dinámica de `process.platform` — en Windows inyecta tabla de equivalencias (dir/ls, del/rm, move/mv) y prohibición de comandos Unix. Pipe-filtering (`build \| grep`) desbloqueado. |
| 🧹 **Clean Output Rendering (v8.7.1)** | Texto intermedio (CoT leak) redirigido al status bar. Bloques `<thinking>` renderizados como acordeón colapsable. La burbuja de chat solo muestra el Orchestrator's Report final. |
| 🌳 **Structural Isolation (v8.8.0)** | `enter_worktree` activa un sandbox git aislado. El motor redirige silenciosamente TODAS las operaciones de archivo al worktree — el agente usa rutas normales. `exit_worktree(merge/discard)` con Human Review. |
| 🔬 **AST-Native Editing (v8.5.0)** | `replace_symbol` delega la localización de bloques al Language Server Protocol (LSP) de VS Code — el agente nombra el símbolo, el LSP calcula el rango exacto. Cero riesgo de llaves desbalanceadas. |
| 🌳 **Git Worktree Isolation** | `enter_worktree` crea un branch aislado antes de refactorizaciones de alto riesgo. `exit_worktree(merge/discard)` incluye Human Review con diff nativo de VS Code. |
| 🛡️ **Sherlock Auditor** | Doble capa de seguridad: bloquea re-declaraciones redundantes, Tech Stack Drift, Modal Collision y Ghost Loops antes de escribir al disco. |
| 🔍 **GlobTool / GrepTool** | Herramientas nativas de exploración (puro Node.js, sin CLI). Reemplazan `ls`, `find`, `grep` en `run_command`. Path normalization middleware silencia la "Amnesia Espacial". |
| 🟢 **Sentinel Auto-Heal** | Monitorea el terminal en tiempo real. Build roto → intercepta y dirige al `@coder` automáticamente. |
| 🔌 **MCP Support** | Conecta servidores MCP externos (SQLite, filesystem, APIs) vía configuración JSON en Settings. |
| 🧬 **Syntax Shield — AST Validation (v8.16.x)** | Valida la sintaxis de TypeScript/JSX en memoria antes de escribir en disco. Corrupción de código fuente imposible: si el AST falla, la escritura se aborta con diagnóstico de error. |
| ⏱️ **Time Machine — Auto-Checkpoint (v8.16.x)** | Checkpointing silencioso de Git antes de cada tarea. Rollback instantáneo a un estado limpio sin intervención manual. |
| 🔒 **Quality Gate & Escape Hatch (v8.16.x)** | Ciclo cerrado: el motor exige que el código pase `npm run build` antes de declarar una tarea completa. Si el agente falla 3 veces consecutivas, el **Circuit Breaker** paraliza el bucle y fuerza una pausa HITL — el agente debe pedir aprobación humana antes de continuar. |

---

## 🧩 Community Skills — Cómo Contribuir

Los Skills son recetas JSON pre-construidas que describen la implementación completa de una integración estándar. Cuando el `@manager` detecta que una tarea coincide con un skill disponible, lo aplica directamente — sin necesidad de análisis manual del repo.

### Estructura de un Skill

```json
{
  "name": "mi-integracion",
  "description": "Una línea clara explicando qué integra este skill y qué cubre.",
  "recipe": "# Implementation Plan — Mi Integración\n\n## Objective\n...\n\n## Sequential Steps\n..."
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `name` | `string` | Identificador kebab-case único. El agente lo llama con `skill(action='apply', skill_name='mi-integracion')`. |
| `description` | `string` | Una línea para el listado. El agente la lee en `skill(action='list')` para decidir si el skill es relevante. |
| `recipe` | `string` | Markdown completo del plan. Sigue el formato obligatorio (ver abajo). |

### Formato Obligatorio del Recipe

```markdown
# Implementation Plan — [Nombre de la Integración]

## Objective
[Una oración: qué se construye y por qué.]

## Files to Modify
| File | Action | Reason |
|------|--------|--------|
| src/api/endpoint.ts | Create | [razón] |

## Sequential Steps

### Step 1: [Nombre del Paso]
- **File**: src/api/endpoint.ts
- **Action**: Create new file
- **Symbol/Block**: [nombre exacto del símbolo o bloque a editar]
- **Details**: [qué agregar, cambiar o eliminar — ser preciso]

### Step 2: ...

## Integration Points
- [Dependencias entre pasos — ej: "Step 3 requiere que Step 1 haya creado el endpoint X"]

## Dependencies & Risks
- [Breaking changes, dependencias externas, comandos de testing local]

## Agent Assignment
- @coder: Steps [N, N, N]
- @designer: Steps [N, N]
```

### Cómo Agregar un Skill

1. Crea un archivo `skills/tu-integracion.json` siguiendo la estructura de arriba.
2. Usa `\n` para saltos de línea dentro del string `recipe` (es JSON, no YAML).
3. Asegúrate de que cada paso tenga un **File** y un **Action** concretos — los pasos vagos ("actualizar el componente") no son accionables.
4. Haz un Pull Request al repositorio con tu skill. Si la comunidad lo valida, se incluye en la próxima versión de la extensión.

### Skills Disponibles

| Skill | Descripción |
|-------|-------------|
| `stripe-payment-flow` | Stripe Checkout completo: session endpoint, webhook con raw-body, checkout button, success/cancel pages. |

---

## 🛠️ Arquitectura Interna (v8.6.0)

```
src/
├── agentEngine.ts   — Motor cognitivo: loop, Hard Brake, Planning Gate, Skills intercept
├── agents.ts        — Swarm: @coder, @designer, @planner, @manager + Sherlock Auditor
├── extension.ts     — Bridge VS Code: LSP callbacks, worktree review, applyNativeEdit
├── sentinel.ts      — Monitor de terminal en tiempo real
skills/              — 📁 Community Skills Library (JSON recipes — root level, VSIX-included)
│   └── stripe-payment-flow.json
└── tools/
    ├── SkillTool/         — skill: list / apply
    ├── EnterPlanModeTool/ — enter_plan_mode: spawna @planner
    ├── TeamCreateTool/    — create_team: Parallel Swarm
    ├── ReplaceSymbolTool/ — replace_symbol: LSP-native AST edits
    ├── GlobTool/          — glob: pattern file finder (no CLI)
    ├── GrepTool/          — grep: regex search across project (no CLI)
    ├── SendMessageTool/   — send_message: inter-agent mailbox
    ├── SearchReplaceTool/ — search_and_replace: native VS Code edit
    ├── FileReadTool/
    ├── FileWriteTool/     — write_file: mutex-protected
    ├── ReplaceBlockTool/  — replace_block: search_snippet / replace_snippet
    └── ...

media/
├── main.js          — WebView UI: tool cards, worktree review, model selector
└── style.css        — Glassmorphism design system
```

---

## 💡 Flujo de Trabajo Ideal (v8.6.0)

```
1. Describe tu feature en el chat → @manager detecta el tipo de tarea
2. Si es una integración conocida → skill(action='list') → skill(action='apply')
   Si es una tarea custom → enter_plan_mode → @planner analiza el repo
3. IMPLEMENTATION_PLAN.md generado en .fluxo/
4. @manager llama create_team → @coder y @designer ejecutan en paralelo
5. Cambios vía replace_symbol (LSP) o replace_block → diff visual en VS Code
6. exit_worktree(merge) → Human Review del diff → aprueba o descarta
```

---

## 🚀 Instalación Rápida

Fluxo AI utiliza **GitHub Releases** para una distribución limpia. Los binarios `.vsix` ya no se rastrean en el repositorio.

1. Ve a la pestaña **[Releases](https://github.com/Denayssam/cnos-ai/releases)** de este repositorio.
2. Descarga el último archivo `.vsix` (ej. `fluxo-ai-8.16.1.vsix`).
3. Instálalo en VS Code arrastrándolo a la vista de **Extensiones**, o usa el comando:
   `Extensions: Install from VSIX...`
4. Configura tu API Key en **VS Code Settings → busca "Fluxo AI"** → pega tu OpenRouter / Gemini / DeepSeek key.

---

## 🤝 Agentes del Swarm

| Agente | Emoji | Especialidad | Toolset |
|--------|-------|--------------|---------|
| `coder` | 💻 | Código, bugs, archivos, comandos | replace_symbol, replace_block, glob, grep, worktree |
| `designer` | 🎨 | UI/UX, Tailwind, glassmorphism | replace_symbol, replace_block, search_images |
| `dashboard` | 📊 | Charts, analytics, KPIs | write_file, run_command |
| `payments` | 💳 | Stripe, PayPal, webhooks | write_file, run_command |
| `planner` | 📋 | Análisis de repo + plan | read_file, glob, grep, get_code_structure, **skill** |
| `manager` | 🧭 | Orquestación, emergencias | create_team, enter_plan_mode, **skill** |

---

## 📁 Documentación

| Archivo | Descripción |
|---------|-------------|
| [INSTALL.md](INSTALL.md) | Guía completa de instalación y configuración |
| [CNOS_MANIFESTO.md](CNOS_MANIFESTO.md) | Constitución del sistema — reglas vinculantes para agentes |
| [CHANGELOG.md](CHANGELOG.md) | Historial técnico completo de versiones |

---

*Construido para domar el caos de la IA generativa.*
*Built by **Denayssam** & Fluxo Tech AI · [fluxotechai.com](https://fluxotechai.com)*

```

### 📁 FILE: `ROADMAP.md`
```text
# 🌌 FLUXO AI - Enterprise Architecture Roadmap (v8.0.0+)

Este documento define la "Estrella del Norte" de FLUXO AI. Tras consolidar el Nivel 4 (LSP Semántico y MCP Fetching), el objetivo de las siguientes versiones es transformar el enjambre de una herramienta de edición reactiva a un **departamento de ingeniería de software asíncrono, paralelo y autónomo**.

---

## 🛡️ Fase 1: Aislamiento Estructural Absoluto (v8.0.0) ✅ COMPLETADA
**Objetivo:** Erradicar los bugs destructivos y la corrupción en la rama principal (`main`) aislando los experimentos de la IA.

* **[x] Implementar `EnterWorktreeTool`:** `git worktree add .fluxo/worktrees/<branch> -b <branch>`. Estado persistido en `.fluxo/active_worktree.json`. Devuelve path e instrucciones de prefijo al agente.
* **[x] Implementar `ExitWorktreeTool`:** `action='merge'` (commit + merge --no-ff en main) | `action='discard'` (worktree remove --force + branch -D). Main jamás es tocado en un discard.
* **[x] Propiedad `isolation: worktree`:** Añadida a `AgentDefinition`. Coder y Manager la tienen activada. El motor inyecta `[ISOLATION MODE ACTIVE]` al inicio de sesión. `RULE (WORKTREE ISOLATION)` en system prompts: obligatoria >50 líneas, opcional para ediciones simples.

---

## ⚡ Fase 2: Orquestación Paralela Asíncrona & Estabilidad (v8.1.0 - v8.3.3) ✅ COMPLETADA
**Objetivo:** Eliminar el cuello de botella secuencial, permitir el trabajo concurrente y asegurar la precisión algorítmica del código generado.

* **[x] The Mutex Protocol (v8.1.0):** Implementación de `lockfile.ts`. Sistema de cerrojos de sistema de archivos para evitar colisiones durante escrituras concurrentes.
* **[x] The Parallel Swarm (v8.2.0):** Refactor de `agentEngine.ts` con `Promise.all()`. Implementación de `TeamCreateTool` para instanciación de hilos y `SendMessageTool` (`AgentMailbox`) para comunicación en segundo plano.
* **[x] Native Visual Diff (v8.3.0):** Integración UX/UI con el motor nativo de Git Diff de VS Code. Pausa de orquestación (`worktreeReviewCallback`) para validación humana antes del merge.
* **[x] Strict Orchestrator (v8.3.1):** Arquitectura de "Deprivación de Herramientas". El `@manager` pierde acceso físico a la mutación de archivos y ejecución de terminal para forzar la delegación obligatoria (`coordinatorMode`).
* **[x] The Precision Protocol (v8.3.2):** Deprecación de la edición por líneas. Implementación de `ReplaceBlockTool` ("Bisturí Semántico" con `search_snippet` / `replace_snippet`) para proteger el AST de errores de conteo de LLMs.
* **[x] The Resilience Patch (v8.3.3):** Feedback loops en fallos de sistema. Sherlock Auditor permite la auto-limpieza (`discard` autorizado) ante conflictos de estado, evitando parálisis del enjambre.

---

## 🤖 Fase 3: Tier 1 Enterprise Autonomy & Daemon Mode (v9.0.0+) ⏳ EN PROGRESO
**Objetivo:** Cerrar la brecha final con los monolitos comerciales (Claude Code). Romper la barrera de VS Code para operar como un proceso de sistema invisible y robustecer la seguridad profunda.

* **[ ] Background Memory & Auto-Cleanup (`cleanupRegistry.ts`):** Servicio silencioso que destruye worktrees huérfanos tras fallos críticos o cierres de ventana, y abstracción de memoria automática (`extractMemories.ts`) sin requerir `update_memory`.
* **[ ] Deep MCP Integration (`services/mcp/`):** Capa de servicios dedicada a *Model Context Protocol*. Soporte para autenticación OAuth por puertos nativos, `officialRegistry.ts`, y herramientas atómicas (`ListMcpResourcesTool`, `McpAuthTool`).
* **[ ] Terminal AST Security (`bash/parser.ts`):** Sistema de parseo sintáctico de comandos de bajo nivel para auditar peticiones de terminal antes de la ejecución (Read-Only Validation) y prevenir inyecciones.
* **[ ] Proactivity & Daemon Core (`DAEMON` flag):** Bifurcar el motor para ejecución nativa en Node.js (fuera de VS Code). Implementación de `SleepTool` y `CronCreateTool` (`cronScheduler.ts`) para auto-escaneos y reparación de CI/CD pipelines en segundo plano.
```

### 📁 FILE: `src\agentEngine.ts`
```typescript
import * as fs from 'fs';
import * as path from 'path';
import { executeTool, getNativeTools, NativeTool } from './tools';
import { stripWorktreePrefix } from './tools/shared';
import { compactToolFailures, proactiveCompact } from './utils/condenser';
import { extractMemories } from './services/extractMemories/extractMemories';
import { AGENTS, buildAgentSystemPrompt, ROUTER_PROMPT, REVISOR_PROMPT, SUMMARIZER_PROMPT } from './agents';
import { AgentMailbox } from './utils/agentMailbox';
import { buildRepoMap } from './utils/repoMap';
import { createSilentCheckpoint } from './utils/gitSafety';
import { validateBuild } from './utils/buildValidator';
import * as DagController from './utils/dagController';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NativeToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON-encoded argument object
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: NativeToolCall[];
  tool_call_id?: string;
  name?: string;
}

export type AgentEvent =
  | { type: 'agentSelected'; agentId: string; agentName: string; emoji: string; color: string }
  | { type: 'thinking'; text: string }
  | { type: 'streamChunk'; text: string }
  | { type: 'toolCall'; name: string; args: Record<string, any>; displayArgs: string }
  | { type: 'toolResult'; name: string; success: boolean; output: string; duration?: string }
  | { type: 'streamEnd' }
  | { type: 'iterationCount'; count: number; max: number }
  | { type: 'error'; message: string };

export interface EngineConfig {
  apiKey: string;
  model: string;        // Manager model (used by @manager and Sherlock auditor)
  workerModel?: string; // Worker model (used by @coder, @designer, etc.) — falls back to model if unset
  maxTokens: number;
  streamingEnabled: boolean;
  deepseekApiKey?: string;
  geminiApiKey?: string;
}

// v8.27.0 — exported alongside callOpenRouterBlocking so external services
// (src/services/extractMemories etc.) can type the awaited result correctly.
export interface ApiResponse {
  content: string | null;
  tool_calls: NativeToolCall[];
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function resolveEndpointAndKey(model: string, config: EngineConfig): { endpointUrl: string; resolvedKey: string; resolvedModel: string } {
  // Bare "deepseek-*" (no slash) → DeepSeek direct API. Models with "deepseek/" prefix go to OpenRouter.
  if (!model.includes('/') && model.startsWith('deepseek-')) {
    return {
      endpointUrl: 'https://api.deepseek.com/chat/completions',
      resolvedKey: config.deepseekApiKey || config.apiKey,
      resolvedModel: model,
    };
  }
  // Bare "gemini-*" (no slash) → Gemini AI Studio direct. "google/gemini-*" goes to OpenRouter.
  if (!model.includes('/') && model.startsWith('gemini-')) {
    return {
      endpointUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      resolvedKey: config.geminiApiKey || config.apiKey,
      resolvedModel: model,
    };
  }
  return { endpointUrl: OPENROUTER_URL, resolvedKey: config.apiKey, resolvedModel: model };
}
const MAX_ITERATIONS = 25;

// ─── RBAC Categories (v8.19.0 — Phase 3 Deep MCP) ───────────────────────────
// Principle of Least Privilege for MCP tools. Each agent role is allowed a
// fixed set of category tags; a tool is admitted iff its inferred categories
// (set by services/mcp/client.inferCategories) overlap the role's allow-set. Tools with
// no categories ("unknown") are denied for every role EXCEPT @manager — the
// orchestrator gets a permissive fallback so it can still operate when the
// inference misses an exotic server.
const RBAC_CATEGORIES: Record<string, Set<string>> = {
  designer: new Set(['design', 'ui', 'figma', 'image']),
  coder:    new Set(['database', 'compiler', 'git', 'github', 'devops']),
  manager:  new Set(['pm', 'jira', 'github', 'git', 'project', 'issues']),
};

function applyMcpRbac(
  agentId: string,
  tools: NativeTool[],
  categoryMap: Record<string, string[]>
): NativeTool[] {
  const allowed = RBAC_CATEGORIES[agentId];
  return tools.filter(t => {
    const cats = categoryMap[t.function.name] ?? [];
    if (cats.length === 0) {
      // Unknown category: only the @manager keeps the tool.
      return agentId === 'manager';
    }
    if (!allowed) {
      // Roles without an explicit RBAC entry (planner, dashboard, payments…)
      // get nothing by default — Principle of Least Privilege.
      return false;
    }
    return cats.some(c => allowed.has(c));
  });
}
// ─────────────────────────────────────────────────────────────────────────────

const MAX_LOG_SIZE = 2 * 1024 * 1024;

// ── HITL Safe-Command Whitelist (v8.10.0) ────────────────────────────────────
// Commands matching any pattern are auto-approved. Everything else pauses for
// user confirmation before execution. Uses the first pipe/semicolon segment only.
const HITL_SAFE_PATTERNS: RegExp[] = [
  /^\s*npm\s+(run|test|install|i\b|ci|update|audit|list|outdated|version|pack|publish|init|uninstall)\b/i,
  /^\s*npx\s+/i,
  /^\s*tsc\b/i,
  /^\s*node\b/i,
  /^\s*yarn\b/i,
  /^\s*pnpm\b/i,
  /^\s*bun\b/i,
  /^\s*vsce\b/i,
  /^\s*git\s+(status|log|diff|fetch|pull|push|add|commit|checkout|switch|branch|merge|stash|remote|tag|show|describe|blame|shortlog|rev-parse|reset|rebase|cherry-pick|revert|ls-files|submodule|clean\s+-n)\b/i,
  /^\s*dir\b/i,
  /^\s*ls\b/i,
  /^\s*echo\s+(?!.*>)/i,  // echo without redirect
  /^\s*(node|npm|npx|yarn|pnpm|tsc|git|vsce|bun)\s+(--version|-v)\b/i,
  /^\s*(where|which)\b/i,
];

function isSafeCommandForAutoRun(command: string): boolean {
  const firstSegment = command.split(/\s*[|;&]+\s*/)[0] ?? command;
  return HITL_SAFE_PATTERNS.some(p => p.test(firstSegment));
}
// ─────────────────────────────────────────────────────────────────────────────

function debugLog(workspacePath: string, msg: string) {
  if (!workspacePath || !path.isAbsolute(workspacePath)) {
    console.warn('[debugLog] Skipped — workspacePath is empty or not absolute:', JSON.stringify(workspacePath));
    return;
  }
  try {
    const logPath = path.join(workspacePath, 'fluxo_agent.log');
    try {
      if (fs.statSync(logPath).size > MAX_LOG_SIZE) {
        fs.renameSync(logPath, path.join(workspacePath, 'fluxo_agent_old.log'));
      }
    } catch { /* log file doesn't exist yet */ }
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e: any) {
    console.error('[debugLog] Failed to write to fluxo_agent.log — path:', workspacePath, '— error:', e?.stack ?? e);
  }
}

// ─── Path Normalization (v8.5.2) ─────────────────────────────────────────────
// Converts any path the LLM sends (Docker-bias, Windows absolute, path-overlap)
// to a clean relative path before it reaches any tool. Eliminates "Amnesia Espacial"
// and "Sesgo de Terminal" where the agent hallucinates /workspace/ or C:\... paths.

interface PathNormResult { ok: boolean; normalized: string; error?: string; }

function normalizeAgentPath(rawPath: string, workspacePath: string): PathNormResult {
  if (!rawPath) { return { ok: true, normalized: rawPath }; }

  let p = rawPath;

  // Strip Docker-bias prefix variants (/workspace/, workspace/, \workspace\)
  if (p.startsWith('/workspace/'))      { p = p.substring(11); }
  else if (p.startsWith('workspace/'))  { p = p.substring(10); }
  else if (p.startsWith('\\workspace\\')) { p = p.substring(11); }

  // Handle path overlap: /workspace/D:\real\path → D:\real\path
  const driveIdx = p.search(/[a-zA-Z]:/);
  if (driveIdx > 0) { p = p.substring(driveIdx); }

  // If still absolute, convert to workspace-relative or reject if outside workspace
  if (path.isAbsolute(p)) {
    const resolvedWs = path.resolve(workspacePath);
    const resolvedP  = path.resolve(p);
    if (!resolvedP.toLowerCase().startsWith(resolvedWs.toLowerCase())) {
      return {
        ok: false,
        normalized: rawPath,
        error:
          `PATH ERROR: La ruta "${rawPath}" apunta fuera del workspace actual (${workspacePath}). ` +
          `Usa rutas RELATIVAS al proyecto (ej: "src/components/MyComponent.tsx"). ` +
          `Llama list_dir('.') o glob('**/*') para explorar la estructura real.`,
      };
    }
    p = path.relative(resolvedWs, resolvedP);
  }

  // Normalize to forward slashes for cross-platform consistency
  return { ok: true, normalized: p.replace(/\\/g, '/') };
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Context Pruning ─────────────────────────────────────────────────────────
// Truncates tool result messages from old turns to prevent context balloon.
// Last 2 turns (assistant+tool pairs) are always kept intact.
const TOOL_PRUNE_PLACEHOLDER = '[Contenido original truncado por el sistema para ahorrar tokens. El agente ya procesó esta información. Si es estrictamente necesario, vuelve a usar la herramienta.]';
const MAX_TOOL_CONTENT_CHARS = 1500;

// ─── Smart Memory Immunity List ─────────────────────────────────────────────
// Tool names whose results are NEVER pruned from history.
// These carry the agent's 'semantic compass' (code structure map + latest file
// snapshot) — pruning them causes re-read loops and wasted iterations.
const PRUNE_IMMUNE_TOOLS = new Set(['get_code_structure']);

function pruneToolResults(messages: ChatMessage[]): ChatMessage[] {
  const turnStarts: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      turnStarts.push(i);
    }
  }
  // Keep last 2 turns intact; prune everything before that
  const keepFromIdx = turnStarts.length >= 2 ? turnStarts[turnStarts.length - 2] : 0;

  // Find the index of the LAST read_file tool result in the full message list.
  // That result must never be pruned — it is the agent's current snapshot of a file.
  let lastReadFileIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'tool' && messages[i].name === 'read_file') {
      lastReadFileIdx = i;
    }
  }

  return messages.map((m, i) => {
    if (i >= keepFromIdx) { return m; }                          // recent turns: always intact
    if (m.role !== 'tool') { return m; }                         // non-tool messages: never prune
    if (PRUNE_IMMUNE_TOOLS.has(m.name ?? '')) { return m; }     // immune tools: always intact
    if (i === lastReadFileIdx) { return m; }                     // last read_file: always intact
    const content = typeof m.content === 'string' ? m.content : '';
    if (content.includes('SYSTEM ERROR') || 
        content.includes('ERROR:') || 
        content.includes('MATCH ERROR:') || 
        content.includes('BUILD_FAILED') || 
        content.includes('SYSTEM DIRECTIVE') || 
        content.includes('[CIRCUIT Breaker ACTIVATED]')) { 
      return m; 
    }
    if (content.length <= MAX_TOOL_CONTENT_CHARS) { return m; }
    return { ...m, content: TOOL_PRUNE_PLACEHOLDER };
  });
}

// ─── Agent Loop ───────────────────────────────────────────────────────────────

export async function* runAgentLoop(
  userMessage: string,
  initialAgentId: string,
  conversationHistory: ChatMessage[],
  config: EngineConfig,
  workspacePath: string,
  abortSignal: AbortSignal,
  sentinelHasError: boolean = false,
  approvalCallback?: (summary: string, details: string) => Promise<boolean>,
  nativeEditCallback?: (filePath: string, searchSnippet: string, replaceSnippet: string) => Promise<{ success: boolean; output: string }>,
  getCodeStructureCallback?: (absolutePath: string) => Promise<{ success: boolean; output: string }>,
  mcpTools: NativeTool[] = [],
  callMcpToolCallback?: (name: string, args: any) => Promise<{ success: boolean; output: string }>,
  worktreeReviewCallback?: (branch: string, worktreePath: string) => Promise<'merge' | 'discard'>,
  replaceSymbolCallback?: (filePath: string, symbolName: string, newCode: string) => Promise<{ success: boolean; output: string }>,
  hitlCommandCallback?: (command: string) => Promise<boolean>,
  // v8.19.0 — per-tool category map keyed by full tool name (mcp_<server>_<tool>).
  // Drives the RBAC filter that runs immediately below. If absent, every tool
  // is treated as 'unknown' and only the @manager keeps access — a safe fallback
  // that satisfies "deny by default unless the agent is the @manager".
  mcpToolCategories: Record<string, string[]> = {},
  // v8.23.0 — LSP Passive Feedback. Polls vscode.languages.getDiagnostics for
  // the recently edited files BEFORE the Quality Gate runs npm run build, so
  // the agent learns about missing props / undeclared symbols / type
  // mismatches without paying the cost of a full compiler invocation. Returns
  // a list of human-readable diagnostic strings (already trimmed and capped).
  // Engine treats absence (undefined/null callback) as "no LSP available" —
  // skips the check silently so non-VS Code execution paths are unaffected.
  getDiagnosticsCallback?: (relPaths: string[]) => Promise<string[]>,
  // v8.26.0 — Phase 3.4 MCP resource discovery. Wired to
  // McpSwarmClient.listResources(serverName) in extension.ts. The engine
  // intercepts `list_mcp_resources` tool calls before executeTool dispatches
  // and routes them through this callback so the live stdio transports owned
  // by the extension host can be reached. Returns the standard
  // {success, output} envelope. Engine treats absence as "MCP service not
  // initialized" and lets the tool's placeholder execute() surface a clean
  // engine error.
  listMcpResourcesCallback?: (serverName: string) => Promise<{ success: boolean; output: string }>,
  // v8.33.0 — Discovery Mode (planner-only). When wired AND the current agent
  // is @planner, ask_user_approval is rerouted: instead of the binary modal,
  // the host surfaces the questions via showInputBox and the user's TEXT
  // answer becomes the tool result.output. The planner sees the answer in its
  // conversation and writes the plan informed by it. For other agents the
  // existing binary approvalCallback flow is preserved unchanged. Returns
  // null/undefined when the user cancels.
  discoveryAnswerCallback?: (questions: string) => Promise<string | null>
): AsyncGenerator<AgentEvent> {

  // 1. Intent Detection (Routing)
  // ── v8.16.6: Skip routing for sub-agent invocations ──────────────────────
  // The @planner is invoked from enter_plan_mode with a FIXED role. Re-routing
  // it via detectIntent reads the mission text (e.g. "Adapt MealPlannerV2.jsx")
  // and incorrectly hands the session to @coder, so the planner's tools array
  // (write_file, get_repo_map…) and its mandate to produce IMPLEMENTATION_PLAN.md
  // are never loaded. Sub-agents bypass the router entirely.
  const SUB_AGENTS_NO_ROUTING = new Set(['planner']);
  let agentId = initialAgentId;

  if (!SUB_AGENTS_NO_ROUTING.has(initialAgentId)) {
    yield { type: 'thinking', text: 'Detecting intent…' };
    try {
      const detectedId = await detectIntent(userMessage, config, abortSignal);
      if (detectedId && AGENTS[detectedId]) { agentId = detectedId; }
    } catch (err) {
      console.error('[Engine] Intent detection failed, falling back to keywords:', err);
    }
  } else {
    debugLog(workspacePath, `[Routing] Sub-agent '${initialAgentId}' — skipping intent detection`);
  }

  const agent = AGENTS[agentId] || AGENTS.coder;
  let agentTools: NativeTool[] = getNativeTools(agent.tools);
  // v8.19.0 — RBAC filter for MCP tools. The filter consults RBAC_CATEGORIES
  // and the per-tool category map produced by services/mcp/client.inferCategories.
  // Tools with unmatched categories are dropped silently from the agent's
  // tool surface; the LLM never sees them and cannot call them.
  let allowedMcpTools: NativeTool[] = [];
  if (mcpTools && mcpTools.length > 0) {
    allowedMcpTools = applyMcpRbac(agentId, mcpTools, mcpToolCategories);
    if (allowedMcpTools.length > 0) {
      agentTools.push(...allowedMcpTools);
    }
    debugLog(workspacePath, `[MCP RBAC] @${agentId} — granted ${allowedMcpTools.length}/${mcpTools.length} MCP tool(s)`);
  }

  // ─── Tool Masker (Deep Masking v7.18.0) ────────────────────────────────────
  // Extended regex handles intermediate text: "PROHIBIDO usar la herramienta search_and_replace"
  const maskRegex = /(?:prohibido|no uses|don['']t use|do not use|stop using)[^\w]*(?:[\w]+\s+){0,3}([\w_]+)/gi;
  let match;
  const maskedTools = new Set<string>();
  while ((match = maskRegex.exec(userMessage)) !== null) {
    maskedTools.add(match[1].toLowerCase());
  }
  if (maskedTools.size > 0) {
    agentTools = agentTools.filter(t => !maskedTools.has(t.function.name.toLowerCase()));
    debugLog(workspacePath, `[Deep Masking] Tool Masker filtered out: ${Array.from(maskedTools).join(', ')}`);
  }
  // ────────────────────────────────────────────────────────────────────────────

  // Multi-brain routing: @manager uses config.model; all worker agents use config.workerModel (if set)
  const effectiveConfig: EngineConfig = {
    ...config,
    model: agentId === 'manager' ? config.model : (config.workerModel || config.model),
  };

  yield {
    type: 'agentSelected',
    agentId: agent.id,
    agentName: agent.name,
    emoji: agent.emoji,
    color: agent.color,
  };

  // 2. Context Pruning — only keep user/assistant turns, never raw tool messages
  const prunedHistory = conversationHistory
    .slice(-12)
    .filter(m => m.role === 'user' || m.role === 'assistant');

  // Agent Memory injection (v8.30.0) — read .fluxo/memory.md once per session.
  // Cap at 15KB to avoid token exhaustion. Framed as persistent lessons, not rules.
  const MEMORY_SIZE_CAP = 15_360; // 15KB
  let workspaceMemoryBlock = '';
  if (workspacePath) {
    const memoryFilePath = path.join(workspacePath, '.fluxo', 'memory.md');
    try {
      if (fs.existsSync(memoryFilePath)) {
        const memoryStats = fs.statSync(memoryFilePath);
        if (memoryStats.size <= MEMORY_SIZE_CAP) {
          const memoryContent = fs.readFileSync(memoryFilePath, 'utf-8').trim();
          if (memoryContent) {
            workspaceMemoryBlock =
              '\n\n<agent_memory>\n' +
              'This is your persistent memory across past sessions. ' +
              'Read these lessons learned to avoid repeating past mistakes. ' +
              'Entries are written by previous instances of yourself after completing tasks or recovering from errors.\n\n' +
              memoryContent +
              '\n</agent_memory>';
            debugLog(workspacePath, `Agent memory loaded: ${memoryContent.length} chars`);
          }
        } else {
          debugLog(workspacePath, `Agent memory skipped: file exceeds ${MEMORY_SIZE_CAP} byte cap (${memoryStats.size} bytes)`);
        }
      }
    } catch { /* memory file unreadable — proceed without it */ }
  }

  // v8.19.0 — pass hasMcpTools so the [EXTERNAL MCP KNOWLEDGE] block is only
  // injected when the RBAC filter actually admitted at least one external tool.
  const baseSystemPrompt = buildAgentSystemPrompt(agentId, allowedMcpTools.length > 0);
  let systemPrompt = workspaceMemoryBlock
    ? baseSystemPrompt + workspaceMemoryBlock
    : baseSystemPrompt;

  // ── RepoMap Injection (v8.9.0 — Semantic Awareness Phase 1) ──────────────────
  // Injected only for agents that write code — @coder and @manager.
  // buildRepoMap is fully fail-safe: returns '' on any I/O error.
  if (['coder', 'manager'].includes(agentId) && workspacePath) {
    const repoMapContent = buildRepoMap(workspacePath);
    if (repoMapContent) {
      systemPrompt +=
        '\n\n<repo_map>\n' + repoMapContent + '\n</repo_map>\n\n' +
        'REPO MAP RULE (v8.9.0): You have a <repo_map> above showing the current semantic structure ' +
        'of the workspace (files → exported symbols). ' +
        'DO NOT use run_command to search for files. ' +
        'Use this map to know exactly which path to pass to read_file, replace_lines, or replace_symbol. ' +
        'If a path from the map does not resolve, call glob() to confirm the real path — never guess.';
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // Deep Masking — inject CRITICAL SYSTEM OVERRIDE into the system prompt for each disabled tool.
  // This prevents the LLM from calling masked tools even when its base rules mention them.
  if (maskedTools.size > 0) {
    for (const toolName of maskedTools) {
      systemPrompt += `\n\n[CRITICAL SYSTEM OVERRIDE]: EL USUARIO HA DESACTIVADO LA HERRAMIENTA '${toolName}'. ESTÁ ESTRICTAMENTE PROHIBIDO INTENTAR LLAMARLA, INCLUSO SI OTRAS REGLAS LA MENCIONAN. DEBES USAR UNA ESTRATEGIA ALTERNATIVA (EJ: si se prohibió search_and_replace, usa replace_lines).`;
    }
  }

  // ── Worktree Isolation Directive ─────────────────────────────────────────────
  // If the active agent declares isolation: 'worktree', prepend a user-turn notice
  // so the LLM enters isolation-aware mode from the very first iteration.
  const isolationNotice: ChatMessage[] = agent.isolation === 'worktree' ? [{
    role: 'user',
    content:
      '[ISOLATION MODE ACTIVE — v8.8.0]: This agent has automatic git worktree isolation. ' +
      'For high-risk refactoring (>50 lines, multiple files): call enter_worktree with a reason. ' +
      'Once active, continue using NORMAL relative paths (e.g. src/App.tsx) — the engine ' +
      'automatically redirects ALL file operations (read_file, write_file, run_command, etc.) ' +
      'to the worktree sandbox. The user\'s production code on main is fully protected. ' +
      'For simple edits (<50 lines, 1-2 files), proceed directly without a worktree.',
  }] : [];

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...prunedHistory,
    ...isolationNotice,
    { role: 'user', content: userMessage },
  ];

  let iterations = 0;
  const toolCallHistory: string[] = [];           // all attempted calls — used for loop detection
  const successfulToolCallHistory: string[] = []; // only committed calls — fed to Sherlock as prior state
  const toolFailureTracker = new Map<string, number>();
  let buildFailureCtx = '';
  let lastEditedFile: string | null = null;
  let consecutiveGhostCount = 0;
  let ghostRetries = 0;
  let planCheckCount = 0;
  let nodeModulesAccessCount = 0; // v8.29.0 — Rabbit Hole soft-limit: first access gets a warning, subsequent are hard-blocked
  let consecutiveBuildFailures = 0;  // ── v8.16.1: Quality Gate circuit breaker counter
  let bypassQualityGate = false;     // ── v8.16.1: set to true when user approves bypass
  // v8.23.0 — LSP Passive Feedback bookkeeping. Tracks the recently edited
  // files so the diagnostics callback knows which files to poll, and a per-
  // turn cap so we never block the same completion attempt more than once
  // (otherwise a stubborn diagnostic could trap the agent in an infinite
  // pre-build loop).
  const recentlyEditedFiles = new Set<string>();
  let lspPassiveInjected = false;

  // ── Worktree Session State (v8.8.0) ──────────────────────────────────────────
  // Initialized from disk so worktree context survives across iterations and is
  // inherited by sub-agents (planner, swarm) spawned from this session.
  let activeWorktreePath: string | null = null;
  const wtStateFile = path.join(workspacePath, '.fluxo', 'active_worktree.json');
  if (workspacePath && fs.existsSync(wtStateFile)) {
    try {
      const wts = JSON.parse(fs.readFileSync(wtStateFile, 'utf-8'));
      if (wts.worktreePath && fs.existsSync(wts.worktreePath)) {
        activeWorktreePath = wts.worktreePath;
        debugLog(workspacePath, `[Worktree] Session restored — branch: ${wts.branchName} → ${wts.worktreePath}`);
      }
    } catch { /* corrupted state — proceed without worktree context */ }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // ─── v4.0 Hook: context_indexing_hook ─────────────────────────────────────
  // Reserved for Vector Memory integration.
  // Example: await contextIndexer.index(messages, workspacePath);
  // ──────────────────────────────────────────────────────────────────────────

  // ─── DAG Dispatch Tracker (v8.17.0 — Phase 1) ────────────────────────────
  // Tasks already announced as 'Ready for Instantiation' so the engine does not
  // re-log the same dispatch resolution every iteration. Dispatch identity is
  // (taskId + agent_type) because the agent_type can shift if the @manager
  // rewrites the DAG mid-flight.
  const dispatchedReady = new Set<string>();
  // ─────────────────────────────────────────────────────────────────────────

  // ─── Panoramic Physical Shield (v8.17.4) ─────────────────────────────────
  // The v8.17.3 PANORAMIC RULE was a prompt-level directive — the LLM ignored
  // it under load and dove straight into grep/glob/search_in_files/
  // search_and_replace, burning tokens to triangulate code it could have read
  // for free with get_repo_map. v8.17.4 promotes the rule to a physical
  // engine block: gated tools fail-fast with a [SYSTEM SHIELD] notice until
  // the agent calls get_repo_map at least once this session. Only @coder and
  // @designer are gated — @manager and @planner have other read paths.
  let hasSeenRepoMap = false;
  const PANORAMIC_GATED_AGENTS = new Set(['coder', 'designer']);
  const PANORAMIC_GATED_TOOLS  = new Set(['grep', 'glob', 'search_in_files', 'search_and_replace']);
  // ─────────────────────────────────────────────────────────────────────────

  // ── v8.16.7: Git Auto-Checkpointing (Smart Auto-Commit) ──────────────────
  // If the human has uncommitted changes, createSilentCheckpoint now auto-saves
  // them as a WIP commit BEFORE creating the agent's anchor commit. On rollback,
  // git reset --hard HEAD~1 discards only the agent's anchor — the human's WIP
  // commit survives, so their work is never lost.
  if (workspacePath) {
    try {
      const rawId = userMessage.replace(/[^\w\s-]/g, '').trim().slice(0, 50).replace(/\s+/g, '-') || 'task';
      createSilentCheckpoint(rawId, workspacePath);
      debugLog(workspacePath, `[Git Checkpoint] Anchor commit created: fluxo-auto-checkpoint:${rawId}`);
    } catch {
      // Not a git repo, no prior commits, or git unavailable — skip silently.
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  while (iterations < MAX_ITERATIONS) {
    if (abortSignal.aborted) {
      yield { type: 'error', message: '⊘ Cancelled by user' };
      return;
    }

    iterations++;
    debugLog(workspacePath, `--- Iteration ${iterations}/${MAX_ITERATIONS} ---`);
    yield { type: 'iterationCount', count: iterations, max: MAX_ITERATIONS };
    yield { type: 'thinking', text: iterations === 1 ? `Agent ${agent.name} is planning…` : `Iteration ${iterations}: processing…` };

    // ── DAG Active Dispatcher (v8.17.2 — Phase 2) ────────────────────────────
    // Scan .fluxo/dag_state.json once per iteration. Any PENDING task whose
    // depends_on parents are all COMPLETED is now ACTIVELY delegated to its
    // declared agent_type — flip status to IN_PROGRESS, spawn the sub-agent
    // via runAgentLoop, replay its events, then commit COMPLETED or FAILED
    // back to the graph. Sub-agents do not dispatch (only the @manager owns
    // the DAG), preventing infinite recursion. Cycle convergence: once new
    // tasks unblock as a result of this round, the next iteration tick picks
    // them up automatically.
    if (agentId === 'manager' && workspacePath && DagController.exists(workspacePath)) {
      try {
        const ready = DagController.getReadyTasks(workspacePath);
        for (const t of ready) {
          // Resolve target agent — strip leading '@' and lowercase. Unknown
          // names fall back to @coder so a typo never strands a task.
          const rawType = (t.agent_type || '').trim().replace(/^@+/, '').toLowerCase();
          const targetAgentId = AGENTS[rawType] ? rawType : 'coder';

          // Refuse to dispatch to ourselves (manager → manager) — that would
          // collapse the loop into an unbounded recursion.
          if (targetAgentId === 'manager') {
            DagController.updateTaskStatus(workspacePath, t.id, 'FAILED',
              `Cannot dispatch task to '@manager' — the manager is the dispatcher itself.`);
            yield { type: 'thinking', text: `🛑 [DAG Engine] Task ${t.id} self-targets @manager — marked FAILED` };
            continue;
          }

          DagController.updateTaskStatus(workspacePath, t.id, 'IN_PROGRESS');
          dispatchedReady.add(`${t.id}:${t.agent_type}`);

          const dispatchMsg = `[DAG Engine] Task ${t.id} dispatched to @${targetAgentId} (was: ${t.agent_type})`;
          debugLog(workspacePath, dispatchMsg);
          yield { type: 'thinking', text: `🚀 ${dispatchMsg}` };

          // Construct the task prompt. The leading [DAG TASK ...] tag lets the
          // sub-agent (and any audit log) see exactly which graph node it is
          // executing, and the closing instruction pins the completion contract.
          const taskPrompt =
            `[DAG TASK ${t.id}] ${t.description}\n\n` +
            `This task was dispatched by the DAG Orchestrator. Execute it end to end. ` +
            `When the implementation is complete and the build is green, end your turn ` +
            `cleanly so the orchestrator can mark this task as COMPLETED.`;

          const subEvents: AgentEvent[] = [];
          try {
            const subGen = runAgentLoop(
              taskPrompt,
              targetAgentId,
              [],
              { ...effectiveConfig, model: config.workerModel || config.model },
              workspacePath,
              abortSignal,
              sentinelHasError,
              approvalCallback,
              nativeEditCallback,
              getCodeStructureCallback,
              mcpTools,
              callMcpToolCallback,
              worktreeReviewCallback,
              replaceSymbolCallback,
              hitlCommandCallback,
              mcpToolCategories,
              getDiagnosticsCallback,
              listMcpResourcesCallback
            );

            yield { type: 'thinking', text: `━━━ DAG dispatch · ${t.id} → @${targetAgentId} ━━━` };
            for await (const ev of subGen) {
              subEvents.push(ev);
              yield ev;
            }
          } catch (err: any) {
            const errMsg = err?.message ?? String(err);
            DagController.updateTaskStatus(workspacePath, t.id, 'FAILED', `Spawn error: ${errMsg}`);
            debugLog(workspacePath, `[DAG Engine] Task ${t.id} spawn threw: ${errMsg}`);
            yield { type: 'thinking', text: `❌ [DAG Engine] Task ${t.id} crashed during dispatch — marked FAILED` };
            continue;
          }

          // ── Lifecycle hook — derive task outcome from the sub-agent's event stream ──
          // FAILED triggers: any 'error' event surfaced (Sherlock audit failure,
          // API error, abort), or the MAX_ITERATIONS warning chunk (stuck loop).
          // COMPLETED otherwise — the engine's own Quality Gate already blocked
          // the streamEnd unless the build was green, so a clean exit is proof
          // of a passing build (and, if a worktree was used, a successful merge).
          const hadError = subEvents.some(e => e.type === 'error');
          const hitMaxIter = subEvents.some(e =>
            e.type === 'streamChunk' && typeof e.text === 'string' &&
            e.text.includes('Reached maximum iterations')
          );
          const finalText = subEvents
            .filter(e => e.type === 'streamChunk')
            .map(e => (e as { type: 'streamChunk'; text: string }).text)
            .join('')
            .trim()
            .slice(0, 4000); // bound the result blob — full audit lives in the engine log

          if (hadError || hitMaxIter) {
            DagController.updateTaskStatus(workspacePath, t.id, 'FAILED', finalText || (hitMaxIter ? 'Hit MAX_ITERATIONS' : 'Sub-agent emitted error event'));
            debugLog(workspacePath, `[DAG Engine] Task ${t.id} FAILED (hadError=${hadError}, hitMaxIter=${hitMaxIter})`);
            yield { type: 'thinking', text: `❌ [DAG Engine] Task ${t.id} FAILED` };
          } else {
            DagController.updateTaskStatus(workspacePath, t.id, 'COMPLETED', finalText);
            debugLog(workspacePath, `[DAG Engine] Task ${t.id} COMPLETED by @${targetAgentId}`);
            yield { type: 'thinking', text: `✅ [DAG Engine] Task ${t.id} COMPLETED by @${targetAgentId}` };
          }
        }

        // If we dispatched at least one task this tick, skip the manager's API
        // call and re-enter the loop so newly-unblocked downstream tasks can
        // be picked up immediately. The manager only needs to "think" once
        // every task in the current ready frontier has been dispatched.
        if (ready.length > 0) {
          continue;
        }
      } catch (e: any) {
        debugLog(workspacePath, `[DAG Engine] Dispatch evaluation failed: ${e?.message ?? String(e)}`);
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Inter-Agent Mailbox drain (v8.2.0) ───────────────────────────────────────
    // Sub-agents running in parallel can send_message to this agent. Drain and
    // inject as user turns so the LLM receives them naturally in context.
    const incomingMsgs = AgentMailbox.drain(agentId);
    if (incomingMsgs.length > 0) {
      yield { type: 'thinking', text: `📬 ${agentId}: received ${incomingMsgs.length} inter-agent message(s)` };
      for (const msg of incomingMsgs) {
        messages.push({ role: 'user', content: `[INTER-AGENT MESSAGE]: ${msg}` });
      }
    }
    // ─────────────────────────────────────────────────────────────────────────────

    // API call — streaming when enabled (fallback to blocking if tools present)
    // Apply context pruning before sending to avoid token balloon from large tool results.
    const msgsToSend = pruneToolResults(messages);
    let apiResponse: ApiResponse;
    let alreadyStreamedText = false;
    try {
      if (effectiveConfig.streamingEnabled) {
        const textChunks: string[] = [];
        apiResponse = await callOpenRouterStreaming(
          msgsToSend, effectiveConfig, abortSignal, agentTools,
          (chunk) => textChunks.push(chunk),
          consecutiveGhostCount > 0
        );
        if (textChunks.length > 0) {
          alreadyStreamedText = true;
          for (const chunk of textChunks) {
            yield { type: 'streamChunk', text: chunk };
          }
        }
      } else {
        apiResponse = await callOpenRouterBlocking(msgsToSend, effectiveConfig, abortSignal, agentTools, consecutiveGhostCount > 0);
      }
    } catch (err: any) {
      if (err.name === 'AbortError') { return; }
      debugLog(workspacePath, `API error: ${err.message}`);
      yield { type: 'error', message: `API error: ${err.message}` };
      return;
    }

    const textContent = apiResponse.content || '';
    const toolCalls = apiResponse.tool_calls;

    debugLog(workspacePath, `Response: ${toolCalls.length} tool calls, ${textContent.length} chars text`);

    // ── Anti-Gaslighting Hard Block (v8.16.14) ────────────────────────────────
    // The @coder is NOT the @manager — only the orchestrator emits the
    // Orchestrator's Report. When @coder hits a hard task it can hallucinate the
    // report phrase to escape the loop early. Intercept it BEFORE streaming so
    // the fake report never reaches the user's chat, drop the response from the
    // valid history, and inject a corrective directive so the next iteration
    // resumes real work.
    if (agentId === 'coder' && textContent && /ORCHESTRATOR['']S\s+REPORT/i.test(textContent)) {
      debugLog(workspacePath, '[Anti-Gaslighting] @coder attempted to emit Orchestrator\'s Report — intercepting');
      yield { type: 'thinking', text: '🛑 Anti-Gaslighting: @coder no puede emitir el reporte final…' };
      messages.push({
        role: 'user',
        content:
          "[SYSTEM ENGINE BLOCK] You are the Coder. Do not generate the Orchestrator's Report. " +
          "Use your tools to fix the code or use 'ask_user_approval' if you are completely stuck.",
      });
      continue;
    }
    // ──────────────────────────────────────────────────────────────────────────

    // ── Merge Enforcer Hard Block (v8.16.17) ──────────────────────────────────
    // No agent — including @manager — may emit the Orchestrator's Report while
    // a worktree is still active. The report belongs on main, after merge. If
    // the LLM tries to ship the report from inside the sandbox, intercept it,
    // do NOT stream it to chat, drop it from the valid history, and force
    // another iteration demanding exit_worktree(merge) first.
    if (textContent && /ORCHESTRATOR['']S\s+REPORT/i.test(textContent) && activeWorktreePath) {
      debugLog(workspacePath, `[Merge Enforcer] @${agentId} attempted to emit Orchestrator's Report while worktree active (${activeWorktreePath}) — intercepting`);
      yield { type: 'thinking', text: '🛑 Merge Enforcer: el worktree sigue activo, exige exit_worktree(merge)…' };
      messages.push({
        role: 'user',
        content:
          "[SYSTEM ENGINE BLOCK] You cannot emit the Orchestrator's Report while a worktree is still active. " +
          "You MUST call the 'exit_worktree' tool with action='merge' to integrate your changes to the main branch first.",
      });
      continue;
    }
    // ──────────────────────────────────────────────────────────────────────────

    // Route text based on whether tool calls follow in this same response (v8.7.1).
    // Text alongside tool calls = intermediate CoT / planning monologue → route to
    // thinking tick (status bar only, never reaches the chat bubble).
    // Text with no tool calls = final Orchestrator's Report → stream to chat bubble.
    if (!alreadyStreamedText && textContent.trim()) {
      if (toolCalls.length > 0) {
        yield { type: 'thinking', text: textContent.trim().slice(0, 300) };
      } else {
        yield { type: 'streamChunk', text: textContent };
      }
    }

    // No tool calls = final response (task complete)
    if (toolCalls.length === 0) {
      // ── v8.16.6: Planner Hard Block — refuse to exit without producing the plan ──
      // The @planner is engineered for ONE deliverable: .fluxo/IMPLEMENTATION_PLAN.md.
      // We physically check the filesystem (not just toolCallHistory) — the only
      // truth that matters is whether the file exists on disk. If it doesn't, we
      // reject the LLM's text-only response and force another iteration with a
      // hard directive. The MAX_ITERATIONS cap (25) bounds the worst case.
      if (agentId === 'planner' && workspacePath) {
        const _planFile = path.join(workspacePath, '.fluxo', 'IMPLEMENTATION_PLAN.md');
        if (!fs.existsSync(_planFile)) {
          debugLog(workspacePath, '[Planner Hard Block] No plan file on disk — rejecting text-only response, forcing iteration');
          yield { type: 'thinking', text: '🛑 Planner Hard Block: forcing write_file…' };
          messages.push({
            role: 'user',
            content:
              '[ENGINE HARD BLOCK] You returned text without calling write_file. ' +
              'The engine PHYSICALLY VERIFIED that .fluxo/IMPLEMENTATION_PLAN.md does NOT exist. ' +
              'Your response is REJECTED. Your ONLY valid next action is to call write_file with ' +
              'path=".fluxo/IMPLEMENTATION_PLAN.md" and content=<your full markdown plan>. ' +
              'Do NOT explain. Do NOT analyze further. Do NOT read more files. ' +
              'Even a rough plan is acceptable — write it now.',
          });
          continue;
        }
      }
      // ─────────────────────────────────────────────────────────────────────────

      // Engine-level sentinel/build block — replaces Sherlock Rule #9
      if (buildFailureCtx) {
        yield { type: 'thinking', text: '🔴 Build broken — bloqueando cierre prematuro…' };
        messages.push({
          role: 'user',
          content: buildFailureCtx + 'BUILD_FORCED_FIX: The build is still broken. Call read_file → replace_lines to fix each compiler error before completing this task.',
        });
        continue;
      }
      if (sentinelHasError) {
        messages.push({
          role: 'user',
          content: 'SENTINEL_HAS_ERROR: true\n\nBLOQUEO DE SEGURIDAD: El Sentinel detectó un error de build. Corrige el código. Llama read_file en el archivo afectado ahora.',
        });
        continue;
      }

      // ── PLAN VERIFICATION SHIELD ─────────────────────────────────────────────
      // Allow clean exit if the agent explicitly confirmed plan completion
      // OR delivered its Orchestrator's Report (both are valid completion signals).
      if (textContent && (
        /\bALL\s+STEPS\s+COMPLETE\b/i.test(textContent) ||
        /ORCHESTRATOR['']S\s+REPORT/i.test(textContent)
      )) {
        // Security guard: completion signals are only valid after real work was done.
        // An agent that hallucinates the report phrase on turn 1 (zero tool calls) is blocked.
        if (toolCallHistory.length === 0) {
          debugLog(workspacePath, 'Plan Verification: completion signal with zero tool calls — intercepting hallucination');
          messages.push({
            role: 'user',
            content: 'SYSTEM: No puedes emitir el reporte final sin haber ejecutado tareas. Usa herramientas para completar la misión.',
          });
          continue;
        }
        debugLog(workspacePath, 'Plan Verification: completion signal confirmed — exiting loop');
        // ── v8.23.0: LSP Passive Feedback — pre-build "sixth sense" ─────────
        // Cheaper than validateBuild (no compiler invocation, just queries the
        // already-running TS/JSX language server for diagnostics on the files
        // we just edited). If the LSP sees missing props, undeclared symbols,
        // or type mismatches, surface them BEFORE we pay the cost of the full
        // build. The agent gets the warning, fixes the typo, and on its next
        // completion attempt the gate runs cleanly. Capped at one injection
        // per turn (lspPassiveInjected) — a stubborn diagnostic must not trap
        // the agent in an infinite pre-build loop. Reset on green build.
        if (
          getDiagnosticsCallback && !lspPassiveInjected &&
          recentlyEditedFiles.size > 0 && workspacePath && !bypassQualityGate
        ) {
          try {
            const _diagnostics = await getDiagnosticsCallback([...recentlyEditedFiles].slice(0, 5));
            if (_diagnostics.length > 0) {
              lspPassiveInjected = true;
              const _diagBlock = _diagnostics.slice(0, 8).map(d => `  • ${d}`).join('\n');
              const _passiveMsg =
                `[LSP PASSIVE FEEDBACK] The Language Server detected ${_diagnostics.length} unresolved issue(s) ` +
                `in the files you just edited:\n${_diagBlock}\n\n` +
                `MANDATORY: Fix these BEFORE running npm run build or declaring the task done. ` +
                `These are AST-level signals from the running TS/JSX server — they will become ` +
                `compiler errors on the next build attempt.`;
              yield { type: 'thinking', text: `🧭 LSP passive feedback: ${_diagnostics.length} issue(s) detected` };
              messages.push({ role: 'user', content: _passiveMsg });
              debugLog(workspacePath, `[LSP Passive] Injected ${_diagnostics.length} diagnostic(s) before Quality Gate`);
              continue;
            }
          } catch (err: any) {
            debugLog(workspacePath, `[LSP Passive] callback failed: ${err?.message ?? err} — falling through to Quality Gate`);
          }
        }
        // ────────────────────────────────────────────────────────────────────
        // ── v8.16.0/8.16.1: Quality Gate + Escape Hatch ──────────────────────
        if (workspacePath && toolCallHistory.length > 0 && !buildFailureCtx && !bypassQualityGate) {
          yield { type: 'thinking', text: '🏗️ Quality Gate: validating build before completion…' };
          const qgResult = await validateBuild(activeWorktreePath || workspacePath);
          if (!qgResult.success && !qgResult.error?.toLowerCase().includes('missing script')) {
            consecutiveBuildFailures++;
            debugLog(workspacePath, `[Quality Gate] FAILED (${consecutiveBuildFailures}/3) — blocking agent completion`);
            if (consecutiveBuildFailures >= 3) {
              messages.push({
                role: 'user',
                content: `[QUALITY GATE CIRCUIT BREAKER] You have failed the build check 3 times. MANDATORY DIRECTIVE: You are FORBIDDEN from trying to complete this task again right now. You MUST immediately use the 'ask_user_approval' tool to explain the build errors to the human and ask if they want to BYPASS the build check or give you manual instructions.`,
              });
            } else {
              messages.push({
                role: 'user',
                content: `[QUALITY GATE FAILED] You attempted to complete the task, but the project fails to build. Error details:\n\n${qgResult.error}\n\nMANDATORY: You MUST fix these build errors before you can complete the task.`,
              });
            }
            continue;
          }
          consecutiveBuildFailures = 0;
          debugLog(workspacePath, '[Quality Gate] Passed — accepting completion');
        }
        // ─────────────────────────────────────────────────────────────────────
        // ── v8.27.0 — Background Memory Extraction (Phase 3.3) ───────────────
        // Fire-and-forget: spawn the extractor on the resolved success path
        // (Orchestrator's Report / ALL STEPS COMPLETE + green Quality Gate or
        // no QG required). The .catch() at the call site guarantees a failed
        // extraction never propagates to the agent loop. The user's stream
        // closes immediately; the bullet (if any) lands in .fluxo/memory.md
        // a few seconds later in the background.
        extractMemories(messages, config, workspacePath).catch(() => { /* swallow */ });
        // ─────────────────────────────────────────────────────────────────────
        yield { type: 'streamEnd' };
        return;
      }
      // If an IMPLEMENTATION_PLAN.md is active, ask the agent to verify progress
      // before allowing a no-tool exit. Guard with planCheckCount to prevent infinite loop.
      if (planCheckCount === 0 && workspacePath) {
        const planFilePath = path.join(workspacePath, '.fluxo', 'IMPLEMENTATION_PLAN.md');
        if (fs.existsSync(planFilePath)) {
          planCheckCount++;
          debugLog(workspacePath, 'Plan Verification: IMPLEMENTATION_PLAN.md found — injecting Manager Override');
          yield { type: 'thinking', text: '📋 Manager: verifying plan completion…' };
          messages.push({
            role: 'user',
            content:
              'MANAGER OVERRIDE: You attempted to end your turn, but there is an active IMPLEMENTATION_PLAN.md. ' +
              'You must verify your progress. Have you completed ALL steps of the plan? ' +
              'If steps are missing (e.g., you only created a file but did not integrate it), execute the next tool immediately. ' +
              'If you truly completed everything, respond with exactly "ALL STEPS COMPLETE".',
          });
          continue;
        }
      }
      // ─────────────────────────────────────────────────────────────────────────

      // Anti-hallucination: intercept ghost completions (agent claims to have edited code
      // but emitted 0 tool calls — the edit never happened).
      const GHOST_SIGNALS = [
        /\b(he|i[''`]ve|i have)\s+(editado|actualizado|modificado|corregido|arreglado|updated|edited|modified|fixed|changed)\b/i,
        /\b(código|archivo|file|code)\s+(actualizado|editado|modificado|updated|edited|modified|fixed)\b/i,
        /\bHecho[\.,]\s*(el\s*)?(código|archivo|fix|cambio)/i,
        /\btarea\s+completada\b/i,
        /\btask\s+completed\b/i,
        /✅.*(completad|tarea|task\s+done|updated|edited|modificado|actualizado)/i,
      ];
      if (textContent && GHOST_SIGNALS.some(re => re.test(textContent)) && toolCallHistory.length === 0) {
        consecutiveGhostCount++;
        debugLog(workspacePath, `Ghost completion #${consecutiveGhostCount} — enforcing tool call`);
        const nudge = consecutiveGhostCount === 1
          ? '⚠️ SYSTEM: You claimed to have updated the code, but you emitted 0 tool calls. You cannot edit code with plain text. Call edit_file with the exact old_string and new_string, or ask a clarifying question.'
          : `[HARD ENFORCEMENT — ghost #${consecutiveGhostCount}] STOP generating completion text. You have produced ${consecutiveGhostCount} responses claiming success with 0 tool calls. tool_choice is now REQUIRED. Your ONLY valid next actions:\n1. Call read_file('<path>') then replace_lines with start_line/end_line from the read output.\n2. Call search_in_files to locate the target first.\n3. Ask the user one specific clarifying question.`;
        messages.push({ role: 'user', content: nudge });
        continue;
      }

      // Action Enforcement — agent returned text but no tools (passive give-up pattern)
      // Silent: engine retries internally — user never sees the "fight" with the LLM.
      if (ghostRetries < 2) {
        ghostRetries++;
        debugLog(workspacePath, `Action enforcement #${ghostRetries} — no tools returned, injecting directive`);
        messages.push({
          role: 'user',
          content: '[SYSTEM ENFORCEMENT]: You provided text but no tool calls. As an autonomous AI, you MUST use tools (like read_file, replace_block) to fix the issue yourself. Do not explain the fix to the user. Execute the fix.',
        });
        continue;
      }
      // ── v8.16.0/8.16.1: Quality Gate + Escape Hatch ──────────────────────
      if (workspacePath && toolCallHistory.length > 0 && !buildFailureCtx && !bypassQualityGate) {
        yield { type: 'thinking', text: '🏗️ Quality Gate: validating build before completion…' };
        const qgResult = await validateBuild(activeWorktreePath || workspacePath);
        if (!qgResult.success && !qgResult.error?.toLowerCase().includes('missing script')) {
          consecutiveBuildFailures++;
          debugLog(workspacePath, `[Quality Gate] FAILED (${consecutiveBuildFailures}/3) — blocking agent completion`);
          if (consecutiveBuildFailures >= 3) {
            messages.push({
              role: 'user',
              content: `[QUALITY GATE CIRCUIT BREAKER] You have failed the build check 3 times. MANDATORY DIRECTIVE: You are FORBIDDEN from trying to complete this task again right now. You MUST immediately use the 'ask_user_approval' tool to explain the build errors to the human and ask if they want to BYPASS the build check or give you manual instructions.`,
            });
          } else {
            messages.push({
              role: 'user',
              content: `[QUALITY GATE FAILED] You attempted to complete the task, but the project fails to build. Error details:\n\n${qgResult.error}\n\nMANDATORY: You MUST fix these build errors before you can complete the task.`,
            });
          }
          continue;
        }
        consecutiveBuildFailures = 0;
        debugLog(workspacePath, '[Quality Gate] Passed — accepting completion');
      }
      // ─────────────────────────────────────────────────────────────────────
      debugLog(workspacePath, 'Ending: no tool calls → final response (ghostRetries exhausted)');
      // v8.27.0 — Same background memory extraction as the Orchestrator's
      // Report path above. This branch fires when the agent ends with text
      // alone (no tool calls) after Quality Gate passed — also a clean
      // success exit, so the extractor runs identically.
      extractMemories(messages, config, workspacePath).catch(() => { /* swallow */ });
      yield { type: 'streamEnd' };
      return;
    }

    // Push assistant message with tool_calls before Sherlock
    messages.push({
      role: 'assistant',
      content: textContent || null,
      tool_calls: toolCalls,
    });

    // ── PRE-FLIGHT LOOP DETECTION ────────────────────────────────────────────
    // Intercept repeated calls BEFORE the Auditor — it must never see them.
    // Looped tcs get a synthetic result immediately; only fresh calls proceed.
    let loopRedirectNeeded = false;
    const tcToExecute: NativeToolCall[] = [];
    for (const tc of toolCalls) {
      let loopArgs: Record<string, any> = {};
      try { loopArgs = JSON.parse(tc.function.arguments); } catch { /* treat as fresh */ }
      const loopKey = `${tc.function.name}:${JSON.stringify(loopArgs)}`;
      if (toolCallHistory.includes(loopKey)) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: `[LOOP_INTERCEPTED] This exact call was already executed in this session. Result suppressed to prevent infinite loop.`,
        });
        loopRedirectNeeded = true;
      } else {
        tcToExecute.push(tc);
      }
    }

    // All calls looped → skip Auditor entirely and re-enter immediately
    if (loopRedirectNeeded && tcToExecute.length === 0) {
      messages.push({
        role: 'user',
        content: `⚠️ SYSTEM: You just executed this exact tool successfully. DO NOT repeat it. Move to the next logical step immediately (e.g., 'run_command' → 'npm run build') or finish the task.`,
      });
      continue;
    }

    // 3. Swarm Verification (Sherlock Auditor) — runs only on fresh tool calls
    // Safe-batch bypass: skip Auditor for calls that can never trigger a rogue rule.
    const SAFE_RUN_PATTERNS = ['npm run', 'tsc ', 'npx ', 'git status', 'git log', 'git diff', 'git pull', 'git push'];
    const isSafeBatch = tcToExecute.every(tc => {
      const n = tc.function.name;
      if (n === 'read_file' || n === 'list_dir' || n === 'search_in_files') { return true; }
      if (n === 'run_command') {
        let cmdArgs: any = {};
        try { cmdArgs = JSON.parse(tc.function.arguments); } catch { return false; }
        const cmd = (cmdArgs.command as string || '').toLowerCase();
        return SAFE_RUN_PATTERNS.some(p => cmd.includes(p));
      }
      // exit_worktree(discard) is a pure environment cleanup — Sherlock must never block it.
      // This covers the case where enter_worktree failed due to a stale worktree conflict.
      if (n === 'exit_worktree') {
        let wtArgs: any = {};
        try { wtArgs = JSON.parse(tc.function.arguments); } catch { return false; }
        return (wtArgs.action as string | undefined)?.toLowerCase() === 'discard';
      }
      return false;
    });

    if (!isSafeBatch) {
      yield { type: 'thinking', text: '🛡️ Sherlock Auditor is verifying the plan…' };
      const sentinelCtx = sentinelHasError ? 'SENTINEL_HAS_ERROR: true\n\n' : '';
      const revisorCtx = sentinelCtx + buildFailureCtx;
      const toolCallSummary = tcToExecute.map((tc, i) => {
        let argsPreview = '';
        try { argsPreview = JSON.stringify(JSON.parse(tc.function.arguments)); }
        catch { argsPreview = tc.function.arguments.slice(0, 300); }
        return `${i + 1}. ${tc.function.name}(${argsPreview})`;
      }).join('\n');

      const priorHistory = successfulToolCallHistory.length > 0
        ? `\n\nPRIOR COMPLETED TOOLS (already executed successfully in this session — account for these before judging the current batch):\n${successfulToolCallHistory.map((h, i) => `${i + 1}. ${h}`).join('\n')}`
        : '';

      const revisorMessages: ChatMessage[] = [
        { role: 'system', content: REVISOR_PROMPT },
        {
          role: 'user',
          content: `${revisorCtx}USER REQUEST: "${userMessage}"\n\nAGENT TOOL CALLS (current batch to evaluate):\n${toolCallSummary}${priorHistory}\n\nReview for rogue behavior. Deleting files the user asked to delete is NOT an error.`,
        },
      ];

      let auditorModel = 'google/gemini-2.5-flash';
      if (config.model.includes('anthropic/')) { auditorModel = 'anthropic/claude-3-haiku'; }
      else if (config.model.includes('openai/')) { auditorModel = 'openai/gpt-4o-mini'; }

      const revisorResult = await callOpenRouterBlocking(revisorMessages, { ...config, model: auditorModel, maxTokens: 512 }, abortSignal);

      if (revisorResult.content && revisorResult.content.toUpperCase().includes('ERROR:')) {
        const errorMsg = revisorResult.content.split('ERROR:')[1]?.trim() || 'Rogue behavior detected.';
        yield { type: 'error', message: `🛡️ Sherlock Auditor: ${errorMsg}` };
        const syntaxTargets = tcToExecute
          .filter(tc => tc.function.name === 'replace_lines' || tc.function.name === 'write_file')
          .map(tc => { try { return (JSON.parse(tc.function.arguments) as any).path || ''; } catch { return ''; } })
          .filter(Boolean);
        const readFileDirective = syntaxTargets.length > 0
          ? `\n\nSYNTAX_RECOVERY_DIRECTIVE: ANTES de enviar cualquier replace_lines, ejecuta read_file en ${syntaxTargets.map((p: string) => `"${p}"`).join(', ')}. Ver el estado actual del archivo es OBLIGATORIO — está prohibido adivinar líneas sin leer primero.`
          : '';
        // ── v8.26.1 — Sherlock 400 Hotfix (Schema Closure) ──────────────────────
        // The OpenAI / OpenRouter Chat Completions schema requires that EVERY
        // tool_call emitted by an assistant message be answered by a tool
        // message carrying the matching tool_call_id BEFORE the next request.
        // The previous Sherlock-rejection path violated this: it pushed a
        // user-role recovery directive and `continue`d without ever emitting
        // the role:'tool' answers for the calls in tcToExecute. Result: the
        // next callOpenRouterBlocking request crashed with HTTP 400
        // "An assistant message with 'tool_calls' must be followed by tool
        // messages responding to each 'tool_call_id'". The fix mirrors the
        // v8.23.1 Safe Compaction discipline: never break the assistant→tool
        // pairing — emit a stub answer for every blocked call so the schema
        // closes cleanly. Push BEFORE the user message so the turn ordering
        // is exactly: assistant(tool_calls) → tool×N (blocked stubs) → user
        // (recovery directive) → next assistant.
        for (const tc of tcToExecute) {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: '[AUDIT BLOCKED] The Sherlock Auditor rejected this tool call. See the critical audit failure message below.',
          });
        }
        // ─────────────────────────────────────────────────────────────────────
        messages.push({ role: 'user', content: `CRITICAL AUDIT FAILURE: ${revisorResult.content}\n\nRECUPERACIÓN OBLIGATORIA: (1) Relee el error arriba con cuidado. (2) Ejecuta read_file en el archivo afectado para ver su estado actual antes de cualquier nuevo replace_lines. (3) Solo corrige el problema específico señalado; no toques nada más.${readFileDirective}` });
        continue;
      }
    }

    buildFailureCtx = ''; // reset — will be set again if build fails this iteration
    consecutiveGhostCount = 0; // reset — real tool calls are executing this iteration
    ghostRetries = 0;

    // 4. Execute Tools (looped calls already handled above — only fresh calls here)
    for (const tc of tcToExecute) {
      if (abortSignal.aborted) { return; }

      // Parse arguments — malformed JSON is fed back as a tool error
      let args: Record<string, any> = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch (e: any) {
        const parseErr = `JSON parse error in ${tc.function.name} arguments: ${e.message}`;
        debugLog(workspacePath, parseErr);
        messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: parseErr });
        continue;
      }

      const toolName = tc.function.name;

      // ── Auto-inject agent_id for mutex-aware tools (FileLockManager v8.1.0) ────
      // The engine tags every file-write operation with the current agent's ID so
      // the FileLockManager always knows who holds each file lock — the LLM does not
      // need to pass agent_id manually.
      if ((toolName === 'replace_lines' || toolName === 'write_file' || toolName === 'replace_block') && !args.agent_id) {
        args.agent_id = agentId;
      }
      // ─────────────────────────────────────────────────────────────────────────

      // ── Path Normalization Middleware (v8.5.2) ────────────────────────────────
      // Normalize 'path' and 'file_path' arguments for ALL tools before execution.
      // Silently fixes /workspace/ bias and converts absolute paths to relative.
      let pathNormError: string | null = null;
      for (const pArg of ['path', 'file_path']) {
        if (typeof args[pArg] === 'string') {
          const norm = normalizeAgentPath(args[pArg], workspacePath);
          if (!norm.ok) { pathNormError = norm.error!; break; }
          args[pArg] = norm.normalized;
        }
      }
      // ─────────────────────────────────────────────────────────────────────────

      // ── Worktree Prefix Sanitizer (v8.22.0) ──────────────────────────────────
      // The engine already executes tools inside the active worktree dynamically,
      // but the LLM still hallucinates the explicit `.fluxo/worktrees/<id>/` head
      // on its arguments under recovery pressure — which double-nests the path
      // and turns into a fatal FILE NOT FOUND. Auto-correct silently across all
      // file-tool path keys: `path`, `file_path`, `absolute_path`, `path_filter`
      // (grep), and `cwd` (glob). The agent never sees an error; the iteration
      // proceeds with the cleaned path. Failing loudly here was the v8.18.x
      // approach for absolute paths, but worktree-prefix is a different failure
      // mode — the LLM has the right repo-relative tail, just an extra head — so
      // a silent fix is correct: it preserves intent and saves an iteration.
      for (const pArg of ['path', 'file_path', 'absolute_path', 'path_filter', 'cwd']) {
        if (typeof args[pArg] === 'string') {
          const { cleaned, stripped } = stripWorktreePrefix(args[pArg]);
          if (stripped) {
            debugLog(workspacePath, `[Worktree Sanitizer] ${toolName}.${pArg}: "${args[pArg]}" → "${cleaned}"`);
            args[pArg] = cleaned;
          }
        }
      }
      // ─────────────────────────────────────────────────────────────────────────

      // ── Deep Masking: Soft Fail ───────────────────────────────────────────────
      // If the LLM hallucinates a call to a disabled tool, intercept it before
      // Sherlock or execution — return a corrective error, never a panic crash.
      if (maskedTools.size > 0 && maskedTools.has(toolName.toLowerCase())) {
        const softFailMsg = `SYSTEM OVERRIDE: Has intentado alucinar la herramienta [${toolName}] que está desactivada. Corrige tu estrategia inmediatamente usando las herramientas disponibles en tu esquema.`;
        debugLog(workspacePath, `[Deep Masking] Soft Fail — intercepted hallucinated call to '${toolName}'`);
        const sfDisplayArgs = Object.entries(args).filter(([k]) => k !== 'content').map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`).join(', ');
        yield { type: 'toolCall', name: toolName, args, displayArgs: sfDisplayArgs };
        yield { type: 'toolResult', name: toolName, success: false, output: softFailMsg };
        messages.push({ role: 'tool', tool_call_id: tc.id, name: toolName, content: softFailMsg });
        continue;
      }
      // ─────────────────────────────────────────────────────────────────────────

      // Register in history (pre-flight check for future iterations)
      toolCallHistory.push(`${toolName}:${JSON.stringify(args)}`);

      // ── Global Circuit Breaker — pre-execution block (v8.13.0) ───────────────
      // Hard-blocks a tool after 3 consecutive failures so the agent is forced
      // to change strategy instead of retrying in an infinite death spiral.
      const _cbFails = toolFailureTracker.get(toolName) ?? 0;
      if (_cbFails >= 3) {
        // ── v8.17.1: read_file Soft Block — degrade, never permanently lock out ──
        // Phase 1 DAG dogfooding showed that a permanent read_file lockout left
        // the agent blind for the remainder of the session — it could no longer
        // inspect any file even after the original cause (a wrong path) was
        // gone. Soft-block strategy: pause one turn, force a list_dir on the
        // parent directory of the failed path so the agent can see what is
        // actually there, then RESET the counter so future read_file calls work.
        if (toolName === 'read_file') {
          const _failedPath = String(args.path ?? args.file_path ?? '').replace(/\\/g, '/');
          const _parentDir  = _failedPath.includes('/')
            ? _failedPath.substring(0, _failedPath.lastIndexOf('/')) || '.'
            : '.';
          const softMsg =
            `[SOFT BLOCK v8.17.1] 'read_file' has failed ${_cbFails} times consecutively — ` +
            `your path resolution is wrong. MANDATORY NEXT ACTION: call list_dir(path="${_parentDir}") ` +
            `to inspect the real contents of that directory, then retry read_file with the correct ` +
            `filename. The failure counter has been RESET — you have a fresh budget once you see the ` +
            `directory listing. Do NOT call read_file again until you have run list_dir.`;
          toolFailureTracker.delete('read_file');
          debugLog(workspacePath, `[Circuit Breaker — Soft] 'read_file' counter reset; forcing list_dir(${_parentDir})`);
          const sbDisplayArgs = Object.entries(args)
            .filter(([k]) => k !== 'content')
            .map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`)
            .join(', ');
          yield { type: 'toolCall', name: toolName, args, displayArgs: sbDisplayArgs };
          yield { type: 'toolResult', name: toolName, success: false, output: softMsg };
          messages.push({ role: 'tool', tool_call_id: tc.id, name: toolName, content: softMsg });
          continue;
        }
        // ── v8.16.2: YIELD_TO_HUMAN — IO core tools abort loop, not retry ────────
        const IO_CORE_TOOLS = ['glob', 'search_in_files', 'list_dir', 'get_code_structure'];
        if (IO_CORE_TOOLS.includes(toolName)) {
          debugLog(workspacePath, `[Circuit Breaker] '${toolName}' is IO_CORE — YIELD_TO_HUMAN, aborting loop`);
          yield { type: 'streamChunk', text: '[SYSTEM ERROR] No puedo mapear el proyecto para encontrar el archivo solicitado. Por favor, verifica la ruta o dame el archivo exacto para continuar.' };
          yield { type: 'streamEnd' };
          return;
        }
        const cbMsg =
          `[SYSTEM] Tool '${toolName}' disabled due to ${_cbFails} consecutive failures. ` +
          `MANDATORY: You must change your strategy and use a different tool ` +
          `(e.g., 'create_team' or 'write_file' directly).`;
        const cbDisplayArgs = Object.entries(args)
          .filter(([k]) => k !== 'content')
          .map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`)
          .join(', ');
        yield { type: 'toolCall', name: toolName, args, displayArgs: cbDisplayArgs };
        yield { type: 'toolResult', name: toolName, success: false, output: cbMsg };
        messages.push({ role: 'tool', tool_call_id: tc.id, name: toolName, content: cbMsg });
        debugLog(workspacePath, `[Circuit Breaker] '${toolName}' hard-blocked — ${_cbFails} consecutive failures`);
        continue;
      }
      // ─────────────────────────────────────────────────────────────────────────

      // Display
      const displayArgs = Object.entries(args)
        .filter(([k]) => k !== 'content')
        .map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`)
        .join(', ');
      yield { type: 'toolCall', name: toolName, args, displayArgs };

      // ── Panoramic Physical Shield (v8.17.4) ──────────────────────────────────
      // Promote the v8.17.3 prompt-level PANORAMIC RULE to a hard engine block.
      // For @coder and @designer, the search/edit family (grep, glob,
      // search_in_files, search_and_replace) is physically gated until the
      // agent has called get_repo_map at least once in this session. The block
      // fires BEFORE the Rabbit Hole guard so the shield message reaches the
      // LLM even if the agent also tried to grep into node_modules.
      if (PANORAMIC_GATED_AGENTS.has(agentId) &&
          PANORAMIC_GATED_TOOLS.has(toolName) &&
          !hasSeenRepoMap) {
        const shieldMsg =
          '[SYSTEM SHIELD] You are operating blind. You MUST call get_repo_map ' +
          'to gain spatial awareness before searching or editing.';
        debugLog(workspacePath, `[Panoramic Shield] ${toolName} blocked for @${agentId} — get_repo_map not yet called`);
        yield { type: 'toolResult', name: toolName, success: false, output: shieldMsg };
        messages.push({ role: 'tool', tool_call_id: tc.id, name: toolName, content: shieldMsg });
        continue;
      }
      // ─────────────────────────────────────────────────────────────────────────

      // ── Rabbit Hole Soft-Limit (v8.29.0, was Hard Block v8.16.23) ───────────
      // Frontier models sometimes have a legitimate reason to peek at a package's
      // source once (e.g. confirm an API shape, check a type export). The old
      // blanket hard-block prevented even that. v8.29.0 converts it to a 1-strike
      // soft-limit: the FIRST access gets a loud warning injected into the tool
      // output but execution is allowed; subsequent accesses are hard-blocked.
      // Whole-word boundary regex so "node_modules_check.ts" still passes through.
      const _rabbitHoleGated = toolName === 'read_file' || toolName === 'grep' ||
                               toolName === 'glob' || toolName === 'search_and_replace' ||
                               toolName === 'run_command';
      if (_rabbitHoleGated) {
        const _rabbitRe = /(?:^|[\/\\\s"'`])node_modules(?:[\/\\\s"'`]|$)/i;
        const _rabbitHit = Object.values(args).some(
          v => typeof v === 'string' && _rabbitRe.test(v)
        );
        if (_rabbitHit) {
          if (nodeModulesAccessCount >= 1) {
            // Hard block on second+ access — same message as before.
            const _rhMsg =
              "[SYSTEM BLOCK] RABBIT HOLE DETECTED. You are strictly forbidden from " +
              "inspecting or debugging 'node_modules/'. The bug is in your own code, " +
              "not in the external libraries. Look at the files you just modified.";
            debugLog(workspacePath, `[Rabbit Hole] ${toolName} hard-blocked — nodeModulesAccessCount=${nodeModulesAccessCount}`);
            yield { type: 'toolResult', name: toolName, success: false, output: _rhMsg };
            messages.push({ role: 'tool', tool_call_id: tc.id, name: toolName, content: _rhMsg });
            continue;
          }
          // First access — allow execution but arm the counter and tag the result.
          nodeModulesAccessCount++;
          debugLog(workspacePath, `[Rabbit Hole] ${toolName} soft-warned — first node_modules access (counter now 1)`);
          // _rabbitSoftWarning will be appended to the real tool result below.
          // We mark with a sentinel so the result-augmentation section can find it.
          (args as any).__rabbitSoftWarn = true;
        }
      }
      // ─────────────────────────────────────────────────────────────────────────

      // ── Worktree Path Redirect (v8.8.0) ──────────────────────────────────────
      // When a git worktree is active, ALL file and command operations are silently
      // redirected to the worktree directory. The LLM uses normal relative paths
      // (e.g. "src/App.tsx") and the engine maps them transparently — no prefix needed.
      // Worktree management tools and planning tools always use the main workspace.
      const _wtExcluded = toolName === 'enter_worktree' || toolName === 'exit_worktree' ||
                          toolName === 'skill' || toolName === 'enter_plan_mode';

      // ── Plan Path Global Bypass (v8.16.20 + v8.17.1) ───────────────────────
      // IMPLEMENTATION_PLAN.md is a session-global handoff file between @planner
      // and @manager/@coder. It MUST live at the repo root regardless of worktree
      // state — otherwise the planner writes it inside the sandbox, the manager
      // checks for it at the root and never finds it, and the planning loop
      // diverges into infinite retry. Detect any tool whose path argument ends
      // in IMPLEMENTATION_PLAN.md and force-route it to the main workspace.
      //
      // v8.17.1: extended to dag_state.json / task_dag_state.json. The DAG is a
      // global orchestrator file — every agent writes its task status into the
      // SAME .fluxo/dag_state.json. If the @coder writes its COMPLETED status
      // inside a worktree sandbox, the @manager polling at the root never sees
      // the update and the dispatcher stalls. Same fix, same global routing.
      const _planPathArg = String(
        args.path ?? args.file_path ?? args.absolute_path ?? ''
      ).replace(/\\/g, '/');
      const _isPlanFile = /(?:^|\/)\.fluxo\/IMPLEMENTATION_PLAN\.md$/i.test(_planPathArg) ||
                          _planPathArg.endsWith('IMPLEMENTATION_PLAN.md');
      const _isDagStateFile = /(?:^|\/)(?:task_)?dag_state\.json$/i.test(_planPathArg);
      const _isGlobalStateFile = _isPlanFile || _isDagStateFile;
      // ───────────────────────────────────────────────────────────────────────

      const effectiveWorkspacePath = (activeWorktreePath && !_wtExcluded && !_isGlobalStateFile)
        ? activeWorktreePath
        : workspacePath;
      if (activeWorktreePath && effectiveWorkspacePath !== workspacePath) {
        debugLog(workspacePath, `[Worktree Redirect] ${toolName} → ${effectiveWorkspacePath}`);
      }
      if (_isGlobalStateFile && activeWorktreePath) {
        const _bypassTag = _isDagStateFile ? 'DAG State Bypass v8.17.1' : 'Plan Bypass v8.16.20';
        debugLog(workspacePath, `[${_bypassTag}] ${toolName}(${_planPathArg}) → main workspace (worktree active but file is global)`);
      }
      // ─────────────────────────────────────────────────────────────────────────

      // Execute
      const startTime = Date.now();
      let result: { success: boolean; output: string };
      try {
        if (pathNormError) {
          result = { success: false, output: pathNormError };
        } else if (toolName === 'ask_user_approval') {
          // ── ask_user_approval Hard Intercept (v8.16.20 + v8.33.0) ───────────
          // ALWAYS intercept before executeTool. There is no native handler for
          // ask_user_approval — letting it fall through would crash the loop
          // with [SYSTEM ENGINE ERROR] and trigger an infinite retry.
          //
          // v8.33.0 — Discovery Mode (planner-only): when discoveryAnswerCallback
          // is wired AND the active agent is @planner, prefer the text-answer
          // flow: the host shows showInputBox, the user TYPES their answers, and
          // those answers become the tool result.output. The planner sees the
          // verbatim answers and writes the plan informed by them in the same
          // sub-loop iteration. For all other agents (manager/coder/designer)
          // the existing binary approvalCallback flow is preserved — Y/N modal
          // remains the right UX for "should I delete this file?" type calls.
          const _intent = String(args.intent_summary ?? '');
          const _reason = String(args.reason_and_files ?? '');
          if (discoveryAnswerCallback && agentId === 'planner') {
            const _question = `${_intent}\n\n${_reason}`.trim();
            yield { type: 'thinking', text: '🔎 Discovery: awaiting your clarifications…' };
            const _answer = await discoveryAnswerCallback(_question);
            if (_answer === null || _answer === undefined || _answer.trim() === '') {
              result = {
                success: false,
                output:
                  'USER CANCELED Discovery. Proceed with the safest default plan ' +
                  'and document any assumptions you must make in the plan markdown.',
              };
            } else {
              result = {
                success: true,
                output:
                  `User answered: ${_answer.trim()}\n\n` +
                  `Now incorporate these answers and ship the implementation plan via ` +
                  `write_file('.fluxo/IMPLEMENTATION_PLAN.md', ...). Do NOT ask further questions.`,
              };
            }
          } else if (approvalCallback) {
            yield { type: 'thinking', text: '🛡️ Bodyguard aguardando tu aprobación…' };
            const approved = await approvalCallback(_intent, _reason);
            result = {
              success: approved,
              output: approved
                ? 'USER APPROVED. Proceed with the planned tools.'
                : 'USER REJECTED. Stop all planned actions. Ask the user a focused clarifying question in plain text — do NOT call any edit tools.',
            };
          } else {
            debugLog(workspacePath, '[ask_user_approval] No approvalCallback wired — returning graceful failure to prevent infinite loop');
            yield { type: 'thinking', text: '⚠️ ask_user_approval invocado sin UI conectada…' };
            result = {
              success: false,
              output:
                '[ENGINE NOTICE] ask_user_approval was invoked but no human approval channel is connected to this session. ' +
                'Do NOT retry this tool. Instead, send your question directly to the user as plain text in your next response, ' +
                `or proceed with the safest default action. Your pending intent was: "${_intent}". Reason: "${_reason}".`,
            };
          }
          // ─────────────────────────────────────────────────────────────────────
        } else if (toolName === 'search_and_replace' && nativeEditCallback) {
          yield { type: 'thinking', text: '🔍 Applying VS Code native edit…' };
          result = await nativeEditCallback(
            String(args.path ?? ''),
            String(args.search_snippet ?? ''),
            String(args.replace_snippet ?? '')
          );
          // ── Smart Failure Interceptor (v8.16.22 — Strict Fallback) ─────────
          // The previous gentle hint allowed the agent to drift into grep abuse
          // when search_and_replace missed. Replace with a strict directive that
          // forbids grep / guessing entirely and pins read_file as the only
          // legal recovery path.
          if (!result.success) {
            result = {
              ...result,
              output: result.output +
                '\n\n[SYSTEM ENFORCEMENT] MATCH ERROR. You hallucinated the search_snippet. ' +
                "You are STRICTLY FORBIDDEN from using 'grep' or guessing to fix this. " +
                "You MUST immediately use 'read_file' to extract the exact lines verbatim. " +
                'Any other action will result in system failure.',
            };
          }
          // ──────────────────────────────────────────────────────────────────
        } else if (toolName === 'get_code_structure' && getCodeStructureCallback) {
          // v8.18.1 — Absolute Path Shield. The engine intercept bypasses the
          // tool's execute() so the shield must mirror the rejection here.
          // Hallucinated drive-letter paths (C:/Users/erick/source/repos/...)
          // are rejected before they reach the LSP callback.
          const _absPath = String(args.absolute_path ?? '').trim();
          if (/^(?:[A-Za-z]:[\\/]|\/)/.test(_absPath)) {
            result = {
              success: false,
              output:
                '[SYSTEM SHIELD] Absolute paths are strictly forbidden. ' +
                "You MUST use relative paths from the repository root (e.g., 'src/components/App.jsx').",
            };
          } else {
            yield { type: 'thinking', text: '🔭 Extracting code structure via LSP…' };
            result = await getCodeStructureCallback(_absPath);
          }
        } else if (toolName.startsWith('mcp_') && callMcpToolCallback) {
          yield { type: 'thinking', text: `🔌 MCP: Calling external tool ${toolName}…` };
          result = await callMcpToolCallback(toolName, args);
        } else if (toolName === 'list_mcp_resources' && listMcpResourcesCallback) {
          // ── v8.26.0 — Phase 3.4 MCP resource discovery ────────────────────
          // Synchronous executeTool can't reach the live stdio transports in
          // the extension host, so we route through the async callback before
          // dispatch. Mirrors the get_code_structure / replace_symbol pattern.
          const _serverName = String(args.server_name ?? '').trim();
          if (!_serverName) {
            result = {
              success: false,
              output: 'list_mcp_resources: missing required `server_name` argument. Provide the alias from .fluxo/mcp_servers.json (e.g. "github", "n8n").',
            };
          } else {
            yield { type: 'thinking', text: `🔌 MCP: Discovering resources on ${_serverName}…` };
            result = await listMcpResourcesCallback(_serverName);
          }
        } else if (toolName === 'replace_symbol' && replaceSymbolCallback) {
          // ── LSP Symbol Replace (v8.5.0) ────────────────────────────────────────
          yield { type: 'thinking', text: '🔬 LSP: locating AST symbol…' };
          result = await replaceSymbolCallback(
            String(args.file_path ?? args.path ?? ''),
            String(args.symbol_name ?? ''),
            String(args.new_code ?? '')
          );
          if (!result.success) {
            result = {
              ...result,
              output: result.output +
                '\n\nRECUPERACIÓN: Llama get_code_structure para ver los nombres exactos de los símbolos disponibles, luego reintenta con el nombre correcto.',
            };
          }
          // ─────────────────────────────────────────────────────────────────────

        } else if (toolName === 'fetch_documentation') {
          yield { type: 'thinking', text: '🌐 Fetching external documentation…' };
          result = await fetchDocumentation(String(args.url ?? ''));

        // ── Worktree Human Review (v8.3.0) ───────────────────────────────────────
        // Intercept exit_worktree merge calls before execution so the user can
        // inspect the diff in VS Code's native diff editor and approve/discard.
        } else if (toolName === 'exit_worktree' && args.action === 'merge' && worktreeReviewCallback) {
          const wStateFile = path.join(workspacePath, '.fluxo', 'active_worktree.json');
          let reviewedAction: 'merge' | 'discard' = 'merge';
          if (fs.existsSync(wStateFile)) {
            try {
              const wState = JSON.parse(fs.readFileSync(wStateFile, 'utf-8'));
              yield { type: 'thinking', text: '🔍 Requesting human review before worktree merge…' };
              reviewedAction = await worktreeReviewCallback(wState.branchName, wState.worktreePath);
              debugLog(workspacePath, `[Worktree Review] User decision: ${reviewedAction}`);
            } catch {
              // State unreadable — fall through to direct merge
            }
          }
          result = executeTool('exit_worktree', { ...args, action: reviewedAction }, workspacePath);
        // ─────────────────────────────────────────────────────────────────────────

        // ── Worktree Auto-Cleanup (v8.11.0) ──────────────────────────────────────
        // If a worktree is already active when enter_worktree is called, silently
        // discard the stale one first. The agent never sees this — it prevents the
        // "already active" conflict without requiring the agent to manage state.
        } else if (toolName === 'enter_worktree') {
          if (activeWorktreePath) {
            yield { type: 'thinking', text: '🧹 Auto-cleanup: discarding stale worktree before entering new one…' };
            executeTool('exit_worktree', { action: 'discard' }, workspacePath);
            activeWorktreePath = null;
            debugLog(workspacePath, '[Worktree Auto-Cleanup] Stale worktree discarded silently before enter_worktree');
          }
          result = executeTool(toolName, args, effectiveWorkspacePath);
        // ─────────────────────────────────────────────────────────────────────────

        // ── Community Skills Library (v8.6.0) ────────────────────────────────────
        // Skills are JSON recipes in the root-level skills/ directory (baked into
        // the VSIX). __dirname = out/ at runtime → ../skills resolves correctly
        // both in development and when installed from a VSIX package.
        } else if (toolName === 'skill') {
          const skillsDir = path.join(__dirname, '..', 'skills');
          const action    = String(args.action ?? 'list');

          if (action === 'list') {
            let skillList: Array<{ name: string; description: string }> = [];
            try {
              if (fs.existsSync(skillsDir)) {
                const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.json'));
                skillList = files.map(f => {
                  try {
                    const data = JSON.parse(fs.readFileSync(path.join(skillsDir, f), 'utf-8'));
                    return { name: data.name ?? f.replace('.json', ''), description: data.description ?? '' };
                  } catch {
                    return { name: f.replace('.json', ''), description: '(unreadable)' };
                  }
                });
              }
            } catch { /* skills dir unreadable — return empty list */ }

            result = skillList.length > 0
              ? { success: true, output: `AVAILABLE SKILLS (${skillList.length}):\n\n` + skillList.map(s => `• ${s.name}\n  ${s.description}`).join('\n\n') }
              : { success: true, output: 'No community skills available yet. Add JSON files to skills/ (root level) to contribute.' };

          } else if (action === 'apply') {
            const skillName = String(args.skill_name ?? '').trim();
            if (!skillName) {
              result = { success: false, output: 'ERROR: skill_name is required for action="apply". Call action="list" to see available skills.' };
            } else {
              const skillFile = path.join(skillsDir, `${skillName}.json`);
              if (!fs.existsSync(skillFile)) {
                result = { success: false, output: `Skill "${skillName}" not found in the library. Call skill(action="list") to see valid names.` };
              } else {
                // All paths inside this try-catch assign result — TypeScript can track cleanly.
                try {
                  const skillData = JSON.parse(fs.readFileSync(skillFile, 'utf-8'));
                  const recipe = typeof skillData.recipe === 'string'
                    ? skillData.recipe
                    : (Array.isArray(skillData.recipe) ? skillData.recipe.join('\n\n') : JSON.stringify(skillData.recipe, null, 2));
                  const planDir  = path.join(workspacePath, '.fluxo');
                  const planFile = path.join(planDir, 'IMPLEMENTATION_PLAN.md');
                  fs.mkdirSync(planDir, { recursive: true });
                  fs.writeFileSync(planFile, recipe, 'utf-8');
                  yield { type: 'thinking', text: `✅ Skill "${skillName}" applied to IMPLEMENTATION_PLAN.md` };
                  result = {
                    success: true,
                    output:
                      `Skill "${skillName}" aplicado exitosamente al IMPLEMENTATION_PLAN.md.\n\n` +
                      `${recipe}\n\n` +
                      `Procede a ejecutar el plan: llama create_team con tasks que referencien los pasos del plan.`,
                  };
                } catch (e: any) {
                  result = { success: false, output: `ERROR: Failed to apply skill "${skillName}": ${e.message}` };
                }
              }
            }
          } else {
            result = { success: false, output: `Unknown action "${action}". Valid values: "list", "apply".` };
          }
        // ─────────────────────────────────────────────────────────────────────────

        // ── Planning Gate — @planner sub-agent (v8.5.3) ─────────────────────────
        } else if (toolName === 'enter_plan_mode') {
          const taskDescription = String(args.task_description ?? userMessage);
          yield { type: 'thinking', text: '📋 Planner: reading codebase…' };

          // ── v8.16.3: Guarantee .fluxo/ exists before @planner tries to write there ──
          if (workspacePath) {
            fs.mkdirSync(path.join(workspacePath, '.fluxo'), { recursive: true });
          }

          const planFile = path.join(workspacePath, '.fluxo', 'IMPLEMENTATION_PLAN.md');

          // ── v8.28.2: Stale Plan Cleanup ──────────────────────────────────────────
          // If a previous session left IMPLEMENTATION_PLAN.md on disk, the
          // `while (!fs.existsSync(planFile))` guard below would skip the planner
          // entirely, leaving the @manager with a stale plan from a prior task. Wipe
          // the old file before the retry loop so the planner always runs on a fresh
          // slate. The try/catch is intentional — a locked file on Windows or a
          // permission error must never block the planning phase from starting.
          try {
            if (fs.existsSync(planFile)) {
              fs.unlinkSync(planFile);
            }
          } catch { /* silenciar errores */ }
          // ─────────────────────────────────────────────────────────────────────────

          // ── v8.16.5 + v8.33.0: Mandatory Output Enforcement + Discovery Mode ────
          // The planner historically suffered from "premature termination" — yielding
          // conversational text instead of calling write_file. The retry harness
          // physically verifies the file exists after each pass; if missing, the
          // planner is re-invoked with an escalating SYSTEM directive.
          //
          // v8.33.0 Discovery Mode adds two extensions:
          //   1) The planner now has approvalCallback + discoveryAnswerCallback
          //      wired so it CAN pause to collect text answers from the user
          //      via ask_user_approval (rerouted to showInputBox in the host).
          //   2) When the planner asks a clarifying question and the plan file
          //      isn't written yet, the iteration is REFUNDED (plannerAttempt--)
          //      and a separate discoveryRounds counter (capped at 2) tracks
          //      Discovery turns. This prevents Discovery from burning the
          //      retry budget meant for stubborn-LLM failures.
          //   3) lastIterationWasDiscovery gates the harsh "[SYSTEM RETRY] You
          //      forgot to use write_file" override — that message is unjust
          //      after a valid Discovery turn and would derail the planner's
          //      next iteration. After Discovery we inject a positive directive
          //      asking the planner to ship the plan informed by user answers.
          const MAX_PLANNER_ATTEMPTS = 3;
          const MAX_DISCOVERY_ROUNDS = 2;
          let plannerAttempt = 0;
          let discoveryRounds = 0;
          let lastIterationWasDiscovery = false;
          let plannerMission =
            `MISSION — ANALYSIS ONLY:\nAnalyze the codebase and produce .fluxo/IMPLEMENTATION_PLAN.md for this task:\n\n${taskDescription}`;

          while (plannerAttempt < MAX_PLANNER_ATTEMPTS && !fs.existsSync(planFile)) {
            plannerAttempt++;
            if (plannerAttempt > 1 && !lastIterationWasDiscovery) {
              yield {
                type: 'thinking',
                text: `📋 Planner: file not produced — retry ${plannerAttempt}/${MAX_PLANNER_ATTEMPTS}…`,
              };
              plannerMission =
                `[SYSTEM RETRY ${plannerAttempt}/${MAX_PLANNER_ATTEMPTS}] You forgot to use write_file. ` +
                `The file .fluxo/IMPLEMENTATION_PLAN.md does NOT exist yet. ` +
                `Do NOT explain. Do NOT analyze further. Do NOT read more files. ` +
                `Your ONLY valid next action is to call write_file with path='.fluxo/IMPLEMENTATION_PLAN.md' ` +
                `and content='<your full markdown plan>'. Even a rough plan is acceptable — write it now.\n\n` +
                `ORIGINAL TASK:\n${taskDescription}`;
            }
            lastIterationWasDiscovery = false;

            const plannerEventBuffer: AgentEvent[] = [];
            const plannerGen = runAgentLoop(
              plannerMission,
              'planner',
              [],
              { ...effectiveConfig, model: config.model },
              workspacePath,
              abortSignal,
              false,
              approvalCallback,         // v8.33.0 — wired so the planner can ask via Discovery Mode
              undefined,                // no native edit
              getCodeStructureCallback,
              mcpTools,
              callMcpToolCallback,
              undefined,                // no worktree review
              undefined,                // no replace symbol
              undefined,                // no HITL — planner is read-only
              mcpToolCategories,        // v8.19.0 — RBAC filter will deny unknown-category tools to planner
              undefined,                // v8.23.0 — no LSP passive feedback for the planner (read-only, never edits)
              listMcpResourcesCallback, // v8.26.0 — Phase 3.4 resource discovery (planner DOES use this)
              discoveryAnswerCallback   // v8.33.0 — text-answer channel for Discovery Mode
            );

            for await (const event of plannerGen) {
              plannerEventBuffer.push(event);
            }

            // v8.33.0 — Discovery refund: a successful clarifying question that
            // didn't yet produce the plan is a valid turn, not a stubborn-LLM
            // failure. Refund the attempt and prime the next iteration with a
            // positive directive. Capped to MAX_DISCOVERY_ROUNDS so the planner
            // cannot loop forever asking instead of writing.
            const askedClarification = plannerEventBuffer.some(e =>
              e.type === 'toolCall' && e.name === 'ask_user_approval'
            );
            if (askedClarification && !fs.existsSync(planFile) && discoveryRounds < MAX_DISCOVERY_ROUNDS) {
              plannerAttempt--;
              discoveryRounds++;
              lastIterationWasDiscovery = true;
              plannerMission =
                `[DISCOVERY MODE — v8.33.0 round ${discoveryRounds}/${MAX_DISCOVERY_ROUNDS}] ` +
                `You collected clarifications from the user via ask_user_approval. ` +
                `Their verbatim answers are now in your tool result history above. ` +
                `WRITE the implementation plan to .fluxo/IMPLEMENTATION_PLAN.md using write_file ` +
                `now — incorporate their answers verbatim. Do NOT ask more questions.\n\n` +
                `ORIGINAL TASK:\n${taskDescription}`;
              yield {
                type: 'thinking',
                text: `🔎 Discovery round ${discoveryRounds}/${MAX_DISCOVERY_ROUNDS} captured — attempt refunded`,
              };
            }

            const headerLabel = plannerAttempt === 1 && !lastIterationWasDiscovery
              ? '━━━ @planner — codebase analysis ━━━'
              : lastIterationWasDiscovery
                ? `━━━ @planner — Discovery round ${discoveryRounds}/${MAX_DISCOVERY_ROUNDS} ━━━`
                : `━━━ @planner — retry ${plannerAttempt}/${MAX_PLANNER_ATTEMPTS} ━━━`;
            yield { type: 'thinking', text: headerLabel };
            for (const event of plannerEventBuffer) { yield event; }
          }
          // ─────────────────────────────────────────────────────────────────────────

          if (fs.existsSync(planFile)) {
            const planContent = fs.readFileSync(planFile, 'utf-8');
            result = {
              success: true,
              output:
                `PLAN GENERATED SUCCESSFULLY. @coder and @designer can now execute sequentially.\n\n` +
                `${planContent}\n\n` +
                `NEXT STEP: Call create_team with agent task strings that reference the step numbers ` +
                `above. Each agent's task must be self-contained and cite the exact files from the plan.`,
            };
          } else {
            result = {
              success: false,
              output:
                `ERROR: @planner did not produce .fluxo/IMPLEMENTATION_PLAN.md after ${MAX_PLANNER_ATTEMPTS} attempts. ` +
                `[CIRCUIT BREAKER WARNING] DO NOT retry. The planning phase has failed. ` +
                `MANDATORY: You MUST use the ask_user_approval tool immediately to inform the user that you cannot proceed without a plan and ask for manual intervention. ` +
                `DO NOT use create_team.`,
            };
          }
        // ─────────────────────────────────────────────────────────────────────────

        // ── Parallel Swarm (v8.2.0) ──────────────────────────────────────────────
        } else if (toolName === 'create_team') {
          const teamSpec = Array.isArray(args.team)
            ? (args.team as Array<{ agent: string; task: string }>)
            : [];

          if (teamSpec.length === 0) {
            result = { success: false, output: 'create_team: the "team" array is empty or malformed. Provide at least one { agent, task } entry.' };
          } else {
            yield { type: 'thinking', text: `🐝 Parallel Swarm: launching ${teamSpec.length} agent(s) concurrently…` };

            // One event buffer per sub-agent — we can't yield from inside Promise.all
            // so we collect everything and replay sequentially after all threads finish.
            const eventBuffers: AgentEvent[][] = teamSpec.map(() => []);

            await Promise.all(teamSpec.map(async (member, idx) => {
              const subAgentId = (member.agent ?? '').toLowerCase().trim() || 'coder';

              // Deliver any pre-queued mailbox messages for this sub-agent as part of its task
              const pendingMsgs = AgentMailbox.drain(subAgentId);
              const taskMessage = pendingMsgs.length > 0
                ? `${member.task}\n\n--- INCOMING MESSAGES ---\n${pendingMsgs.join('\n')}`
                : member.task;

              const subGen = runAgentLoop(
                taskMessage,
                subAgentId,
                [],  // each sub-agent starts with a clean conversation slate
                { ...effectiveConfig, model: config.workerModel || config.model },
                workspacePath,
                abortSignal,
                sentinelHasError,
                approvalCallback,
                nativeEditCallback,
                getCodeStructureCallback,
                mcpTools,
                callMcpToolCallback,
                worktreeReviewCallback,
                replaceSymbolCallback,
                hitlCommandCallback,    // HITL propagated to all swarm sub-agents
                mcpToolCategories,       // v8.19.0 — each sub-agent re-applies its own RBAC filter
                getDiagnosticsCallback,  // v8.23.0 — sub-agents also get LSP passive feedback before their gate
                listMcpResourcesCallback // v8.26.0 — Phase 3.4 resource discovery propagated to swarm sub-agents
              );

              for await (const event of subGen) {
                eventBuffers[idx].push(event);
              }
            }));

            // Replay all sub-agent events in order, separated by dividers
            for (let i = 0; i < teamSpec.length; i++) {
              yield { type: 'thinking', text: `━━━ @${teamSpec[i].agent} — thread ${i + 1}/${teamSpec.length} ━━━` };
              for (const event of eventBuffers[i]) {
                yield event;
              }
            }

            result = {
              success: true,
              output: `Parallel Swarm complete. ${teamSpec.length} agent(s) ran concurrently: ${teamSpec.map(m => `@${m.agent}`).join(', ')}. Review all results above and emit your Orchestrator's Report.`,
            };
          }
        // ─────────────────────────────────────────────────────────────────────────

        // ── HITL — Human-in-the-Loop for run_command (v8.10.0) ──────────────────
        } else if (toolName === 'run_command') {
          const cmd = String(args.command ?? '');
          if (hitlCommandCallback && !isSafeCommandForAutoRun(cmd)) {
            yield { type: 'thinking', text: `🛡️ HITL: Solicitando autorización para: ${cmd.slice(0, 100)}…` };
            const approved = await hitlCommandCallback(cmd);
            result = approved
              ? executeTool(toolName, args, effectiveWorkspacePath)
              : {
                  success: false,
                  output:
                    '[HITL_REJECTED]: El usuario denegó la ejecución de este comando. ' +
                    'ALTERNATIVA OBLIGATORIA: Usa herramientas nativas — delete_file, delete_dir, ' +
                    'write_file, create_dir — para operaciones de archivos. ' +
                    'El shell es EXCLUSIVAMENTE para compilación (npm run build) y tests.',
                };
          } else {
            result = executeTool(toolName, args, effectiveWorkspacePath);
          }
        // ─────────────────────────────────────────────────────────────────────────

        } else {
          result = executeTool(toolName, args, effectiveWorkspacePath);
        }
      } catch (err: any) {
        result = { success: false, output: `[SYSTEM ENGINE ERROR]: ${err.message ?? String(err)}` };
      }

      // ── Worktree Conflict Resolution Hint (v8.3.3) ───────────────────────────
      // When enter_worktree fails because a worktree is already active, the agent
      // needs explicit authorization to discard it — otherwise it may loop or give up.
      if (!result.success && toolName === 'enter_worktree' && result.output.includes('already active')) {
        result = {
          ...result,
          output: result.output +
            '\n\nCONFLICTO DE WORKTREE DETECTADO: Tienes permiso para usar exit_worktree con action=\'discard\' para limpiar el entorno antes de reintentar. El Auditor ha sido notificado y autorizará este descarte automáticamente.',
        };
      }
      // ─────────────────────────────────────────────────────────────────────────

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      // ── Rabbit Hole Soft-Warning Injection (v8.29.0) ─────────────────────────
      // If the agent's first node_modules access was allowed through (sentinel
      // set above), mutate the result payload to append the warning BEFORE the
      // Financial Killswitch and the toolResult yield so the LLM reads both the
      // real output AND the one-shot brake advisory in the same message.
      if ((args as any).__rabbitSoftWarn) {
        delete (args as any).__rabbitSoftWarn;
        const _softWarning =
          '\n\n[SOFT BLOCK] Estás entrando a node_modules. Esta es tu ÚNICA lectura ' +
          'permitida aquí. Accesos futuros serán bloqueados físicamente.';
        result = { ...result, output: result.output + _softWarning };
      }
      // ─────────────────────────────────────────────────────────────────────────

      // ── Financial Killswitch (v8.24.0 — NON-NEGOTIABLE) ──────────────────────
      // Hard engine abort the moment ANY tool result carries the `[YIELD TO HUMAN`
      // sentinel. These payloads are emitted by tools that detected an OS-level
      // failure the LLM cannot fix (Node lost cmd.exe via ENOENT on Windows,
      // System32 dropped from PATH, ComSpec emptied, etc.). In the v8.23.x and
      // earlier behavior, the YIELD payload was pushed back into the message
      // history; the LLM read it, ignored the explicit "DO NOT retry" directive,
      // and burned the rest of MAX_ITERATIONS hallucinating MCP servers and
      // PowerShell evasions trying to "fix" a problem that lives outside the
      // process — costing real money per recovery attempt with zero chance of
      // success. The fix is structural: the result NEVER reaches the LLM. We
      // surface the tool output to the user (so they see what tool produced
      // the YIELD), emit a clear final error explaining what happened and what
      // the human needs to do, and terminate the generator before any further
      // API call. Detection is on the literal substring `[YIELD TO HUMAN` so
      // the v8.16.8 cmd.exe payload, the v8.16.2 IO_CORE breaker payload, and
      // any future tool that opts into this protocol all hit the same break.
      if (typeof result.output === 'string' && result.output.includes('[YIELD TO HUMAN')) {
        yield { type: 'toolResult', name: toolName, success: result.success, output: result.output, duration };
        debugLog(workspacePath, `[Financial Killswitch] '${toolName}' returned YIELD_TO_HUMAN — aborting loop to prevent API drain`);
        yield {
          type: 'streamChunk',
          text:
            '\n\n🛑 **[FINANCIAL KILLSWITCH — v8.24.0]** A tool reported a fatal OS-level error ' +
            '(see the tool output above). The agent loop has been halted before any further ' +
            'LLM call to prevent burning API credits on a problem that lives outside the ' +
            'process (typically a missing shell, broken PATH, or detached terminal). ' +
            'Resolve the underlying environment issue (restart VS Code from a fresh terminal, ' +
            'verify %ComSpec% on Windows, etc.) and retry the task.',
        };
        yield { type: 'streamEnd' };
        return;
      }
      // ─────────────────────────────────────────────────────────────────────────

      yield { type: 'toolResult', name: toolName, success: result.success, output: result.output, duration };
      debugLog(workspacePath, `Tool ${toolName}: success=${result.success}${!result.success ? ` — ${result.output.slice(0, 300)}` : ''}`);

      // ── v8.16.1: Quality Gate Bypass Detection ───────────────────────────────
      // Activates bypass when: (a) circuit breaker has fired (3+ QG failures) and the user
      // approves the ask_user_approval call, OR (b) the agent's intent_summary / reason
      // contains explicit bypass keywords (e.g., "bypass", "ignora el build", "skip").
      if (toolName === 'ask_user_approval' && result.success) {
        const intentText = (String(args.intent_summary ?? '') + ' ' + String(args.reason_and_files ?? '')).toLowerCase();
        const isBypassIntent = intentText.includes('bypass') || intentText.includes('ignora') ||
                               intentText.includes('skip') || intentText.includes('omitir') ||
                               intentText.includes('saltar');
        if (consecutiveBuildFailures >= 3 || isBypassIntent) {
          bypassQualityGate = true;
          debugLog(workspacePath, '[Quality Gate] Bypass activated by user approval after circuit breaker');
        }
      }
      // ─────────────────────────────────────────────────────────────────────────

      // ── Motor-level telemetry ────────────────────────────────────────────────
      // Auto-log tool failures to .fluxo/improvements.md without relying on the agent.
      if (!result.success && workspacePath && !result.output.startsWith('[LOOP_INTERCEPTED]')) {
        try {
          const improvementsDir = path.join(workspacePath, '.fluxo');
          const improvementsPath = path.join(improvementsDir, 'improvements.md');
          fs.mkdirSync(improvementsDir, { recursive: true });
          const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
          const isNew = !fs.existsSync(improvementsPath);
          const header = isNew
            ? '# Fluxo AI — Friction & Improvement Log\n\n> Auto-generated by the engine. Tool failures are logged automatically.\n'
            : '';
          const argsSnippet = JSON.stringify(args).slice(0, 200);
          const entry = `\n---\n\n### [${ts}] \`tool_failure\`\n\n**Tool:** ${toolName}\n**Args:** ${argsSnippet}\n**Error:** ${result.output.slice(0, 400)}\n`;
          fs.appendFileSync(improvementsPath, header + entry, 'utf-8');
        } catch { /* telemetry must never interrupt execution */ }
      }
      // ─────────────────────────────────────────────────────────────────────────

      // ── Circuit Breaker — halts blind retries on repeated tool failure ───────
      // replace_lines is the last-resort editing tool — it must NEVER be locked out.
      if (!result.success) {
        if (toolName !== 'run_command' && toolName !== 'get_code_structure' && toolName !== 'replace_lines') {
          const fails = (toolFailureTracker.get(toolName) || 0) + 1;
          toolFailureTracker.set(toolName, fails);
          if (fails >= 2) {
            result = {
              ...result,
              output: `SYSTEM ERROR [CIRCUIT Breaker ACTIVATED]: Has fallado ${fails} veces consecutivas intentando usar ${toolName}. ` +
                `Tienes PROHIBIDO seguir intentándolo a ciegas. El error probablemente se deba a diferencias invisibles de espacios/indentación. ` +
                `DEBES CAMBIAR DE ESTRATEGIA INMEDIATAMENTE (ej. usa replace_lines apoyándote en el LSP) o detente, ` +
                `emite tu reporte y pídele ayuda al usuario para que ajuste el código manualmente.`,
            };
            debugLog(workspacePath, `Circuit Breaker activated for ${toolName} after ${fails} consecutive failures`);

            // ── Micro-Condenser (v8.22.0) ────────────────────────────────────
            // The breaker fired → the agent has just spent N iterations re-
            // reading its own raw stack traces for this tool. Collapse the
            // last 3 prior failure messages into a single [CONDENSER] system
            // marker so the next LLM call sees one explicit corrective signal
            // instead of a wall of redundant errors. The current iteration's
            // CB-activated message is still pushed normally below — the LLM
            // gets exactly one fresh error + one condenser reminder.
            const _condenseResult = compactToolFailures(messages, toolName, 3);
            if (_condenseResult.compacted > 0) {
              debugLog(workspacePath, `[Condenser] Compacted ${_condenseResult.compacted} prior '${toolName}' failure(s) into a single system marker at index ${_condenseResult.insertedAt}`);
            }
            // ─────────────────────────────────────────────────────────────────
          }
        }
      } else {
        toolFailureTracker.delete(toolName);
        // Stateless Auditor: only commit to Sherlock's prior-state history on success.
        // Failed calls stay in toolCallHistory (loop detection) but never reach Sherlock,
        // preventing false REDUNDANT_DECLARATION positives on legitimate retries.
        successfulToolCallHistory.push(`${toolName}:${JSON.stringify(args)}`);

        // ── v8.16.1: Reset Quality Gate failure counter on successful code edit ──
        if (toolName === 'replace_lines' || toolName === 'write_file' ||
            toolName === 'replace_symbol' || toolName === 'replace_block' ||
            toolName === 'search_and_replace') {
          consecutiveBuildFailures = 0;
        }
        // ─────────────────────────────────────────────────────────────────────────

        // ── v8.17.4: Lift the Panoramic Physical Shield once the agent has seen the map ──
        // A successful get_repo_map call is the only event that flips this flag.
        // From here on, gated tools (grep/glob/search_in_files/search_and_replace)
        // execute normally for the rest of the session.
        if (toolName === 'get_repo_map' && !hasSeenRepoMap) {
          hasSeenRepoMap = true;
          debugLog(workspacePath, `[Panoramic Shield] Lifted for @${agentId} — get_repo_map call succeeded`);
        }
        // ─────────────────────────────────────────────────────────────────────────

        // ── Worktree State Sync (v8.8.0 + v8.17.1 reset) ───────────────────────
        // v8.17.1: Entering or exiting a worktree changes the entire filesystem
        // root the agent is reading against. Any read_file failures accumulated
        // before the worktree boundary were attributable to the OLD path layout,
        // not the new one — keeping that count would punish the agent for
        // failures that no longer apply. Reset on every worktree boundary.
        if (toolName === 'enter_worktree') {
          try {
            const wts = JSON.parse(fs.readFileSync(wtStateFile, 'utf-8'));
            activeWorktreePath = wts.worktreePath || null;
            debugLog(workspacePath, `[Worktree] Activated: ${wts.branchName} → ${activeWorktreePath}`);
          } catch { /* state file not written — no worktree context */ }
          if (toolFailureTracker.has('read_file')) {
            toolFailureTracker.delete('read_file');
            debugLog(workspacePath, '[Circuit Breaker — Reset v8.17.1] read_file counter cleared on enter_worktree');
          }
        } else if (toolName === 'exit_worktree') {
          activeWorktreePath = null;
          debugLog(workspacePath, '[Worktree] Deactivated — path redirect cleared');
          if (toolFailureTracker.has('read_file')) {
            toolFailureTracker.delete('read_file');
            debugLog(workspacePath, '[Circuit Breaker — Reset v8.17.1] read_file counter cleared on exit_worktree');
          }
        }
        // ─────────────────────────────────────────────────────────────────────────
      }
      // ─────────────────────────────────────────────────────────────────────────

      // ── replace_lines Chunking Hint ──────────────────────────────────────────
      // If replace_lines fails (e.g. malformed JSON from an overly long block),
      // append a strict fragmentation directive so the LLM splits the edit instead
      // of panicking or escalating to write_file.
      if (!result.success && toolName === 'replace_lines') {
        result = {
          ...result,
          output: result.output +
            '\n\nERROR DE SINTAXIS/JSON. Si el bloque de código que intentas reemplazar es demasiado largo (más de 30-40 líneas), divídelo en fragmentos más pequeños. Haz un replace_lines para las líneas 50-60, luego otro para 61-70. NO intentes reemplazar todo de un solo golpe. Revisa tu sintaxis y reintenta usar replace_lines.',
        };
      }
      // ─────────────────────────────────────────────────────────────────────────

      // Track most recently edited file for SYNTAX_RECOVERY_DIRECTIVE
      if ((toolName === 'replace_lines' || toolName === 'write_file') && result.success) {
        lastEditedFile = (args.path as string) || null;
      }
      // v8.23.0 — Broader edit tracking for the LSP Passive Feedback poller.
      // Captures every successful edit across all editing tools so the LSP
      // check sees the full set of recently-touched files, not just the
      // single file that gates SYNTAX_RECOVERY. Capped implicitly by Set
      // semantics — same file edited 5 times stays one entry. Reset on a
      // green build below (see run_command success branch).
      const _EDIT_TOOLS_FOR_LSP = new Set([
        'write_file', 'replace_lines', 'replace_block',
        'replace_symbol', 'search_and_replace', 'insert_lines',
      ]);
      if (_EDIT_TOOLS_FOR_LSP.has(toolName) && result.success) {
        const _editPath = (args.path ?? args.file_path) as string | undefined;
        if (typeof _editPath === 'string' && _editPath.trim()) {
          recentlyEditedFiles.add(_editPath.trim());
        }
      }

      // Build failure tracking + mandatory fix injection
      if (toolName === 'run_command') {
        const cmd = (args.command as string || '').toLowerCase();
        if (cmd.includes('build')) {
          if (!result.success) {
            const fileHint = lastEditedFile
              ? `\nSYNTAX_RECOVERY_DIRECTIVE: Tu último replace_lines editó "${lastEditedFile}". Ejecuta read_file("${lastEditedFile}") AHORA para ver el estado actual del archivo antes de cualquier nuevo replace_lines.`
              : '';
            buildFailureCtx = `BUILD_FAILED: true\nBUILD ERROR OUTPUT:\n${result.output.slice(0, 1500)}\n\n`;
            result = {
              ...result,
              output: result.output + `\n\nBUILD_FAILED — MANDATORY FIX PROTOCOL:\nDO NOT send the Final Response or Execution Report.\nFix every compiler error RIGHT NOW:\n1. Find the exact file:line from each error.\n2. Use read_file then replace_lines to fix each one.\n3. Run npm run build again after all fixes.\nRepeat until exit code is 0.${fileHint}`,
            };
          } else {
            buildFailureCtx = '';
            lastEditedFile = null;
            // v8.23.0 — green build means the recently-edited set has been
            // proven by the compiler; flush it so the next LSP poll only
            // covers files touched AFTER this checkpoint. Also reset the
            // per-turn LSP injection guard so a follow-up edit cycle gets a
            // fresh diagnostic check.
            recentlyEditedFiles.clear();
            lspPassiveInjected = false;
          }
        }
      }

      // Post-edit delay (Sentinel observation window)
      if (toolName === 'replace_lines' || toolName === 'write_file') {
        yield { type: 'thinking', text: 'Observando terminal (2s)...' };
        await new Promise<void>(resolve => setTimeout(resolve, 2000));
      }

      // ── v8.15.0: Rollback Hard Stop ──────────────────────────────────────────
      // After a successful abort_and_rollback the codebase has been reset — any
      // further agent action would operate on corrupted or missing state. Force exit.
      if (toolName === 'abort_and_rollback' && result.success) {
        debugLog(workspacePath, '[Git Checkpoint] Rollback complete — terminating agent loop');
        yield { type: 'streamEnd' };
        return;
      }
      // ─────────────────────────────────────────────────────────────────────────

      // ── HARD BRAKE: Plan proposal detected — override history and break loop ─
      // Bypass for @planner: the planner writes IMPLEMENTATION_PLAN.md internally as
      // part of enter_plan_mode — it must not trigger a pause in the parent loop.
      const planFilePath = (args.path as string || '').replace(/\\/g, '/').toLowerCase();
      const isPlanBrake = agentId !== 'planner' && result.success && (
        toolName === 'propose_plan' ||
        toolName === 'enter_plan_mode' || // v8.28.1 — entering plan mode is itself a brake event
        ((toolName === 'write_file' || toolName === 'replace_lines') &&
          planFilePath.includes('implementation_plan'))
      );
      const PLAN_PAUSE_DIRECTIVE =
        "SYSTEM DIRECTIVE: Plan presented to user. Execution is now PAUSED. " +
        "You must wait for the user to explicitly click 'Aprobar' or 'Solicitar Cambios'. " +
        "Do not execute any further actions.";

      // ── ERROR ANCHORING: wrap failed results with Manager directive for LLM ──
      // The UI already received the raw error via the toolResult yield above.
      // Only the history content is wrapped — prevents panic re-tries.
      const anchoredContent = (!result.success &&
        !result.output.includes('BUILD_FAILED — MANDATORY FIX PROTOCOL') &&
        !result.output.includes('[SYSTEM ENGINE ERROR]') &&
        !result.output.includes('[CIRCUIT BREAKER ACTIVATED]'))
        ? `MANAGER DIRECTIVE: The tool failed with the following error: ${result.output}\n\n` +
          `Do not panic and DO NOT repeat the exact same call. ` +
          `Review your plan, analyze the error, and formulate an alternative strategy to achieve the goal.`
        : result.output;

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: toolName,
        content: isPlanBrake ? PLAN_PAUSE_DIRECTIVE : anchoredContent,
      });

      if (isPlanBrake) {
        debugLog(workspacePath, `HARD BRAKE: ${toolName} triggered plan pause — breaking agent loop`);
        yield { type: 'streamEnd' };
        return;
      }
    }

    // ─── v4.0 Hook: vision_audit_hook ───────────────────────────────────────
    // Reserved for "The Eyes" visual verification integration.
    // Example: await visionAuditor.audit(messages, workspacePath);
    // ────────────────────────────────────────────────────────────────────────

    // Anti-loop redirect: mixed iteration (some loops + some fresh calls executed)
    if (loopRedirectNeeded) {
      messages.push({
        role: 'user',
        content: `⚠️ SYSTEM: You just executed this exact tool successfully. DO NOT repeat it. Move to the next logical step immediately (e.g., 'run_command' → 'npm run build') or finish the task.`,
      });
      continue;
    }

    // Strict Transition Hook (user message after tool results)
    const recentToolResults = messages.filter(m => m.role === 'tool').slice(-toolCalls.length);
    const hasSuccessfulResult = recentToolResults.some(m =>
      !String(m.content).startsWith('Error:') &&
      !String(m.content).startsWith('CRITICAL') &&
      !String(m.content).startsWith('HARD_RESET') &&
      !String(m.content).startsWith('🚫')
    );
    if (hasSuccessfulResult) {
      messages.push({
        role: 'user',
        content: '⚡ RESULTADO RECIBIDO. Si el build está roto o la tarea incompleta, llama la siguiente herramienta. Si completaste TODOS los pasos y el build está limpio, envía tu Execution Report final (sin tool calls).',
      });
    }

    // ── Active Auto-Condenser (v8.23.0) ────────────────────────────────────
    // Run once per outer iteration AFTER all tool results have been pushed
    // and the iteration's user-side nudge is in place. Compacts stale tool
    // failures and superseded edit results from the older portion of the
    // history, leaving the live working window untouched. This is the
    // cognitive analogue of the v8.22.0 reactive condenser: that one fires
    // when one tool burns the breaker; this one fires every iteration on the
    // accumulated residue across all tools, so Context Window Intoxication
    // never gets a chance to set in even when no single tool trips its
    // breaker. Idempotent and silent — if there is nothing to compact (small
    // history, no stale residue), it is a no-op.
    const _autoCompact = proactiveCompact(messages);
    if (_autoCompact.compactedFailures > 0 || _autoCompact.compactedRedundantEdits > 0) {
      debugLog(
        workspacePath,
        `[Auto-Condenser] Compacted ${_autoCompact.compactedFailures} failure(s) + ${_autoCompact.compactedRedundantEdits} redundant edit(s) at index ${_autoCompact.insertedAt} (history now ${messages.length} msgs)`,
      );
    }
  }

  debugLog(workspacePath, `MAX_ITERATIONS (${MAX_ITERATIONS}) reached.`);
  yield { type: 'streamChunk', text: `\n\n⚠️ Reached maximum iterations (${MAX_ITERATIONS}). The task was too long or the agent got stuck.` };
  yield { type: 'streamEnd' };
}

// ─── Swarm Components ─────────────────────────────────────────────────────────

async function detectIntent(userMessage: string, config: EngineConfig, signal: AbortSignal): Promise<string> {
  const routingMessages: ChatMessage[] = [
    { role: 'system', content: ROUTER_PROMPT },
    { role: 'user', content: userMessage },
  ];
  const routerModel = config.model.includes('google/') ? 'google/gemini-2.5-flash' : (config.model.includes('free') ? config.model : 'google/gemini-2.5-flash');
  const response = await callOpenRouterBlocking(routingMessages, { ...config, model: routerModel }, signal);
  return (response.content || '').trim().toLowerCase();
}

// ─── OpenRouter API ───────────────────────────────────────────────────────────

// v8.27.0 — exported so the background services layer
// (src/services/extractMemories) can issue its own short LLM calls without
// re-implementing endpoint resolution / key picking / OpenRouter headers.
// The function stays in agentEngine.ts because it is the canonical engine
// transport — services consume it as a thin RPC primitive.
export async function callOpenRouterBlocking(
  messages: ChatMessage[],
  config: EngineConfig,
  signal: AbortSignal,
  tools?: NativeTool[],
  toolChoiceRequired?: boolean
): Promise<ApiResponse> {
  const fetchSignal = signal.aborted ? signal : (AbortSignal.timeout ? AbortSignal.timeout(120000) : signal);

  const { endpointUrl, resolvedKey, resolvedModel } = resolveEndpointAndKey(config.model, config);
  const body: Record<string, any> = {
    model: resolvedModel,
    messages,
    max_tokens: config.maxTokens,
    temperature: 0.1,
    stream: false,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    if (toolChoiceRequired) { body.tool_choice = 'required'; }
  }

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${resolvedKey}`,
    'Content-Type': 'application/json',
  };
  if (endpointUrl === OPENROUTER_URL) {
    headers['HTTP-Referer'] = 'https://fluxotechai.com';
    headers['X-Title'] = 'Fluxo AI Agent';
  }

  const response = await fetch(endpointUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: fetchSignal,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`${response.status}: ${err.slice(0, 200)}`);
  }

  const data = await response.json() as any;
  const msg = data.choices?.[0]?.message;
  return {
    content: msg?.content ?? null,
    tool_calls: msg?.tool_calls ?? [],
  };
}

// ─── Streaming API (SSE with delta aggregation) ───────────────────────────────
// When tools are present the model streams tool_calls across many delta chunks
// that must be index-keyed and concatenated before JSON.parse is possible.
// Aggregation instability on some providers makes this risky, so we apply the
// fallback rule: if the request payload carries tools, force stream: false and
// delegate to the blocking path. Streaming is used only for tool-free calls
// (router, auditor) where delta.content is the only field of interest.

async function callOpenRouterStreaming(
  messages: ChatMessage[],
  config: EngineConfig,
  signal: AbortSignal,
  tools?: NativeTool[],
  onChunk?: (text: string) => void,
  toolChoiceRequired?: boolean
): Promise<ApiResponse> {
  // FALLBACK — tools present: force blocking to guarantee tool_call integrity
  if (tools && tools.length > 0) {
    return callOpenRouterBlocking(messages, config, signal, tools, toolChoiceRequired);
  }

  const { endpointUrl: streamUrl, resolvedKey: streamKey, resolvedModel: streamModel } = resolveEndpointAndKey(config.model, config);
  const body: Record<string, any> = {
    model: streamModel,
    messages,
    max_tokens: config.maxTokens,
    temperature: 0.1,
    stream: true,
  };

  const streamHeaders: Record<string, string> = {
    'Authorization': `Bearer ${streamKey}`,
    'Content-Type': 'application/json',
  };
  if (streamUrl === OPENROUTER_URL) {
    streamHeaders['HTTP-Referer'] = 'https://fluxotechai.com';
    streamHeaders['X-Title'] = 'Fluxo AI Agent';
  }

  const response = await fetch(streamUrl, {
    method: 'POST',
    headers: streamHeaders,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`${response.status}: ${err.slice(0, 200)}`);
  }

  const reader = response.body!.getReader();
  const tcBuffers = new Map<number, { id: string; name: string; arguments: string }>();
  let content = '';
  let lineBuffer = '';
  let done = false;

  while (!done) {
    const { value, done: streamDone } = await reader.read();
    done = streamDone;
    if (value) {
      lineBuffer += Buffer.from(value).toString('utf-8');
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) { continue; }
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') { done = true; break; }
        try {
          const parsed = JSON.parse(raw);
          const delta = parsed.choices?.[0]?.delta;
          if (!delta) { continue; }
          if (delta.content) {
            content += delta.content;
            onChunk?.(delta.content);
          }
          // Aggregate tool_call fragments by index
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx: number = tc.index ?? 0;
              if (!tcBuffers.has(idx)) {
                tcBuffers.set(idx, { id: '', name: '', arguments: '' });
              }
              const buf = tcBuffers.get(idx)!;
              if (tc.id) { buf.id = tc.id; }
              if (tc.function?.name) { buf.name += tc.function.name; }
              if (tc.function?.arguments) { buf.arguments += tc.function.arguments; }
            }
          }
        } catch { /* malformed SSE chunk — skip */ }
      }
    }
  }

  const tool_calls: NativeToolCall[] = Array.from(tcBuffers.entries())
    .sort(([a], [b]) => a - b)
    .map(([, buf], i) => ({
      id: buf.id || `call_stream_${i}`,
      type: 'function' as const,
      function: { name: buf.name, arguments: buf.arguments },
    }));

  return { content: content || null, tool_calls };
}

export async function summarizeHistory(
  history: ChatMessage[],
  config: EngineConfig
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SUMMARIZER_PROMPT },
    {
      role: 'user',
      content: `Please summarize the following conversation history:\n\n${JSON.stringify(history.filter(m => m.role !== 'tool'), null, 2)}`,
    }
  ];
  const result = await callOpenRouterBlocking(messages, config, new AbortController().signal);
  return result.content || '';
}

// ─── fetch_documentation helper ──────────────────────────────────────────────
// Zero external dependencies: uses the native fetch API available in Node ≥18
// and VS Code's built-in runtime. Cleans HTML to plain text via regex so the
// LLM receives readable documentation without burning tokens on markup noise.

const MAX_DOC_CHARS = 20_000;

async function fetchDocumentation(url: string): Promise<{ success: boolean; output: string }> {
  if (!url || !url.startsWith('http')) {
    return { success: false, output: `[fetch_documentation] Invalid URL: "${url}". Must start with http:// or https://.` };
  }

  let rawText: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000); // 15 s timeout
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'FluxoAI-DocFetcher/1.0 (https://fluxotechai.com)' },
    });
    clearTimeout(timer);

    if (!response.ok) {
      return {
        success: false,
        output: `[fetch_documentation] HTTP ${response.status} ${response.statusText} — Could not fetch: ${url}`,
      };
    }

    rawText = await response.text();
  } catch (err: any) {
    const isTimeout = err?.name === 'AbortError';
    return {
      success: false,
      output: isTimeout
        ? `[fetch_documentation] Timeout (15s) fetching: ${url}`
        : `[fetch_documentation] Network error: ${err?.message ?? String(err)}`,
    };
  }

  // ── HTML Cleaning Pipeline ────────────────────────────────────────────────
  let cleaned = rawText;

  // 1. Extract body content if HTML (skip for raw text/markdown responses)
  const bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) { cleaned = bodyMatch[1]; }

  // 2. Remove noise tags wholesale (scripts, styles, nav, header, footer, svg, forms)
  cleaned = cleaned.replace(/<script[\s\S]*?<\/script>/gi, '');
  cleaned = cleaned.replace(/<style[\s\S]*?<\/style>/gi, '');
  cleaned = cleaned.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  cleaned = cleaned.replace(/<header[\s\S]*?<\/header>/gi, '');
  cleaned = cleaned.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  cleaned = cleaned.replace(/<svg[\s\S]*?<\/svg>/gi, '');
  cleaned = cleaned.replace(/<form[\s\S]*?<\/form>/gi, '');
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '');

  // 3. Convert structural HTML tags to Markdown equivalents for readability
  cleaned = cleaned.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  cleaned = cleaned.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  cleaned = cleaned.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  cleaned = cleaned.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, '\n#### $1\n');
  cleaned = cleaned.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1');
  cleaned = cleaned.replace(/<br\s*\/?>/gi, '\n');
  cleaned = cleaned.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n');
  cleaned = cleaned.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');
  cleaned = cleaned.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  cleaned = cleaned.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

  // 4. Strip all remaining HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');

  // 5. Decode common HTML entities
  cleaned = cleaned
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');

  // 6. Normalize whitespace — collapse runs of blank lines to a single blank line
  cleaned = cleaned.replace(/[ \t]+/g, ' ');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  cleaned = cleaned.trim();

  // 7. Truncate to stay within context budget
  const truncated = cleaned.length > MAX_DOC_CHARS
    ? cleaned.slice(0, MAX_DOC_CHARS) + `\n\n...[TRUNCATED — ${cleaned.length - MAX_DOC_CHARS} additional characters omitted to protect context window]`
    : cleaned;

  return {
    success: true,
    output: `[fetch_documentation] Source: ${url}\n\n${truncated}`,
  };
}

```

