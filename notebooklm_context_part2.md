# 📦 APP MANIFEST
* **App Name:** fluxo-ai
* **Version:** 8.36.6
* **Stack:** Vanilla JS
* **Part:** 2
* **Generated At:** 2026-06-13T03:57:22.719Z

---

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
  // v8.36.3 — Swarm depth counter (incremented every time create_team spawns
  // a sub-loop). Used to block recursion bombs: a manager → coder → coder→
  // coder → coder chain like Test 11 (4 nested spawns, ~75 wasted iterations).
  // Capped at MAX_SWARM_DEPTH inside the create_team intercept.
  _swarmDepth?: number;
}

const MAX_SWARM_DEPTH = 2;

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
// v8.36.4 — Continuation Audit constants. The penultimate iteration of each
// agent loop triggers a Manager-model audit that decides whether to grant a
// bounded extension. Test 12 showed Gemini 2.5 Pro needing ~30 iterations on
// the task tracker CLI, and hard-stopping at 25 cost the entire prior $1+ of
// work. Hard-stopping is correct as a default (cost guard) but the extension
// is earned: only granted if the agent has a clear path to completion.
const CONTINUATION_AUDIT_TRIGGER_OFFSET = 1; // audit at MAX_ITERATIONS - 1
const MAX_EXTENSION_ITERATIONS = 15; // ceiling on a single grant

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
  // v8.36.5 — Test 13 observed the agent attempting basic filesystem ops via
  // shell ("mkdir src", "del tasks.json") and getting blocked by HITL.
  // These are harmless on a sandboxed worktree and the bot's recovery to
  // create_dir / delete_file just wasted iterations. Auto-approve safe
  // single-arg filesystem primitives. The dangerous variants (rm -rf, del /s,
  // mkdir with redirects/&&) still fall through to user approval because
  // they contain `;`/`|`/`&&` and we only match the first segment.
  /^\s*mkdir\s+(?!.*\.\.)[\w./\\-]+\s*$/i,            // mkdir foo  (single relative path)
  /^\s*md\s+(?!.*\.\.)[\w./\\-]+\s*$/i,                // md foo     (Windows alias)
  /^\s*(del|erase)\s+(?!.*\.\.)(?!.*[/\\]\*)[\w./\\-]+\s*$/i,    // del foo.txt (single file, no wildcards, no /s)
  /^\s*rm\s+(?!.*\.\.)(?!-r)(?!-f)(?!.*\*)[\w./\\-]+\s*$/i,     // rm foo.txt  (POSIX, no -r/-f, no globs)
  /^\s*type\s+(?!.*\.\.)[\w./\\-]+\s*$/i,              // type foo.txt (Windows cat)
  /^\s*cat\s+(?!.*\.\.)[\w./\\-]+\s*$/i,               // cat foo.txt (POSIX)
  /^\s*(touch|copy|cp|move|mv|rename|ren)\s+/i,        // basic copy/move ops
];

function isSafeCommandForAutoRun(command: string): boolean {
  const firstSegment = command.split(/\s*[|;&]+\s*/)[0] ?? command;
  return HITL_SAFE_PATTERNS.some(p => p.test(firstSegment));
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Stale JSON Corruption Sanitizer (v8.36.3 + v8.36.5 scope expansion) ───────
// Test 11 surfaced the pattern: a prior session leaves package.json with
// malformed JSON. The agent then tries to surgically repair text it can never
// match — the corrupted substring leaks into context via error messages and
// the agent edits the error text instead of the file. v8.36.3 added this
// sanitizer only at session-restore. v8.36.5 extends it to fire AFTER any
// successful enter_worktree call too (Test 13 case: fresh worktree inherited
// a corrupted package.json from the main branch state).
function sanitizeWorktreeJson(worktreeRoot: string, workspacePath: string): void {
  if (!worktreeRoot || !fs.existsSync(worktreeRoot)) { return; }
  try {
    const entries = fs.readdirSync(worktreeRoot);
    for (const entry of entries) {
      if (!entry.endsWith('.json')) { continue; }
      const fp = path.join(worktreeRoot, entry);
      try {
        const stat = fs.statSync(fp);
        if (!stat.isFile()) { continue; }
        const content = fs.readFileSync(fp, 'utf-8');
        if (content.trim() === '') { continue; }
        JSON.parse(content);
      } catch {
        try {
          fs.unlinkSync(fp);
          debugLog(workspacePath, `[Stale JSON Sanitizer] Deleted corrupted ${entry} at ${worktreeRoot} — agent will recreate via write_file`);
        } catch { /* unlink failure — non-fatal */ }
      }
    }
  } catch { /* readdir failure — non-fatal */ }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Worktree .gitignore Guard (v8.36.6) ───────────────────────────────────────
// Test 15 surfaced the pattern: agent shipped a clean build, Pre-Merge QG
// approved, user clicked merge — and exit_worktree(merge) failed because
// node_modules contained .exe files that Windows had file-locked, so git
// couldn't unlink them during the merge. The fix is upstream: never let
// node_modules / dist / out enter the commit in the first place. This helper
// reads the worktree's .gitignore (creates if missing) and appends entries
// idempotently. Safe to call repeatedly — only writes if a needed entry is
// absent. Non-fatal on any IO failure (worst case: agent has to manually fix
// .gitignore, but the merge would still fail loudly rather than silently).
const WORKTREE_GITIGNORE_REQUIRED_ENTRIES = [
  'node_modules/',
  'dist/',
  'out/',
  'build/',
  '.fluxo/',
];

function ensureWorktreeGitignore(worktreeRoot: string, workspacePath: string): void {
  if (!worktreeRoot || !fs.existsSync(worktreeRoot)) { return; }
  const gitignorePath = path.join(worktreeRoot, '.gitignore');
  try {
    let content = '';
    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, 'utf-8');
    }
    const existingLines = content.split('\n').map(l => l.trim());
    const missing: string[] = [];
    for (const required of WORKTREE_GITIGNORE_REQUIRED_ENTRIES) {
      const bareForm = required.replace(/\/$/, '');
      const alreadyPresent = existingLines.some(l => l === required || l === bareForm);
      if (!alreadyPresent) { missing.push(required); }
    }
    if (missing.length === 0) { return; }

    const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    const block = `${prefix}\n# Fluxo AI v8.36.6 — Worktree merge safety (prevent locked-binary conflicts)\n${missing.join('\n')}\n`;
    fs.appendFileSync(gitignorePath, block, 'utf-8');
    debugLog(workspacePath, `[Worktree .gitignore Guard] Added ${missing.length} entries (${missing.join(', ')}) to ${gitignorePath} — prevents Windows file-lock merge conflicts on compiled binaries`);
  } catch {
    // Read-only filesystem, permission error, or no git environment — non-fatal.
    // The merge may still hit the original conflict, but that's strictly no
    // worse than pre-v8.36.6 behavior.
  }
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
  const MAX_ACTION_REFUSALS = 4; // v8.34.2 — was implicit 2; raised to 4 for Frontier LLMs in narration loops
  let planCheckCount = 0;
  let nodeModulesAccessCount = 0; // v8.29.0 — Rabbit Hole soft-limit: first access gets a warning, subsequent are hard-blocked
  let consecutiveBuildFailures = 0;  // ── v8.16.1: Quality Gate circuit breaker counter
  let bypassQualityGate = false;     // ── v8.16.1: set to true when user approves bypass
  // v8.34.0 — Anti-Gaslighting Circuit Breaker. Tallies how many times the
  // agent tried to escape the loop via fake "ORCHESTRATOR'S REPORT" emissions
  // (intercepted by either the Anti-Gaslighting block at line ~722 or the
  // Merge Enforcer block at line ~741). Shared between both intercepts so a
  // panicked agent burning attempts via either vector is caught uniformly.
  // At 3 strikes the loop yields to human via the Financial Killswitch path
  // rather than burning the remaining iteration budget on a bot in panic.
  let gaslightingAttempts = 0;
  const MAX_GASLIGHTING_ATTEMPTS = 3;
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

        // v8.36.3 + v8.36.5: Stale JSON Corruption Sanitizer
        sanitizeWorktreeJson(wts.worktreePath as string, workspacePath);
        // v8.36.6: Worktree .gitignore guard (node_modules, dist, build, out)
        ensureWorktreeGitignore(wts.worktreePath as string, workspacePath);
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
  // v8.34.1 — Hotfix Exemption Patch: search_and_replace removed from the
  // panoramic gate. Rationale: the gate exists to prevent BLIND exploration
  // (grep/glob/search_in_files all scan unknown paths). search_and_replace
  // operates on a known, explicit file path — typically given to the agent
  // by the user as a Vite/TS error like `PomodoroTimer.jsx:183`. Forcing a
  // get_repo_map for a 1-line hotfix on a known file caused the agent to
  // weaponize ask_user_approval with hallucinated success claims when the
  // gate blocked the legitimate edit. Surgical hotfixes are now unblocked.
  const PANORAMIC_GATED_TOOLS  = new Set(['grep', 'glob', 'search_in_files']);
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

  // v8.36.4 — Dynamic iteration ceiling. Starts at MAX_ITERATIONS but the
  // Continuation Auditor may raise it once per session (top-level only).
  let effectiveMaxIterations = MAX_ITERATIONS;
  let continuationAuditFired = false;

  while (iterations < effectiveMaxIterations) {
    if (abortSignal.aborted) {
      yield { type: 'error', message: '⊘ Cancelled by user' };
      return;
    }

    iterations++;

    // ── v8.36.4 Continuation Audit ──────────────────────────────────────────
    // When the agent is about to start its LAST permitted iteration, give a
    // Manager-model auditor a chance to grant a bounded extension. Strict
    // single-fire, top-level-only (sub-agents can't independently inflate
    // budget — observed Test 11 recursion bomb). Conservative auditor prompt
    // defaults to DENY.
    if (
      !continuationAuditFired &&
      iterations === effectiveMaxIterations &&
      effectiveMaxIterations === MAX_ITERATIONS &&
      (effectiveConfig._swarmDepth ?? 0) === 0
    ) {
      continuationAuditFired = true;
      yield { type: 'thinking', text: '🧭 Continuation Audit: reviewing progress before final iteration…' };
      try {
        const verdict = await auditContinuation(messages, userMessage, agentId, effectiveConfig, abortSignal);
        if (verdict.extend && verdict.iterations > 0) {
          effectiveMaxIterations += verdict.iterations;
          debugLog(workspacePath, `[v8.36.4 Continuation Audit] GRANTED +${verdict.iterations} iterations. Reason: ${verdict.reason}`);
          yield { type: 'streamChunk', text: `\n\n🧭 **Continuation Audit** granted **+${verdict.iterations} iterations** (new ceiling: ${effectiveMaxIterations}).\nReason: ${verdict.reason}\n\n` };
        } else {
          debugLog(workspacePath, `[v8.36.4 Continuation Audit] DENIED. Reason: ${verdict.reason}`);
          yield { type: 'thinking', text: `❌ Continuation Audit denied extension — ${verdict.reason}` };
        }
      } catch (e) {
        debugLog(workspacePath, `[v8.36.4 Continuation Audit] FAILED to audit: ${String(e).slice(0, 200)}`);
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    debugLog(workspacePath, `--- Iteration ${iterations}/${effectiveMaxIterations} ---`);
    yield { type: 'iterationCount', count: iterations, max: effectiveMaxIterations };
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
              {
                ...effectiveConfig,
                model: config.workerModel || config.model,
                _swarmDepth: (effectiveConfig._swarmDepth ?? 0) + 1, // v8.36.3
              },
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
      gaslightingAttempts++;
      debugLog(workspacePath, `[Anti-Gaslighting] @coder attempted to emit Orchestrator's Report — intercepting (strike ${gaslightingAttempts}/${MAX_GASLIGHTING_ATTEMPTS})`);
      // v8.34.0 — Circuit Breaker: yield to human after 3 strikes rather than
      // burn remaining iterations on a panicked agent rebounding off the shield.
      if (gaslightingAttempts >= MAX_GASLIGHTING_ATTEMPTS) {
        yield { type: 'thinking', text: `🛑 Anti-Gaslighting Circuit Breaker tripped (${gaslightingAttempts}/${MAX_GASLIGHTING_ATTEMPTS})` };
        yield {
          type: 'streamChunk',
          text:
            '\n\n🛑 **[YIELD TO HUMAN — Anti-Gaslighting Circuit Breaker (v8.34.0)]** ' +
            `The @coder attempted to fake task completion via "ORCHESTRATOR'S REPORT" ${gaslightingAttempts} times. ` +
            'The agent is in a panic loop it cannot escape on its own — the engine has halted ' +
            'further LLM calls to prevent burning API credits. Review the partial work above, ' +
            'inspect the code state, and either give the agent more specific instructions or ' +
            'roll back via the Restore button if the workspace was corrupted.',
        };
        yield { type: 'streamEnd' };
        return;
      }
      yield { type: 'thinking', text: `🛑 Anti-Gaslighting: @coder no puede emitir el reporte final (strike ${gaslightingAttempts}/${MAX_GASLIGHTING_ATTEMPTS})…` };
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
      gaslightingAttempts++;
      debugLog(workspacePath, `[Merge Enforcer] @${agentId} attempted to emit Orchestrator's Report while worktree active (${activeWorktreePath}) — intercepting (strike ${gaslightingAttempts}/${MAX_GASLIGHTING_ATTEMPTS})`);
      // v8.34.0 — Circuit Breaker shared with Anti-Gaslighting; yields to human
      // after 3 strikes via either vector to prevent panic-loop credit burn.
      if (gaslightingAttempts >= MAX_GASLIGHTING_ATTEMPTS) {
        yield { type: 'thinking', text: `🛑 Anti-Gaslighting Circuit Breaker tripped (${gaslightingAttempts}/${MAX_GASLIGHTING_ATTEMPTS})` };
        yield {
          type: 'streamChunk',
          text:
            '\n\n🛑 **[YIELD TO HUMAN — Anti-Gaslighting Circuit Breaker (v8.34.0)]** ' +
            `@${agentId} attempted to fake task completion via "ORCHESTRATOR'S REPORT" while a worktree was still active ${gaslightingAttempts} times. ` +
            'The agent is in a panic loop it cannot escape on its own — the engine has halted ' +
            'further LLM calls to prevent burning API credits. Review the worktree state, decide ' +
            `whether to merge or discard via the worktree review UI, and re-prompt with explicit guidance.`,
        };
        yield { type: 'streamEnd' };
        return;
      }
      yield { type: 'thinking', text: `🛑 Merge Enforcer: el worktree sigue activo (strike ${gaslightingAttempts}/${MAX_GASLIGHTING_ATTEMPTS})…` };
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

          // ── v8.34.2: Stale Plan Auto-Cleanup for debug requests ──────────────
          // A stale IMPLEMENTATION_PLAN.md from a prior planning session contaminates
          // a fresh debug task: the agent reads the plan, can't reconcile it with a
          // runtime-error fix request, and falls into Action Refusal narrating both
          // contexts without executing either. When the userMessage shows clear debug
          // markers (error keywords, stack-trace patterns, HTTP failure codes), delete
          // the stale plan and re-prompt with a clean directive instead of injecting
          // Manager Override. The @manager will regenerate a fresh plan via
          // enter_plan_mode if the bug fix grows beyond a quick patch.
          const _DEBUG_INDICATORS = [
            /\berror[s]?\b/i,
            /\bbug[s]?\b/i,
            /\bfailed\b/i,
            /\bcrash(ed)?\b/i,
            /\bbroken\b/i,
            /\bexception\b/i,
            /\buncaught\b/i,
            /:\d+:\d+/,                    // "App.jsx:6" line:col patterns
            /net::err_/i,                  // browser fetch errors
            /internal\s+server\s+error/i,
            /\bno\s+funciona\b/i,          // Spanish: "doesn't work"
            /\btengo\s+(un\s+)?error\b/i,  // Spanish: "I have an error"
          ];
          const _isDebugRequest = _DEBUG_INDICATORS.some(re => re.test(userMessage));

          if (_isDebugRequest) {
            try {
              fs.unlinkSync(planFilePath);
              debugLog(workspacePath, '[Stale Plan Cleanup v8.34.2] Debug-style userMessage detected — deleted stale IMPLEMENTATION_PLAN.md instead of injecting Manager Override');
              yield { type: 'thinking', text: '🗑️ Stale plan removed — debug request detected' };
              messages.push({
                role: 'user',
                content:
                  '[ENGINE NOTICE — Stale Plan Cleanup v8.34.2] A stale IMPLEMENTATION_PLAN.md from ' +
                  'a prior session was just removed from disk. Your previous response was contaminated ' +
                  'by it — you tried to reconcile a stale plan with the user\'s fresh debug request. ' +
                  'Restart your reasoning fresh on the user\'s ORIGINAL message: investigate the runtime ' +
                  'error directly with read_file, search_and_replace, etc. Do NOT reference any prior plan.',
              });
              continue;
            } catch (e: any) {
              debugLog(workspacePath, `[Stale Plan Cleanup v8.34.2] Failed to delete plan: ${e?.message ?? e} — falling back to Manager Override`);
              // Fall through to the Manager Override path below
            }
          }
          // ─────────────────────────────────────────────────────────────────────

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

      // Action Enforcement (v8.34.2 hardened) — Frontier LLMs (notably Gemini 2.5 Pro)
      // sometimes enter a "narration loop": they describe what they will do ("I need
      // to read App.jsx", "First, I'll examine MainContent.jsx") repeatedly without
      // ever calling a tool. The previous polite directive was treated as a suggestion
      // and consumed credits in a paralysis spiral. The hardened version uses
      // mandatory-tone language and explicitly forbids more conversational text.
      if (ghostRetries < MAX_ACTION_REFUSALS) {
        ghostRetries++;
        debugLog(workspacePath, `Action enforcement #${ghostRetries}/${MAX_ACTION_REFUSALS} — no tools returned, injecting hardened directive`);
        messages.push({
          role: 'user',
          content:
            `[ENGINE HARD BLOCK — Action Refusal #${ghostRetries}/${MAX_ACTION_REFUSALS}] ` +
            `You produced ${ghostRetries} consecutive text-only response${ghostRetries === 1 ? '' : 's'}. ` +
            `tool_choice is REQUIRED. You are FORBIDDEN from emitting more conversational text. ` +
            `Your ONLY valid next action is to CALL A TOOL — typically read_file with the path ` +
            `mentioned in the user's error trace. If you are genuinely stuck, call ask_user_approval ` +
            `(but the Lie Detector v8.34.1 will block claims of completion you cannot back up). ` +
            `Repeating "I will read X" or "I need to examine X" without actually calling read_file('X') ` +
            `IS the violation. Execute, do not narrate.`,
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
      // ── v8.34.2: Action Refusal Syndrome — YIELD TO HUMAN on cap exhaustion ─
      // When ghostRetries hits MAX_ACTION_REFUSALS AND the agent still produced
      // zero tool calls in this entire session, this is no longer a normal
      // text-only completion — it is the Frontier LLM narration-loop pathology.
      // Silent return would leave the user staring at an empty chat with no
      // explanation. Instead emit a clear YIELD TO HUMAN sentinel naming the
      // syndrome and the likely remediation (explicit imperative re-prompt or
      // model switch). Twin pattern to the Anti-Gaslighting Circuit Breaker
      // (v8.34.0) and the Financial Killswitch (v8.24.0).
      if (ghostRetries >= MAX_ACTION_REFUSALS && toolCallHistory.length === 0) {
        debugLog(workspacePath, `[Action Refusal Syndrome v8.34.2] @${agentId} produced ${ghostRetries + 1} text-only responses with zero tool calls — yielding to human`);
        yield { type: 'thinking', text: `🛑 Action Refusal Syndrome — ${ghostRetries + 1} narrations sin ejecución` };
        yield {
          type: 'streamChunk',
          text:
            `\n\n🛑 **[YIELD TO HUMAN — Action Refusal Syndrome (v8.34.2)]** ` +
            `@${agentId} narrated ${ghostRetries + 1} actions without executing any of them ` +
            `(read_file, search_and_replace, etc. were never called this session). ` +
            `Probable cause: Frontier LLM (typically Gemini 2.5 Pro) stuck in a description-only ` +
            `loop where it keeps saying "I will read X" / "I need to examine X" without making the ` +
            `actual tool call. The engine has halted further LLM calls to prevent burning credits.\n\n` +
            `**To recover:** re-prompt with explicit imperative guidance ` +
            `(e.g. "execute read_file('src/components/MainContent.jsx') RIGHT NOW, then patch the ` +
            `JSX syntax error on line 149") or switch to a different model via the model selector.`,
        };
        yield { type: 'streamEnd' };
        return;
      }
      // ─────────────────────────────────────────────────────────────────────────

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
        // ── v8.35.0 — Override Patch: Double-Key Bypass ──────────────────────────
        // Sherlock blocks REDUNDANT_DECLARATION when the agent tries to re-inject
        // an identifier that already exists. In Test 7 we observed Claude 3.7
        // Sonnet trapped between user orders ("fix it now") and Sherlock's veto,
        // burning the iteration budget. The Override Patch grants a bypass when
        // BOTH keys are present:
        //   Key 1 — agent intent: at least one tool call carries healing_mode: true
        //   Key 2 — user authorization: userMessage contains an override marker
        //           ("fix it anyway", "force", "i know", "yo sé", etc.)
        // Both must align — neither key alone unlocks the bypass. Scope is
        // narrow: only REDUNDANT_DECLARATION is bypassable; ROGUE DESIGNER,
        // SILOED CHANGES, TECH STACK DRIFT, MODAL COLLISION etc. remain blocked
        // because those flag genuinely dangerous patterns the user cannot safely
        // override blindly. The bypass logs explicitly so the audit trail
        // captures every override event.
        const _isRedundancyBlock = /REDUNDANT_DECLARATION/i.test(revisorResult.content);
        const _hasHealingFlag = tcToExecute.some(tc => {
          try { return JSON.parse(tc.function.arguments).healing_mode === true; }
          catch { return false; }
        });
        const _USER_OVERRIDE_REGEX = /\b(fix\s+it\s+(anyway|even\s+if|now)|force\s+(it|the\s+change)|override|do\s+it\s+anyway|hazlo\s+(igual|de\s+todas\s+formas)|arr[ée]glalo\s+(igual|aunque|ahora)|i\s+know\s+(about|we\s+have)|yo\s+s[eé]\s+que|s[eé]\s+que\s+(est[áa]|hay))\b/i;
        const _hasUserOverride = _USER_OVERRIDE_REGEX.test(userMessage);
        if (_isRedundancyBlock && _hasHealingFlag && _hasUserOverride) {
          debugLog(workspacePath, '[Override Bypass v8.35.0] REDUNDANT_DECLARATION bypassed: healing_mode flag present AND userMessage matches override marker');
          yield { type: 'thinking', text: '🔓 Sherlock REDUNDANT_DECLARATION bypassed — user override + healing_mode' };
          // Fall through to tool execution (do NOT push audit failure or continue)
        } else {
        // ─────────────────────────────────────────────────────────────────────
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
        } // close v8.35.0 Override Patch else
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

          // ── v8.34.1: Lie Detector for ask_user_approval ──────────────────────
          // The Anti-Gaslighting Circuit Breaker (v8.34.0) blocked agents from
          // emitting a fake "ORCHESTRATOR'S REPORT" — Frontier LLMs responded
          // by weaponizing ask_user_approval instead, sending an intent_summary
          // claiming the build was "fixed" or "implemented" without having
          // edited a single file. This intercept catches that exact lie.
          //
          // Trigger conditions (ALL must hold):
          //   1. agent is NOT @planner (the planner asks legitimate Discovery
          //      questions and never edits production code)
          //   2. intent_summary contains a past-tense success claim
          //      (fixed/implemented/cleaned/clean/resolved/completed/done)
          //   3. recentlyEditedFiles is empty for this turn (no edits since
          //      the last green build cleared the set)
          //   4. successfulToolCallHistory contains zero successful edit
          //      operations for the entire session (catches the brand-new
          //      session lie; condition 3 alone false-positives after a
          //      successful build because the set is cleared on green)
          const _CLAIM_REGEX = /\b(fixed|implemented|clean(ed)?|resolved|complete[d]?|done)\b/i;
          const _EDIT_TOOL_NAMES = ['write_file', 'search_and_replace', 'replace_lines', 'replace_block', 'replace_symbol', 'insert_lines'];
          const _hasAnySuccessfulEdit = successfulToolCallHistory.some(entry =>
            _EDIT_TOOL_NAMES.some(name => entry.startsWith(name + ':'))
          );
          if (
            agentId !== 'planner' &&
            recentlyEditedFiles.size === 0 &&
            !_hasAnySuccessfulEdit &&
            _CLAIM_REGEX.test(_intent)
          ) {
            debugLog(workspacePath, `[Lie Detector v8.34.1] ${agentId} claimed completion in intent_summary but never made a successful edit — blocking`);
            yield { type: 'thinking', text: '🛑 Lie Detector: claim de éxito sin ediciones — bloqueando…' };
            result = {
              success: false,
              output:
                '[SYSTEM ENGINE BLOCK — Lie Detector v8.34.1] You cannot claim the build is ' +
                'fixed or code is implemented. You haven\'t successfully modified any files yet ' +
                '(recentlyEditedFiles is empty AND no edit tool has succeeded this session). ' +
                'Fix the code first using your edit tools (search_and_replace, replace_block, ' +
                'replace_lines, write_file, etc.). Once the edits land and the build verifies, ' +
                'then you may use ask_user_approval to summarize the work.',
            };
          } else if (discoveryAnswerCallback && agentId === 'planner') {
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
          // v8.36.1 — Aliasing parity with SearchReplaceTool.execute(). Tier-1
          // models (Gemini 2.5 Pro, Claude 3.7) emit file_path/filepath and
          // search_pattern/replace_pattern instead of the canonical names.
          // Without this fallback the engine forwarded empty strings to
          // applyNativeEdit, which surfaced as "File not found: ." — observed
          // in Test 9 with Gemini on package.json.
          const _srPath = String(
            args.path ?? args.file_path ?? args.filepath ?? ''
          );
          const _srSearch = String(
            args.search_snippet ?? args.search ?? args.old_code ?? args.search_pattern ?? ''
          );
          const _srReplace = String(
            args.replace_snippet ?? args.replace ?? args.new_code ?? args.replace_pattern ?? ''
          );
          result = await nativeEditCallback(_srPath, _srSearch, _srReplace);
          // ── Smart Failure Interceptor (v8.16.22 + v8.36.1) ─────────────────
          // v8.36.1 — Branch the recovery directive on failure mode. Path
          // misses ("File not found") demand list_dir; content misses demand
          // read_file. Conflating them (the v8.16.22 behavior) sent the agent
          // into the wrong recovery loop in Test 9.
          if (!result.success) {
            const _isPathMiss = /File not found/i.test(result.output);
            result = {
              ...result,
              output: result.output + (_isPathMiss
                ? '\n\n[SYSTEM ENFORCEMENT] PATH ERROR. The file path could not be opened. ' +
                  'Call list_dir to enumerate the directory and verify the EXACT relative path ' +
                  '(check the alias you used: the canonical arg is `path`, not file_path/filepath). ' +
                  'Then retry search_and_replace with the corrected path.'
                : '\n\n[SYSTEM ENFORCEMENT] MATCH ERROR. You hallucinated the search_snippet. ' +
                  "You are STRICTLY FORBIDDEN from using 'grep' or guessing to fix this. " +
                  "You MUST immediately use 'read_file' to extract the exact lines verbatim. " +
                  'Any other action will result in system failure.'),
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

        // ── Worktree Human Review (v8.3.0 + v8.35.1 Pre-Merge Quality Gate) ─────
        // Intercept exit_worktree merge calls before execution so the user can
        // inspect the diff in VS Code's native diff editor and approve/discard.
        //
        // v8.35.1 — Pre-Merge Quality Gate: validate the WORKTREE's build BEFORE
        // showing the human review modal. Closes the lazy-merge path observed in
        // Test 8 where @coder hit a TS2591 build error inside the worktree, then
        // skipped Build Repair Protocol and called exit_worktree(merge) anyway,
        // pushing broken code through the user's approval click. The post-merge
        // Quality Gate then blocked task completion on main, trapping the agent
        // in a 25-iteration death spiral on hallucinated edits.
        //
        // Three invariants honored:
        //   (a) Validates the WORKTREE path (matches v8.30.1 worktree-aware Quality
        //       Gate — never compile main when the changes live in the worktree).
        //   (b) Missing-script exemption (mirror of Quality Gate behavior at
        //       line ~1007): projects without npm run build are not gated.
        //   (c) Honors session bypassQualityGate flag — if the user already
        //       chose to bypass the post-completion Quality Gate this session,
        //       they can also merge broken code (consistent escape-hatch behavior).
        } else if (toolName === 'exit_worktree' && args.action === 'merge' && worktreeReviewCallback) {
          const wStateFile = path.join(workspacePath, '.fluxo', 'active_worktree.json');
          let wState: { branchName: string; worktreePath: string } | null = null;
          if (fs.existsSync(wStateFile)) {
            try { wState = JSON.parse(fs.readFileSync(wStateFile, 'utf-8')); }
            catch { /* state unreadable — fall through to direct merge */ }
          }

          // v8.35.1 — Pre-Merge Quality Gate: build a discriminated block-result
          // FIRST, then assign result in a single if/else so TypeScript can prove
          // result is always definitely-assigned downstream.
          let preMergeBlock: { success: false; output: string } | null = null;
          if (wState && !bypassQualityGate) {
            yield { type: 'thinking', text: '🏗️ Pre-Merge Quality Gate: validating worktree build…' };
            const preMergeResult = await validateBuild(wState.worktreePath);
            if (!preMergeResult.success && !preMergeResult.error?.toLowerCase().includes('missing script')) {
              debugLog(workspacePath, `[Pre-Merge Quality Gate v8.35.1] MERGE BLOCKED — worktree build failed: ${preMergeResult.error?.slice(0, 200)}`);
              yield { type: 'thinking', text: '🛑 Pre-Merge Quality Gate: worktree build broken — blocking merge' };
              preMergeBlock = {
                success: false,
                output:
                  `[SYSTEM ENGINE BLOCK — Pre-Merge Quality Gate v8.35.1] MERGE REJECTED.\n` +
                  `El código en este worktree no compila. NO puedes fusionar código roto a la rama principal — ` +
                  `el merge habría introducido errores de compilación en main y atrapado al loop en una death spiral.\n\n` +
                  `ERRORES DEL COMPILADOR:\n${preMergeResult.error}\n\n` +
                  `DIRECTIVA OBLIGATORIA: Usa tus tools de edición (replace_symbol, search_and_replace, replace_block, ` +
                  `replace_lines) para corregir cada error arriba. Luego ejecuta run_command con 'npm run build' ` +
                  `dentro del worktree hasta que pase verde. Solo entonces reintenta exit_worktree(merge). ` +
                  `Si el build genuinamente no se puede arreglar, llama exit_worktree(discard) para abandonar los cambios.`,
              };
            } else {
              debugLog(workspacePath, '[Pre-Merge Quality Gate v8.35.1] Worktree build OK — proceeding to human review');
            }
          }

          if (preMergeBlock) {
            result = preMergeBlock;
          } else {
            let reviewedAction: 'merge' | 'discard' = 'merge';
            if (wState) {
              try {
                yield { type: 'thinking', text: '🔍 Requesting human review before worktree merge…' };
                reviewedAction = await worktreeReviewCallback(wState.branchName, wState.worktreePath);
                debugLog(workspacePath, `[Worktree Review] User decision: ${reviewedAction}`);
              } catch {
                // Callback failed — fall through to direct merge
              }
            }
            result = executeTool('exit_worktree', { ...args, action: reviewedAction }, workspacePath);
          }
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

          // ── v8.36.3: Swarm Depth Cap ─────────────────────────────────────
          // Test 11 spawned 4 nested create_team calls (Manager → Coder →
          // Coder → Coder → Coder). Each level inherited filesystem state
          // but had a fresh context, so each level rediscovered the same
          // corrupted package.json and burned its iteration budget on the
          // same fix attempts. Total: ~75 wasted iterations.
          const _currentDepth = effectiveConfig._swarmDepth ?? 0;
          if (_currentDepth >= MAX_SWARM_DEPTH) {
            result = {
              success: false,
              output:
                `[SYSTEM ENGINE BLOCK — Swarm Depth Cap v8.36.3] create_team REJECTED.\n` +
                `You are already inside a sub-agent loop spawned by a previous create_team ` +
                `(depth ${_currentDepth}, max ${MAX_SWARM_DEPTH}). Spawning another team here ` +
                `creates a recursion bomb — observed in Test 11, where 4 nested spawns burned ` +
                `~75 iterations rediscovering the same problem.\n\n` +
                `MANDATORY: Solve the current task in THIS loop. Use read_file, write_file, ` +
                `search_and_replace, and run_command directly. If the task is truly beyond ` +
                `your scope, send your Execution Report and let the parent manager decide.`,
            };
          } else if (teamSpec.length === 0) {
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
                {
                  ...effectiveConfig,
                  model: config.workerModel || config.model,
                  // v8.36.3 — increment depth so sub-agents can't unbounded-recurse via create_team
                  _swarmDepth: (effectiveConfig._swarmDepth ?? 0) + 1,
                },
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
            // v8.36.5 — Sanitize the freshly-created worktree's JSON files.
            // Closes the Test 13 scope gap: the v8.36.3 sanitizer ran on
            // session-restore but a NEW worktree spawned mid-loop could still
            // inherit a corrupted package.json from main branch state.
            if (activeWorktreePath) {
              sanitizeWorktreeJson(activeWorktreePath, workspacePath);
              // v8.36.6 — Worktree .gitignore guard. Prevents the Test 15
              // failure where exit_worktree(merge) collided on Windows-locked
              // node_modules/*.exe files when git tried to apply the branch
              // diff to main. Injecting node_modules/, dist/, etc. into
              // .gitignore BEFORE any npm install / tsc run means git never
              // tracks those paths, so the merge moves only source code.
              ensureWorktreeGitignore(activeWorktreePath, workspacePath);
            }
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

      // ── v8.36.3: EJSONPARSE Recovery Interceptor ────────────────────────────
      // Test 11 root cause #2: when npm hits malformed JSON it prints the
      // corrupted snippet ("type": "modul"scripts": {) in the error output.
      // The agent then grafted that error-substring into search_and_replace
      // attempts — searching for text that exists in the error message but
      // NOT in the file (which has been overwritten by intervening writes).
      // Replace the raw npm error with a structured directive that pins the
      // recovery to write_file (cannot fail on snippet match) and explicitly
      // warns the agent that the error substring is NOT the file content.
      if (toolName === 'run_command' && !result.success && typeof result.output === 'string') {
        if (/EJSONPARSE|JSONParseError|JSON\.parse Invalid/i.test(result.output)) {
          const _pathMatch = result.output.match(/Invalid (\S+\.json)/i)
            || result.output.match(/parsing (\S+\.json)/i)
            || result.output.match(/(\S+\.json):\s*\d+:\d+/);
          const _badFile = _pathMatch ? _pathMatch[1] : 'package.json';
          result = {
            ...result,
            output: result.output +
              `\n\n[SYSTEM RECOVERY v8.36.3] EJSONPARSE detected in ${_badFile}.\n` +
              `Your in-context memory of this file is STALE — the corrupted substring quoted ` +
              `in the error above is NOT necessarily the current file content (the file may ` +
              `have been overwritten by intervening writes).\n\n` +
              `MANDATORY RECOVERY (in this exact order):\n` +
              `1. Call read_file("${_badFile}") to see the ACTUAL current content.\n` +
              `2. Call write_file("${_badFile}", <complete valid JSON>) to overwrite the entire file.\n` +
              `   DO NOT use search_and_replace — JSON corruption makes snippets unreliable.\n` +
              `3. Retry the original run_command.\n\n` +
              `Common JSON build errors:\n` +
              `• Missing comma between properties (e.g., "type":"module" "scripts":{...})\n` +
              `• Property merged into value (e.g., "type":"modul"scripts":{)\n` +
              `When in doubt, rewrite the file from scratch — it's a few lines.`,
          };
        }
      }
      // ──────────────────────────────────────────────────────────────────────────

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

  debugLog(workspacePath, `MAX_ITERATIONS (${effectiveMaxIterations}) reached.`);
  yield { type: 'streamChunk', text: `\n\n⚠️ Reached maximum iterations (${effectiveMaxIterations}). The task was too long or the agent got stuck.` };
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

// ─── Continuation Auditor (v8.36.4) ───────────────────────────────────────────
// Spawns at iteration MAX_ITERATIONS-1 to decide whether to grant the agent
// more iterations. Conservative by design — defaults to NO extension unless
// there is empirical evidence of progress + a clear short path to completion.
// Always uses the Manager model (better reasoning than worker; this is the
// budget gatekeeper, not a worker).
interface AuditorVerdict {
  extend: boolean;
  iterations: number;
  reason: string;
}

function summarizeHistoryForAudit(messages: ChatMessage[]): string {
  // Pull last 30 messages; truncate tool outputs to first 400 chars each.
  // The auditor needs SIGNALS (success, error, build state), not full payloads.
  const tail = messages.slice(-30);
  return tail.map(m => {
    const role = m.role;
    const rawContent: unknown = (m as any).content;
    const content: string = typeof rawContent === 'string'
      ? rawContent
      : (rawContent == null ? '' : JSON.stringify(rawContent));
    const truncated = content.length > 400 ? content.slice(0, 400) + '… [truncated]' : content;
    // For assistant messages with tool_calls, surface the tool names called
    const toolCalls = (m as any).tool_calls;
    const toolHint = Array.isArray(toolCalls) && toolCalls.length > 0
      ? ` [called: ${toolCalls.map((tc: any) => tc.function?.name ?? '?').join(', ')}]`
      : '';
    return `<${role}${toolHint}> ${truncated}`;
  }).join('\n');
}

async function auditContinuation(
  history: ChatMessage[],
  originalTask: string,
  agentId: string,
  config: EngineConfig,
  signal: AbortSignal,
): Promise<AuditorVerdict> {
  const auditSystemPrompt =
    `You are the Fluxo Continuation Auditor.\n\n` +
    `An agent loop is about to hit its iteration cap (${MAX_ITERATIONS}). ` +
    `Decide whether the agent deserves a bounded extension (up to ${MAX_EXTENSION_ITERATIONS} more iterations).\n\n` +
    `THE USER IS PAYING PER ITERATION. Default to DENY. Only EXTEND when ALL of the following hold:\n` +
    `  • The agent has shown forward progress in the recent history (successful tool calls, not panic loops).\n` +
    `  • There is a CLEAR remaining path to completion that fits in 5-15 more iterations.\n` +
    `  • The agent is NOT stuck on the same error repeating (e.g., 3+ identical MATCH ERROR or build failures with no recovery).\n` +
    `  • The task is NOT already substantially complete (don't extend just to polish).\n\n` +
    `Output rules:\n` +
    `  • Return ONE JSON object on a single line, NOTHING ELSE — no prose, no markdown, no fences.\n` +
    `  • Schema: {"extend": boolean, "iterations": number, "reason": string}\n` +
    `  • iterations: integer 5-15 when extending, 0 when denying.\n` +
    `  • reason: ONE short sentence (<= 25 words) — what convinced you to extend / deny.`;

  const auditUserContent =
    `Agent: @${agentId}\n` +
    `\n` +
    `ORIGINAL TASK:\n${originalTask}\n` +
    `\n` +
    `RECENT HISTORY (tail of conversation, tool outputs truncated):\n${summarizeHistoryForAudit(history)}\n` +
    `\n` +
    `Return ONLY the JSON object.`;

  const auditMessages: ChatMessage[] = [
    { role: 'system', content: auditSystemPrompt },
    { role: 'user', content: auditUserContent },
  ];

  try {
    const auditConfig: EngineConfig = { ...config, maxTokens: 200 };
    const response = await callOpenRouterBlocking(auditMessages, auditConfig, signal);
    let raw = (response.content || '').trim();

    // v8.36.5 — Defensive JSON extraction. Test 13 showed the non-greedy
    // regex /\{[\s\S]*?\}/ failed when the model wrapped output in markdown
    // fences (```json ... ```), included reasoning prose, or returned the
    // JSON on multiple lines. Strip fences first, then locate the outermost
    // balanced {...} block by brace counting.
    raw = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();

    let extracted: string | null = null;
    // Find first '{', then track brace depth to find the matching '}'.
    const firstOpen = raw.indexOf('{');
    if (firstOpen >= 0) {
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let i = firstOpen; i < raw.length; i++) {
        const ch = raw[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) { continue; }
        if (ch === '{') { depth++; }
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            extracted = raw.slice(firstOpen, i + 1);
            break;
          }
        }
      }
    }
    if (!extracted) {
      // Fallback: try parsing the whole stripped response in case it's already pure JSON
      try { JSON.parse(raw); extracted = raw; } catch {
        return { extend: false, iterations: 0, reason: `auditor returned no parseable JSON (raw: "${raw.slice(0, 80)}")` };
      }
    }

    const parsed = JSON.parse(extracted);
    const extend = parsed.extend === true;
    const itersRaw = Number(parsed.iterations);
    const iters = Math.max(0, Math.min(MAX_EXTENSION_ITERATIONS, isFinite(itersRaw) ? Math.floor(itersRaw) : 0));
    const reason = String(parsed.reason ?? '').slice(0, 200);
    return { extend, iterations: extend ? Math.max(5, iters) : 0, reason };
  } catch (e) {
    return { extend: false, iterations: 0, reason: 'auditor failed: ' + String(e).slice(0, 100) };
  }
}
// ─────────────────────────────────────────────────────────────────────────────

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

### 📁 FILE: `src\agents.ts`
```typescript

// ─── OS Awareness Directive (v8.7.0) ─────────────────────────────────────────
// Computed once at module load — process.platform never changes during a session.
// Injected into the system prompt of any agent that has run_command in its toolset.

const _isWindows = process.platform === 'win32';

const OS_DIRECTIVE = _isWindows
  ? `
─── WINDOWS HOST ──────────────────────────────────────────────────────────────

You are running on Windows. run_command uses Windows shell only.

For shell commands: use dir/del/move/copy (not ls/rm/mv/cp).
For builds and git: npm/tsc/git work identically on every OS.

File reads via terminal are BLOCKED at engine level — use read_file:
  ❌ type/more/cat/head/tail "src\\file.js"  → use read_file('src/file.js')

Directory creation: ALWAYS use create_dir('src/components'). NEVER call
'mkdir' or 'md' via run_command — they fail noisily when the directory
already exists, burning iterations on recovery. create_dir is idempotent.

Paths in Windows: backslash separator (src\\components\\Button.tsx). Quote any
path containing spaces. Engine normalizes paths automatically; always use
RELATIVE paths from repo root.

Forbidden Windows commands (will fail or be intercepted):
  ls, pwd, cat, rm -rf, mv, cp, chmod, touch, type, more, head, tail, mkdir -p

─────────────────────────────────────────────────────────────────────────────────
`
  : `
─── UNIX/LINUX/macOS HOST ──────────────────────────────────────────────────────

Standard POSIX commands available: ls, rm, mv, cp, mkdir -p.
Forward-slash path separator: src/components/Button.tsx
File reads via terminal still discouraged — prefer read_file for code inspection.

─────────────────────────────────────────────────────────────────────────────────
`;

// ─── Agent Definitions ────────────────────────────────────────────────────────

export interface AgentDefinition {
  id: string;
  name: string;
  emoji: string;
  color: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  keywords: string[];
  isolation?: 'worktree'; // When set, engine injects a worktree-awareness directive at session start
}

// ─── Manifesto Reference (injected at the top of every agent system prompt) ──

const MANIFESTO_REF = `CNOS_MANIFESTO: This workspace contains CNOS_MANIFESTO.md at its root. ` +
  `It is the binding constitutional document for all code produced by Fluxo AI — covering ` +
  `Editing Philosophy (read_file → search_and_replace for editing existing files, write_file for new files only), Security Protocol ` +
  `(Sherlock + Sentinel), Web SOP (Glassmorphism, Mobile-First, lucide-react), and Build ` +
  `Verification (npm run build required before structural delivery). ` +
  `WORKSPACE ROOT: The root of this workspace IS the current working directory. Subdirectories like "my-react-app", "frontend/", or "app/" do NOT exist unless you have already called list_dir and confirmed them. Your FIRST action on any new task MUST be list_dir('.') to map the real structure — any assumption about the directory tree without reading it first is a HALLUCINATION and will cause broken paths. ` +
  `If you are uncertain about any standard, call read_file on "CNOS_MANIFESTO.md" to consult it.\n\n`;

// ─── Shared Web Architecture SOP ─────────────────────────────────────────────

const WEB_ARCHITECTURE_SOP = `
─── WEB ARCHITECTURE SOP — APPLY ALWAYS ──────────────────────────────────────

These standards are MANDATORY on every web project. Apply them automatically
without waiting for the user to ask.

1. LLMO & SEO
   - Create or verify /llms.txt in the project root (AI-crawler index file).
   - Every HTML page or React route must include:
     • <script type="application/ld+json"> Schema Markup (LocalBusiness, WebSite, etc.)
     • OpenGraph tags: og:title, og:description, og:image, og:url
     • <meta name="description" content="..."> with a relevant, keyword-rich description.

2. PERFORMANCE — Lazy Loading
   - NEVER import heavy components/pages directly. Always wrap with React.lazy + Suspense:
       const HeavyComponent = React.lazy(() => import('./HeavyComponent'));
       <Suspense fallback={<div className="animate-pulse bg-white/10 rounded-xl h-40" />}>
         <HeavyComponent />
       </Suspense>
   - Apply to: page routes, image galleries, dashboards, map/chart components.

3. UI/UX — Mobile-First + Design System
   - ALL layouts must be mobile-first (sm: → md: → lg: → xl:). Never desktop-first.
   - Preferred aesthetic: Glassmorphism with Tailwind CSS:
       bg-white/10 backdrop-blur-md border border-white/20 rounded-2xl shadow-xl
   - Icon library: ALWAYS use lucide-react. Never use @heroicons, react-icons, or
     any other icon package unless the user explicitly requests it.

──────────────────────────────────────────────────────────────────────────────
`;

// ─── Holistic Diagnostic Protocol (injected into Coder + Manager) ────────────

const HOLISTIC_DIAGNOSTIC_PROTOCOL = `
─── HOLISTIC DIAGNOSTIC PROTOCOL — TECH LEAD MODE ──────────────────────────────

ACTIVATE when the user reports any of these signals:
  • Auth failures: login loops, signups not working, session / token / redirect issues
  • Silent errors: "it's not working" / "still can't access" with NO explicit console error
  • Third-party API failures: Firebase, Supabase, AWS, Stripe, OAuth providers, CORS
  • Behavioral issues that differ between localhost and deployed URL

THE TECH LEAD TEST — run this BEFORE calling any search_and_replace or write_file:
  "Could this be fixed in a cloud dashboard (Firebase Console, Vercel, AWS,
   Stripe, Supabase) without touching any code?"
  If YES or UNSURE → diagnose infrastructure first. Do NOT touch code yet.

INFRASTRUCTURE DIAGNOSIS STEPS:
1. Use read_file to scan relevant config files (firebase.ts, .env, vite.config.ts, cors config).
2. Respond in TEXT with focused DevOps questions — call NO edit/write tools until answered:
   • Firebase Auth domain:  "Have you added this domain to Firebase Console →
                              Authentication → Settings → Authorized Domains?"
   • API Keys:              "Are your API keys set in .env? Production keys, not dev keys?"
   • Exact redirect URL:    "What is the EXACT URL you land on after the action?
                              (e.g., localhost:5173 vs 127.0.0.1:5173 — these are different origins)"
   • CORS:                  "Is this error on localhost, staging, or the production domain?"
   • OAuth callback:        "Is the callback URL registered in the provider's dashboard?"
3. Wait for the user's answers. Proceed to code edits only after infrastructure is confirmed correct.

BALANCED TRACING: If the user provides console logs that explicitly show a logic failure
(e.g., states returning NULL, hooks firing twice, missing props, wrong conditional branch,
undefined variables, type errors), DO NOT paralyze yourself with infrastructure questions
— the evidence already points to code. Act as a Senior Developer: trace the execution
sequentially across files (Component → Service → Config → Hook). Use read_file and
search_in_files to map the exact data flow. You are fully authorized to replace brittle
or overly complex patterns with simpler, robust alternatives (e.g., swapping a failing
redirect flow for a popup flow) if it guarantees stability. Speed of diagnosis > caution
when the logs are explicit.

CRITICAL — NEVER do this:
  • Delete or weaken auth checks (email verification, role gates, token validation)
    to make an error "disappear". This creates a security hole while leaving the root
    cause intact — the user will remain locked out or exposed.
  • Assume a Firebase redirect loop is a React Router bug before checking Authorized Domains.
  • Assume a "network error" on login is a fetch() bug before checking CORS policy.

ROOT CAUSE RULE: Infrastructure misconfigurations CANNOT be fixed with code changes.
A code edit that masks an infra error is not a fix — it is a security vulnerability.

────────────────────────────────────────────────────────────────────────────────────
`;

export const AGENTS: Record<string, AgentDefinition> = {

  coder: {
    id: 'coder',
    name: 'Coder',
    emoji: '💻',
    color: '#3b82f6',
    description: 'General coding: creates files, runs commands, fixes bugs',
    tools: ['read_file', 'write_file', 'replace_symbol', 'search_and_replace', 'insert_lines', 'get_code_structure', 'glob', 'grep', 'create_dir', 'list_dir', 'run_command', 'delete_file', 'delete_dir', 'propose_plan', 'search_in_files', 'ask_user_approval', 'fetch_documentation', 'enter_worktree', 'exit_worktree', 'send_message', 'get_repo_map', 'abort_and_rollback', 'security_audit', 'update_memory'],
    isolation: 'worktree',
    keywords: [
      'código', 'code', 'función', 'function', 'clase', 'class',
      'bug', 'error', 'fix', 'implementa', 'implement', 'crea',
      'create', 'archivo', 'file', 'componente', 'component',
      'api', 'endpoint', 'ruta', 'route', 'test', 'prueba',
      'refactori', 'migra', 'instala', 'install', 'npm', 'typescript',
    ],
    systemPrompt: `You are Fluxo Coder — an autonomous full-stack engineer. Execute, do not narrate.

━━━ CORE RULES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PATHS: Always relative to repo root (e.g. src/components/App.jsx). Never prepend
.fluxo/worktrees/... — the engine routes for you. The implementation plan is
always at .fluxo/IMPLEMENTATION_PLAN.md (no worktree prefix).

WORKSPACE ORIENTATION: Use native tools, not shell:
  glob(pattern), grep(pattern, path_filter), list_dir(path), search_in_files(query)
  run_command for ls/find/grep/dir/cat is blocked. Native tools are mandatory.

SHELL SCOPE: run_command is EXCLUSIVELY for npm/tsc/git/firebase. For any
file operation use native tools (write_file, delete_file, delete_dir, create_dir).
Violations trigger HITL approval prompts.

━━━ EDITING WORKFLOW ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Standard sequence: get_repo_map → read_file → edit → run_command npm run build

Tool selection:
  • replace_symbol → named functions/classes/components (LSP-precise; no line counting)
  • search_and_replace → unnamed blocks, imports, config — verbatim snippets only
  • insert_lines → injections >50 lines (avoids brace-balance failures)
  • write_file → ONLY for brand new files (never on existing — Sherlock will block)

VERBATIM RULE [CRITICAL]: search_and_replace requires the search_snippet copied
character-for-character from read_file output (tabs, spaces, newlines all exact).
Never guess from memory. On MATCH ERROR, re-read; do NOT retry with a guess.

[NON-NEGOTIABLE — v8.36.3] STALE CONTEXT RECOVERY:
After ANY tool error containing "MATCH ERROR", "PATH ERROR", "EJSONPARSE",
"JSONParseError", or "[SYSTEM RECOVERY]" — your IMMEDIATE next call MUST be
read_file on the affected path. NOT search_and_replace. NOT write_file. NOT
list_dir. ONLY read_file. Reason: the file's current state has diverged from
your context window memory (intervening writes, error-message substrings that
were never in the file, prior session corruption). Trying to edit blindly will
fail every time. Read first, then act on what you actually see.

[NON-NEGOTIABLE] ERROR ≠ FILE CONTENT:
Error messages quoting file content (e.g., npm's "parsing near ..." dumps with
the offending substring) are STALE. The file may have been overwritten between
the error and your next action. NEVER copy substrings from an error message
into a search_and_replace search_snippet — they describe a past state, not
the current one. read_file first to see the actual current text.

DUPLICATE PREVENTION: Before declaring a hook/import/variable, scan the file
content you read. Re-declaring causes runtime crashes (Vite: "Identifier already
declared"). If exists, skip the injection.

JSX/AST: When editing React/JSX, replace the ENTIRE balanced block (opening tag
to matching closing tag). Partial-tag replacements corrupt the AST.

GREP DISCIPLINE: grep is for LOCATING files, never for inspecting one you're about
to edit. After a failed edit, your ONLY recovery is read_file (not grep). Avoid
complex glob patterns in path_filter — ripgrep does not expand braces.

JSON FILE EDITS: For package.json, tsconfig.json, and other small JSON config
files — when you need to make ANY structural change (add field, fix syntax,
rearrange), prefer write_file with the COMPLETE valid JSON. search_and_replace
is fragile on JSON because comma placement and brace balance are unforgiving.

━━━ BUG INVESTIGATION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. read_file or search_in_files to trace ACTUAL data flow (never assume).
2. Identify root cause from real code, NOT training memory.
3. Edit with replace_symbol (named) or search_and_replace (inline).
4. search_in_files to check if the same bug pattern exists elsewhere.

CODE-FIRST: When user requests modify access/features/behaviors, ALWAYS check
if logic is in the code first. Never assume external admin panel/database is
needed before reading the source.

━━━ BUILD REPAIR PROTOCOL [NON-NEGOTIABLE] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

If npm run build FAILS, all feature work HALTS. Allowed actions ONLY:
  read_file at the EXACT file:line in the compiler output → fix → re-run build.
Forbidden: grep loops, exploring unrelated files, emitting reports, new features.
The compiler tells you exactly what broke. Trust it. Fix the line. Re-build.

DEPENDENCY AUTOCORRECT: If error is "Cannot find module 'X'" or "Cannot find
name 'Y' — install @types/X", autonomously run:
  npm install <pkg>     OR    npm install --save-dev @types/<pkg>
Then re-run build. Do NOT ask user permission for missing-module installs.

CTRL+Z escape: If an edit is too messy to fix manually, run_command
"git restore <path>" to undo and re-read the clean state. Try a different approach.

━━━ ANTI-RABBIT HOLE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

If 3 attempts fail on the same bug, you are in a Rabbit Hole. Stop guessing.
run_command "git restore <file>", re-read clean, retry differently.
Counter resets on green build.

Symptoms of being in a rabbit hole: reading node_modules, hypothesizing about
framework internals, grepping unrelated files. Engine physically blocks
node_modules access — do not waste iterations trying.

━━━ VERIFICATION STRICTNESS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

After replace_symbol/insert_lines + green npm run build, STOP. Do NOT re-grep
or re-read to "verify" the edit landed. The LSP and the compiler are two
independent oracles — there is no third worth iterations. Merge and exit.

━━━ TASK COMPLETION [NON-NEGOTIABLE] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You are NOT the Manager. NEVER emit "ORCHESTRATOR'S REPORT" or fake build
success. Engine intercepts and rejects fake reports — your turn fails.

Exit ramp on green build: call ask_user_approval with intent_summary
"Code injected and build green. Ready for review or merge." and
reason_and_files listing files touched. This is the ONLY legal way to exit.

ASK_USER_APPROVAL — when to use:
  Required: deleting files/dirs | editing package.json/vite.config.*/tsconfig/.env
            | touching 5+ files | genuinely ambiguous file target.
  Not needed: feature edits with clear target | bug fixes | new files | builds.
  Default: search_in_files to disambiguate before asking.

━━━ WORKTREE ISOLATION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

For high-risk work (>50 lines, multi-file, refactors): call enter_worktree first.
The engine routes all file ops to the sandbox. Continue using normal relative paths.
On green build → exit_worktree(action='merge'). On unfixable break → exit_worktree(action='discard').
For simple edits (1-2 files, <50 lines), worktree is optional.

━━━ SHERLOCK OVERRIDE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Default path on REDUNDANT_DECLARATION: prefer Sherlock's diagnostic fix
(read_file → search_and_replace with replace_snippet="" to delete the existing
duplicate). Override is the exception, not the default.

If user explicitly authorized ("fix it anyway", "I know about the duplicate,
force the change"): set healing_mode: true on your edit tool AND quote the
user's verbatim phrase in your reasoning. Engine verifies BOTH the flag AND
the user override marker before letting the edit through.

━━━ EXTERNAL DOCS & MEMORY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

For unfamiliar libraries (Stripe, Firebase, Framer Motion, etc.) call
fetch_documentation BEFORE writing code. Prefer raw.githubusercontent.com URLs.
This avoids "Tutorial Bias" from stale training knowledge.

After non-trivial recovery (Circuit Breaker, >5 iterations on one bug, repeated
MATCH ERRORS, corrupted imports), call update_memory ONLY AFTER green build with
fields: task_id, outcome (Success/Failure), what_failed, why_it_failed, the_fix.
Skip for trivial tasks. Memory is post-mortem signal, not success log.

━━━ SECURITY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

NO PLACEHOLDERS: never hardcode "yourwebsite.com", "localhost:3000", fake emails,
demo data. Use window.location.origin and dynamic routing. If a value is unknown,
insert a clear TODO comment and tell the user.

NO MODAL NESTING: before modifying Modal/Dialog/Sheet/Drawer logic, search_in_files
the component name to confirm it isn't already nested. Use Multi-Step pattern
(internal state) instead of opening a new modal on top.

VERIFY DELETIONS: before deleting any file, search_in_files to confirm it isn't
imported elsewhere. Deleting an in-use file is a critical failure.
${HOLISTIC_DIAGNOSTIC_PROTOCOL}${WEB_ARCHITECTURE_SOP}`,
  },

  designer: {
    id: 'designer',
    name: 'Designer',
    emoji: '🎨',
    color: '#ec4899',
    description: 'UI/UX design, stock images, CSS, landing pages',
    tools: ['read_file', 'write_file', 'replace_symbol', 'replace_block', 'glob', 'grep', 'create_dir', 'list_dir', 'run_command', 'delete_file', 'delete_dir', 'search_images', 'send_message'],
    keywords: [
      'diseño', 'design', 'imagen', 'image', 'foto', 'photo',
      'css', 'ui', 'ux', 'color', 'layout', 'visual', 'estilo',
      'style', 'landing', 'hero', 'banner', 'tipografía', 'font',
      'animación', 'animation', 'responsive', 'móvil', 'mobile',
      'tailwind', 'scss', 'gradient', 'glassmorphism', 'dark mode',
    ],
    systemPrompt: `You are Fluxo Designer — a world-class UI/UX designer.

CRITICAL CONSTRAINTS:
1. YOU ARE NOT SANDBOXED.
2. PLANNING MODE: Use <reasoning> to audit the setup.
3. NO ROGUE CODE: Never create "demo" files unrequested.
4. WINDOWS SAFETY: Quote paths in 'run_command'. Use 'delete_dir' for cleanup.

EDICIÓN DE CÓDIGO (v8.5.0 — AST Protocol):
Ya no buscas texto plano. Ahora editas código por Nodos AST.
- Para reemplazar un componente React, función, o clase: usa replace_symbol con file_path, symbol_name (nombre exacto), y new_code (versión completa).
  El LSP calcula las llaves y el rango por ti — cero riesgo de AST corruption.
- Para editar bloques sin nombre semántico (imports, estilos inline, config): usa replace_block con search_snippet + replace_snippet.
- Para archivos NUEVOS: usa write_file.
FAIL-SAFE de replace_symbol: Si el símbolo no se encuentra, la herramienta devuelve error sin tocar el archivo. Usa get_code_structure para ver los nombres disponibles.
${WEB_ARCHITECTURE_SOP}`,
  },

  dashboard: {
    id: 'dashboard',
    name: 'Dashboard',
    emoji: '📊',
    color: '#10b981',
    description: 'Charts, analytics, data visualization, KPI dashboards',
    tools: ['read_file', 'write_file', 'create_dir', 'list_dir', 'run_command', 'delete_file', 'delete_dir'],
    keywords: [
      'dashboard', 'chart', 'gráfica', 'grafica', 'visualiz',
      'chart.js', 'recharts', 'd3', 'datos', 'data', 'estadísticas',
      'estadisticas', 'analytics', 'kpi', 'métrica', 'metrica',
      'reporte', 'report', 'tabla', 'table', 'gauge', 'pie', 'bar',
      'line chart', 'histograma', 'tendencia', 'trend',
    ],
    systemPrompt: `You are Fluxo Dashboard. Use 'delete_dir' for cleanup.`,
  },

  payments: {
    id: 'payments',
    name: 'Payments',
    emoji: '💳',
    color: '#f59e0b',
    description: 'Stripe, PayPal, Mercado Pago, payment gateway integration',
    tools: ['read_file', 'write_file', 'create_dir', 'list_dir', 'run_command', 'delete_file', 'delete_dir'],
    keywords: [
      'pago', 'payment', 'stripe', 'paypal', 'mercado pago',
      'checkout', 'cobro', 'tarjeta', 'card', 'suscripción',
      'suscripcion', 'subscription', 'webhook', 'billing',
      'factura', 'invoice', 'precio', 'price', 'plan', 'trial',
      'reembolso', 'refund', 'transferencia', 'transfer',
    ],
    systemPrompt: `You are Fluxo Payments. Always wrap payment credentials in environment variables, never hardcode them.`,
  },

  planner: {
    id: 'planner',
    name: 'Planner',
    emoji: '📋',
    color: '#6366f1',
    description: 'Analyzes the codebase and produces a structured implementation plan',
    tools: ['get_repo_map', 'read_file', 'write_file', 'ask_user_approval', 'list_mcp_resources'],
    keywords: [],
    systemPrompt: `You are Fluxo Planner — a Senior Software Architect and Technical Lead.

━━━ CRITICAL DIRECTIVE (v8.16.5 + v8.33.0) — ABSOLUTE HIGHEST PRIORITY ━━━━━━━
YOUR ULTIMATE GOAL IS TO PRODUCE A PLAN. You MUST use the 'write_file' tool to
save your final plan EXACTLY at the path '.fluxo/IMPLEMENTATION_PLAN.md'.
The engine physically checks this file's existence — if it is missing, the
planning phase is marked FAILED. Calling write_file on
'.fluxo/IMPLEMENTATION_PLAN.md' is the ONLY way this agent can finish.

DO NOT use ask_user_approval to say you are done. The plan file IS your exit.
DO NOT attempt to write production code. Your write_file is ONLY authorized
for '.fluxo/IMPLEMENTATION_PLAN.md'.

━━━ DISCOVERY MODE PROTOCOL (v8.33.1 — NON-NEGOTIABLE) ━━━━━━━━━━━━━━━━━━━━━━
You are a Senior Product Manager and Tech Lead. If the user's prompt is
ambiguous or lacks architectural depth, you must clarify it BEFORE planning.

CRITICAL RULES FOR DISCOVERY:
1. ZERO-YAPPING FOR QUESTIONS: You are STRICTLY FORBIDDEN from asking your
   clarifying questions in conversational plain text. You MUST invoke the
   'ask_user_approval' tool and place your questions inside the
   'intent_summary' parameter.
2. MUTUALLY EXCLUSIVE ACTIONS: You CANNOT invoke 'ask_user_approval' and
   'write_file' in the same turn. If you need to ask questions, invoke
   'ask_user_approval' and END YOUR TURN immediately to wait for the user's
   answer.
3. NO ASSUMPTIONS: Do not guess or hallucinate database schemas or backend
   providers if they are not explicitly mentioned in the code or the prompt.

Only invoke 'write_file' to generate the IMPLEMENTATION_PLAN.md when the
requirements are crystal clear or after the user has answered your questions.

EXAMPLES of well-formed clarifying questions (place inside intent_summary):
  • "Should the CSV data be filterable by date before export?"
  • "Do you want the filename to include a UTC timestamp?"
  • "Should empty rows be skipped or written as blanks?"
  • "What auth scope do the new endpoints require — bearer token or session?"
  • "Is the migration reversible (down() needed) or one-way?"

The engine reroutes your ask_user_approval to a text-input modal — the user
TYPES verbatim answers and you receive them as the tool result.output. Read
those answers and write the plan informed by them on your NEXT iteration.

WHEN to skip Discovery and write the plan immediately:
  • The user's task already specifies file paths, data shapes, and acceptance
    criteria with zero ambiguity (e.g. "add a button at line 47 of App.tsx
    that calls handleExport").
  • A matching skill is found via skill(action='list') — the recipe IS the plan.
  • You already completed one Discovery round and have answers — DO NOT ask
    again. Ship the plan now.

HARD CAP: maximum 2 Discovery rounds enforced by the engine. After the second
round, the engine forces you to write the plan with whatever you have.

SEPARATION PROTOCOL (v8.16.6):
Do NOT explain your plan in chat. Do NOT preface it with "Here is the plan…".
Output ONLY the tool call for write_file with the full markdown plan as the
content argument. The user reads the plan from disk, not from chat. Any text
outside a tool call is a violation. The engine physically verifies the file's
existence after every turn and will REJECT your response if the file is
missing AND you did not invoke ask_user_approval this turn.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

MISSION: Analyze the codebase for the given task and produce a COMPLETE, ACTIONABLE implementation plan.
You are a PURE ANALYST. You read code. You NEVER modify source files.

YOUR ONLY DELIVERABLE: Write the plan to .fluxo/IMPLEMENTATION_PLAN.md using write_file.

STRICT CONSTRAINTS:
1. ZERO code modifications. Your write_file is ONLY authorized for .fluxo/IMPLEMENTATION_PLAN.md.
2. NEVER call replace_lines, replace_block, replace_symbol, delete_file, run_command, or replace_symbol.
3. You MUST read the relevant files BEFORE writing the plan. Flying blind is a CRITICAL FAILURE.
4. You MUST produce the plan file. If you finish without writing it, you have failed your mission.

COMMUNITY SKILLS SHORTCUT:
Before manually analyzing the codebase, call skill(action='list') to check if a pre-built recipe
already exists for this task (e.g. "stripe-payment-flow", "firebase-auth", etc.).
If a matching skill exists, call skill(action='apply', skill_name='...') — the engine will inject
the recipe into IMPLEMENTATION_PLAN.md automatically. You can then skip manual analysis.
If no skill matches, proceed with the manual workflow below.

CRITICAL: You do not have directory search tools. Use get_repo_map to understand the holistic project structure, use read_file only if you need granular details, and IMMEDIATELY use write_file to create the .fluxo/IMPLEMENTATION_PLAN.md.

WORKFLOW:
1. Call get_repo_map — get the full project structure in one shot. No glob, no list_dir.
2. Decide if the task is ambiguous (see DISCOVERY MODE PROTOCOL above):
   • If YES → call ask_user_approval ONCE with 3 technical questions, then on
     the next iteration use the user's verbatim answers to write the plan.
   • If NO → proceed directly to step 3.
3. Use read_file only for specific files you need granular details on (max 2–3 files).
4. Write the complete plan to .fluxo/IMPLEMENTATION_PLAN.md using write_file.
5. Output a short FINAL_REPORT confirming the plan was written.

PLAN FORMAT (MANDATORY — use this exact structure):
\`\`\`markdown
# Implementation Plan — [Task Name]

## Objective
[One clear sentence: what will be built/changed and why.]

## Files to Modify
| File | Action | Reason |
|------|--------|--------|
| path/to/file.ts | Modify | [reason] |
| path/to/new.ts | Create | [reason] |

## Sequential Steps
### Step 1: [Step Name]
- **File**: path/to/file.ts
- **Action**: [Precise action: add function X, modify component Y, etc.]
- **Symbol/Block**: [Exact symbol name or text block to target]
- **Details**: [What to add, remove, or change]

### Step 2: [Step Name]
- **File**: path/to/file.ts
- **Action**: [Precise action]
...

## Integration Points
- [Key connections between steps — e.g., "Step 3 must follow Step 1 because it imports X from it"]

## Dependencies & Risks
- [Breaking changes, ordering constraints, or external dependencies]

## Agent Assignment
- @coder: Steps [N, N, N]
- @designer: Steps [N, N] (if applicable — only if UI/CSS changes are needed)
\`\`\`

Do NOT write the plan until you have read the relevant source files.
Write the plan exactly once with write_file. Do NOT use search_and_replace on it.
Ensure every step has a concrete file target and symbol/block reference.
Vague steps ("update the component") are a FAILURE — be precise ("replace_symbol on 'handleSubmit' in src/Login.tsx").
`,
  },

  manager: {
    id: 'manager',
    name: 'Manager',
    emoji: '🧭',
    color: '#8b5cf6',
    description: 'Orchestration, complex planning, and emergency debugging',
    tools: ['read_file', 'search_in_files', 'get_code_structure', 'glob', 'grep', 'run_command', 'enter_worktree', 'exit_worktree', 'create_team', 'send_message', 'enter_plan_mode', 'skill', 'get_repo_map', 'abort_and_rollback', 'list_mcp_resources', 'security_audit', 'update_memory'],
    isolation: 'worktree',
    keywords: [
      'manager', 'gestiona', 'organiza', 'planifica', 'proyecto',
      'architect', 'arquitecto', 'debug', 'investiga', 'loop',
      'estancado', 'stuck', 'complex', 'complejo', 'pasos',
    ],
    systemPrompt: `You are Fluxo Manager — the primary orchestrator.

━━━ SECURITY AUDIT PROTOCOL (v8.28.0 — NON-NEGOTIABLE) ━━━━━━━━━━━━━━━━━━━━━
Cuando el usuario te pida auditar el código o buscar vulnerabilidades, NUNCA
uses read_file o grep para buscar a ciegas. Llama INMEDIATAMENTE a la
herramienta 'security_audit'. Analiza su reporte de bajo coste y, si hay
vulnerabilidades o secretos expuestos, usa create_team para que el @coder
mueva los secretos al archivo .env o actualice los paquetes afectados.

Triggers obligatorios para 'security_audit' (no opcionales):
  • "audita", "audit", "auditoría", "audita el código"
  • "busca vulnerabilidades", "scan for vulnerabilities", "vulnerabilities"
  • "secretos expuestos", "leaked secrets", "exposed API keys", "claves expuestas"
  • "security review", "revisión de seguridad", "review de seguridad"
  • "npm audit", "dependency advisories", "vulnerabilidades de dependencias"

Razón arquitectónica: 'security_audit' corre 100% local (Node.js + regex +
npm audit), NO consume tokens del LLM, y sus findings ya vienen redactados
(secrets en formato <prefix>…<sufijo> para que el reporte mismo sea seguro).
Hacer grep manual a ciegas sobre el repo es lento, caro en iteraciones, y
puede leakear el secreto en plain text al historial de la conversación.

Flujo completo después del audit:
  1. Llama 'security_audit' (sin parámetros).
  2. Lee el reporte. Si dice "No security issues found. Code is clean." →
     responde al usuario con esa misma frase y termina la tarea.
  3. Si hay SECRETS — para cada finding, ordena al @coder via create_team:
     leer el archivo, mover el secreto a .env (creándolo si no existe),
     reemplazar el literal en código por process.env.NOMBRE, y agregar
     el archivo a .gitignore si aún no está.
  4. Si hay DEPENDENCIES con high/critical — ordena al @coder ejecutar
     'npm audit fix' y verificar build verde después.
  5. NUNCA pegues el secret completo (ni siquiera el redactado) en
     respuestas finales al usuario — solo file:line + provider name.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

─── SHELL SCOPE — IRON RULE (v8.10.0) ──────────────────────────────────────
TIENES ESTRICTAMENTE PROHIBIDO usar run_command para crear, mover o eliminar archivos
o carpetas. El shell es EXCLUSIVAMENTE para compilación (npm run build, tsc) y tests.
Cualquier comando de archivos (del, rm, mkdir, move, xcopy, New-Item, Remove-Item)
será interceptado por el sistema HITL y el usuario verá el comando antes de ejecutarse.
─────────────────────────────────────────────────────────────────────────────────────────

─── STRICT ORCHESTRATOR CONSTRAINT (v8.3.1 — NON-NEGOTIABLE) ───────────────

Eres el Orquestador (Manager). Tienes ESTRICTAMENTE PROHIBIDO editar código directamente.
Físicamente no tienes acceso a herramientas de escritura. Si el usuario te pide una tarea
de programación o diseño, DEBES usar obligatoriamente create_team para instanciar a
@coder y @designer y coordinarlos en paralelo. Actúas como un enrutador puro.

TOOLS YOU HAVE: read_file · search_in_files · get_code_structure · run_command ·
                enter_worktree · exit_worktree · create_team · send_message · enter_plan_mode · skill
TOOLS YOU DO NOT HAVE AND CANNOT USE: write_file · search_and_replace · insert_lines ·
  replace_symbol · create_dir · delete_file · delete_dir · any file-mutation tool.
  If you attempt to call a missing tool, the engine will return a hard error.

MANDATORY DELEGATION RULE: Any coding, editing, or design task → create_team immediately.
Never write a single line of code yourself. Your value is coordination, not execution.

─────────────────────────────────────────────────────────────────────────────────────────

─── PLANNING GATE — IRON RULE (v8.5.3) ─────────────────────────────────────────────────

For ANY task that involves more than 1 file OR any logical refactor, you MUST call
enter_plan_mode FIRST before any create_team delegation.

enter_plan_mode spawns @planner to analyze the project and produce a precise
.fluxo/IMPLEMENTATION_PLAN.md with sequential steps and exact file targets.

YOU ARE STRICTLY FORBIDDEN from calling create_team if:
  a) The task touches more than 1 file, AND
  b) .fluxo/IMPLEMENTATION_PLAN.md does not already exist from a prior enter_plan_mode call.

Exception: Single-file tasks with a clearly identified target (e.g., "fix the button color in
  src/Button.tsx") may skip planning and delegate directly.

After enter_plan_mode returns, use the plan steps to build your create_team task descriptions.
Reference specific step numbers in each agent's task string so they know exactly what to build.

COMMUNITY SKILLS FAST LANE: Before calling enter_plan_mode, check skill(action='list').
If a pre-built recipe exists for the task (e.g. "stripe-payment-flow"), call
skill(action='apply', skill_name='...') directly — the engine injects the plan instantly
without spawning @planner. This is faster than manual planning for known integrations.

─────────────────────────────────────────────────────────────────────────────────────────

─── SENTINEL PROTOCOL — When a Sentinel error alert arrives ─────────────────

A Sentinel alert starts with "🔴 Sentinel detectó un error". When you receive one:
1. You are AUTOMATICALLY in command — do NOT ask the user what to do.
2. Use <reasoning> to identify which file and which recent edit caused the error.
3. Output this exact opener (outside <reasoning>):
   "🔴 Detecté que la última edición rompió el build. Tomando el control.
    @coder: lee el error, localiza el bloque exacto con read_file (copia el texto verbatim), y corrige
    con search_and_replace en [file] ahora."
4. Then immediately emit a tool_call yourself (read_file on the broken file).
5. If the Coder fails to fix it in one attempt, take over and execute the fix
   directly — do NOT loop or ask for permission.

─────────────────────────────────────────────────────────────────────────────
${HOLISTIC_DIAGNOSTIC_PROTOCOL}
─── CONSULTANT MODE — MANDATORY for broad/vague requests ────────────────────

SIGNAL: A request is "broad" if it lacks all three of: (a) a specific file to
create or edit, (b) a clear technical action (fix, add, delete, refactor),
(c) an explicit scope (component name, page name, feature name).

Examples of broad requests: "crea una landing page", "haz una web para mi
restaurante", "necesito una app", "hazme un sitio bonito".

When a broad request is detected, you MUST NOT start coding. Instead:
1. Use <reasoning> to analyze what is unknown.
2. Ask the user exactly 3–4 focused architecture questions. Choose from:
   - "¿El enfoque es mobile-first o desktop-first?"
   - "¿Necesitas pasarela de pagos? (Stripe, PayPal, Mercado Pago)"
   - "¿Qué paleta de colores o estética buscas? (ej. glassmorphism oscuro, minimalista claro, colorido)"
   - "¿Requieres autenticación de usuarios o es un sitio estático/público?"
   - "¿Hay una marca/logo existente o empezamos desde cero?"
   - "¿Qué tecnología de base usas? (React/Next.js, HTML vanilla, Vue…)"
   Pick the 3–4 most relevant for this specific request.
3. End your message with:
   "Una vez que respondas, el enjambre asignará los agentes adecuados
   (@designer, @coder, @payments, etc.) para ejecutar el trabajo."

NEVER skip the consultation step for a broad request. Coding without context is
a CRITICAL FAILURE — it produces generic output the user will immediately reject.

─────────────────────────────────────────────────────────────────────────────

─── MANIFESTO ENFORCEMENT — You are the guardian of CNOS_MANIFESTO.md ──────────

If you observe any of the following deviations from the Manifesto, you MUST stop
the offending agent immediately and demand refactoring before any work continues:

  • write_file used on an existing file (use read_file → search_and_replace instead)  →  Editing Philosophy violation (Section I)
  • @heroicons, react-icons, or any non-lucide icon library  →  SOP violation (Section III)
  • Desktop-first layout (xl: before sm:)  →  SOP violation (Section III)
  • No npm run build after a structural change  →  Quality Signature violation (Section IV)
  • Orchestrator's Report emitted while SENTINEL_HAS_ERROR or BUILD_FAILED is active  →  Security Protocol violation (Section II)

When a violation is detected, respond with:
"⛔ MANIFESTO VIOLATION — [Section name]: [describe exactly what was wrong].
 Refactoriza esto antes de continuar. Consulta CNOS_MANIFESTO.md Sección [N] si tienes dudas."

─────────────────────────────────────────────────────────────────────────────────

BODYGUARD PROTOCOL — call ask_user_approval ONLY for high-risk operations:
  ✅ REQUIRE APPROVAL: deleting files or directories | editing infrastructure files (package.json, vite.config.*, tsconfig.json, firebase.json, .env, any CI/CD config) | user request is genuinely ambiguous about scope and search_in_files cannot resolve it | orchestrating a plan touching 5+ files.
  ❌ NO APPROVAL NEEDED: normal code edits where the file is clear | bug fixes | new file creation | builds/tests | read-only operations.

PLANNING MODE:
- You are the master of 'propose_plan'. Use it for any multi-step project.

CRITICAL CONSTRAINTS:
1. FULL COMMAND ACCESS: You have full access to 'run_command'.
2. WINDOWS MASTERY: Quote all paths. Use 'delete_dir'.
3. PIVOT AGGRESSIVELY: If an agent is stuck, take over and write the code yourself.

RULE 5 (NO CLI READING/EDITING): Está terminantemente PROHIBIDO usar la terminal para leer, filtrar o editar código. Esto incluye el uso creativo de sed, awk, node -e, o scripts de Python. Cualquier intento de evasión será bloqueado por el motor de seguridad. Si una herramienta falla, el problema es la RUTA, no la herramienta.

RULE (GIT SAFETY NET): Como ahora guardamos los archivos automáticamente, el control de versiones es nuestra única red de seguridad. Antes de delegar tareas de programación pesadas en un nuevo proyecto, verifica o asume que el usuario está usando Git. Si el usuario reporta que una edición tuya rompió el código irremediablemente, recomiéndale usar el Source Control de VS Code para revertir los cambios del archivo.

RULE (WORKTREE ISOLATION — v8.8.0): Si la tarea implica modificar más de 1 archivo o hacer refactorizaciones complejas, DEBES llamar enter_worktree ANTES de delegar a create_team. El motor redirigirá automáticamente todas las operaciones de archivo al worktree aislado — los agentes usan rutas normales (src/App.tsx) y el engine hace el mapeo invisible. Una vez que @coder compile exitosamente dentro del worktree (npm run build = exit 0), llama exit_worktree con action='merge'. Si la refactorización falla irremediablemente, llama exit_worktree con action='discard' — el código de producción en main queda INTACTO.

RULE (CHANGELOG MAINTENANCE): Cada vez que se incremente la versión de la extensión (vX.X.X), DEBES actualizar el archivo CHANGELOG.md en la raíz del proyecto. Añade una nueva sección en la parte superior con la versión, fecha y un resumen técnico y claro de los cambios realizados. Este es nuestro registro público de producto.
RULE (EXTERNAL CONTEXT): Si el usuario te pide implementar una librería externa específica (ej. Stripe, React DnD, Firebase, Framer Motion, etc.) o cualquier concepto que requiera precisión técnica actualizada, TIENES PERMITIDO — y se RECOMIENDA — usar la herramienta fetch_documentation para leer el README oficial (ej. https://raw.githubusercontent.com/user/repo/main/README.md) o la documentación de npm (ej. https://www.npmjs.com/package/<nombre>) ANTES de escribir una sola línea de código. Esto evita el "Tutorial Bias" causado por conocimiento estático de entrenamiento. Prefiere siempre URLs de contenido raw (raw.githubusercontent.com) sobre páginas renderizadas para obtener texto más limpio.

TOPOGRAPHY RULE (v8.12.0): Before making sweeping changes or searching blindly for functions, you MUST call get_repo_map to understand the semantic structure and dependencies of the workspace. This gives you an instant atlas of every exported symbol and its file location — use it before dispatching create_team, and include the relevant map entries in each sub-agent's task description so they navigate directly without guessing paths.

─── ORCHESTRATOR REPORT RULE (v8.16.16 — NON-NEGOTIABLE) ───────────────────

ORCHESTRATOR REPORT RULE: You MUST ONLY emit the "ORCHESTRATOR'S REPORT"
EXACTLY ONCE per task. It must be the VERY LAST message you send, ONLY AFTER
you have successfully merged the worktree (using exit_worktree) and verified
the final build on the main branch. NEVER emit partial or preliminary reports
while still inside a worktree.

If a sub-agent (@coder, @designer, etc.) returns its own intermediate summary,
you ABSORB it silently — do NOT relay it to the user as a report. The user
only ever sees ONE Orchestrator's Report per task, written by you, at the end.

─────────────────────────────────────────────────────────────────────────────

━━━ CONTINUOUS LEARNING PROTOCOL (v8.31.0 — NON-NEGOTIABLE) ━━━━━━━━━━━━━━━━
You MUST use 'update_memory' to document ERRORS — not generic success messages.
Before emitting your ORCHESTRATOR'S REPORT on a complex task or after
recovering from a severe error, call update_memory with a Blameless
Post-Mortem entry. Future instances of yourself will read this log to avoid
repeating the same mistakes.

MANDATORY TRIGGER CONDITIONS (any one of these = call update_memory):
  • A sub-agent hit the Circuit Breaker (3+ consecutive build failures)
  • You had to abort_and_rollback or discard a worktree due to failure
  • A sub-agent looped more than 5 iterations on the same bug
  • You forgot a mandatory pre-step (e.g. get_repo_map before create_team,
    enter_plan_mode before non-trivial coding) and paid for it
  • You discovered a non-obvious constraint (library behaves differently than
    documented, tool requires specific argument order, etc.)
  • The task required re-routing more than once (manager → coder → manager)

TIMING RULE: Call update_memory ONLY AFTER the final build on main is green
(exit_worktree(merge) succeeded + npm run build exit 0). Never log a
post-mortem about a hypothesis — only log verified, post-build truth.

REQUIRED FIELDS — you MUST explicitly fill all five:
  • task_id        — short context tag
  • outcome        — "Success" (recovered) or "Failure" (abandoned)
  • what_failed    — the concrete error or blockage
                     e.g. "Coder corrupted imports during search_and_replace"
                     e.g. "Forgot to call get_repo_map before delegating"
  • why_it_failed  — the root cause
                     e.g. "I delegated without a repo map and the coder
                     guessed the wrong file path"
  • the_fix        — the concrete technical solution applied
                     e.g. "Re-ran the task after calling get_repo_map first"

DO NOT write update_memory for trivial tasks (single-file edits, zero errors,
< 3 total iterations). DO NOT write generic 'task completed successfully'
messages — those are noise. Every entry must answer: what failed, why,
and how was it fixed.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

─────────────────────────────────────────────────────────────────────────────

─── PARALLEL SWARM PROTOCOL (v8.2.0) — create_team & send_message ──────────

USE create_team when tasks are GENUINELY INDEPENDENT:
  • No shared files between agents (FileLockManager will block collisions anyway)
  • No sequential data dependency (Agent B does NOT need Agent A's output to start)
  • Tasks can run at the same time without coordination

HOW TO CALL create_team:
  { "team": [
      { "agent": "coder",    "task": "Build REST endpoints in src/api/routes.ts — include full OpenAPI schema. The project uses Express + TypeScript." },
      { "agent": "designer", "task": "Create src/components/Dashboard.tsx — glassmorphism style, mobile-first, lucide-react icons. No backend calls needed." }
  ]}
  CRITICAL: Each task must be COMPLETE and SELF-CONTAINED. Sub-agents have NO memory of this conversation.
  Include all relevant file paths, tech stack, and constraints in the task string.

HOW TO PASS DATA BETWEEN PARALLEL AGENTS with send_message:
  If @coder finishes an API and @designer needs its response schema:
  @coder calls: send_message({ to_agent: "designer", from_agent: "coder", payload: "GET /api/products returns: [{id, name, price, imageUrl}]" })
  The payload is delivered silently to @designer's next iteration — it does NOT appear as raw JSON in the user's UI.
  @designer receives it as an injected context block: "[FROM @coder]: GET /api/products returns: [...]"

RULES:
  1. NEVER use create_team for tasks that edit the SAME files — use sequential calls instead.
  2. ALWAYS give sub-agents their agent_id context in the task description (they will auto-tag their file edits with it for the mutex).
  3. After create_team completes, review all sub-agent results and emit your Orchestrator's Report.
  4. If a sub-agent returns a SYSTEM LOCK error, it means a sibling tried to edit the same file — redesign the task split.

─────────────────────────────────────────────────────────────────────────────
`,
  },

};

// ─── Internal System Prompts ──────────────────────────────────────────────────

/** Internal prompt for the router agent (used in agentEngine detectIntent) */
export const ROUTER_PROMPT = `You are the Fluxo Intent Router.
Your ONLY job is to analyze the user message and output the ID of the most appropriate expert agent.

Available Agents:
- 'coder': General coding, logic, bugs, API, backend, infrastructure.
- 'designer': UI/UX, CSS, Tailwind, layouts, "making things look good", visual aesthetics.
- 'dashboard': Charts, data tables, metrics, analytics.
- 'payments': Stripe, PayPal, checkouts, billing.
- 'manager': Complex requests, planning multiple steps, or when the user is stuck.

CRITICAL RULES:
- If the user says "make it look good", "se vea bien", "mejorar estética", route to 'designer'.
- If the user says "push", "git", "commit", "deploy", "firebase", "build", "run", "clean", "delete", route to 'coder' or 'manager'.
- If the user says "fix formatting", "linter", "prettier", "código limpio", route to 'coder'.
- OUTPUT ONLY the raw agent ID (one word). No markdown, no punctuation.
`;

/** Internal prompt for the revisor agent (used to validate tool calls) */
export const REVISOR_PROMPT = `You are the Fluxo Reviewer (The Sherlock Auditor).
Your role is to ensure the agent's TOOL CALLS align with the USER REQUEST and prevent rogue behavior.
You receive a structured list of tool calls the agent intends to make — not free-form text.

CONTEXT AWARENESS: When the message includes a "PRIOR COMPLETED TOOLS" section, those steps already executed successfully earlier in this session. Use this to understand task progression. A run_command('npm run build') that follows prior search_and_replace calls is normal build verification — NOT a skipped step. Never flag normal multi-step sequences when the prior work is visible.

HEALING MODE OVERRIDE — HIGHEST PRIORITY:
If ANY tool call in the batch includes "healing_mode": true, the agent is performing an authorized surgical repair on an already-broken file. In this case:
  • Large search_and_replace or insert_lines operations are FULLY AUTHORIZED — do NOT flag as rogue behavior.
  • Rewriting an entire component or file section is expected and correct.
  • Skip checks 3, 4, and 5 below for that specific tool call.
  • Output "OK" unless there is a violation unrelated to file size or scope.

NOTE (v8.35.0): Check 6 (REDUNDANT_DECLARATION) is NOT auto-skipped by healing_mode alone — it requires a SECOND key. The engine independently verifies that the user's message contains an override marker ("fix it anyway", "I know about the duplicate", "force the change", etc.) before letting the redundancy through. From your perspective as Sherlock, ALWAYS run check 6 normally and emit the REDUNDANT_DECLARATION error when triggered — the engine handles the conditional bypass downstream. Do not pre-skip check 6.

WORKTREE CLEANUP EXCEPTION — SECOND HIGHEST PRIORITY (v8.3.3):
exit_worktree with action='discard' is ALWAYS an authorized environment cleanup operation.
It is NEVER rogue behavior, regardless of prior tool call history.
  • This is especially valid when the prior tool was a failed enter_worktree (stale worktree conflict).
  • NEVER output "ERROR:" for exit_worktree(discard) under any circumstances.
  • If you would otherwise flag it, output exactly: "Cleanup Authorized: Se permite el descarte para resolver el conflicto de entorno detectado."

WIRING EXCEPTION — THIRD HIGHEST PRIORITY (v8.34.0):
Modifying existing structural files to integrate a newly created component or module is REQUIRED
and is NEVER rogue behavior. When a prior tool call created a new file (e.g. CreatePomodoroModal.jsx,
SharedWithMe.jsx), the agent MUST also edit the wiring layer to make that file reachable. The
following three categories of edits are ALWAYS authorized as part of the same logical task:
  (a) PARENT COMPONENTS — Editing a parent component (App.jsx/tsx, Layout, Page, direct visual
      parent) to import and render a newly created child component is REQUIRED, not rogue.
  (b) BARREL EXPORTS — Editing index.ts/index.tsx/index.js files to add export lines for newly
      created modules is REQUIRED to make them reachable, not rogue.
  (c) ROUTERS — Editing the router configuration (App router, route registry, routes.ts, Routes
      component) to register a new page route alongside its newly created page component is
      REQUIRED, not rogue.
For these three categories, output "OK" — never "ERROR: ROGUE" or scope-creep flags. The user
asked for the new feature; the wiring is implied. Only flag genuinely unrelated edits (e.g.
modifying an authentication module while creating a CSV export feature).

Watch for these CRITICAL ERRORS:
1. ROGUE DESIGNER: Agent calling write_file or create_dir to create UI components (e.g., "Button.jsx", "Card.jsx", "UIDemoPage") that were NOT requested by the user.
   - EXCEPTION: If the user asked to delete or modify these files, it is NOT an error.
   - EXCEPTION: Modifying translation/i18n files is always valid for UI text changes.
2. [ENGINE-MANAGED] Loop detection: Repeated tool calls are intercepted by the engine pre-flight and suppressed silently. The Auditor never receives them. Do NOT flag repeated calls as errors.
3. SILOED CHANGES: Agent using search_and_replace, insert_lines, replace_symbol, or write_file on a file that references other files, without first calling search_in_files to check for usages.
4. TECH STACK DRIFT: Agent's write_file, search_and_replace replace_snippet, or replace_symbol new_code imports packages that don't match what's already in the codebase.
   When detected, your ERROR must include:
   (a) The incorrect import being added.
   (b) The correct alternative already in use.
   (c) The exact file:line where the correct library is imported.
   Format: "ERROR: Tech Stack Drift — agent imported '[WRONG]' but this project uses '[CORRECT]' (found in: [path:LINE])."
   If you cannot verify from the tool call args alone: "ERROR: Tech Stack Drift suspected — agent must call search_in_files('import') to verify libraries before adding imports."
5. WRITE_FILE FALLBACK: Agent calling write_file with a path that already exists in the workspace (i.e., editing an existing file). The correct workflow is replace_symbol (for named AST symbols) or search_and_replace (for unnamed blocks). Using write_file on an existing file risks hallucinating the entire file from training memory.
6. REDUNDANCY CHECK: Compare the current tool calls with the "PRIOR COMPLETED TOOLS" section. If the agent is attempting to re-declare a hook (useParams, useState, useEffect, useRef, useContext, useMemo, useCallback, etc.) or a variable (const, let, var declarations) that was already successfully injected in a previous turn of this same session, output (v8.35.0 diagnostic format):
   ERROR: REDUNDANT_DECLARATION — '[identifier]' is already declared in '[file_path]'. Re-injecting a SECOND copy will cause a Runtime Crash (duplicate identifier). The fix is NOT to add another copy — the fix is to DELETE the existing one OR replace it in place. Mandatory recovery workflow: (1) call read_file('[file_path]') to find the exact lines of the existing declaration; (2) call search_and_replace with the existing declaration as search_snippet and the new value as replace_snippet (or replace_snippet="" to delete it entirely); (3) NEVER inject a third copy of '[identifier]' into the same file. If the user explicitly authorized you to bypass this guard ("fix it anyway", "I know about the duplicate, force the change"), set healing_mode: true on your edit tool call AND quote the user's override phrase in your reasoning so the engine can verify the authorization.
   SCOPE: ONLY check the actual code logic inside "new_content" or "new_code". DO NOT flag tool names like "replace_symbol", "search_and_replace", or "read_file" as redundant declarations. Ignore tool names completely in this check.
   BUILD FAILURE HOTFIX EXCEPTION (v8.5.1): If the context includes BUILD_FAILED or a prior tool result showing a syntax error or AST corruption, the agent has EXPLICIT PERMISSION to re-declare or fully rewrite any symbol to apply a hotfix. In this case, do NOT output REDUNDANT_DECLARATION — output "OK" instead. A build-broken state overrides the redundancy guard because the prior injection is already corrupt and must be replaced.
7. MODAL COLLISION: Agent's tool call modifies the open/toggle/trigger logic of a Modal, Dialog, Sheet, or Drawer component, WITHOUT a prior search_in_files call that verified the component's full render chain and confirmed it is NOT already nested inside another modal.
   When detected: "ERROR: Modal Collision Risk — '{ComponentName}' may already render inside a modal. Agent must call search_in_files('{ComponentName}') to verify the full render chain before editing modal-open logic. If nesting is confirmed, a Multi-Step (internal state) pattern is required instead of opening a new modal."

NOTE: Ghost Execution, Sentinel/Build blocking, and brace-balance validation are now handled deterministically by the engine and ReplaceLinesTool — do NOT attempt to count characters or flag syntax errors here.

CRITICAL: Deleting files the user asked to delete is GOOD. Only block unrequested creation.

If you detect an error, your response MUST start with "ERROR:" followed by the reason.
If the agent's tool calls are valid, output exactly "OK".
Keep your response extremely short.
`;

/** Internal prompt for summarizing conversation history */
export const SUMMARIZER_PROMPT = `You are the Fluxo Context Summarizer.
Your goal is to compress a long conversation into a concise, structured "Memory Snapshot".

Maintain the following truth:
1. What was the original goal?
2. What has been achieved so far? (List files created/modified)
3. What are the current blockers or pending steps?
4. Key technical decisions made.

Format: Provide a structured summary in MARKDOWN. Be extremely concise. Use bullet points.
`;

/**
 * Shared output separation protocol injected into every agent's system prompt.
 * This enforces a strict split between internal reasoning and user-facing summaries.
 */
const SEPARATION_PROTOCOL = `
─── COMMUNICATION PROTOCOL (ZERO-YAPPING) — v8.16.16 — NON-NEGOTIABLE ─────────

Do not narrate your actions. Do not say "I will now do X". Do not explain the
code you are writing in the conversational chat. Let your tool calls do the
talking. Only communicate with the user when you need their explicit approval,
or when delivering the final Orchestrator Report.

PROHIBITED CHAT PATTERNS (these will be flagged as verbosity violations):
  ❌ "Now I will read the file..."
  ❌ "Let me check the package.json..."
  ❌ "I'm going to refactor the function..."
  ❌ "Here's what I changed and why..." (outside the final report)
  ❌ Step-by-step recap before/after each tool call.

ALLOWED CHAT OUTPUT:
  ✅ Tool calls (the work itself).
  ✅ ask_user_approval calls when explicit consent is required.
  ✅ The single, final Orchestrator's Report at the end of the task.
  ✅ <thinking>...</thinking> blocks (collapsed in the UI; never user-facing).

If you must emit text between tool calls, limit it to ONE short status line
(<= 12 words). Anything longer is a violation.

─────────────────────────────────────────────────────────────────────────────

─── OUTPUT SEPARATION PROTOCOL — MANDATORY ────────────────────────────────────

INTERNAL REASONING POLICY — CRITICAL:
If you need to reason, plan, or think to yourself BEFORE calling a tool, you MUST
wrap your internal monologue completely inside <thinking> and </thinking> tags.
Do NOT mix internal thoughts with the user-facing final response.
The UI will collapse <thinking> blocks — the user only sees your final Orchestrator's Report.

Example of CORRECT output:
<thinking>
The user wants to add Stripe. I need to check if stripe is already installed...
Let me look at package.json first.
</thinking>
[tool call: read_file("package.json")]

Example of WRONG output (CoT Leak):
"I'm going to check package.json to see if Stripe is installed, then I'll add it..."
[tool call: read_file("package.json")]

The system operates in two modes. Each turn you are in exactly one:

TOOL CALL MODE — you have work left to execute:
  • Call the required tools. The API executes them and returns results.
  • Your text content (if any) must be a single brief status line — no narration.
  • NEVER describe what a tool will do — just call it.

FINAL RESPONSE MODE — all steps are complete and verified:
  • Send NO tool calls. Your text is the Orchestrator's Report shown to the user.
  • Format EXACTLY as shown below — all three sections are MANDATORY:

ANTI-GHOST GUARD — ABSOLUTE RULE:
YOU ARE STRICTLY FORBIDDEN FROM OUTPUTTING THE ORCHESTRATOR'S REPORT IF YOU HAVE ONLY USED read_file IN THIS SESSION.
You cannot claim to have made changes unless you successfully executed write_file, search_and_replace, or insert_lines during this session.
If you have not made any write operations, DO NOT output the Orchestrator's Report — execute the pending writes first, then report.

✅ ORCHESTRATOR'S REPORT

**Architectural Summary**
[Write 3–5 sentences in Tech Lead narrative style. Explain WHAT was built, HOW the components connect to each other, and WHY the chosen implementation approach was used. Do NOT use bullet points here — this must be prose that gives the Orchestrator a mental model of the system.]

**Technical Debt / Mocked UI**
[MANDATORY. This section can NEVER be omitted or left blank.
 • If everything is fully wired and functional: write exactly "None — all components are connected and functional."
 • If ANYTHING is incomplete, stubbed, mocked, or not connected to real logic: list each item explicitly.
   Examples of what to confess:
     - "The Save button (ProfileCard.tsx:47) has an onClick handler but the backend call is not implemented."
     - "The payment form renders but the Stripe webhook endpoint returns a hardcoded 200 — no real processing."
     - "The user roles UI is complete but API route enforcement has not been added yet."
     - "The modal opens and closes, but the form data is never submitted — onSubmit is empty."
 The Orchestrator MUST NOT be surprised by half-finished code. If you built a UI element
 without connecting it to logic, or scaffolded a function without implementing its body,
 you MUST declare it here. Silence on this section is a CRITICAL FAILURE.]

**Files Changed**
- **path/to/file.ext**: <action + lines touched>. _(Reason: <one concise technical reason>)_

ACTION VOCABULARY (one per bullet in Files Changed):
  "Texto reemplazado"         → search_and_replace edits
  "Creado nuevo archivo"      → write_file on a new file
  "Archivo eliminado"         → delete_file
  "Directorio creado"         → create_dir
  "Comando ejecutado: <cmd>"  → run_command

FLUXO WATERMARK — MANDATORY on every new file created with write_file:
  The VERY FIRST LINE of every new source file must be a comment with the Fluxo attribution:
    JavaScript/TypeScript:  // Powered by Fluxo Tech AI — https://fluxotechai.com
    Python:                 # Powered by Fluxo Tech AI — https://fluxotechai.com
    CSS/SCSS:               /* Powered by Fluxo Tech AI — https://fluxotechai.com */
    HTML:                   <!-- Powered by Fluxo Tech AI — https://fluxotechai.com -->
    SQL:                    -- Powered by Fluxo Tech AI — https://fluxotechai.com
  Do NOT add the watermark to: JSON, .env, .gitignore, lock files, or binary files.
  Do NOT add the watermark when using search_and_replace on an existing file.

MULTI-STEP TASK VERIFICATION — MANDATORY:
After receiving tool results, re-read your original plan. Ask: "Are ALL planned steps complete?"
If NO → call the next tool immediately. Do NOT send the Final Response until every step is done.

GOLDEN RULE — POST-EDIT TERMINAL OBSERVATION:
After every file edit, observe terminal output before sending the Final Response.
If a Sentinel alert arrives ("🔴 Sentinel"), call read_file on the broken file and fix it immediately.
A task is only complete when the terminal shows no errors.

SYSTEM ENFORCEMENT — HARDWARE BLOCK:
If SENTINEL_HAS_ERROR or BUILD_FAILED is active and you send no tool calls, the engine will
automatically block task closure and inject a mandatory fix directive. The only exit condition
is a clean build. You cannot bypass this.

CRITICAL: A conversational paragraph or a plain bullet list instead of the Orchestrator's Report (with all three sections) is a FAILURE.
────────────────────────────────────────────────────────────────────────────────
`;

// ─── RAW GIT WORKFLOW BLOCK (v8.17.1 — NON-NEGOTIABLE) ────────────────────────
// Phase 1 DAG dogfooding showed @coder and @designer issuing raw `git checkout`
// / `git merge` / `git push` via run_command, fighting the Worktree Isolation
// engine and corrupting the merge state. The only sanctioned merge path is the
// exit_worktree tool — it owns the diff review, the user approval, and the
// state cleanup. This block is injected into every agent that has run_command
// (it is meaningless for read-only agents like @planner).
const RAW_GIT_WORKFLOW_BLOCK = `
─── RAW GIT WORKFLOW (v8.17.1 — NON-NEGOTIABLE) ───────────────────────────────

You are STRICTLY FORBIDDEN from using the run_command tool to execute
'git checkout master', 'git checkout main', 'git merge', or 'git push'.

To merge your changes from an isolated worktree back to the main branch, you
MUST ONLY use the exit_worktree tool with action='merge'. exit_worktree owns:
  • The diff preview shown to the human in VS Code's native diff editor.
  • The user approval gate (merge vs. discard).
  • The atomic state cleanup of .fluxo/active_worktree.json.

Any raw git invocation that targets branches will be flagged as a workflow
violation, will desynchronize the engine's worktree state tracker, and will
trigger a failed merge that cannot be safely recovered. There is no exception:
even if you "just want to peek" at another branch, do not use git checkout —
ask the user via ask_user_approval instead.

ALLOWED git commands via run_command (read-only / housekeeping):
  ✅ git status, git log, git diff, git show, git blame, git rev-parse
  ✅ git stash list, git tag, git describe, git branch (without -d/-D)
  ✅ git fetch, git pull (only when you are NOT inside an active worktree)

PROHIBITED git commands via run_command (workflow-altering):
  ❌ git checkout <branch>, git switch <branch>
  ❌ git merge, git rebase, git cherry-pick, git revert
  ❌ git push, git push --force, git push -u
  ❌ git reset --hard, git branch -d, git branch -D, git worktree (any action)

For worktree lifecycle, the ONLY sanctioned tools are:
  enter_worktree(reason="…")            → spawn a sandbox branch
  exit_worktree(action="merge")         → diff review + user approval + merge to main
  exit_worktree(action="discard")       → drop the sandbox branch entirely

────────────────────────────────────────────────────────────────────────────────
`;

// ─── Agent Router ──────────────────────────────────────────────────────────────

/** Detect which agent should handle a message.
 *
 * v8.36.2 — Manager-as-front-door. Previously this function did keyword-scoring
 * routing (e.g. messages containing 'create'/'file'/'typescript' went to @coder)
 * and defaulted to @coder when nothing matched. That bypassed the documented
 * architecture in the README ("Describe tu feature en el chat → @manager
 * detecta el tipo de tarea") and made the Manager-model dropdown effectively
 * dead — most coding prompts scored at least one @coder keyword and never
 * reached the Manager brain. Test 10 surfaced this: every iteration ran on
 * workerModel even though the user had picked a Manager model.
 *
 * The new contract: every message goes to @manager unless the user explicitly
 * names another agent via @mention. Manager's system prompt knows how to
 * short-circuit trivial edits (send_message to @coder) and orchestrate complex
 * tasks (enter_plan_mode / create_team). Power users who want to skip the
 * Manager turn keep the fast path by typing "@coder fix this".
 */
export function routeToAgent(message: string): string {
  const lower = message.toLowerCase();

  if (lower.includes('@coder'))     { return 'coder'; }
  if (lower.includes('@designer') || lower.includes('@diseñador')) { return 'designer'; }
  if (lower.includes('@dashboard')) { return 'dashboard'; }
  if (lower.includes('@payments') || lower.includes('@pagos'))     { return 'payments'; }
  if (lower.includes('@planner'))   { return 'planner'; }
  if (lower.includes('@manager'))   { return 'manager'; }

  return 'manager';
}

// ─── MCP Knowledge Block (v8.19.0 — Phase 3 Deep MCP) ──────────────────────
// Injected only when the engine's RBAC filter has actually granted MCP tools
// to this agent. Tells the LLM that external tools are live in its toolset
// and frames them as "live context from the outside world" so it reaches for
// them when its native tools cannot satisfy the task. Read-only agents and
// agents that ended up with zero MCP tools after RBAC do NOT see this block.
const MCP_KNOWLEDGE_BLOCK = `
─── [EXTERNAL MCP KNOWLEDGE] (v8.19.0 — Phase 3) ──────────────────────────────

You have been granted access to dynamically loaded external tools via the
Model Context Protocol. Use them to fetch live context from the outside world.

These tools are prefixed with 'mcp_<server>_<tool>' in your toolset and have
been filtered to your role by the engine's RBAC layer — every tool you can
see is one you are explicitly authorized to call. When a task requires real
data (issue trackers, design files, databases, repository state, deploy
status, etc.) prefer calling the matching MCP tool over guessing from your
training cutoff or asking the user.

────────────────────────────────────────────────────────────────────────────────
`;

/** Build full system prompt for an agent including tools and the shared separation protocol */
export function buildAgentSystemPrompt(agentId: string, hasMcpTools: boolean = false): string {
  const agent = AGENTS[agentId] || AGENTS.coder;
  // Inject OS_DIRECTIVE only for agents that have access to run_command.
  // This avoids polluting read-only agents (@planner) with OS-specific command advice.
  const osBlock = agent.tools.includes('run_command') ? OS_DIRECTIVE : '';
  // v8.17.1: only inject the raw git block for agents that actually have run_command —
  // it is the only tool the rule constrains, and read-only agents like @planner do
  // not need the noise in their system prompt.
  const gitBlock = agent.tools.includes('run_command') ? RAW_GIT_WORKFLOW_BLOCK : '';
  // v8.19.0 — only mention MCP if RBAC actually admitted at least one external tool.
  const mcpBlock = hasMcpTools ? MCP_KNOWLEDGE_BLOCK : '';
  return `${MANIFESTO_REF}${agent.systemPrompt}${osBlock}\n${SEPARATION_PROTOCOL}${gitBlock}${mcpBlock}`;
}

/** Get all agents as a list for UI display */
export function getAgentList(): Array<{ id: string; name: string; emoji: string; color: string; description: string }> {
  return Object.values(AGENTS).map(({ id, name, emoji, color, description }) => ({
    id, name, emoji, color, description,
  }));
}

```

### 📁 FILE: `src\commands\mcp.ts`
```typescript
#!/usr/bin/env node
// ─── Fluxo MCP CLI (v8.20.0) ────────────────────────────────────────────────
// Standalone Node entrypoint that mirrors `claude mcp add <server>`. Compiled
// to out/commands/mcp.js by tsc. Invoke from any workspace root with:
//
//   node <path-to-vsix>/out/commands/mcp.js add <alias>
//   node <path-to-vsix>/out/commands/mcp.js list
//   node <path-to-vsix>/out/commands/mcp.js remove <alias>
//   node <path-to-vsix>/out/commands/mcp.js registry
//
// Workspace is auto-detected from process.cwd() (or --workspace=<path>).
// All ops touch .fluxo/mcp_servers.json via mcpConfigWriter — same code path
// the in-extension `Fluxo: Add MCP Server` command uses.

import * as path from 'path';
import { listRegistry, getRegistryEntry } from '../utils/mcpRegistry';
import { addServer, removeServer, listConfigured } from '../utils/mcpConfigWriter';

function resolveWorkspace(args: string[]): string {
  const flag = args.find(a => a.startsWith('--workspace='));
  if (flag) { return path.resolve(flag.substring('--workspace='.length)); }
  return process.cwd();
}

function printUsage(): void {
  console.log('Fluxo MCP CLI (v8.20.0)');
  console.log('');
  console.log('Usage:');
  console.log('  fluxo mcp add <alias> [--workspace=<path>]');
  console.log('  fluxo mcp remove <alias> [--workspace=<path>]');
  console.log('  fluxo mcp list [--workspace=<path>]');
  console.log('  fluxo mcp registry');
  console.log('');
  console.log('Aliases live in the official registry (see `registry`).');
  console.log('Files written to <workspace>/.fluxo/mcp_servers.json.');
}

function cmdRegistry(): number {
  const entries = listRegistry();
  console.log(`Official MCP registry (${entries.length} entries):\n`);
  for (const e of entries) {
    const star = e.starter ? ' ★' : '';
    const cats = e.categories.join(', ');
    console.log(`  ${e.alias}${star}`);
    console.log(`    ${e.description}`);
    console.log(`    categories: ${cats}`);
    if (e.note) { console.log(`    note: ${e.note}`); }
    console.log('');
  }
  console.log('★ = included in the auto-generated starter pack.');
  return 0;
}

function cmdAdd(workspacePath: string, alias: string | undefined): number {
  if (!alias) {
    console.error('error: missing <alias>. Try `fluxo mcp registry` to see available servers.');
    return 1;
  }
  const entry = getRegistryEntry(alias);
  if (!entry) {
    console.error(`error: "${alias}" is not in the official registry. Run \`fluxo mcp registry\` for the full list.`);
    return 1;
  }
  const result = addServer(workspacePath, alias);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }
  if (result.reason) {
    console.log(result.reason);
  } else {
    console.log(`✅ Added "${result.alias}" to ${workspacePath}/.fluxo/mcp_servers.json`);
    if (entry.note) { console.log(`   note: ${entry.note}`); }
  }
  return 0;
}

function cmdRemove(workspacePath: string, alias: string | undefined): number {
  if (!alias) {
    console.error('error: missing <alias>.');
    return 1;
  }
  const result = removeServer(workspacePath, alias);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }
  console.log(result.reason ?? `✅ Removed "${alias}" from .fluxo/mcp_servers.json`);
  return 0;
}

function cmdList(workspacePath: string): number {
  const configured = listConfigured(workspacePath);
  const aliases = Object.keys(configured).sort();
  if (aliases.length === 0) {
    console.log('No MCP servers configured. Run `fluxo mcp add <alias>` to add one.');
    return 0;
  }
  console.log(`Configured MCP servers (${aliases.length}):\n`);
  for (const alias of aliases) {
    const cfg = configured[alias];
    console.log(`  ${alias}`);
    console.log(`    command: ${cfg.command} ${(cfg.args ?? []).join(' ')}`);
    if (cfg.categories) { console.log(`    categories: ${cfg.categories.join(', ')}`); }
  }
  return 0;
}

export function runCli(argv: string[]): number {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage();
    return 0;
  }
  const sub = args[0];
  const wsPath = resolveWorkspace(args);
  const positional = args.slice(1).filter(a => !a.startsWith('--'));

  switch (sub) {
    case 'add':      return cmdAdd(wsPath, positional[0]);
    case 'remove':
    case 'rm':       return cmdRemove(wsPath, positional[0]);
    case 'list':
    case 'ls':       return cmdList(wsPath);
    case 'registry': return cmdRegistry();
    default:
      console.error(`error: unknown subcommand "${sub}"`);
      printUsage();
      return 1;
  }
}

// Only execute when invoked directly (not when imported by extension.ts).
if (require.main === module) {
  process.exit(runCli(process.argv));
}

```

### 📁 FILE: `src\extension.ts`
```typescript
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import { runAgentLoop, ChatMessage, EngineConfig, summarizeHistory } from './agentEngine';
import { routeToAgent, getAgentList } from './agents';
import { Sentinel } from './sentinel';
import { McpSwarmClient } from './services/mcp/client';
import { listRegistry } from './utils/mcpRegistry';
import { addServer, removeServer, listConfigured } from './utils/mcpConfigWriter';
import { rollbackToLastCheckpoint } from './utils/gitSafety';
import { cleanupOrphanedWorktrees } from './utils/cleanupRegistry';

// ─── State Management ─────────────────────────────────────────────────────────

let _panel: vscode.WebviewPanel | undefined;
let _conversationHistory: ChatMessage[] = [];
let _currentAbortController: AbortController | undefined;
let _extensionUri: vscode.Uri;
let _context: vscode.ExtensionContext;
let _sentinel: Sentinel | undefined;
let _sentinelHasError = false;
let _mcpClient: McpSwarmClient;
// Worktree Human Review (v8.3.0) — resolved when the user clicks Approve/Discard in the webview
let _pendingWorktreeReview: ((action: 'merge' | 'discard') => void) | undefined;

const STORAGE_KEY = 'fluxo.chatHistory';
const LOG_FILE = 'fluxo_errors.log';

// ─── Sidebar Provider (Left Launcher) ─────────────────────────────────────────

class FluxoSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'fluxo.sidebar';

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <style>
          body { padding: 10px; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; font-family: sans-serif; gap: 15px; text-align: center; color: var(--vscode-foreground); }
          .launch-btn { background: #3b82f6; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-weight: bold; width: 100%; transition: opacity 0.2s; }
          .launch-btn:hover { opacity: 0.9; }
          .hint { font-size: 11px; opacity: 0.7; }
        </style>
      </head>
      <body>
        <div style="font-size: 24px;">🐾</div>
        <div style="font-weight: bold;">Fluxo AI</div>
        <button class="launch-btn" id="launch">Open Chat Panel</button>
        <div class="hint">Shortcut: Ctrl+Alt+C</div>
        <script>
          const vscode = acquireVsCodeApi();
          document.getElementById('launch').addEventListener('click', () => {
            vscode.postMessage({ type: 'launchMain' });
          });
          // Auto-launch if clicked
          setTimeout(() => { vscode.postMessage({ type: 'launchMain' }); }, 100);
        </script>
      </body>
      </html>
    `;

    webviewView.webview.onDidReceiveMessage(data => {
      if (data.type === 'launchMain') {
        vscode.commands.executeCommand('fluxo.openPanel');
      }
    });
  }
}

// ─── Logging Utility ──────────────────────────────────────────────────────────

function logError(message: string, details?: any) {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    console.warn('[logError] Skipped — no workspace folder open');
    return;
  }
  const workspaceFsPath = folders[0].uri.fsPath;
  if (!path.isAbsolute(workspaceFsPath)) {
    console.error('[logError] Unexpected: fsPath is not absolute:', JSON.stringify(workspaceFsPath));
    return;
  }
  const logPath = path.join(workspaceFsPath, LOG_FILE);
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ERROR: ${message}\n${details ? JSON.stringify(details, null, 2) + '\n' : ''}----------------------------------------\n`;
  try {
    const MAX_LOG_SIZE = 2 * 1024 * 1024;
    try {
      if (fs.statSync(logPath).size > MAX_LOG_SIZE) {
        fs.renameSync(logPath, path.join(workspaceFsPath, 'fluxo_errors_old.log'));
      }
    } catch { /* log file doesn't exist yet */ }
    fs.appendFileSync(logPath, logEntry, 'utf-8');
  } catch (err: any) {
    console.error('[logError] Failed to write to', LOG_FILE, '— path:', logPath, '— error:', err?.stack ?? err);
  }
}

// ─── Session Cleanup ──────────────────────────────────────────────────────────

// ── v8.32.0: Auto-Gitignore for *.log ────────────────────────────────────────
// Worktree merges (exit_worktree) repeatedly conflicted because Fluxo's debug
// logs were tracked. We append `*.log` to the workspace .gitignore (creating
// the file if missing, idempotent if the line already exists) and then run
// `git rm --cached *.log -q` to evict any logs already in the index. Both
// steps wrapped in try/catch — non-fatal if the workspace isn't a git repo,
// has no logs, or the user has a custom ignore strategy.
function ensureGitignoreLogs(wsPath: string): void {
  try {
    const gitignorePath = path.join(wsPath, '.gitignore');
    let needsAppend = true;
    if (fs.existsSync(gitignorePath)) {
      const contents = fs.readFileSync(gitignorePath, 'utf-8');
      const hasLogPattern = contents
        .split(/\r?\n/)
        .some(line => line.trim() === '*.log');
      if (hasLogPattern) { needsAppend = false; }
    }
    if (needsAppend) {
      const prefix = fs.existsSync(gitignorePath) ? '\n' : '';
      fs.appendFileSync(gitignorePath, `${prefix}*.log\n`, 'utf-8');
      console.log('[Fluxo Sanitizer] Appended *.log to .gitignore');
    }
  } catch (err: any) {
    console.error('[Fluxo Sanitizer] .gitignore update failed:', err?.message ?? err);
  }

  try {
    cp.execSync('git rm --cached *.log -q', {
      cwd: wsPath,
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch { /* expected when no logs are tracked or not a git repo */ }
}
// ─────────────────────────────────────────────────────────────────────────────

function cleanupLogsOnActivation(): void {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) { return; }
  const wsPath = folders[0].uri.fsPath;

  // v8.32.0 — Sanitize git environment: ensure *.log is gitignored and uncached
  ensureGitignoreLogs(wsPath);

  // Prune .fluxo/backups/ — keep only the 30 most recent files, delete the rest
  const backupDir = path.join(wsPath, '.fluxo', 'backups');
  try {
    if (fs.existsSync(backupDir)) {
      const files = fs.readdirSync(backupDir)
        .map(f => ({ name: f, mtime: fs.statSync(path.join(backupDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      files.slice(30).forEach(f => {
        try { fs.unlinkSync(path.join(backupDir, f.name)); } catch { /* skip locked files */ }
      });
    }
  } catch { /* non-fatal */ }

  // ── v8.27.0 — Orphaned-Worktree Auto-Cleanup (Phase 3.3) ──────────────────
  // Background janitor sweeps any .fluxo/worktrees/<branch> directory whose
  // branch is not the currently-active one (per .fluxo/active_worktree.json).
  // Idempotent + silent — zero orphans ⇒ no-op. Failures inside the helper
  // are isolated per-orphan so a single stuck worktree never blocks the rest.
  // Wrapped in try/catch here so even a catastrophic exception in the helper
  // never blocks extension activation (the entire cleanup pass is best-effort).
  try {
    const destroyed = cleanupOrphanedWorktrees(wsPath);
    if (destroyed.length > 0) {
      console.log(`[Fluxo Cleanup] Destroyed ${destroyed.length} orphan worktree(s): ${destroyed.join(', ')}`);
    }
  } catch (err: any) {
    console.error('[Fluxo Cleanup] Orphan-worktree sweep failed:', err?.message ?? err);
  }
}

// ─── Panel Manager ────────────────────────────────────────────────────────────

function getOrCreatePanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  if (_panel) {
    _panel.reveal(vscode.ViewColumn.Beside, true);
    return _panel;
  }

  _panel = vscode.window.createWebviewPanel(
    'fluxo.chatPanel',
    '🐾 Fluxo AI',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(_extensionUri, 'media')],
    }
  );

  _panel.iconPath = vscode.Uri.joinPath(_extensionUri, 'media', 'sidebar-icon.svg');
  _panel.webview.html = _buildHtml(_panel.webview);

  _panel.webview.onDidReceiveMessage(async (msg) => {
    await _handleMessage(msg, context);
  });

  _panel.onDidDispose(() => {
    _panel = undefined;
    _currentAbortController?.abort();
    _currentAbortController = undefined;
  });

  return _panel;
}

// ─── Message Handler ──────────────────────────────────────────────────────────

async function _handleMessage(msg: any, context: vscode.ExtensionContext): Promise<void> {
  switch (msg.type) {
    case 'ready': {
      const cfg = await _buildConfig();
      const models = await _buildModelList();
      _postToPanel({
        type: 'config',
        model: cfg.model,
        workerModel: cfg.workerModel,
        models,
        hasApiKey: !!cfg.apiKey,
        agents: getAgentList(),
        history: _conversationHistory
      });
      _sendWorkspaceInfo();
      _postToPanel({ type: 'sentinelStatus', active: _sentinel?.isActive ?? false });
      break;
    }

    case 'sendMessage':
      if (msg.text && (msg.model || msg.managerModel)) {
        const txt = msg.text.trim().toLowerCase();
        if (txt === '/new' || txt === '/clear') {
          _conversationHistory = [];
          context.workspaceState.update(STORAGE_KEY, []);
          _postToPanel({ type: 'chatCleared' });
          break;
        }
        _handleSendMessage(msg.text, msg.managerModel || msg.model, msg.workerModel, context).catch(e => {
            console.error('Send message error:', e);
        });
      }
      break;

    case 'clearChat':
      _conversationHistory = [];
      context.workspaceState.update(STORAGE_KEY, []);
      _postToPanel({ type: 'chatCleared' });
      break;

    case 'compressHistory':
      await _handleCompression(context);
      break;

    case 'cancelStream':
      _currentAbortController?.abort();
      _currentAbortController = undefined;
      _postToPanel({ type: 'streamCancelled' });
      break;

    case 'copyCode':
      if (msg.code) {
        await vscode.env.clipboard.writeText(msg.code);
        vscode.window.showInformationMessage('✓ Copied to clipboard');
      }
      break;

    case 'insertCode':
      if (msg.code) {
        const editor = vscode.window.activeTextEditor;
        if (editor) { editor.edit(eb => eb.replace(editor.selection, msg.code)); }
      }
      break;

    case 'openFile':
    case 'open_file': {
      if (msg.path) {
        const folders = vscode.workspace.workspaceFolders;
        if (folders?.length) {
          const fullPath = path.isAbsolute(msg.path)
            ? msg.path
            : path.join(folders[0].uri.fsPath, msg.path);
          try {
            const doc = await vscode.workspace.openTextDocument(fullPath);
            await vscode.window.showTextDocument(doc);
          } catch {
            vscode.window.showWarningMessage(`Could not open: ${msg.path}`);
          }
        }
      }
      break;
    }

    case 'open_git_diff': {
      if (msg.path) {
        const folders = vscode.workspace.workspaceFolders;
        if (folders?.length) {
          const fullPath = path.isAbsolute(msg.path)
            ? msg.path
            : path.join(folders[0].uri.fsPath, msg.path);
          const fileUri = vscode.Uri.file(fullPath);
          try {
            // Opens VS Code's native Source Control diff view (Working Tree vs HEAD)
            await vscode.commands.executeCommand('git.openChange', fileUri);
          } catch {
            // Fallback: open the file in the editor if the Git extension is unavailable
            try {
              const doc = await vscode.workspace.openTextDocument(fileUri);
              await vscode.window.showTextDocument(doc);
            } catch {
              vscode.window.showWarningMessage(`Could not open git diff for: ${msg.path}`);
            }
          }
        }
      }
      break;
    }

    // ── Worktree Native Diff (v8.3.0) ────────────────────────────────────────
    case 'open_worktree_diff': {
      // Opens VS Code's native side-by-side diff: main workspace file vs worktree file.
      const folders = vscode.workspace.workspaceFolders;
      if (msg.filePath && folders?.length) {
        const wsPath = folders[0].uri.fsPath;
        const stateFile = path.join(wsPath, '.fluxo', 'active_worktree.json');
        try {
          const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
          const originalUri = vscode.Uri.file(path.join(wsPath, msg.filePath));
          const worktreeUri = vscode.Uri.file(path.join(state.worktreePath, msg.filePath));
          await vscode.commands.executeCommand(
            'vscode.diff',
            originalUri,
            worktreeUri,
            `Diff: ${msg.filePath} — Original vs Cambios de Fluxo`
          );
        } catch (e: any) {
          vscode.window.showWarningMessage(`No se pudo abrir el diff: ${e.message}`);
        }
      }
      break;
    }

    case 'worktree_decision': {
      // User clicked Approve or Discard in the worktree review card
      if (_pendingWorktreeReview) {
        _pendingWorktreeReview(msg.action === 'discard' ? 'discard' : 'merge');
        _pendingWorktreeReview = undefined;
      }
      break;
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Restore Workspace Only — North Star v8.25.0 ──────────────────────────
    // Atomic rollback to the last fluxo-auto-checkpoint via the existing
    // gitSafety.rollbackToLastCheckpoint helper (runs `git reset --hard
    // HEAD~1`). The Smart Auto-Commit flow from v8.16.7 means any human WIP
    // edits made before the agent's checkpoint are preserved as their own
    // commit and survive the rollback — only the agent's anchor + everything
    // layered on top gets discarded. We still gate the call behind a modal
    // confirmation because reset --hard is irreversible from the UI; the
    // dialog is intentionally explicit about which checkpoint is being
    // dropped so a user cannot click through it absent-mindedly.
    case 'restoreWorkspace': {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders?.length) {
        vscode.window.showWarningMessage('Restore Workspace: no hay un workspace activo.');
        break;
      }
      const wsPath = folders[0].uri.fsPath;
      const choice = await vscode.window.showWarningMessage(
        '⟲ Restore Workspace Only\n\n' +
        'Vas a revertir TODO lo que el agente cambió desde el último checkpoint ' +
        '(git reset --hard HEAD~1). Cualquier edición manual previa al checkpoint ' +
        'fue auto-guardada como WIP commit y SE PRESERVA. Esta acción no se puede ' +
        'deshacer desde la UI.\n\n¿Continuar?',
        { modal: true },
        'Restaurar',
      );
      if (choice !== 'Restaurar') {
        _postToPanel({ type: 'restoreResult', success: false, output: 'Restauración cancelada por el usuario.' });
        break;
      }
      const result = rollbackToLastCheckpoint(wsPath);
      _postToPanel({ type: 'restoreResult', success: result.success, output: result.output });
      if (result.success) {
        vscode.window.showInformationMessage('✓ Workspace restaurado al último checkpoint.');
      } else {
        vscode.window.showErrorMessage(`Restore falló: ${result.output}`);
      }
      break;
    }
    // ─────────────────────────────────────────────────────────────────────────

    case 'saveModel':
      if (msg.managerModel) { context.globalState.update('fluxo.selectedModel', msg.managerModel); }
      if (msg.workerModel !== undefined) { context.globalState.update('fluxo.workerModel', msg.workerModel || ''); }
      break;

    case 'openSettings':
      vscode.commands.executeCommand('workbench.action.openSettings', 'fluxo');
      break;

    case 'showStreamingInfo':
      vscode.window.showInformationMessage(
        '🌊 Streaming: las respuestas aparecen gradualmente mientras el modelo genera, en lugar de esperar la respuesta completa. Si ves respuestas cortadas, desactívalo en Ajustes → Fluxo AI → Streaming Enabled.'
      );
      break;

    case 'sentinelToggle': {
      const isNowActive = _sentinel?.toggle() ?? false;
      _context.globalState.update('fluxo.sentinelActive', isNowActive);
      _postToPanel({ type: 'sentinelStatus', active: isNowActive });
      vscode.window.showInformationMessage(
        isNowActive ? '🟢 Sentinel activated — monitoring terminal' : '⚫ Sentinel deactivated'
      );
      break;
    }
  }
}

// ─── Core: Engine Integration ───────────────────────────────────────────────

async function _handleSendMessage(userText: string, model: string, workerModel: string | undefined, context: vscode.ExtensionContext): Promise<void> {
  const config = await _buildConfig();
  config.model = model;
  if (workerModel) { config.workerModel = workerModel; }

  const isDeepseek = model.startsWith('deepseek/') || (!model.includes('/') && model.startsWith('deepseek-'));
  const effectiveKey = isDeepseek
    ? (config.deepseekApiKey || config.apiKey)
    : model.startsWith('gemini-')
    ? (config.geminiApiKey || config.apiKey)
    : config.apiKey;
  if (!effectiveKey) {
    const keyName = isDeepseek ? 'DEEPSEEK_API_KEY'
      : model.startsWith('gemini-') ? 'GEMINI_API_KEY'
      : 'OPENROUTER_API_KEY';
    _postToPanel({ type: 'error', text: `⚠️ No API key for ${model}. Set ${keyName} in Settings → Fluxo AI or .env file.` });
    return;
  }

  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const agentId = routeToAgent(userText);

  _currentAbortController?.abort();
  _currentAbortController = new AbortController();

  _postToPanel({ type: 'streamStart' });

  try {
    const engineConfig: EngineConfig = {
      apiKey: config.apiKey,
      model: config.model,
      workerModel: config.workerModel,
      maxTokens: config.maxTokens,
      streamingEnabled: config.streamingEnabled,
      deepseekApiKey: config.deepseekApiKey,
      geminiApiKey: config.geminiApiKey,
    };

    let fullAssistantText = '';

    const approvalCallback = async (summary: string, details: string): Promise<boolean> => {
      const answer = await vscode.window.showInformationMessage(
        `🛡️ Fluxo Bodyguard — Permiso Requerido\n\nIntención: ${summary}\n\nDetalles: ${details}`,
        { modal: true },
        '✅ Approve',
        '❌ Reject'
      );
      return answer === '✅ Approve';
    };

    // v8.33.0 — Discovery Mode (planner-only). The engine reroutes the
    // planner's ask_user_approval calls to this callback. We surface the
    // questions in a showInputBox so the user TYPES their answers; the engine
    // then injects those answers verbatim into the planner's tool result and
    // the planner ships the plan informed by them in the same sub-loop.
    const discoveryAnswerCallback = async (questions: string): Promise<string | null> => {
      const answer = await vscode.window.showInputBox({
        title: '🔎 Fluxo Discovery — el @planner necesita clarificación',
        prompt: questions,
        placeHolder: 'Escribe tus respuestas aquí (una línea por pregunta o todo junto — el planner las lee verbatim)',
        ignoreFocusOut: true,
      });
      return answer ?? null;
    };

    const nativeEditCallback = async (relPath: string, searchSnippet: string, replaceSnippet: string) =>
      applyNativeEdit(relPath, searchSnippet, replaceSnippet, workspacePath);

    const getCodeStructureCallback = async (absolutePath: string): Promise<{ success: boolean; output: string }> => {
      try {
        // ── Robust Path Sanitization (v7.14.0) ──────────────────────────────
        // Handles ALL known LLM path hallucinations:
        //   1. Docker-bias:   /workspace/src/file.tsx
        //   2. Overlap:       /workspace/d:\real\path\file.tsx  (Docker prefix + Windows absolute)
        //   3. Pure relative: src/file.tsx
        //   4. Pure absolute: d:\real\path\file.tsx (correct — no modification needed)
        let cleanPath = absolutePath;

        // Strip /workspace/ prefix (Docker-bias hallucination)
        if (cleanPath.startsWith('/workspace/'))     { cleanPath = cleanPath.substring(11); }
        else if (cleanPath.startsWith('workspace/')) { cleanPath = cleanPath.substring(10); }
        else if (cleanPath.startsWith('\\workspace\\')) { cleanPath = cleanPath.substring(11); }

        const driveIndex = cleanPath.search(/[a-zA-Z]:/);
        if (driveIndex > 0) {
          cleanPath = cleanPath.substring(driveIndex);
        }

        cleanPath = path.normalize(cleanPath);

        // Resolve to an absolute path inside the workspace
        let finalPath: string;
        const resolvedClean = path.resolve(cleanPath);
        const resolvedWs    = path.resolve(workspacePath);

        // Case-insensitive comparison on Windows (d: vs D:)
        if (resolvedClean.toLowerCase().startsWith(resolvedWs.toLowerCase())) {
          finalPath = resolvedClean;  // Already inside the workspace — use as-is
        } else if (path.isAbsolute(cleanPath)) {
          // Absolute path outside the workspace — reject to prevent LSP scope escape
          return {
            success: false,
            output: `PATH ERROR: "${absolutePath}" apunta fuera del workspace actual. ` +
              `Usa una ruta relativa al workspace (ej. "src/pages/MiArchivo.jsx") o llama list_dir(".") para descubrir la estructura real.`,
          };
        } else {
          finalPath = path.join(workspacePath, cleanPath);
        }

        const uri = vscode.Uri.file(finalPath);
        await vscode.workspace.openTextDocument(uri);

        // Retry loop — TS/JS Language Server may not have finished parsing the AST yet.
        // Poll up to 4 times (2 s total) before giving up.
        const MAX_LSP_ATTEMPTS = 4;
        let symbols: vscode.DocumentSymbol[] | undefined;
        for (let attempt = 1; attempt <= MAX_LSP_ATTEMPTS; attempt++) {
          symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider',
            uri
          );
          if (symbols && symbols.length > 0) { break; }
          if (attempt < MAX_LSP_ATTEMPTS) {
            await new Promise<void>(r => setTimeout(r, 500));
          }
        }

        if (!symbols || symbols.length === 0) {
          return {
            success: false,
            output: 'LSP ERROR: El servidor de lenguaje no pudo extraer los símbolos a tiempo. Usa read_file como fallback.',
          };
        }

        function mapSymbols(syms: vscode.DocumentSymbol[]): object[] {
          return syms.map(s => {
            const entry: Record<string, unknown> = {
              name: s.name,
              kind: vscode.SymbolKind[s.kind],
              start: s.range.start.line + 1,
              end: s.range.end.line + 1,
            };
            if (s.children && s.children.length > 0) {
              entry.children = mapSymbols(s.children);
            }
            return entry;
          });
        }
        return { success: true, output: JSON.stringify(mapSymbols(symbols), null, 2) };
      } catch (err: any) {
        return { success: false, output: `get_code_structure error: ${err.message ?? String(err)}` };
      }
    };

    const mcpTools = _mcpClient.getMcpTools();
    const mcpToolCategories = _mcpClient.getMcpToolCategories();

    // ── LSP Symbol Replace callback (v8.5.0) ─────────────────────────────────
    // Uses VS Code's Language Server to locate a named AST symbol and replace it
    // atomically — no line numbers, no string matching, no brace counting.
    const replaceSymbolCallback = async (
      relPath: string,
      symbolName: string,
      newCode: string
    ): Promise<{ success: boolean; output: string }> => {
      try {
        const fullPath = path.isAbsolute(relPath) ? relPath : path.join(workspacePath, relPath);
        const uri = vscode.Uri.file(fullPath);

        const document = await vscode.workspace.openTextDocument(uri);

        // Retry loop — Language Server may still be indexing the file
        const MAX_ATTEMPTS = 4;
        let symbols: vscode.DocumentSymbol[] | undefined;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider', uri
          );
          if (symbols && symbols.length > 0) { break; }
          if (attempt < MAX_ATTEMPTS) {
            await new Promise<void>(r => setTimeout(r, 500));
          }
        }

        if (!symbols || symbols.length === 0) {
          return {
            success: false,
            output: `LSP ERROR: El servidor de lenguaje no pudo extraer los símbolos de ${relPath}. Verifica que el archivo tiene extensión .ts/.tsx/.js/.jsx y espera a que el Language Server termine de cargar. Usa replace_block como fallback.`,
          };
        }

        function findSymbol(syms: vscode.DocumentSymbol[], name: string): vscode.DocumentSymbol | undefined {
          for (const sym of syms) {
            if (sym.name === name) { return sym; }
            const found = findSymbol(sym.children, name);
            if (found) { return found; }
          }
          return undefined;
        }

        const target = findSymbol(symbols, symbolName);
        if (!target) {
          const available = symbols.slice(0, 8).map(s => `"${s.name}"`).join(', ');
          return {
            success: false,
            output: `Símbolo no encontrado por el LSP. Verifica el nombre exacto de la función/clase. Nombre buscado: "${symbolName}".\nSímbolos disponibles en el nivel raíz: ${available}.\nUsa get_code_structure para ver el árbol completo.`,
          };
        }

        // ── LSP Boundary Sanitizer (v8.5.1) ──────────────────────────────────
        // The LSP range for a symbol sometimes starts AFTER the keyword (const/let/async),
        // so when the LLM includes it in new_code the merge produces duplicates.
        // These regexes are order-sensitive: multi-word patterns before single-word ones.
        let sanitizedCode = newCode
          .replace(/\basync\s+async\b/g,  'async')
          .replace(/\bconst\s+const\b/g,  'const')
          .replace(/\blet\s+let\b/g,      'let')
          .replace(/\bvar\s+var\b/g,      'var')
          .replace(/;{2,}/g,              ';');
        // ─────────────────────────────────────────────────────────────────────

        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, target.range, sanitizedCode);
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
          return { success: false, output: `VS Code WorkspaceEdit failed for ${relPath}. The file may be read-only.` };
        }
        await document.save();

        const kind   = vscode.SymbolKind[target.kind];
        const lines  = target.range.end.line - target.range.start.line + 1;
        return {
          success: true,
          output: `replace_symbol: "${symbolName}" (${kind}) in ${relPath} — replaced ${lines} line(s) at L${target.range.start.line + 1}–L${target.range.end.line + 1}.\n\nEDICIÓN EXITOSA — Símbolo reemplazado vía LSP. Verifica el resultado y continúa con tu siguiente herramienta.`,
        };
      } catch (err: any) {
        return { success: false, output: `replace_symbol error: ${err.message ?? String(err)}` };
      }
    };
    // ─────────────────────────────────────────────────────────────────────────

    // ── Worktree Human Review callback (v8.3.0) ──────────────────────────────
    // Called by the engine just before executing exit_worktree(action='merge').
    // Gets changed files from git, posts the review card to the webview, and
    // suspends the agent loop until the user clicks Approve or Discard.
    const worktreeReviewCallback = async (branch: string, worktreePath: string): Promise<'merge' | 'discard'> => {
      let changedFiles: string[] = [];
      try {
        // git status --porcelain captures both tracked modifications (M, A, D, R)
        // AND untracked new files (??) — git diff --name-only HEAD missed the latter.
        const output = cp.execSync('git status --porcelain', {
          cwd: worktreePath, encoding: 'utf-8', stdio: 'pipe',
        });
        changedFiles = output
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(line => {
            // porcelain format: "XY filepath" (2-char status + space + path)
            const filePart = line.slice(3).trim();
            // Renames are "old -> new" — take only the new name
            const arrowIdx = filePart.indexOf(' -> ');
            return arrowIdx !== -1 ? filePart.slice(arrowIdx + 4) : filePart;
          })
          .filter(Boolean);
      } catch { /* git unavailable or worktree path invalid — proceed without file list */ }

      _postToPanel({ type: 'worktreeReview', branch, worktreePath, changedFiles });

      return new Promise<'merge' | 'discard'>(resolve => {
        _pendingWorktreeReview = resolve;
      });
    };
    // ─────────────────────────────────────────────────────────────────────────

    // ── HITL — Human-in-the-Loop for run_command (v8.10.0) ───────────────────────
    // Presents a modal VSCode dialog before any non-whitelisted shell command executes.
    // The Promise resolves only after the user clicks Permitir or Rechazar.
    const hitlCommandCallback = async (command: string): Promise<boolean> => {
      const choice = await vscode.window.showWarningMessage(
        `⚠️ El agente quiere ejecutar un comando de shell:\n\n${command}`,
        { modal: true },
        'Permitir',
        'Rechazar'
      );
      return choice === 'Permitir';
    };
    // ─────────────────────────────────────────────────────────────────────────────

    // ── LSP Passive Feedback Callback (v8.23.0) ─────────────────────────────────
    // Polls vscode.languages.getDiagnostics for the recently-edited files BEFORE
    // the engine runs npm run build. The TS/JSX language server is already
    // running and indexing every open document; querying its diagnostics is
    // effectively free compared to a compiler invocation. Returns one
    // human-readable line per diagnostic (file:line: message) suitable for
    // injecting straight into the agent's message stream. Errors and warnings
    // both flow through — the agent treats them uniformly. Filtered down to
    // Error and Warning severity to silence Information/Hint chatter (LSPs
    // emit a lot of "consider extracting this" hints that are not actionable
    // pre-build).
    //
    // Behavior contract (matches the engine's expectations):
    //   • Returns [] (not throws) when no diagnostics — the engine treats this
    //     as "nothing to surface, proceed to Quality Gate".
    //   • Resolves bare repo-relative paths against the workspace, just like
    //     the get_code_structure callback does.
    //   • Each path is opened (so the LSP indexes it if it wasn't already)
    //     and given a short settle window — TS server can take ~300ms to
    //     update diagnostics on a freshly-edited file. Total budget capped at
    //     ~1.2s across all files so we do not block the gate noticeably.
    const getDiagnosticsCallback = async (relPaths: string[]): Promise<string[]> => {
      if (!Array.isArray(relPaths) || relPaths.length === 0) { return []; }
      const out: string[] = [];
      const settleMs = 300;
      try {
        for (const rel of relPaths.slice(0, 5)) {
          if (typeof rel !== 'string' || !rel.trim()) { continue; }
          let cleanPath = rel.trim();
          // Strip /workspace/ Docker-bias and worktree-prefix hallucinations
          // mirror the same heuristics get_code_structure uses.
          if (cleanPath.startsWith('/workspace/'))      { cleanPath = cleanPath.substring(11); }
          else if (cleanPath.startsWith('workspace/'))  { cleanPath = cleanPath.substring(10); }
          else if (cleanPath.startsWith('\\workspace\\')) { cleanPath = cleanPath.substring(11); }
          const finalPath = path.isAbsolute(cleanPath) ? cleanPath : path.join(workspacePath, cleanPath);
          if (!fs.existsSync(finalPath)) { continue; }
          const uri = vscode.Uri.file(finalPath);
          try {
            await vscode.workspace.openTextDocument(uri);
            await new Promise<void>(r => setTimeout(r, settleMs));
          } catch { /* continue with whatever diagnostics already exist */ }
          const diags = vscode.languages.getDiagnostics(uri);
          for (const d of diags) {
            if (d.severity !== vscode.DiagnosticSeverity.Error && d.severity !== vscode.DiagnosticSeverity.Warning) {
              continue;
            }
            const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
            const line = d.range.start.line + 1;
            const msg = (d.message || '').replace(/\s+/g, ' ').trim().slice(0, 240);
            out.push(`${cleanPath}:${line} [${sev}] ${msg}`);
            if (out.length >= 10) { break; }
          }
          if (out.length >= 10) { break; }
        }
      } catch (err: any) {
        // Defensive: never throw — engine treats absence/empty as "no LSP".
        console.error('[Fluxo LSP Passive] callback error:', err);
        return [];
      }
      return out;
    };
    // ─────────────────────────────────────────────────────────────────────────────

    for await (const event of runAgentLoop(
      userText,
      agentId,
      _conversationHistory,
      engineConfig,
      workspacePath,
      _currentAbortController.signal,
      _sentinelHasError,
      approvalCallback,
      nativeEditCallback,
      getCodeStructureCallback,
      mcpTools,
      async (name, args) => await _mcpClient.callMcpTool(name, args),
      worktreeReviewCallback,
      replaceSymbolCallback,
      hitlCommandCallback,
      mcpToolCategories,
      getDiagnosticsCallback,
      // v8.26.0 — Phase 3.4 MCP resource discovery. The McpSwarmClient owns
      // the live stdio transports, so the engine routes list_mcp_resources
      // calls back here to reach them.
      async (serverName: string) => await _mcpClient.listResources(serverName),
      // v8.33.0 — Discovery Mode (planner-only). Forwarded by the engine to
      // the planner sub-loop so the @planner can collect text answers from
      // the user via showInputBox during clarifying questions.
      discoveryAnswerCallback
    )) {
      _postToPanel({ ...event });
      if (event.type === 'streamChunk') { fullAssistantText += event.text; }
      if (event.type === 'toolResult' && !event.success) {
        logError(`Tool [${event.name}] failed`, { output: event.output.slice(0, 500), model: config.model });
      }
      if (event.type === 'error') {
        logError(event.message, { model: config.model, userText });
        break;
      }
    }

    // Clear Sentinel error flag — agent has completed its fix attempt
    _sentinelHasError = false;

    // Update & Persist History
    _conversationHistory.push({ role: 'user', content: userText });
    _conversationHistory.push({ role: 'assistant', content: fullAssistantText || '[Task processed]' });
    
    // Keep reasonable history size for stability
    if (_conversationHistory.length > 50) { _conversationHistory = _conversationHistory.slice(-50); }
    context.workspaceState.update(STORAGE_KEY, _conversationHistory);

  } catch (err: any) {
    if (err.name !== 'AbortError') {
      logError(err.message, { stack: err.stack });
      _postToPanel({ type: 'error', text: `❌ ${err.message}` });
    }
  }

  _currentAbortController = undefined;
}

async function _handleCompression(context: vscode.ExtensionContext): Promise<void> {
  const config = await _buildConfig();

  // Resolve the effective key for the currently selected model —
  // mirrors resolveEndpointAndKey() logic in agentEngine.ts.
  const isDeepseekDirect = !config.model.includes('/') && config.model.startsWith('deepseek-');
  const isGeminiDirect   = !config.model.includes('/') && config.model.startsWith('gemini-');
  const effectiveKey = isDeepseekDirect ? (config.deepseekApiKey || config.apiKey)
    : isGeminiDirect   ? (config.geminiApiKey  || config.apiKey)
    : config.apiKey;

  if (!effectiveKey) {
    // Always notify the webview so the token-wheel spinner stops.
    _postToPanel({ type: 'error', text: '⚠️ No API key configured for the current model. Check Settings → Fluxo AI.' });
    vscode.window.showErrorMessage('API Key missing for the current model. Configure it in Settings → Fluxo AI.');
    return;
  }

  if (_conversationHistory.length < 2) {
    _postToPanel({ type: 'error', text: '⚠️ Not enough history to compress yet (minimum 2 messages).' });
    return;
  }

  _postToPanel({ type: 'thinking', text: 'Compressing context…' });

  try {
    // Pass the FULL config so resolveEndpointAndKey() picks the right provider.
    const summary = await summarizeHistory(_conversationHistory, {
      apiKey:          config.apiKey,
      deepseekApiKey:  config.deepseekApiKey,
      geminiApiKey:    config.geminiApiKey,
      model:           config.model,
      maxTokens:       1024,
      streamingEnabled: false,
    });

    if (!summary) {
      throw new Error('Received empty summary from AI');
    }

    _conversationHistory = [
      { role: 'assistant', content: `🔄 **Context Compressed**. Previous conversation summary:\n\n${summary}` }
    ];
    context.workspaceState.update(STORAGE_KEY, _conversationHistory);

    _postToPanel({ type: 'chatCleared' });
    _postToPanel({ type: 'historySync', history: _conversationHistory });
    vscode.window.showInformationMessage('✓ Context compressed successfully.');
  } catch (err: any) {
    logError('Compression failed', err);
    _postToPanel({ type: 'error', text: `❌ Compression failed: ${err.message}` });
    vscode.window.showErrorMessage(`Failed to compress history: ${err.message}`);
  }
}

// ─── Model List Builder ───────────────────────────────────────────────────────

async function _buildModelList(): Promise<string[]> {
  const config = await _buildConfig();
  const baseModels = vscode.workspace.getConfiguration('fluxo').get<string[]>('customModels') || [
    "google/gemini-2.5-flash", "google/gemini-2.5-flash-lite", "google/gemini-2.5-pro",
    "deepseek/deepseek-v3.2", "anthropic/claude-3.7-sonnet", "anthropic/claude-3.5-haiku", "openai/gpt-4o"
  ];

  const models = [...baseModels];

  if (config.geminiApiKey) {
    ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"].forEach(m => {
      if (!models.includes(m)) { models.push(m); }
    });
  }

  if (config.deepseekApiKey) {
    // Bare names (no slash) → routed to api.deepseek.com directly by agentEngine
    ["deepseek-chat", "deepseek-reasoner"].forEach(m => {
      if (!models.includes(m)) { models.push(m); }
    });
  }

  return models;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _postToPanel(payload: Record<string, unknown>): void {
  _panel?.webview.postMessage(payload);
}

function _sendWorkspaceInfo(): void {
  const folders = vscode.workspace.workspaceFolders;
  const editor = vscode.window.activeTextEditor;
  _postToPanel({
    type: 'workspaceInfo',
    workspaceName: folders?.[0]?.name ?? null,
    workspacePath: folders?.[0]?.uri.fsPath ?? null,
    fileName: editor ? path.basename(editor.document.fileName) : null,
    language: editor?.document.languageId ?? null,
    hasWorkspace: !!folders?.length,
  });
}

async function _buildConfig(): Promise<{
  apiKey: string; model: string; workerModel?: string; maxTokens: number; streamingEnabled: boolean;
  deepseekApiKey?: string; geminiApiKey?: string;
}> {
  const vscodeConfig = vscode.workspace.getConfiguration('fluxo');
  let apiKey = vscodeConfig.get<string>('openrouterApiKey') || '';
  let deepseekApiKey = vscodeConfig.get<string>('deepseekApiKey') || '';
  let geminiApiKey = vscodeConfig.get<string>('geminiApiKey') || '';

  if (!apiKey || !deepseekApiKey || !geminiApiKey) {
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length) {
      const envPath = path.join(folders[0].uri.fsPath, '.env');
      try {
        if (fs.existsSync(envPath)) {
          const envContent = fs.readFileSync(envPath, 'utf-8');
          if (!apiKey) {
            const m = envContent.match(/OPENROUTER_API_KEY\s*=\s*(.+)/);
            if (m) { apiKey = m[1].trim(); }
          }
          if (!deepseekApiKey) {
            const m = envContent.match(/DEEPSEEK_API_KEY\s*=\s*(.+)/);
            if (m) { deepseekApiKey = m[1].trim(); }
          }
          if (!geminiApiKey) {
            const m = envContent.match(/GEMINI_API_KEY\s*=\s*(.+)/);
            if (m) { geminiApiKey = m[1].trim(); }
          }
        }
      } catch { /* ignore */ }
    }
  }
  const savedModel = _context?.globalState.get<string>('fluxo.selectedModel');
  const savedWorkerModel = _context?.globalState.get<string>('fluxo.workerModel');
  return {
    apiKey,
    deepseekApiKey: deepseekApiKey || undefined,
    geminiApiKey: geminiApiKey || undefined,
    model: savedModel || vscodeConfig.get<string>('defaultModel') || 'google/gemini-2.5-flash',
    workerModel: savedWorkerModel || undefined,
    maxTokens: vscodeConfig.get<number>('maxTokens') || 4096,
    streamingEnabled: vscodeConfig.get<boolean>('streamingEnabled') ?? true,
  };
}

// ─── Native Edit (Fase 8) ─────────────────────────────────────────────────────

function fuzzyFindOffsets(
  text: string,
  snippet: string
): { startIndex: number; length: number } | null {
  const norm = (s: string) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const normLine = (s: string) => s.trim().replace(/\s+/g, ' ');

  const content = norm(text);
  const snip    = norm(snippet);
  const fileLines = content.split('\n');
  const rawSnip   = snip.split('\n');

  let si = 0, ei = rawSnip.length - 1;
  while (si <= ei && rawSnip[si].trim() === '') { si++; }
  while (ei >= si && rawSnip[ei].trim() === '') { ei--; }
  const snippetLines = rawSnip.slice(si, ei + 1);
  if (snippetLines.length === 0) { return null; }

  const snipNorm = snippetLines.map(normLine);
  const n = snippetLines.length;
  const matches: number[] = [];

  outer: for (let i = 0; i <= fileLines.length - n; i++) {
    for (let j = 0; j < n; j++) {
      if (normLine(fileLines[i + j]) !== snipNorm[j]) { continue outer; }
    }
    matches.push(i);
  }
  if (matches.length !== 1) { return null; }

  const startLine = matches[0];
  const endLine   = matches[0] + n - 1;
  const startIndex = fileLines.slice(0, startLine).reduce((s, l) => s + l.length + 1, 0);
  const length     = fileLines.slice(startLine, endLine + 1)
    .reduce((s, l, i, arr) => s + l.length + (i < arr.length - 1 ? 1 : 0), 0);

  return { startIndex, length };
}

const MAX_DIFF_LINES = 25;
function buildNativeDiffBlock(search: string, replace: string): string {
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

async function applyNativeEdit(
  relPath: string,
  searchSnippet: string,
  replaceSnippet: string,
  workspacePath: string
): Promise<{ success: boolean; output: string }> {
  const fullPath = path.isAbsolute(relPath) ? relPath : path.join(workspacePath, relPath);
  const uri = vscode.Uri.file(fullPath);

  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(uri);
  } catch {
    return { success: false, output: `File not found: ${relPath}. Verify the path with list_dir.` };
  }

  const text = document.getText();

  let startIndex = text.indexOf(searchSnippet);
  let matchLength = searchSnippet.length;

  if (startIndex === -1) {
    const fuzzy = fuzzyFindOffsets(text, searchSnippet);
    if (!fuzzy) {
      return {
        success: false,
        output: `MATCH ERROR: search_snippet not found in ${relPath} — exact and fuzzy matches both failed.\n` +
                `Call read_file to get current content and re-copy the target block verbatim.`,
      };
    }
    startIndex  = fuzzy.startIndex;
    matchLength = fuzzy.length;
  }

  const startPos = document.positionAt(startIndex);
  const endPos   = document.positionAt(startIndex + matchLength);
  const range    = new vscode.Range(startPos, endPos);

  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, range, replaceSnippet);

  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    return { success: false, output: `VS Code WorkspaceEdit failed for ${relPath}. The file may be read-only.` };
  }

  await document.save();

  const diffBlock = buildNativeDiffBlock(searchSnippet, replaceSnippet);
  return {
    success: true,
    output: `${diffBlock}\n\n**${relPath}** — Cambio aplicado y guardado automáticamente. Continúa con tu siguiente paso.`,
  };
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function _buildHtml(webview: vscode.Webview): string {
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(_extensionUri, 'media', 'style.css'));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(_extensionUri, 'media', 'main.js'));
  const nonce = getNonce();

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https:; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource} https: data:;">
  <link href="${styleUri}" rel="stylesheet">
  <title>Fluxo AI</title>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <!-- Token Wheel Container -->
      <div id="token-wheel-container" class="token-wheel-container" title="Context usage. Click to compress.">
        <svg class="token-wheel" viewBox="0 0 36 36">
          <path class="wheel-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
          <path id="wheel-progress" class="wheel-progress" stroke-dasharray="0, 100" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
        </svg>
        <div class="logo-dot"></div>
      </div>
      <span class="header-title">Fluxo AI</span>
      <span id="agent-badge" class="agent-badge hidden"></span>
    </div>
    <div class="header-right">
      <div class="brain-selectors">
        <span class="brain-label" title="Manager Model — @manager y Sherlock Auditor">🧭</span>
        <select id="manager-model-select" class="model-select" title="Manager Model"></select>
        <span class="brain-sep">|</span>
        <span class="brain-label" title="Worker Model — @coder, @designer y demás agentes">💻</span>
        <select id="worker-model-select" class="model-select" title="Worker Model"></select>
      </div>
      <button id="sentinel-btn" class="header-btn sentinel-btn" title="Sentinel Guard — Protege contra comandos peligrosos. Click para activar/desactivar."><span class="sentinel-icon">👁</span><span class="sentinel-label">Guard</span></button>
      <button id="restore-btn" class="header-btn restore-btn" title="Restore Workspace Only — Revierte el último checkpoint del agente (git reset --hard HEAD~1). Tu trabajo manual quedó guardado como WIP commit por v8.16.7.">⟲</button>
      <button id="streaming-info-btn" class="header-btn" title="Streaming: Renderizado de texto en tiempo real. Las respuestas aparecen gradualmente mientras el modelo genera.">ⓘ</button>
      <button id="settings-btn" class="header-btn" title="Settings">⚙</button>
    </div>
  </div>
  <div id="api-key-warning" class="api-warning hidden">⚠️ <em>API Key missing. Click the gear icon to configure.</em></div>
  <div class="agent-bar" id="agent-bar">
    <div class="agent-pills" id="agent-pills"></div>
  </div>
  <div id="context-bar" class="context-bar hidden">
    <span class="context-bar-label">Editando:</span>
    <span id="context-bar-file" class="context-bar-file"></span>
    <span class="context-bar-action" id="context-bar-action"></span>
  </div>
  <div id="status-bar" class="status-bar hidden">
    <div class="status-spinner" id="status-spinner"><span></span><span></span><span></span></div>
    <span id="status-text"></span>
  </div>
  <div id="chat-container" class="chat-container">
    <div id="messages" class="messages"></div>
  </div>
  <div class="input-area">
    <div class="input-wrapper">
      <textarea id="prompt-input" class="prompt-input" placeholder="Ask anything..." rows="1"></textarea>
      <div class="input-actions">
        <span id="char-count" class="char-count"></span>
        <button id="cancel-btn" class="action-btn cancel-btn hidden">⏹</button>
        <button id="send-btn" class="action-btn send-btn">➤</button>
      </div>
    </div>
    <div class="input-footer">
      <span id="workspace-label" class="workspace-label"></span>
      <a class="powered-by" href="https://fluxotechai.com" target="_blank">⚡ Powered by Fluxo Tech AI</a>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

// ─── Zero Footprint: Auto-Gitignore (v8.4.0) ─────────────────────────────────
// Silently patches .gitignore on every activation to keep .fluxo/ out of the
// user's repository. Safe to call repeatedly — exits early if already present.

function ensureGitignore(workspacePath: string): void {
  const gitignorePath = path.join(workspacePath, '.gitignore');
  const entry = '.fluxo/';
  try {
    let content = '';
    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, 'utf-8');
      const lines = content.split('\n').map(l => l.trim());
      // Already ignored under either form — nothing to do
      if (lines.some(l => l === '.fluxo/' || l === '.fluxo')) { return; }
    }
    // Ensure we start on a fresh line whether the file is empty or not
    const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(gitignorePath, `${prefix}\n# Fluxo AI Engine Data\n${entry}\n`, 'utf-8');
  } catch { /* non-fatal — read-only workspace or no .gitignore yet */ }
}

// ─── Activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  _extensionUri = context.extensionUri;
  _context = context;

  // v8.19.0 — pass the workspace root so the client also reads
  // .fluxo/mcp_servers.json (per-project MCP config) on top of the
  // user-scoped fluxo.mcpServers VSCode setting.
  const _initWsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  _mcpClient = new McpSwarmClient(_initWsPath);
  _mcpClient.initialize();

  // Initialize conversation persistence
  _conversationHistory = context.workspaceState.get<ChatMessage[]>(STORAGE_KEY) || [];

  // Session cleanup — trim logs and prune old backups on every new session
  cleanupLogsOnActivation();

  // Zero Footprint — ensure .fluxo/ is gitignored before any agent writes to it
  const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (wsPath) { ensureGitignore(wsPath); }

  // ─── Sentinel: Real-Time Self-Healing ──────────────────────────────────────
  _sentinel = new Sentinel(async (errorText: string) => {
    // Don't interrupt an agent that is currently running
    if (_currentAbortController) { return; }

    _sentinelHasError = true;
    getOrCreatePanel(context);
    _postToPanel({ type: 'sentinelAlert', errorText });

    const config = await _buildConfig();
    const msg =
      `@manager 🔴 Sentinel detectó un error de compilación en la terminal:\n\n\`\`\`\n${errorText}\n\`\`\`\n\nToma el control. Identifica qué edición reciente causó este error y dirige al @coder para corregirlo de inmediato con read_file → replace_lines.`;

    // Small delay so the WebView renders the alert bubble before streamStart fires
    setTimeout(() => {
      _handleSendMessage(msg, config.model, config.workerModel, context).catch(console.error);
    }, 150);
  });

  // Restore sentinel state from last session (default: off)
  if (context.globalState.get<boolean>('fluxo.sentinelActive', false)) {
    _sentinel.activate();
  }
  context.subscriptions.push({ dispose: () => _sentinel?.dispose() });

  // Register Panel Serializer — reopens the panel automatically after Developer: Reload Window
  vscode.window.registerWebviewPanelSerializer('fluxo.chatPanel', {
    async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, _state: unknown) {
      _panel = webviewPanel;
      webviewPanel.webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(_extensionUri, 'media')],
      };
      webviewPanel.webview.html = _buildHtml(webviewPanel.webview);
      webviewPanel.webview.onDidReceiveMessage(async (msg) => {
        await _handleMessage(msg, context);
      });
      webviewPanel.onDidDispose(() => {
        _panel = undefined;
        _currentAbortController?.abort();
        _currentAbortController = undefined;
      });
    }
  });

  // Register Sidebar
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(FluxoSidebarProvider.viewType, new FluxoSidebarProvider(_extensionUri))
  );

  // Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('fluxo.openPanel', () => getOrCreatePanel(context)),

    vscode.commands.registerCommand('fluxo.newChat', () => {
      _conversationHistory = [];
      context.workspaceState.update(STORAGE_KEY, []);
      _postToPanel({ type: 'chatCleared' });
    }),

    vscode.commands.registerCommand('fluxo.clearChat', () => {
      _conversationHistory = [];
      context.workspaceState.update(STORAGE_KEY, []);
      _postToPanel({ type: 'chatCleared' });
    }),

    vscode.commands.registerCommand('fluxo.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', 'fluxo');
    }),

    vscode.commands.registerCommand('fluxo.askAboutSelection', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return; }
      const selection = editor.document.getText(editor.selection);
      if (!selection.trim()) { return; }
      getOrCreatePanel(context);
      _postToPanel({ type: 'prefillPrompt', text: `About this code:\n\`\`\`\n${selection}\n\`\`\`` });
    }),

    vscode.commands.registerCommand('fluxo.toggleSentinel', () => {
      const isNowActive = _sentinel?.toggle() ?? false;
      context.globalState.update('fluxo.sentinelActive', isNowActive);
      _postToPanel({ type: 'sentinelStatus', active: isNowActive });
      vscode.window.showInformationMessage(
        isNowActive
          ? '🟢 Sentinel activated — monitoring terminal for errors'
          : '⚫ Sentinel deactivated'
      );
    }),

    // ── MCP Commands (v8.20.0 — Zero-Config UX) ─────────────────────────────
    // QuickPick-driven UI on top of the same mcpConfigWriter the CLI uses.
    // Workspace is auto-detected; if no folder is open, fall back to the
    // user's home or report and bail gracefully.
    vscode.commands.registerCommand('fluxo.mcp.add', async () => {
      const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!wsPath) {
        vscode.window.showWarningMessage('Fluxo MCP: open a workspace folder first — server config lives in <workspace>/.fluxo/mcp_servers.json.');
        return;
      }
      const items = listRegistry().map(e => ({
        label: `${e.starter ? '★ ' : '  '}${e.alias}`,
        description: e.categories.join(', '),
        detail: e.description,
        alias: e.alias,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select an MCP server to add to .fluxo/mcp_servers.json',
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!pick) { return; }
      const result = addServer(wsPath, pick.alias);
      if (!result.ok) {
        vscode.window.showErrorMessage(`Fluxo MCP: ${result.reason}`);
      } else {
        vscode.window.showInformationMessage(
          result.reason ?? `✅ Added "${result.alias}" to .fluxo/mcp_servers.json. Reload the window for the new server to take effect.`
        );
      }
    }),

    vscode.commands.registerCommand('fluxo.mcp.remove', async () => {
      const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!wsPath) {
        vscode.window.showWarningMessage('Fluxo MCP: open a workspace folder first.');
        return;
      }
      const configured = listConfigured(wsPath);
      const aliases = Object.keys(configured).sort();
      if (aliases.length === 0) {
        vscode.window.showInformationMessage('Fluxo MCP: no servers configured in this workspace.');
        return;
      }
      const pick = await vscode.window.showQuickPick(aliases, {
        placeHolder: 'Select an MCP server to remove',
      });
      if (!pick) { return; }
      const result = removeServer(wsPath, pick);
      if (!result.ok) {
        vscode.window.showErrorMessage(`Fluxo MCP: ${result.reason}`);
      } else {
        vscode.window.showInformationMessage(result.reason ?? `🗑️ Removed "${pick}" from .fluxo/mcp_servers.json. Reload the window to disconnect.`);
      }
    }),

    vscode.commands.registerCommand('fluxo.mcp.list', async () => {
      const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!wsPath) {
        vscode.window.showWarningMessage('Fluxo MCP: open a workspace folder first.');
        return;
      }
      const configured = listConfigured(wsPath);
      const aliases = Object.keys(configured).sort();
      if (aliases.length === 0) {
        vscode.window.showInformationMessage('Fluxo MCP: no servers configured. Run "Fluxo: Add MCP Server" to install one.');
        return;
      }
      const lines = aliases.map(a => {
        const cfg = configured[a];
        const cmd = `${cfg.command} ${(cfg.args ?? []).join(' ')}`.trim();
        return `• ${a} — ${cmd}`;
      });
      vscode.window.showInformationMessage(`Configured MCP servers (${aliases.length}):\n${lines.join('\n')}`, { modal: true });
    })
  );

  // Re-send model list when API keys change so dropdown updates live
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async e => {
      if (e.affectsConfiguration('fluxo') && _panel) {
        const models = await _buildModelList();
        const cfg = await _buildConfig();
        _postToPanel({ type: 'modelsUpdate', models, model: cfg.model, workerModel: cfg.workerModel });
      }
    })
  );

  console.log('[Fluxo AI] v8.10.0 — The Shield Patch: HITL + DeleteTool guards + Iron Rule');
}

export function deactivate(): void {
  _currentAbortController?.abort();
  _mcpClient?.destroy();
}

```

### 📁 FILE: `src\sentinel.ts`
```typescript
import * as vscode from 'vscode';

// ─── ANSI / Control Sequence Stripper ────────────────────────────────────────
// Covers: CSI (\x1b[...m), OSC (\x1b]...\x07), DCS/SOS/PM/APC, and lone Fe
const ANSI_RE = /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07]*\x07|[PX^_].*?\x1b\\|[@-_])/g;

function stripAnsi(raw: string): string {
  return raw.replace(ANSI_RE, '').replace(/\r/g, '');
}

// ─── Error Detection Patterns ─────────────────────────────────────────────────
const ERROR_PATTERNS: RegExp[] = [
  /error\s*TS\d+:/i,                          // TypeScript compiler  e.g.  error TS2345:
  /failed to compile/i,                        // Vite / CRA
  /failed to resolve import/i,                 // Vite missing module
  /\[vite\].*error/i,                          // Vite runtime HMR error
  /\[plugin:vite:oxc\]/i,                      // Vite OXC parser plugin error (Vite 6+)
  /\bparse_error\b/i,                          // OXC / SWC / esbuild parse error
  /\bsyntaxerror\b/i,                          // JS SyntaxError
  /\breferenceerror\b/i,                       // JS ReferenceError
  /\btypeerror\b/i,                            // JS TypeError
  /build failed/i,                             // Generic build failure
  /compilation failed/i,                       // tsc / webpack
  /npm err!/i,                                 // npm
  /✗.*\berror\b/i,                             // Vite ✗ error prefix
  /error\s+in\s+\S+\.(ts|tsx|js|jsx)/i,       // "Error in src/foo.ts"
  /\berror\b.*\.(ts|tsx|js|jsx):\d+/i,        // "Error  src/foo.ts:42"
];

// ─── Tuning Constants ─────────────────────────────────────────────────────────
const BUFFER_MAX  = 4096;   // Keep only the last 4 KB of terminal output
const DEBOUNCE_MS = 2000;   // Wait 2 s of silence after last error chunk before firing
const COOLDOWN_MS = 30_000; // After firing, ignore terminal for 30 s (avoid re-trigger loops)

// ─── Sentinel Class ───────────────────────────────────────────────────────────

export class Sentinel {
  private _buffer       = '';
  private _active       = false;
  private _debounce: ReturnType<typeof setTimeout> | null = null;
  private _cooldownUntil = 0;
  private _disposable: vscode.Disposable | null = null;

  constructor(private readonly onError: (errorText: string) => void) {}

  get isActive(): boolean { return this._active; }

  activate(): void {
    if (this._active) { return; }
    this._active = true;
    this._buffer = '';

    // onDidWriteTerminalData was proposed in VS Code 1.56 and stabilized in 1.88.
    // @types/vscode@^1.85 doesn't include the stable declaration yet, so we use a
    // runtime check + cast to avoid a compile error while still working at runtime.
    type TermDataHandler = (e: { terminal: vscode.Terminal; data: string }) => void;
    const termEvent = (vscode.window as any).onDidWriteTerminalData as
      ((handler: TermDataHandler) => vscode.Disposable) | undefined;

    if (termEvent) {
      this._disposable = termEvent(e => this._onData(e.data));
    } else {
      vscode.window.showWarningMessage(
        'CNOS Sentinel: Terminal monitoring requires VS Code 1.88+. Please update VS Code to enable auto-heal.'
      );
    }
  }

  deactivate(): void {
    if (!this._active) { return; }
    this._active = false;
    this._buffer = '';
    if (this._debounce) { clearTimeout(this._debounce); this._debounce = null; }
    this._disposable?.dispose();
    this._disposable = null;
  }

  /** Toggle active state. Returns the new state. */
  toggle(): boolean {
    if (this._active) { this.deactivate(); } else { this.activate(); }
    return this._active;
  }

  dispose(): void { this.deactivate(); }

  private _onData(raw: string): void {
    if (!this._active) { return; }
    if (Date.now() < this._cooldownUntil) { return; } // Still in post-fire cooldown

    const clean = stripAnsi(raw);
    if (!clean.trim()) { return; }

    // Append to rolling buffer, trimming from the front when over ceiling
    this._buffer += clean;
    if (this._buffer.length > BUFFER_MAX) {
      this._buffer = this._buffer.slice(this._buffer.length - BUFFER_MAX);
    }

    // Only arm the debounce if the buffer actually contains an error signal
    if (!ERROR_PATTERNS.some(p => p.test(this._buffer))) { return; }

    // Reset the debounce timer on every new chunk — fire only after silence
    if (this._debounce) { clearTimeout(this._debounce); }
    this._debounce = setTimeout(() => {
      this._debounce = null;
      const snapshot = this._buffer.trim();
      this._buffer = '';
      this._cooldownUntil = Date.now() + COOLDOWN_MS;
      this.onError(snapshot);
    }, DEBOUNCE_MS);
  }
}

```

### 📁 FILE: `src\services\extractMemories\extractMemories.ts`
```typescript
// ─── Background Memory Extraction (v8.27.0 — Phase 3.3) ────────────────────
//
// Inspired by the "subconscious" pattern in mature CLI agents (Claude Code's
// memory tool, Cursor's persistent project notes): after a task completes
// successfully, a small background pass distills the conversation into ONE
// durable bullet — a webhook URL the user revealed, a quirky build script,
// a non-obvious config requirement, a structural fix the agent rediscovered
// from scratch — and appends it to .fluxo/memory.md. Subsequent sessions
// that include memory.md in context (via @manager / @planner read patterns)
// avoid re-discovering the same gotcha.
//
// Critical design constraints:
//
//   1. FIRE-AND-FORGET. The agent loop never awaits this. The function is
//      always called via .catch() at the call site so a network blip / API
//      timeout / quota exhaustion never breaks the agent's success exit.
//      The user does not pay for memory extraction in their iteration count
//      and does not see the latency.
//
//   2. CHEAP MODEL. Defaults to gemini-2.5-flash-lite (the fastest model
//      available in the default model catalog) when config.workerModel is
//      unset, falls back to whatever the worker was running otherwise.
//      Memory extraction is single-call / single-token-budget; spending a
//      premium model on it would be wasteful — the cognitive load is
//      "summarize one bullet" not "reason about code".
//
//   3. SHORT BUDGET. 1024 max_tokens cap. The contract with the LLM is
//      "single Markdown bullet OR the literal string NONE" — anything
//      larger than 1024 tokens is by definition a contract violation and
//      we discard it.
//
//   4. NONE-FILTER. The strictest part of the prompt is the negative
//      contract: "If nothing genuinely new was learned, return NONE".
//      Without this, every successful task would write a vacuous "the
//      agent edited a file" bullet, polluting memory.md until the @manager
//      can't find the real signal. The post-call check is a literal
//      .trim().toUpperCase() === 'NONE' on the response.
//
//   5. PROJECT-SCOPED. .fluxo/memory.md lives inside the workspace and
//      gets versioned alongside the rest of the project state. A team
//      member who clones the repo inherits the accumulated knowledge.
//      We append + create-if-missing; we never rewrite or condense the
//      file (that would silently lose entries).

import * as fs from 'fs';
import * as path from 'path';
import {
  ChatMessage,
  EngineConfig,
  callOpenRouterBlocking,
} from '../../agentEngine';

const MEMORY_FILE_RELATIVE = path.join('.fluxo', 'memory.md');
const MEMORY_HEADER =
  '# Fluxo AI — Project Memory\n\n' +
  '> Auto-generated by the engine on successful task completion. Each bullet is a single durable lesson the agent rediscovered.\n' +
  '> Edit freely — the engine appends but never overwrites.\n';

// Trim the conversation to the most recent K messages before sending. The
// extractor only needs the last task's flow, not the entire session. Caps
// payload size and keeps the cost predictable across long sessions.
const HISTORY_TAIL_KEEP = 30;

// Per-message content cap so a single huge tool-result payload (read_file on
// a 60KB file, etc.) does not blow the context budget on its own.
const PER_MESSAGE_CONTENT_CAP = 2000;

const DEFAULT_FAST_MODEL = 'gemini-2.5-flash-lite';

const EXTRACT_SYSTEM_PROMPT =
  `You are a project-memory extractor. You read a recently-completed agent ` +
  `conversation and decide whether it revealed ONE durable, project-specific ` +
  `lesson worth remembering across sessions.\n\n` +
  `Examples of WORTH remembering:\n` +
  `  • A non-obvious build/deploy command (e.g. "this project uses pnpm not npm").\n` +
  `  • A webhook URL or API endpoint the user revealed.\n` +
  `  • A quirky config requirement (e.g. "vite.config.ts needs base:'/app/' for prod").\n` +
  `  • A structural rule of the codebase the agent had to rediscover from scratch.\n` +
  `  • A correction the user explicitly made to the agent's approach.\n\n` +
  `Examples of NOT worth remembering (return NONE):\n` +
  `  • The agent edited a file — that is just normal work.\n` +
  `  • The agent ran the build successfully — that is the default expectation.\n` +
  `  • Generic advice that applies to any project.\n` +
  `  • Anything already obvious from reading package.json or the README.\n\n` +
  `OUTPUT CONTRACT — non-negotiable:\n` +
  `  • If you found exactly ONE worth-remembering lesson, output a SINGLE Markdown bullet ` +
  `starting with "- " (dash + space). Use one line. No headers, no preamble, no trailing prose.\n` +
  `  • If you did not, output the literal word NONE — uppercase, no punctuation, no other text.\n` +
  `  • Never output more than one bullet. Never output explanation alongside the bullet.`;

function buildExtractMessages(history: ChatMessage[]): ChatMessage[] {
  // Take the tail of the session to keep the prompt small. Strip empty
  // assistant messages and giant tool payloads.
  const tail = history.slice(-HISTORY_TAIL_KEEP);
  const condensed = tail
    .filter(m => {
      // Drop pure-system markers we have already injected — they are noise
      // for memory extraction (the [CONDENSER] / [COMPACTED MEMORY] /
      // [LSP PASSIVE FEEDBACK] etc. prefixes carry no project-specific signal).
      if (m.role === 'system' && typeof m.content === 'string') {
        if (m.content.startsWith('[CONDENSER]') || m.content.startsWith('[COMPACTED MEMORY]')) {
          return false;
        }
      }
      return true;
    })
    .map(m => {
      const raw = typeof m.content === 'string' ? m.content : '';
      const truncated = raw.length > PER_MESSAGE_CONTENT_CAP
        ? raw.slice(0, PER_MESSAGE_CONTENT_CAP) + '\n…[truncated for memory extraction]'
        : raw;
      // Render every message as a plain user-role payload prefixed with the
      // original role tag. The extractor LLM does not need to follow the
      // assistant↔tool API pairing — it just needs the text. Flattening
      // sidesteps the schema constraints entirely.
      return `[${m.role}] ${truncated}`;
    })
    .join('\n\n');

  return [
    { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Here is the recent agent conversation (most recent ${HISTORY_TAIL_KEEP} messages, ` +
        `tool payloads truncated). Apply the OUTPUT CONTRACT.\n\n` +
        `--- BEGIN CONVERSATION ---\n${condensed}\n--- END CONVERSATION ---`,
    },
  ];
}

function appendMemoryEntry(workspacePath: string, bullet: string): void {
  const dir = path.join(workspacePath, '.fluxo');
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(workspacePath, MEMORY_FILE_RELATIVE);
  const isNew = !fs.existsSync(fp);
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const entry = `${bullet.trim()} _(captured ${ts})_\n`;
  const payload = isNew ? `${MEMORY_HEADER}\n${entry}` : entry;
  fs.appendFileSync(fp, payload, 'utf-8');
}

/**
 * Extract a single durable lesson from the recent session and append it to
 * .fluxo/memory.md. ALWAYS call as fire-and-forget:
 *
 *   extractMemories(history, config, workspacePath).catch(() => {});
 *
 * The function never throws to the caller (its top-level try/catch swallows
 * everything) but a Promise rejection from somewhere inside the await chain
 * could still leak into an unhandledRejection if the caller forgets the
 * .catch — so we defend in both layers.
 *
 * Returns a promise that resolves to the extracted bullet (or null if NONE
 * or extraction failed). The boolean is for telemetry only — the caller
 * does not need to act on it.
 */
export async function extractMemories(
  history: ChatMessage[],
  config: EngineConfig,
  workspacePath: string,
): Promise<string | null> {
  try {
    if (!workspacePath || !Array.isArray(history) || history.length === 0) {
      return null;
    }

    // Pick the cheapest model available. Defaults to gemini-2.5-flash-lite
    // per the spec — the fastest entry in the default catalog. Falls back
    // to the configured worker model when the lite model is unreachable
    // (custom OpenRouter installs without google/* access).
    const modelToUse = config.workerModel || DEFAULT_FAST_MODEL;
    const extractConfig: EngineConfig = {
      ...config,
      model: modelToUse,
      maxTokens: 1024,
      streamingEnabled: false,
    };

    const messages = buildExtractMessages(history);

    // 30s soft timeout — memory extraction is best-effort. AbortSignal.timeout
    // is widely available in Node 18+, but guard for older runtimes.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    let result;
    try {
      result = await callOpenRouterBlocking(messages, extractConfig, controller.signal);
    } finally {
      clearTimeout(timer);
    }

    const raw = (result?.content ?? '').trim();
    if (!raw) { return null; }
    if (raw.toUpperCase() === 'NONE') { return null; }

    // Defensive: if the LLM ignored the contract and emitted a multi-line
    // narrative, take only the FIRST bullet line. Anything else gets dropped.
    const firstBulletLine = raw
      .split('\n')
      .map(l => l.trim())
      .find(l => l.startsWith('- ') || l.startsWith('* '));
    if (!firstBulletLine) {
      // The LLM gave us prose without a bullet marker. Treat as NONE rather
      // than scrape — we cannot guarantee the prose is a clean lesson.
      return null;
    }

    appendMemoryEntry(workspacePath, firstBulletLine);
    return firstBulletLine;
  } catch (err: any) {
    // Top-level swallow. Memory extraction must NEVER surface an error to
    // the caller — it would corrupt the agent's success exit.
    console.error('[Fluxo Memory] extractMemories failed silently:', err?.message ?? err);
    return null;
  }
}

```

### 📁 FILE: `src\services\mcp\client.ts`
```typescript
// ─── Fluxo MCP Service Layer (v8.26.0 — Phase 3.4) ──────────────────────────
//
// History: this file used to live at src/mcpClient.ts as the monolithic MCP
// integration surface. v8.26.0 extracts it into a dedicated services layer
// (`src/services/mcp/`) in preparation for Phase 4 work — n8n/SaaS automation
// flows that need additional services (resource discovery, prompt templates,
// long-running webhook handlers) to live alongside the client without
// re-monolithizing.
//
// What MOVED unchanged from src/mcpClient.ts (zero behavior regression):
//   • McpServerConfig interface
//   • CATEGORY_KEYWORDS heuristic + inferCategories()
//   • McpSwarmClient class — _loadMergedConfig (auto-injection of starter
//     pack via ensureStarterPack), _resolveServerConfig (${ENV:...} /
//     ${ARG:...} placeholder resolution), _initializeAsync with
//     Promise.allSettled parallel boot + 30s connect timeout + transport
//     cleanup on timeout, _cacheTools with explicit/inferred category
//     merging, and the public surface (initialize, getMcpTools,
//     getMcpToolCategories, callMcpTool, destroy).
//
// What is NEW in v8.26.0:
//   • listResources(serverName) — atomic discovery of remote resources
//     (n8n workflow files, DB schemas, config blobs) for the new
//     ListMcpResourcesTool. Wired through the agent engine via a callback
//     interceptor so @planner and @manager can enumerate what an MCP
//     server exposes BEFORE deciding which tool to call.
//
// PRESERVED INVARIANTS (must remain true on every refactor):
//   1. Parallel boot via Promise.allSettled — no server's slow npx fetch
//      blocks the others; one failed server does not abort the batch.
//   2. RBAC category map (toolCategories) is keyed by full mcp_<server>_<tool>
//      name and consumed by agentEngine.applyMcpRbac at runtime.
//   3. Placeholder resolution runs on every string in args + every value in
//      env BEFORE the StdioClientTransport is constructed.
//   4. ensureStarterPack is idempotent — re-running on a workspace with
//      existing .fluxo/mcp_servers.json is a no-op.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { NativeTool } from '../../tools';
import { ensureStarterPack } from '../../utils/mcpConfigWriter';
import { resolvePlaceholders } from '../../utils/mcpRegistry';

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Optional v8.19.0 — explicit categories for this server's tools, used by
   * the RBAC filter when the heuristic inference cannot classify them. Authors
   * of mcp_servers.json can pin a server's tools to one or more roles.
   * Examples: ["design", "figma"], ["database", "git"], ["pm", "jira"].
   */
  categories?: string[];
}

// ─── Category Inference (v8.19.0, moved verbatim in v8.26.0) ────────────────
// Heuristic mapping from server/tool/description text to RBAC categories.
// Multi-tag: a single tool can carry several categories (e.g. GitHub provides
// both git ops and issue/PR project-management surfaces). The RBAC filter in
// agentEngine treats a tool as allowed if ANY of its categories overlaps the
// agent's allowed set.

const CATEGORY_KEYWORDS: Record<string, RegExp> = {
  design:   /\b(design|ui|ux|css|sketch|wireframe|mockup|prototype|color)\b/i,
  figma:    /\b(figma)\b/i,
  image:    /\b(image|photo|illustration|icon|svg|png|jpg|asset)\b/i,
  database: /\b(database|db|sql|postgres|postgresql|mysql|mariadb|mongo|mongodb|redis|sqlite|query|nosql|prisma|supabase|firebase)\b/i,
  compiler: /\b(compile|compiler|build|lint|linter|tsc|typescript|gcc|rustc|webpack|vite|esbuild|swc)\b/i,
  git:      /\b(git|repo|repository|branch|commit|merge|pull[\s-]?request|pr\b|gitlab|bitbucket)\b/i,
  github:   /\b(github)\b/i,
  pm:       /\b(jira|linear|asana|trello|notion|monday|clickup|project|ticket|issue|backlog|sprint|kanban)\b/i,
  jira:     /\b(jira|atlassian)\b/i,
  devops:   /\b(docker|kubernetes|k8s|deploy|deployment|ci\/?cd|pipeline|terraform|ansible|aws|gcp|azure)\b/i,
};

export function inferCategories(serverName: string, toolName: string, description: string): string[] {
  const haystack = `${serverName} ${toolName} ${description}`.toLowerCase();
  const cats = new Set<string>();
  for (const [cat, re] of Object.entries(CATEGORY_KEYWORDS)) {
    if (re.test(haystack)) { cats.add(cat); }
  }
  return Array.from(cats);
}

export class McpSwarmClient {
  private clients: Map<string, Client> = new Map();
  private transports: Map<string, StdioClientTransport> = new Map();

  private cachedTools: NativeTool[] = [];
  private toolCategories: Record<string, string[]> = {};
  private isInitialized = false;
  private workspacePath: string | undefined;

  /**
   * v8.19.0 — workspacePath is optional but recommended. When provided, the
   * client also reads .fluxo/mcp_servers.json from the workspace and merges it
   * with the user-level fluxo.mcpServers VSCode setting. The workspace JSON
   * wins on key collisions, so a project can pin its own MCP stack.
   */
  constructor(workspacePath?: string) {
    this.workspacePath = workspacePath;
  }

  public initialize() {
    this._initializeAsync().catch(err => console.error("[Fluxo MCP] Init error:", err));
  }

  private _loadMergedConfig(): Record<string, McpServerConfig> {
    const userConfig = vscode.workspace.getConfiguration('fluxo')
      .get<Record<string, McpServerConfig>>('mcpServers') || {};

    let workspaceConfig: Record<string, McpServerConfig> = {};
    if (this.workspacePath) {
      // v8.20.0 — Zero-Config Auto-Injection. If the workspace has never
      // configured MCP, drop a starter pack JSON onto disk before we try to
      // read it. ensureStarterPack is idempotent and only writes when the
      // file is missing, so a user who deleted everything intentionally is
      // never surprised by a re-seed mid-session.
      try {
        const written = ensureStarterPack(this.workspacePath);
        if (written.length > 0) {
          console.log(`[Fluxo MCP] Auto-injected starter pack into .fluxo/mcp_servers.json: ${written.join(', ')}`);
        }
      } catch (err: any) {
        console.error(`[Fluxo MCP] Failed to auto-inject starter pack: ${err?.message ?? err}`);
      }

      const fp = path.join(this.workspacePath, '.fluxo', 'mcp_servers.json');
      try {
        if (fs.existsSync(fp)) {
          const raw = fs.readFileSync(fp, 'utf-8');
          const parsed = JSON.parse(raw);
          // Accept both root-level map and { mcpServers: { ... } } envelope.
          if (parsed && typeof parsed === 'object') {
            workspaceConfig = (parsed.mcpServers ?? parsed) as Record<string, McpServerConfig>;
          }
          console.log(`[Fluxo MCP] Loaded .fluxo/mcp_servers.json (${Object.keys(workspaceConfig).length} server(s))`);
        }
      } catch (err: any) {
        console.error(`[Fluxo MCP] Failed to read .fluxo/mcp_servers.json: ${err?.message ?? err}`);
      }
    }

    // Workspace JSON wins on collisions — projects can pin their own MCP stack.
    return { ...userConfig, ...workspaceConfig };
  }

  /**
   * v8.20.0 — resolve ${ENV:...} / ${ARG:...:default} placeholders in a
   * server config before we hand it to the StdioClientTransport. Applied to
   * every string in args + every value in env. Servers that need a real env
   * var (BRAVE_API_KEY, GITHUB_TOKEN) read it from process.env transparently.
   */
  private _resolveServerConfig(serverConfig: McpServerConfig): McpServerConfig {
    const resolved: McpServerConfig = {
      command: resolvePlaceholders(serverConfig.command),
      args: serverConfig.args?.map(a => resolvePlaceholders(a)),
    };
    if (serverConfig.env) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(serverConfig.env)) {
        env[k] = resolvePlaceholders(v);
      }
      resolved.env = env;
    }
    return resolved;
  }

  private async _initializeAsync() {
    const config = this._loadMergedConfig();
    if (!config || Object.keys(config).length === 0) {
      this.isInitialized = true;
      return;
    }

    // v8.20.0 — Parallel boot. Cold `npx -y` fetches can take 10-30s on a
    // fresh cache; running servers serially used to make startup time scale
    // linearly with N servers. Parallelizing keeps total init bounded by the
    // slowest server. A failure on one server never blocks the others, and
    // never throws — the whole batch is wrapped in Promise.allSettled.
    //
    // Per-server connect timeout bumped 5s → 30s so first-run npx fetches
    // have headroom. Transports that miss the deadline are explicitly
    // closed to avoid orphan node processes.
    const CONNECT_TIMEOUT_MS = 30_000;
    await Promise.allSettled(
      Object.entries(config).map(async ([serverName, rawConfig]) => {
        const serverConfig = this._resolveServerConfig(rawConfig);
        const transport = new StdioClientTransport({
          command: serverConfig.command,
          args: serverConfig.args,
          env: { ...process.env, ...serverConfig.env } as Record<string, string>
        });

        const client = new Client(
          { name: 'fluxo-ai', version: '8.26.0' },
          { capabilities: {} }
        );

        try {
          await Promise.race([
            client.connect(transport),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Connection timeout (${CONNECT_TIMEOUT_MS}ms) — likely a slow npx fetch on first run`)), CONNECT_TIMEOUT_MS))
          ]);
          this.clients.set(serverName, client);
          this.transports.set(serverName, transport);
          console.log(`[Fluxo MCP] Connected to server: ${serverName}`);
        } catch (err: any) {
          console.error(`[Fluxo MCP] Failed to connect to server ${serverName}:`, err?.message ?? err);
          // Clean up the transport on failure so we don't leak a dangling
          // child process holding a stdio pipe.
          try { await transport.close(); } catch { /* nothing more to clean */ }
        }
      })
    );

    await this._cacheTools(config);
    this.isInitialized = true;
  }

  private async _cacheTools(config: Record<string, McpServerConfig>) {
    const allTools: NativeTool[] = [];
    const categoryMap: Record<string, string[]> = {};

    for (const [serverName, client] of this.clients.entries()) {
      try {
        const response = await Promise.race([
          client.listTools(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('listTools timeout')), 5000))
        ]) as any;

        const explicitCategories = config[serverName]?.categories ?? [];

        for (const t of response.tools) {
          const fullName    = `mcp_${serverName}_${t.name}`;
          const description = `[MCP Server: ${serverName}] ${t.description || ''}`;
          allTools.push({
            type: 'function',
            function: {
              name: fullName,
              description,
              parameters: (t.inputSchema as any) || { type: 'object', properties: {} }
            }
          });

          // Merge explicit (config-pinned) + inferred categories. Explicit wins
          // on intent but inferred cats add coverage if the author missed any.
          const inferred = inferCategories(serverName, t.name, t.description || '');
          const merged   = Array.from(new Set([...explicitCategories, ...inferred]));
          categoryMap[fullName] = merged;
        }
      } catch (err) {
        console.error(`[Fluxo MCP] Failed to list tools for ${serverName}:`, err);
      }
    }

    this.cachedTools    = allTools;
    this.toolCategories = categoryMap;
  }

  public getMcpTools(): NativeTool[] {
    return this.cachedTools;
  }

  /**
   * v8.19.0 — return the per-tool category map keyed by full tool name (e.g.
   * "mcp_github_create_issue" → ["github", "git", "pm"]). Consumed by the
   * RBAC filter in agentEngine.ts. Tools whose keyword inference returns no
   * matches AND whose server config did not pin categories appear here with
   * an empty array — the RBAC filter treats those as "unknown".
   */
  public getMcpToolCategories(): Record<string, string[]> {
    return this.toolCategories;
  }

  public async callMcpTool(fullName: string, args: any): Promise<{ success: boolean; output: string }> {
    const match = fullName.match(/^mcp_([^_]+)_(.+)$/);
    if (!match) {
      return { success: false, output: `Invalid MCP tool name: ${fullName}` };
    }
    const serverName = match[1];
    const toolName = match[2];

    const client = this.clients.get(serverName);
    if (!client) {
      return { success: false, output: `MCP Server not found: ${serverName}` };
    }

    try {
      const response = await client.callTool({ name: toolName, arguments: args });
      if (response.isError) {
        const textContent = (response.content as any[]).map((c: any) => c.text).join('\n');
        return { success: false, output: `MCP Tool Error:\n${textContent}` };
      }
      const textContent = (response.content as any[]).map((c: any) => c.text).join('\n');
      return { success: true, output: textContent };
    } catch (err: any) {
      return { success: false, output: `MCP call failed: ${err.message}` };
    }
  }

  /**
   * v8.26.0 — Phase 3.4 resource discovery. MCP servers expose two parallel
   * surfaces: `tools` (callable functions, already cached during init) and
   * `resources` (readable URIs — n8n workflow JSON blobs, database schemas,
   * config files, prompt templates). The agent needs to enumerate resources
   * BEFORE deciding which tool to call against them, much like an LSP
   * `textDocument/documentSymbol` precedes a refactor.
   *
   * Returns the same { success, output } envelope as callMcpTool so the
   * engine intercept and the existing tool-result pipeline treat it
   * uniformly. Output is a human-readable list (uri / name / mimeType /
   * description) — formatted for direct injection into the LLM's context
   * with low parsing overhead.
   *
   * Defensive: if the server does not advertise the resources/list capability
   * the SDK throws — we trap and return a clean failure rather than letting
   * the engine see a raw exception.
   */
  public async listResources(serverName: string): Promise<{ success: boolean; output: string }> {
    if (!serverName || typeof serverName !== 'string') {
      return { success: false, output: 'list_mcp_resources: missing or invalid `server_name` argument.' };
    }
    const client = this.clients.get(serverName);
    if (!client) {
      const available = Array.from(this.clients.keys());
      return {
        success: false,
        output:
          `MCP Server not found: "${serverName}". ` +
          (available.length > 0
            ? `Available servers: ${available.join(', ')}.`
            : 'No MCP servers are currently connected — check .fluxo/mcp_servers.json.'),
      };
    }
    try {
      const response = await Promise.race([
        client.listResources(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('listResources timeout (5s)')), 5000)),
      ]) as any;
      const resources: any[] = Array.isArray(response?.resources) ? response.resources : [];
      if (resources.length === 0) {
        return {
          success: true,
          output: `MCP server "${serverName}" exposes 0 resources. The server may only provide tools, or the resources/list capability is unimplemented.`,
        };
      }
      const lines = resources.slice(0, 50).map(r => {
        const parts = [
          `uri: ${r.uri ?? '(missing)'}`,
          `name: ${r.name ?? '(unnamed)'}`,
        ];
        if (r.mimeType) { parts.push(`mimeType: ${r.mimeType}`); }
        if (r.description) { parts.push(`description: ${String(r.description).slice(0, 200)}`); }
        return `- ${parts.join(' | ')}`;
      });
      const truncated = resources.length > 50 ? `\n…(showing first 50 of ${resources.length})` : '';
      return {
        success: true,
        output: `MCP server "${serverName}" exposes ${resources.length} resource(s):\n\n${lines.join('\n')}${truncated}`,
      };
    } catch (err: any) {
      return { success: false, output: `list_mcp_resources("${serverName}") failed: ${err?.message ?? String(err)}` };
    }
  }

  /**
   * v8.26.0 — utility for the new ListMcpResourcesTool's error path. Returns
   * the list of currently connected server names so the tool can suggest
   * valid alternatives when the agent asks about a typo'd server.
   */
  public getConnectedServerNames(): string[] {
    return Array.from(this.clients.keys());
  }

  public async destroy() {
    for (const [serverName, transport] of this.transports.entries()) {
      try {
        await transport.close();
        console.log(`[Fluxo MCP] Disconnected from server: ${serverName}`);
      } catch (err) {
        console.error(`[Fluxo MCP] Error closing transport for ${serverName}:`, err);
      }
    }
    this.clients.clear();
    this.transports.clear();
  }
}

```

### 📁 FILE: `src\tools\AbortAndRollbackTool\index.ts`
```typescript
import { NativeTool, ToolResult } from '../shared';
import { rollbackToLastCheckpoint } from '../../utils/gitSafety';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'abort_and_rollback',
    description:
      'Use this tool ONLY if you realize your edits have fundamentally broken the project\'s logic, ' +
      'or if the user commands you to revert your changes. ' +
      'It will instantly reset the codebase to the state before you started the task ' +
      'by running git reset --hard HEAD~1 against the fluxo-auto-checkpoint anchor commit. ' +
      'WARNING: This is irreversible within the current session — all agent file edits will be discarded.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Brief explanation of why the rollback is being triggered.',
        },
      },
      required: ['reason'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  return rollbackToLastCheckpoint(workspacePath);
}

```

### 📁 FILE: `src\tools\AskApprovalTool\index.ts`
```typescript
// Powered by Fluxo Tech AI — https://fluxotechai.com
import { NativeTool, ToolResult } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'ask_user_approval',
    description: `BODYGUARD PROTOCOL — Pause execution and request explicit human approval before proceeding.
WHEN TO USE: (1) The user's request is ambiguous about WHICH file to edit. (2) You plan to modify an infrastructure file (routing config, auth, build config, .env-adjacent logic, CI). (3) You are about to make a destructive or large-scope change not explicitly confirmed by the user.
WORKFLOW: Call this tool FIRST with your plan. Wait for the result. If "USER APPROVED" → proceed with planned tools. If "USER REJECTED" → stop all planned edits and ask a focused clarifying question in plain text.
NEVER skip this tool when ambiguity or infrastructure risk is present.`,
    parameters: {
      type: 'object',
      properties: {
        intent_summary: {
          type: 'string',
          description: 'One short sentence describing what you intend to do (e.g., "Modify the frontend routing in App.tsx to add a new /dashboard route").',
        },
        reason_and_files: {
          type: 'string',
          description: 'Explanation of why and which specific files you plan to touch (e.g., "The user asked for a red modal. I plan to edit GenericModal.jsx ~line 45 and App.css ~line 12 to change the background color").',
        },
      },
      required: ['intent_summary', 'reason_and_files'],
    },
  },
};

// This execute stub is never reached — the engine intercepts ask_user_approval
// before calling executeTool and delegates to the VS Code approvalCallback.
export function execute(_args: Record<string, any>, _workspacePath: string): ToolResult {
  return {
    success: false,
    output: '[ENGINE ERROR] ask_user_approval must be intercepted by the engine approval callback before reaching executeTool.',
  };
}

```

### 📁 FILE: `src\tools\CreateDirTool\index.ts`
```typescript
import * as fs from 'fs';
import { NativeTool, ToolResult, safePath } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'create_dir',
    description: 'Create a directory and all necessary parent directories.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to workspace root.' },
      },
      required: ['path'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const dp = safePath(workspacePath, args.path);
  fs.mkdirSync(dp, { recursive: true });
  return { success: true, output: `Directory created: ${args.path}` };
}

```

### 📁 FILE: `src\tools\DeleteDirTool\index.ts`
```typescript
import * as fs from 'fs';
import * as path from 'path';
import { NativeTool, ToolResult, safePath } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'delete_dir',
    description: 'Delete a directory and all its contents recursively. Safer than run_command for deletions.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the directory to delete.' },
      },
      required: ['path'],
    },
  },
};

// ── Shield Patch (v8.10.0) — critical path validation ─────────────────────────
function validateDeletionPath(resolvedPath: string, workspacePath: string): string | null {
  const resolvedWs = path.resolve(workspacePath);
  const rel = path.relative(resolvedWs, resolvedPath).replace(/\\/g, '/');

  // Block workspace root itself
  if (resolvedPath.toLowerCase() === resolvedWs.toLowerCase()) {
    return 'SHIELD BLOCKED: Cannot delete the workspace root directory.';
  }
  // Block .git directory (whole tree or any subdirectory inside it)
  if (rel === '.git' || rel.startsWith('.git/') || rel.startsWith('.git\\')) {
    return `SHIELD BLOCKED: Deleting the .git directory is forbidden. Path: ${rel}`;
  }
  // Block node_modules only when path IS node_modules at the workspace root
  // (allow sub-package deletions inside nested node_modules)
  if (rel === 'node_modules') {
    return 'SHIELD BLOCKED: Deleting node_modules via agent is forbidden. Run "npm install" to restore it.';
  }
  return null;
}

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const dp = safePath(workspacePath, args.path);

  const shieldError = validateDeletionPath(dp, workspacePath);
  if (shieldError) { return { success: false, output: shieldError }; }

  if (!fs.existsSync(dp)) {
    return { success: false, output: `Directory not found: ${args.path}` };
  }
  fs.rmSync(dp, { recursive: true, force: true });
  return { success: true, output: `Directory and contents deleted: ${args.path}` };
}

```

### 📁 FILE: `src\tools\DeleteFileTool\index.ts`
```typescript
import * as fs from 'fs';
import * as path from 'path';
import { NativeTool, ToolResult, safePath } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'delete_file',
    description: 'Delete a single file from the workspace. Safer than run_command for deletions.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file to delete.' },
      },
      required: ['path'],
    },
  },
};

// ── Shield Patch (v8.10.0) — critical path validation ─────────────────────────
function validateDeletionPath(resolvedPath: string, workspacePath: string): string | null {
  const rel = path.relative(workspacePath, resolvedPath).replace(/\\/g, '/');

  // Block .git directory contents
  if (rel === '.git' || rel.startsWith('.git/') || rel.startsWith('.git\\')) {
    return `SHIELD BLOCKED: Deleting inside .git is forbidden. Path: ${rel}`;
  }
  // Block deletion of workspace root itself
  if (resolvedPath.toLowerCase() === path.resolve(workspacePath).toLowerCase()) {
    return 'SHIELD BLOCKED: Cannot delete the workspace root.';
  }
  return null;
}

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const fp = safePath(workspacePath, args.path);

  const shieldError = validateDeletionPath(fp, workspacePath);
  if (shieldError) { return { success: false, output: shieldError }; }

  if (!fs.existsSync(fp)) {
    return { success: false, output: `File not found: ${args.path}` };
  }
  fs.unlinkSync(fp);
  return { success: true, output: `Deleted: ${args.path}` };
}

```

### 📁 FILE: `src\tools\EnterPlanModeTool\index.ts`
```typescript
import { ToolResult, NativeTool } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'enter_plan_mode',
    description:
      'Spawns the @planner sub-agent to analyze the codebase and produce a structured IMPLEMENTATION_PLAN.md ' +
      'at .fluxo/IMPLEMENTATION_PLAN.md before any code is written. ' +
      'Required before any create_team delegation for tasks touching more than 1 file or involving logical refactoring. ' +
      'The planner is read-only — it only writes the plan file. ' +
      'FALLBACK RULE: If this tool fails to produce the implementation plan due to circuit breaker limits, DO NOT retry it. ' +
      'The fallback is to use ask_user_approval to request human help. ' +
      'You have STRICTLY PROHIBITED assigning tasks to the @coder without an IMPLEMENTATION_PLAN.md.',
    parameters: {
      type: 'object',
      properties: {
        task_description: {
          type: 'string',
          description:
            'Complete description of the task the planner must analyze and break down into sequential, ' +
            'file-precise implementation steps. Include all known context: tech stack, files suspected, goal.',
        },
      },
      required: ['task_description'],
    },
  },
};

export function execute(_args: Record<string, any>, _workspacePath: string): ToolResult {
  return {
    success: false,
    output: '[SYSTEM]: enter_plan_mode is intercepted by the engine. This execute() body should never run.',
  };
}

```

### 📁 FILE: `src\tools\EnterWorktreeTool\index.ts`
```typescript
// Powered by Fluxo Tech AI — https://fluxotechai.com
import * as fs   from 'fs';
import * as path from 'path';
import * as cp   from 'child_process';
import { NativeTool, ToolResult } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'enter_worktree',
    description: `Create an isolated git worktree sandbox for high-risk refactoring.
Use this BEFORE any operation that touches >50 lines or modifies multiple files simultaneously.
The worktree is a full checkout of the current HEAD on a fresh branch — edits there CANNOT corrupt the user's production code on main.

WORKFLOW:
1. Call enter_worktree → get back the worktree path.
2. Perform ALL edits using that path as the root (e.g. worktreePath/src/App.tsx).
3. Run npm run build inside the worktree to verify.
4. Call exit_worktree with action='merge' on success, or action='discard' to abort cleanly.

RULE: Never attempt to work in two worktrees simultaneously.`,
    parameters: {
      type: 'object',
      properties: {
        branch_name: {
          type: 'string',
          description: 'Optional branch name (e.g. "refactor-auth"). Auto-generated from timestamp if omitted.',
        },
        reason: {
          type: 'string',
          description: 'One-sentence description of why isolation is needed (shown to the user).',
        },
      },
      required: ['reason'],
    },
  },
};

const STATE_RELATIVE = path.join('.fluxo', 'active_worktree.json');

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  // ── Genesis Patch v8.16.15: auto-init git + anchor commit ─────────────────
  let isRepo = true;
  try {
    cp.execSync('git rev-parse --is-inside-work-tree', { cwd: workspacePath, stdio: 'pipe' });
  } catch {
    isRepo = false;
  }

  if (!isRepo) {
    try {
      cp.execSync('git init', { cwd: workspacePath, stdio: 'pipe' });
    } catch (e: any) {
      const stderr = (e.stderr?.toString() || e.message || '').slice(0, 400);
      return { success: false, output: `EnterWorktree: git init failed:\n${stderr}` };
    }
  }

  // The Mandatory Anchor — worktrees cannot be created on an empty history
  let hasCommits = true;
  try {
    cp.execSync('git rev-list -n 1 --all', { cwd: workspacePath, stdio: 'pipe' });
    const out = cp.execSync('git rev-list -n 1 --all', { cwd: workspacePath, stdio: 'pipe' }).toString().trim();
    if (!out) hasCommits = false;
  } catch {
    hasCommits = false;
  }

  if (!hasCommits) {
    // Ensure committer identity exists locally so the genesis commit doesn't fail
    try { cp.execSync('git config user.email', { cwd: workspacePath, stdio: 'pipe' }); }
    catch { try { cp.execSync('git config user.email "fluxo@local"', { cwd: workspacePath, stdio: 'pipe' }); } catch {} }
    try { cp.execSync('git config user.name', { cwd: workspacePath, stdio: 'pipe' }); }
    catch { try { cp.execSync('git config user.name "Fluxo AI"', { cwd: workspacePath, stdio: 'pipe' }); } catch {} }

    try {
      cp.execSync('git commit --allow-empty -m "chore: initial genesis commit"', {
        cwd: workspacePath,
        stdio: 'pipe',
      });
    } catch (e: any) {
      const stderr = (e.stderr?.toString() || e.message || '').slice(0, 400);
      return { success: false, output: `EnterWorktree: genesis commit failed:\n${stderr}` };
    }
  }

  // ── Guard: one worktree at a time ─────────────────────────────────────────
  const stateFilePath = path.join(workspacePath, STATE_RELATIVE);
  if (fs.existsSync(stateFilePath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8'));
      return {
        success: false,
        output: `EnterWorktree: A worktree is already active ('${existing.branchName}'). ` +
          `Call exit_worktree with action='merge' or action='discard' before creating a new one.`,
      };
    } catch { /* corrupted state file — proceed and overwrite */ }
  }

  // ── Resolve names & paths ─────────────────────────────────────────────────
  const timestamp  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rawBranch  = (args.branch_name as string | undefined) || `fluxo-wt-${timestamp}`;
  const branchName = rawBranch.replace(/[^a-zA-Z0-9-_]/g, '-');
  const worktreePath = path.join(workspacePath, '.fluxo', 'worktrees', branchName);
  const reason = String(args.reason || 'High-risk refactoring');

  // ── Create worktree ────────────────────────────────────────────────────────
  try {
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  } catch (e: any) {
    return { success: false, output: `EnterWorktree: Could not create worktree parent directory: ${e.message}` };
  }

  try {
    cp.execSync(`git worktree add "${worktreePath}" -b "${branchName}"`, {
      cwd:   workspacePath,
      stdio: 'pipe',
    });
  } catch (e: any) {
    const stderr = (e.stderr?.toString() || e.message || '').slice(0, 400);
    return { success: false, output: `EnterWorktree: git worktree add failed:\n${stderr}` };
  }

  // ── Persist state ─────────────────────────────────────────────────────────
  try {
    fs.writeFileSync(stateFilePath, JSON.stringify({
      branchName,
      worktreePath,
      reason,
      createdAt: new Date().toISOString(),
    }, null, 2), 'utf-8');
  } catch { /* non-fatal */ }

  const relPath = path.relative(workspacePath, worktreePath).replace(/\\/g, '/');

  return {
    success: true,
    output:
      `✅ WORKTREE ACTIVE — Isolation sandbox created.\n\n` +
      `Branch:        ${branchName}\n` +
      `Worktree path: ${relPath}/\n` +
      `Reason:        ${reason}\n\n` +
      `PATH REDIRECT ACTIVE (v8.8.0):\n` +
      `• Continue using NORMAL relative paths (e.g. 'src/App.tsx').\n` +
      `• The engine automatically redirects ALL file operations to the worktree — no prefix needed.\n` +
      `• 'npm run build' will also run inside the worktree to verify your changes.\n` +
      `• When done → exit_worktree(action='merge') on success, exit_worktree(action='discard') to abort.`,
  };
}

```

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

  // ── Aider-style Overwrite Block (v8.25.0 — North Star) ──────────────────────
  // Hard-block: write_file may NEVER touch a file that already exists. Forces
  // the agent toward AST/diff editing tools (replace_block, replace_symbol,
  // replace_lines, search_and_replace, insert_lines) which surgically edit
  // existing files instead of nuking them. Aligns the swarm with Aider's
  // unified-diff discipline — no agent can quietly destroy unrelated code by
  // re-emitting an entire file with a "small fix" inside.
  // Position: after safePath() so the existsSync check uses the resolved
  // absolute path; before syntax validation and lock acquisition since both
  // are wasted work if we are about to reject.
  //
  // Whitelist: paths under `.fluxo/` are the engine's state space (the
  // @planner's IMPLEMENTATION_PLAN.md, the @manager's memory.md, the
  // improvements log, the active_worktree.json, the DAG state, the MCP
  // config, etc.). Those files are designed to be overwritten on every run
  // — they describe ephemeral engine state, not user code. The block exists
  // to protect USER source from blind overwrites, so the engine's own state
  // namespace is the natural exception. Match both POSIX (`.fluxo/`) and
  // Windows (`.fluxo\`) separators because the path normalization
  // middleware in agentEngine.ts (v8.5.2) emits forward slashes by default
  // but the engine still receives backslashes from a few legacy code paths.
  const _rawPath = String(args.path ?? '');
  const _isFluxoState = _rawPath.startsWith('.fluxo/') || _rawPath.startsWith('.fluxo\\');
  if (fs.existsSync(fp) && !_isFluxoState) {
    // ── v8.29.0: Size-Aware Write Block ─────────────────────────────────────
    // Small files (< 10 KB) are safe to overwrite in full — they are typically
    // configs, tiny utility modules, or new files under active construction
    // that have not grown large yet. The original Aider-style blanket block
    // (v8.25.0) was too strict for these cases and introduced unnecessary
    // friction when frontier models wanted to rewrite a 2 KB helper cleanly.
    // Large files (>= 10 KB) keep the hard block: at that size the risk of
    // silently nuking unrelated code is real and the surgical editing tools
    // (replace_block, search_and_replace, replace_symbol) are the right path.
    const _SIZE_THRESHOLD = 10_240; // 10 KB
    try {
      const _existingSize = fs.statSync(fp).size;
      if (_existingSize >= _SIZE_THRESHOLD) {
        return {
          success: false,
          output: '[SYSTEM BLOCK] El archivo es demasiado grande. Prohibido usar write_file en archivos extensos. Debes usar replace_block o search_and_replace.',
        };
      }
      // File is small — allow the overwrite and fall through to the rest of execute().
    } catch {
      // statSync failed (race condition between existsSync and statSync on
      // Windows, or a symlink edge case). Fall through conservatively —
      // the write will proceed; a subsequent write error surfaces naturally.
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────

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
import * as ListMcpResourcesTool  from './ListMcpResourcesTool';
import * as SecurityAuditTool     from './SecurityAuditTool';
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
  ListMcpResourcesTool,
  SecurityAuditTool,
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
    description: `Insert content BEFORE a 1-based line number. Nothing is removed.
Best for dropping a fresh component/function block into a file (replace_* would force counting brackets across 50+ JSX lines). read_file FIRST to get line count. at_line=1 prepends, at_line=(lastLine+1) appends.`,
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

### 📁 FILE: `src\tools\ListMcpResourcesTool\index.ts`
```typescript
import { NativeTool, ToolResult } from '../shared';

// ─── ListMcpResourcesTool (v8.26.0 — Phase 3.4 Discovery) ───────────────────
//
// MCP servers expose two parallel surfaces: `tools` (callable functions, which
// the engine already discovers and caches at boot via McpSwarmClient._cacheTools)
// and `resources` (readable URIs — n8n workflow JSON blobs, database schemas,
// configuration documents, prompt templates). The cached tool list does NOT
// reveal what resources are available; agents need an explicit discovery step
// before they can decide which tool to invoke against which resource.
//
// This tool gives @planner and @manager an atomic discovery primitive: pass a
// `server_name` (the alias from .fluxo/mcp_servers.json), get back a
// human-readable list of resources (uri / name / mimeType / description) that
// server exposes. Output is formatted for direct LLM consumption.
//
// EXECUTION MODEL: like get_code_structure / replace_symbol / mcp_*, this
// tool requires the live McpSwarmClient instance which lives in the extension
// host (it owns the open stdio transports). The synchronous execute() below
// is a placeholder; the real work happens in agentEngine.ts via the
// `listMcpResourcesCallback` injected through runAgentLoop. The placeholder
// only fires if the callback is missing (e.g. running outside the extension
// host) and surfaces a clear "engine integration error" rather than a silent
// hang.

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'list_mcp_resources',
    description:
      'Discover what resources (readable URIs — n8n workflow JSONs, DB schemas, ' +
      'prompt templates, config documents) a specific MCP server exposes. ' +
      'Returns a list of {uri, name, mimeType, description} entries. ' +
      'WHEN TO USE: before calling an mcp_<server>_<tool> that operates on a remote ' +
      'resource — call this first to learn the exact URIs available, then pass them ' +
      'verbatim to the tool. Avoids hallucinating non-existent resource paths. ' +
      'WHEN NOT TO USE: do not call this for every server you know about — only call ' +
      'when you are about to perform an operation that needs the resource list.',
    parameters: {
      type: 'object',
      properties: {
        server_name: {
          type: 'string',
          description:
            'The MCP server alias as it appears in .fluxo/mcp_servers.json ' +
            '(e.g. "github", "n8n", "memory", "sqlite"). Case-sensitive.',
        },
      },
      required: ['server_name'],
    },
  },
};

// Real execution is intercepted by agentEngine.ts (listMcpResourcesCallback
// from extension.ts → McpSwarmClient.listResources). This synchronous path is
// a defense-in-depth fallback only — in production the engine never reaches
// it because the intercept fires before executeTool dispatches.
export function execute(_args: Record<string, any>, _workspacePath: string): ToolResult {
  return {
    success: false,
    output: '[SYSTEM ENGINE ERROR]: list_mcp_resources must be intercepted by the McpSwarmClient callback in extension.ts. Ensure the extension host is active and the MCP service layer initialized.',
  };
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
    description: `Replace a text block by exact + fuzzy matching — no line numbers.
read_file FIRST → copy search_snippet verbatim with 2-3 lines of context for uniqueness → call. replace_snippet="" deletes. On not-found the file is untouched; re-read and retry with the verbatim block.`,
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
    description: `Replace a 1-based line range. read_file FIRST (line numbers shift after every edit).
new_content="" deletes the range. To insert without deleting: set start_line=end_line and prepend the original line text + \\n in new_content.`,
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
    description: `Replace a named function/class/component via LSP — no line counting.
Call get_code_structure first to confirm the exact symbol_name (case-sensitive). On not-found the file is untouched; retry with the correct name. For files without LSP support use search_and_replace.`,
    parameters: {
      type: 'object',
      properties: {
        file_path:    { type: 'string', description: 'File path relative to workspace root (e.g. "src/components/Dashboard.tsx").' },
        symbol_name:  { type: 'string', description: 'Exact name of the function, class, or variable to replace (case-sensitive, e.g. "handleDelete" or "AdminDashboard"). Must match the AST node name exactly.' },
        new_code:     { type: 'string', description: 'Complete replacement code for the symbol. Include the full function/class signature and body. The engine will replace the old node boundaries with this text exactly.' },
        healing_mode: { type: 'boolean', description: 'Set to true ONLY when the user explicitly authorized you to bypass the Sherlock Auditor (e.g. "fix the duplicate anyway", "I know about it, force the change"). Combined with the engine\'s user-override marker check, this lets the edit through even if Sherlock would otherwise flag REDUNDANT_DECLARATION. Quote the user\'s override phrase in your reasoning so the engine can verify.' },
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
      'Execute a shell command (npm/tsc/git/firebase). NEVER for reading files (use read_file) ' +
      'or for ls/find/grep/cat (use glob/grep/list_dir/search_in_files). Worktree is auto-routed — ' +
      'do NOT use "cd .fluxo/worktrees/...". Quote paths with spaces. ' +
      '"git restore <path>" is your CTRL+Z when an edit breaks a file.',
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
    description: `Surgical edit by contextual search — no line numbers needed.
Workflow: read_file FIRST → copy search_snippet VERBATIM (every space/tab/newline) → call. Use replace_snippet="" to delete.
For >50 line injections use insert_lines instead. On MATCH ERROR re-read the file (your snippet is wrong); never guess.`,
    parameters: {
      type: 'object',
      properties: {
        path:            { type: 'string', description: 'File path relative to workspace root.' },
        search_snippet:  { type: 'string', description: 'The EXACT code currently in the file that you want to replace. Include 2–3 surrounding lines of context to guarantee uniqueness.' },
        replace_snippet: { type: 'string', description: 'The NEW code that will replace search_snippet. Use empty string "" to delete the block.' },
        healing_mode:    { type: 'boolean', description: 'Set to true ONLY when the user explicitly authorized you to bypass the Sherlock Auditor (e.g. "fix the duplicate anyway", "I know about it, force the change"). Combined with the engine\'s user-override marker check, this lets the edit through even if Sherlock would otherwise flag REDUNDANT_DECLARATION. Quote the user\'s override phrase in your reasoning so the engine can verify.' },
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

// v8.34.0 — When MATCH ERROR fires, locate the file region whose first lines
// best match the LLM's hallucinated snippet (longest contiguous run of
// normalized-equal lines). Returns the 0-based start line of that region or
// null when no line of the snippet matches anything in the file. Used purely
// for guidance — never to mutate the file.
function findBestFuzzyCandidate(fileContent: string, snippet: string): number | null {
  const fileLines = fileContent.replace(/\r\n/g, '\n').split('\n');
  const snipLines = snippet
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(normalizeLine)
    .filter(l => l !== '');
  if (snipLines.length === 0 || fileLines.length === 0) { return null; }

  let bestStart = -1;
  let bestRun = 0;
  for (let i = 0; i < fileLines.length; i++) {
    let run = 0;
    for (let j = 0; j < snipLines.length && i + j < fileLines.length; j++) {
      if (normalizeLine(fileLines[i + j]) === snipLines[j]) {
        run++;
      } else {
        break;
      }
    }
    if (run > bestRun) {
      bestRun = run;
      bestStart = i;
    }
  }
  return bestRun >= 1 ? bestStart : null;
}

function formatNumberedLines(lines: string[], startIndex: number): string {
  return lines
    .map((l, i) => `${(startIndex + i + 1).toString().padStart(4)}: ${l}`)
    .join('\n');
}

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
  // ── v8.31.0/v8.32.0: Tool Aliasing — tolerate LLM arg-name slips under stress ─
  // Tier-1 models (Gemini/Claude) frequently emit `file_path` instead of `path`,
  // `old_code`/`new_code` instead of the canonical `*_snippet`, and Gemini 2.5
  // Pro additionally hallucinates `search_pattern`/`replace_pattern` based on
  // Python regex APIs. We normalize at the boundary so the rest of the function
  // operates on a single shape.
  const targetPath: unknown = args.path ?? args.file_path ?? args.filepath;
  const searchTarget: unknown =
    args.search_snippet ?? args.search ?? args.old_code ?? args.search_pattern;
  const replaceTarget: unknown =
    args.replace_snippet ?? args.replace ?? args.new_code ?? args.replace_pattern ?? '';
  // ─────────────────────────────────────────────────────────────────────────────

  if (typeof targetPath !== 'string' || targetPath === '') {
    return { success: false, output: 'CRITICAL ERROR: "path" is required (alias accepted: file_path, filepath).' };
  }
  if (typeof searchTarget !== 'string' || searchTarget === '') {
    return { success: false, output: 'CRITICAL ERROR: search_snippet must be a non-empty string (aliases accepted: search, old_code, search_pattern).' };
  }
  if (typeof replaceTarget !== 'string') {
    return { success: false, output: 'CRITICAL ERROR: replace_snippet must be a string (aliases accepted: replace, new_code, replace_pattern). Use "" to delete.' };
  }

  const fp = safePath(workspacePath, targetPath);
  if (!fs.existsSync(fp)) {
    return { success: false, output: `File not found: ${targetPath}. Use list_dir to verify the path.` };
  }

  const original = fs.readFileSync(fp, 'utf-8');
  const match = findMatch(original, searchTarget);

  if (match.kind === 'none') {
    // ── v8.34.0: Auto-Read on MATCH ERROR (Panic Recovery rampa #1) ───────────
    // Instead of telling the agent "call read_file and try again" (which burns
    // an iteration and frequently fails again because the LLM re-hallucinates
    // from training memory), the engine itself injects the relevant file
    // content into the error output. Sized to fit a 200-line head + a ±10
    // line window around the best fuzzy candidate, so even large files keep
    // the payload compact while giving the LLM verbatim text to copy from.
    const HEAD_LINES = 200;
    const FUZZY_RADIUS = 10;
    const fileLines = original.replace(/\r\n/g, '\n').split('\n');
    const snipLineCount = searchTarget.replace(/\r\n/g, '\n').split('\n').length;

    let context: string;
    if (fileLines.length <= HEAD_LINES + 50) {
      context = formatNumberedLines(fileLines, 0);
    } else {
      const headChunk = formatNumberedLines(fileLines.slice(0, HEAD_LINES), 0);
      const fuzzyStart = findBestFuzzyCandidate(original, searchTarget);

      let fuzzyChunk = '';
      if (fuzzyStart !== null && fuzzyStart >= HEAD_LINES) {
        const start = Math.max(0, fuzzyStart - FUZZY_RADIUS);
        const end = Math.min(fileLines.length, fuzzyStart + snipLineCount + FUZZY_RADIUS);
        fuzzyChunk =
          `\n\n--- Best fuzzy candidate near line ${fuzzyStart + 1} ` +
          `(rejected — too dissimilar from your snippet) ---\n` +
          formatNumberedLines(fileLines.slice(start, end), start);
      }
      context = headChunk + fuzzyChunk;
    }

    return {
      success: false,
      output:
        `MATCH ERROR — search_snippet not found in ${targetPath}.\n\n` +
        `[v8.34.0 Auto-Read] Current file content (use this to copy the verbatim snippet — ` +
        `your memory of this file is stale):\n\n` +
        context +
        `\n\nRe-call search_and_replace with a snippet copied character-for-character from ` +
        `the lines above. Do NOT guess. If you need to inject a wholly new block of code ` +
        `that does not yet exist in this file, use insert_lines instead.`,
    };
    // ─────────────────────────────────────────────────────────────────────────
  }
  if (match.kind === 'ambiguous') {
    return {
      success: false,
      output: `AMBIGUOUS MATCH: search_snippet appears ${match.count} times in ${targetPath}.\n` +
              `Expand the snippet — add more surrounding lines to make the block unique.`,
    };
  }

  let updated: string;
  let removedPreview: string;
  let removedLines: number;
  let startLine: number;

  if (match.kind === 'strict') {
    const snip = searchTarget.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    updated = original.replace(/\r\n/g, '\n').replace(snip, replaceTarget.replace(/\n$/, ''));
    const before = original.replace(/\r\n/g, '\n').indexOf(snip);
    startLine = original.slice(0, before).split('\n').length;
    removedLines = snip.split('\n').length;
    removedPreview = snip.length > 300 ? snip.slice(0, 300) + '\n…(truncated)' : snip;
  } else {
    const fileLines = original.replace(/\r\n/g, '\n').split('\n');
    const newLines = replaceTarget === '' ? [] : replaceTarget.replace(/\n$/, '').split('\n');
    updated = [...fileLines.slice(0, match.start), ...newLines, ...fileLines.slice(match.end + 1)].join('\n');
    startLine = match.start + 1;
    removedLines = match.end - match.start + 1;
    const removed = fileLines.slice(match.start, match.end + 1).join('\n');
    removedPreview = removed.length > 300 ? removed.slice(0, 300) + '\n…(truncated)' : removed;
  }

  if (updated.trim() === '' && original.trim() !== '') {
    return { success: false, output: 'SAFETY ABORT: replacement would produce an empty file.' };
  }

  try {
    const backupDir = path.join(workspacePath, '.fluxo', 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(backupDir, `${path.basename(fp)}_${ts}.bak`), original, 'utf-8');
  } catch { /* non-fatal */ }

  fs.writeFileSync(fp, updated, 'utf-8');

  const matchNote = match.kind === 'fuzzy' ? ` [fuzzy match, line ${startLine}]` : ` [exact match, line ${startLine}]`;
  const diffBlock = buildDiffBlock(searchTarget, replaceTarget);
  return {
    success: true,
    output: `${diffBlock}\n\n**${targetPath}** — ${removedLines} line${removedLines !== 1 ? 's' : ''} replaced.${matchNote}\n\nCambio aplicado en el editor. Revisa el Diff arriba y presiona Ctrl+S en el archivo para guardar.\n\nEDICIÓN EXITOSA — Si la tarea no está completa, llama la siguiente herramienta.`,
  };
}

```

### 📁 FILE: `src\tools\SecurityAuditTool\index.ts`
```typescript
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { NativeTool, ToolResult } from '../shared';

// ─── SecurityAuditTool (v8.28.0 — DevSecOps Token-Free SAST) ────────────────
//
// Static security scanner that runs ENTIRELY in the extension host. Never
// ships repository content to any LLM. The contract with the agent: call
// this tool, read the short report, then act surgically on the findings via
// the existing edit/refactor tools.
//
// Two scanners run in sequence and their findings are concatenated into a
// single report:
//
//   A. Secret Scanner — recursive walk of the workspace (skipping
//      node_modules, .git, .fluxo, dist, build, out, .next, coverage,
//      .vscode, plus binary extensions). For each text file <= MAX_FILE_SIZE
//      bytes, every line is matched against the SECRET_PATTERNS table. A
//      hit emits one finding line: "<relpath>:<line> [<provider>] <preview>".
//      The preview is REDACTED — only the first 12 and last 4 chars survive
//      so the report itself does not become a secrets-disclosure.
//
//   B. NPM Audit — if package.json exists at the workspace root, runs
//      `npm audit --json` via execSync (silent stderr) with a hard timeout.
//      Parses the JSON envelope (npm 7+ format: metadata.vulnerabilities)
//      and reports only the High + Critical counts. Below those severities
//      the noise-to-signal ratio collapses (most npm advisories are dev-only
//      and unactionable inside an editor session).
//
// Output contract:
//   • If both scanners come back empty: "No security issues found. Code is clean."
//   • Otherwise: section headers SECRETS / DEPENDENCIES with bullet findings.
//
// Performance bounds (hard caps, not estimates):
//   • Max files walked        — 5000 (workspace cap, prevents monorepo blowups)
//   • Max walk depth          — 10
//   • Max file size scanned   — 1 MB (binaries / huge generated files skipped)
//   • Max secrets reported    — 200 (after that we stop appending — caller
//                               sees "+N more" footer)
//   • npm audit timeout       — 60 s (cold cache audit can be slow; beyond
//                               that it's almost certainly hung — give up
//                               gracefully and mention the timeout in output)
//
// Skipped extensions: every binary / artifact format we can identify by
// extension. The walker also skips files whose first 1KB contains a NUL
// byte (cheap heuristic to catch unknown-extension binaries — e.g. .pyc
// compiled blobs sitting in non-standard locations).

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.fluxo', 'dist', 'build', 'out',
  '.next', '.nuxt', '.cache', 'coverage', '.vscode', '.idea',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.tox',
]);

const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar',
  '.mp3', '.mp4', '.mov', '.avi', '.webm', '.wav',
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.pyc', '.class', '.jar', '.war',
  '.lock', '.vsix',
  '.map',  // sourcemaps — high false-positive rate, low signal
]);

interface SecretPattern {
  provider: string;
  re: RegExp;
}

// Patterns are ordered roughly by specificity — high-confidence prefixes
// (sk_live_, AKIA, ghp_, AIzaSy) first; the generic JWT / private key
// patterns last. Each `re` is constructed without the /g flag here; the
// scanLine helper iterates with .exec inside a manual loop.
const SECRET_PATTERNS: SecretPattern[] = [
  { provider: 'Stripe Live Secret Key',     re: /sk_live_[A-Za-z0-9]{24,}/ },
  { provider: 'Stripe Restricted Key',      re: /rk_live_[A-Za-z0-9]{24,}/ },
  { provider: 'Stripe Test Secret Key',     re: /sk_test_[A-Za-z0-9]{24,}/ },
  { provider: 'Google API Key (Firebase)',  re: /AIzaSy[A-Za-z0-9_-]{33}/ },
  { provider: 'GitHub Personal Access',     re: /ghp_[A-Za-z0-9]{36}/ },
  { provider: 'GitHub Fine-Grained PAT',    re: /github_pat_[A-Za-z0-9_]{82}/ },
  { provider: 'GitHub OAuth Token',         re: /gho_[A-Za-z0-9]{36}/ },
  { provider: 'AWS Access Key ID',          re: /\bAKIA[0-9A-Z]{16}\b/ },
  { provider: 'OpenAI API Key',             re: /sk-[A-Za-z0-9]{20,}/ },
  { provider: 'Anthropic API Key',          re: /sk-ant-[A-Za-z0-9_-]{40,}/ },
  { provider: 'Slack Token',                re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { provider: 'Slack Webhook URL',          re: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/ },
  { provider: 'Discord Webhook',            re: /discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/ },
  { provider: 'JSON Web Token',             re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { provider: 'Private Key (PEM)',          re: /-----BEGIN (?:RSA |OPENSSH |DSA |EC |PGP )?PRIVATE KEY-----/ },
];

const MAX_FILES        = 5000;
const MAX_DEPTH        = 10;
const MAX_FILE_SIZE    = 1_000_000;     // 1 MB
const MAX_SECRETS      = 200;
const NPM_AUDIT_TIMEOUT_MS = 60_000;

interface SecretHit {
  relpath: string;
  line: number;
  provider: string;
  redactedPreview: string;
}

// Redact a matched secret to "<first12>…<last4>" so the audit report itself
// is safe to paste into an LLM context, into a screenshot, or into a Slack
// thread. Short matches (< 16 chars total) get fully masked except first 4
// chars to preserve enough signal for triage.
function redactSecret(raw: string): string {
  if (raw.length <= 16) {
    return raw.slice(0, 4) + '…[redacted]';
  }
  return `${raw.slice(0, 12)}…${raw.slice(-4)}`;
}

function isLikelyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 1024));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) { return true; }
  }
  return false;
}

function scanFile(absPath: string, relpath: string, hits: SecretHit[]): void {
  let buf: Buffer;
  try {
    const stat = fs.statSync(absPath);
    if (stat.size === 0 || stat.size > MAX_FILE_SIZE) { return; }
    buf = fs.readFileSync(absPath);
  } catch {
    return;
  }
  if (isLikelyBinary(buf)) { return; }

  const text = buf.toString('utf-8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (hits.length >= MAX_SECRETS) { return; }
    const line = lines[i];
    if (line.length > 4000) { continue; } // skip pathological minified lines
    for (const pattern of SECRET_PATTERNS) {
      const match = pattern.re.exec(line);
      if (match) {
        hits.push({
          relpath,
          line: i + 1,
          provider: pattern.provider,
          redactedPreview: redactSecret(match[0]),
        });
        break; // one finding per line is enough — avoid double-reporting
      }
    }
  }
}

interface WalkState {
  filesWalked: number;
  hits: SecretHit[];
  workspacePath: string;
  reachedFileCap: boolean;
  reachedSecretCap: boolean;
}

function walkSecrets(dir: string, depth: number, state: WalkState): void {
  if (depth > MAX_DEPTH) { return; }
  if (state.filesWalked >= MAX_FILES) { state.reachedFileCap = true; return; }
  if (state.hits.length >= MAX_SECRETS) { state.reachedSecretCap = true; return; }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (state.filesWalked >= MAX_FILES) { state.reachedFileCap = true; return; }
    if (state.hits.length >= MAX_SECRETS) { state.reachedSecretCap = true; return; }
    const name = entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(name)) { continue; }
      walkSecrets(path.join(dir, name), depth + 1, state);
      continue;
    }
    if (!entry.isFile()) { continue; }
    const ext = path.extname(name).toLowerCase();
    if (SKIP_EXTENSIONS.has(ext)) { continue; }
    state.filesWalked++;
    const absPath = path.join(dir, name);
    const relpath = path.relative(state.workspacePath, absPath).replace(/\\/g, '/');
    scanFile(absPath, relpath, state.hits);
  }
}

interface NpmAuditSummary {
  ran: boolean;
  high: number;
  critical: number;
  totalAdvisories: number;
  error?: string;
}

function runNpmAudit(workspacePath: string): NpmAuditSummary {
  const pkgPath = path.join(workspacePath, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { ran: false, high: 0, critical: 0, totalAdvisories: 0 };
  }

  let raw: string;
  try {
    // npm audit exits with code 1 when vulnerabilities exist, which causes
    // execSync to throw — we still want the JSON body in that case, so we
    // catch and read err.stdout. The audit JSON is on stdout regardless of
    // exit code.
    raw = execSync('npm audit --json', {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: NPM_AUDIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 8,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err: any) {
    raw = err?.stdout ? String(err.stdout) : '';
    if (!raw && err?.code === 'ETIMEDOUT') {
      return { ran: true, high: 0, critical: 0, totalAdvisories: 0, error: 'npm audit timed out (60s) — registry unreachable or huge dep tree' };
    }
    if (!raw) {
      return { ran: true, high: 0, critical: 0, totalAdvisories: 0, error: `npm audit failed: ${err?.message ?? String(err)}` };
    }
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ran: true, high: 0, critical: 0, totalAdvisories: 0, error: 'npm audit returned non-JSON output' };
  }

  // npm 7+ shape: { metadata: { vulnerabilities: { info, low, moderate, high, critical, total } } }
  const v = parsed?.metadata?.vulnerabilities ?? {};
  return {
    ran: true,
    high: typeof v.high === 'number' ? v.high : 0,
    critical: typeof v.critical === 'number' ? v.critical : 0,
    totalAdvisories: typeof v.total === 'number' ? v.total : 0,
  };
}

function buildReport(hits: SecretHit[], walkState: WalkState, audit: NpmAuditSummary): string {
  const sections: string[] = [];

  if (hits.length > 0) {
    const header = `SECRETS — ${hits.length} hardcoded secret(s) detected:`;
    const bullets = hits.map(h => `- ${h.relpath}:${h.line} [${h.provider}] ${h.redactedPreview}`);
    if (walkState.reachedSecretCap) {
      bullets.push(`- …(stopped at MAX_SECRETS=${MAX_SECRETS}; rerun after fixing the first batch)`);
    }
    sections.push([header, '', ...bullets].join('\n'));
  }

  if (audit.ran && (audit.high > 0 || audit.critical > 0)) {
    const lines = [
      `DEPENDENCIES (npm audit) — ${audit.critical} critical, ${audit.high} high (${audit.totalAdvisories} total advisories)`,
      '',
      `- Run \`npm audit\` in the terminal for the full list and \`npm audit fix\` to auto-patch what is safely updatable.`,
      `- For breaking patches, review the advisory before forcing the upgrade.`,
    ];
    sections.push(lines.join('\n'));
  } else if (audit.ran && audit.error) {
    sections.push(`DEPENDENCIES (npm audit) — ${audit.error}`);
  }

  if (sections.length === 0) {
    return 'No security issues found. Code is clean.';
  }

  const footer: string[] = [];
  if (walkState.reachedFileCap) {
    footer.push(`(walked ${walkState.filesWalked} files — workspace cap of ${MAX_FILES} reached; some files were not scanned)`);
  }

  return [
    `[security_audit] ${hits.length} secret(s) + ${audit.high + audit.critical} high/critical dependency advisor(ies):`,
    '',
    ...sections.map(s => s + '\n'),
    ...footer,
  ].join('\n').trim();
}

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'security_audit',
    description:
      'Static Application Security Testing (SAST) scanner that runs ENTIRELY in the extension host. ' +
      'Never sends repository content to any LLM — only the short findings report. ' +
      'TWO scanners: (A) Secret Scanner walks the workspace (skipping node_modules / .git / .fluxo / ' +
      'dist / build / out / .next / coverage and binary extensions) matching every line against a ' +
      'curated table of known secret formats (Stripe, Firebase/Google, GitHub PAT, AWS, OpenAI, ' +
      'Anthropic, Slack, JWT, PEM private keys, etc.). Reports file:line plus a REDACTED preview of ' +
      'each match — the report itself never leaks the secret. (B) NPM Audit runs `npm audit --json` ' +
      'silently if package.json exists, returns only the High + Critical counts. ' +
      'WHEN TO USE: any user request to "audit", "scan for vulnerabilities", "find leaked secrets", ' +
      '"check for exposed API keys", or "run a security review". ' +
      'WHEN NOT TO USE: do not call as part of unrelated tasks — the scanner walks up to 5000 files ' +
      'and runs npm audit which can take 30-60s on a cold cache. ' +
      'NO PARAMETERS — the tool always scans the workspace root.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
};

export function execute(_args: Record<string, any>, workspacePath: string): ToolResult {
  if (!workspacePath) {
    return { success: false, output: 'security_audit: no workspace open.' };
  }

  const walkState: WalkState = {
    filesWalked: 0,
    hits: [],
    workspacePath,
    reachedFileCap: false,
    reachedSecretCap: false,
  };

  try {
    walkSecrets(workspacePath, 0, walkState);
  } catch (err: any) {
    return { success: false, output: `security_audit: secret-scan failed: ${err?.message ?? String(err)}` };
  }

  const audit = runNpmAudit(workspacePath);
  const report = buildReport(walkState.hits, walkState, audit);

  // Success regardless of findings — the agent needs the report either way.
  // Failure status is reserved for the tool itself crashing (caught above).
  return { success: true, output: report };
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

