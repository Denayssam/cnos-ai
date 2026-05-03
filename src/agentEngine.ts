import * as fs from 'fs';
import * as path from 'path';
import { executeTool, getNativeTools, NativeTool } from './tools';
import { stripWorktreePrefix } from './tools/shared';
import { compactToolFailures } from './utils/condenser';
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

interface ApiResponse {
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
// (set by mcpClient.inferCategories) overlap the role's allow-set. Tools with
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
  mcpToolCategories: Record<string, string[]> = {}
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
  // and the per-tool category map produced by mcpClient.inferCategories.
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

  // Workspace Memory injection — read .fluxo/memory.md once per session
  let workspaceMemoryBlock = '';
  if (workspacePath) {
    const memoryFilePath = path.join(workspacePath, '.fluxo', 'memory.md');
    try {
      if (fs.existsSync(memoryFilePath)) {
        const memoryContent = fs.readFileSync(memoryFilePath, 'utf-8').trim();
        if (memoryContent) {
          workspaceMemoryBlock =
            '\n\n--- WORKSPACE MEMORY & RULES ---\n' +
            'The following rules and conventions were set by the user for this workspace. ' +
            'They are BINDING — apply them automatically on every task without being asked:\n\n' +
            memoryContent +
            '\n--- END OF WORKSPACE MEMORY ---';
          debugLog(workspacePath, `Workspace memory loaded: ${memoryContent.length} chars`);
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
  let consecutiveBuildFailures = 0;  // ── v8.16.1: Quality Gate circuit breaker counter
  let bypassQualityGate = false;     // ── v8.16.1: set to true when user approves bypass

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
              mcpToolCategories
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
        // ── v8.16.0/8.16.1: Quality Gate + Escape Hatch ──────────────────────
        if (workspacePath && toolCallHistory.length > 0 && !buildFailureCtx && !bypassQualityGate) {
          yield { type: 'thinking', text: '🏗️ Quality Gate: validating build before completion…' };
          const qgResult = await validateBuild(workspacePath);
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
        const qgResult = await validateBuild(workspacePath);
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

      // ── Rabbit Hole Hard Block (v8.16.23) ────────────────────────────────────
      // When a build/runtime error appears, the @coder occasionally drifts into
      // inspecting node_modules/ instead of rolling back its own edits. Blocks
      // any read/search/terminal tool whose args reference node_modules as a
      // path segment. Whole-word boundary check so filenames like
      // "node_modules_check.ts" still pass through.
      const _rabbitHoleGated = toolName === 'read_file' || toolName === 'grep' ||
                               toolName === 'glob' || toolName === 'search_and_replace' ||
                               toolName === 'run_command';
      if (_rabbitHoleGated) {
        const _rabbitRe = /(?:^|[\/\\\s"'`])node_modules(?:[\/\\\s"'`]|$)/i;
        const _rabbitHit = Object.values(args).some(
          v => typeof v === 'string' && _rabbitRe.test(v)
        );
        if (_rabbitHit) {
          const _rhMsg =
            "[SYSTEM BLOCK] RABBIT HOLE DETECTED. You are strictly forbidden from " +
            "inspecting or debugging 'node_modules/'. The bug is in your own code, " +
            "not in the external libraries. Look at the files you just modified.";
          debugLog(workspacePath, `[Rabbit Hole] ${toolName} blocked — args referenced node_modules`);
          yield { type: 'toolResult', name: toolName, success: false, output: _rhMsg };
          messages.push({ role: 'tool', tool_call_id: tc.id, name: toolName, content: _rhMsg });
          continue;
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
          // ── ask_user_approval Hard Intercept (v8.16.20) ─────────────────────
          // ALWAYS intercept before executeTool. There is no native handler for
          // ask_user_approval — letting it fall through would crash the loop
          // with [SYSTEM ENGINE ERROR] and trigger an infinite retry. If the
          // approvalCallback is wired (real UI flow), pause the agent and hand
          // control to the human. If not (headless / test mode), fail loudly
          // with explicit guidance so the agent does NOT loop on the same call.
          const _intent = String(args.intent_summary ?? '');
          const _reason = String(args.reason_and_files ?? '');
          if (approvalCallback) {
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

          // ── v8.16.5: Mandatory Output Enforcement Loop ──────────────────────────
          // The planner has historically suffered from "premature termination" — yielding
          // conversational text instead of calling write_file. We now wrap the sub-loop
          // in a retry harness that physically verifies the file exists after each pass.
          // If missing, we re-invoke the planner with an escalating SYSTEM directive.
          const MAX_PLANNER_ATTEMPTS = 3;
          let plannerAttempt = 0;
          let plannerMission =
            `MISSION — ANALYSIS ONLY:\nAnalyze the codebase and produce .fluxo/IMPLEMENTATION_PLAN.md for this task:\n\n${taskDescription}`;

          while (plannerAttempt < MAX_PLANNER_ATTEMPTS && !fs.existsSync(planFile)) {
            plannerAttempt++;
            if (plannerAttempt > 1) {
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

            const plannerEventBuffer: AgentEvent[] = [];
            const plannerGen = runAgentLoop(
              plannerMission,
              'planner',
              [],
              { ...effectiveConfig, model: config.model },
              workspacePath,
              abortSignal,
              false,
              undefined,              // no approval callback — planner never asks for approval
              undefined,              // no native edit
              getCodeStructureCallback,
              mcpTools,
              callMcpToolCallback,
              undefined,              // no worktree review
              undefined,              // no replace symbol
              undefined,              // no HITL — planner is read-only
              mcpToolCategories       // v8.19.0 — RBAC filter will deny unknown-category tools to planner
            );

            for await (const event of plannerGen) {
              plannerEventBuffer.push(event);
            }

            const headerLabel = plannerAttempt === 1
              ? '━━━ @planner — codebase analysis ━━━'
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
                mcpToolCategories        // v8.19.0 — each sub-agent re-applies its own RBAC filter
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

async function callOpenRouterBlocking(
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
