import * as fs from 'fs';
import * as path from 'path';
import { executeTool, getNativeTools, NativeTool } from './tools';
import { AGENTS, buildAgentSystemPrompt, ROUTER_PROMPT, REVISOR_PROMPT, SUMMARIZER_PROMPT } from './agents';
import { AgentMailbox } from './utils/agentMailbox';

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

const MAX_LOG_SIZE = 2 * 1024 * 1024;

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
  replaceSymbolCallback?: (filePath: string, symbolName: string, newCode: string) => Promise<{ success: boolean; output: string }>
): AsyncGenerator<AgentEvent> {

  // 1. Intent Detection (Routing)
  yield { type: 'thinking', text: 'Detecting intent…' };
  let agentId = initialAgentId;

  try {
    const detectedId = await detectIntent(userMessage, config, abortSignal);
    if (detectedId && AGENTS[detectedId]) { agentId = detectedId; }
  } catch (err) {
    console.error('[Engine] Intent detection failed, falling back to keywords:', err);
  }

  const agent = AGENTS[agentId] || AGENTS.coder;
  let agentTools: NativeTool[] = getNativeTools(agent.tools);
  if (mcpTools && mcpTools.length > 0) {
    agentTools.push(...mcpTools);
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

  const baseSystemPrompt = buildAgentSystemPrompt(agentId);
  let systemPrompt = workspaceMemoryBlock
    ? baseSystemPrompt + workspaceMemoryBlock
    : baseSystemPrompt;

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

  while (iterations < MAX_ITERATIONS) {
    if (abortSignal.aborted) {
      yield { type: 'error', message: '⊘ Cancelled by user' };
      return;
    }

    iterations++;
    debugLog(workspacePath, `--- Iteration ${iterations}/${MAX_ITERATIONS} ---`);
    yield { type: 'iterationCount', count: iterations, max: MAX_ITERATIONS };
    yield { type: 'thinking', text: iterations === 1 ? `Agent ${agent.name} is planning…` : `Iteration ${iterations}: processing…` };

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

      // Display
      const displayArgs = Object.entries(args)
        .filter(([k]) => k !== 'content')
        .map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`)
        .join(', ');
      yield { type: 'toolCall', name: toolName, args, displayArgs };

      // ── Worktree Path Redirect (v8.8.0) ──────────────────────────────────────
      // When a git worktree is active, ALL file and command operations are silently
      // redirected to the worktree directory. The LLM uses normal relative paths
      // (e.g. "src/App.tsx") and the engine maps them transparently — no prefix needed.
      // Worktree management tools and planning tools always use the main workspace.
      const _wtExcluded = toolName === 'enter_worktree' || toolName === 'exit_worktree' ||
                          toolName === 'skill' || toolName === 'enter_plan_mode';
      const effectiveWorkspacePath = (activeWorktreePath && !_wtExcluded)
        ? activeWorktreePath
        : workspacePath;
      if (activeWorktreePath && effectiveWorkspacePath !== workspacePath) {
        debugLog(workspacePath, `[Worktree Redirect] ${toolName} → ${effectiveWorkspacePath}`);
      }
      // ─────────────────────────────────────────────────────────────────────────

      // Execute
      const startTime = Date.now();
      let result: { success: boolean; output: string };
      try {
        if (pathNormError) {
          result = { success: false, output: pathNormError };
        } else if (toolName === 'ask_user_approval' && approvalCallback) {
          yield { type: 'thinking', text: '🛡️ Bodyguard aguardando tu aprobación…' };
          const approved = await approvalCallback(
            String(args.intent_summary ?? ''),
            String(args.reason_and_files ?? '')
          );
          result = {
            success: approved,
            output: approved
              ? 'USER APPROVED. Proceed with the planned tools.'
              : 'USER REJECTED. Stop all planned actions. Ask the user a focused clarifying question in plain text — do NOT call any edit tools.',
          };
        } else if (toolName === 'search_and_replace' && nativeEditCallback) {
          yield { type: 'thinking', text: '🔍 Applying VS Code native edit…' };
          result = await nativeEditCallback(
            String(args.path ?? ''),
            String(args.search_snippet ?? ''),
            String(args.replace_snippet ?? '')
          );
          // ── Smart Failure Interceptor ──────────────────────────────────────
          // Inject an engine-level hint BEFORE the Circuit Breaker can fire,
          // steering the agent toward get_code_structure instead of blind retry.
          if (!result.success) {
            result = {
              ...result,
              output: result.output +
                '\n\nCONSEJO DEL MOTOR: El texto no coincide exactamente. ' +
                'Las causas más comunes son: indentación cambiada, líneas insertadas/eliminadas, o espacios invisibles. ' +
                'SIGUIENTE PASO OBLIGATORIO: llama get_code_structure sobre el archivo para obtener el mapa de líneas actualizado, ' +
                'luego usa read_file con el rango exacto (start_line/end_line) para ver el bloque real antes de reintentar.',
            };
          }
          // ──────────────────────────────────────────────────────────────────
        } else if (toolName === 'get_code_structure' && getCodeStructureCallback) {
          yield { type: 'thinking', text: '🔭 Extracting code structure via LSP…' };
          result = await getCodeStructureCallback(String(args.absolute_path ?? ''));
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

          const plannerEventBuffer: AgentEvent[] = [];
          const plannerGen = runAgentLoop(
            `MISSION — ANALYSIS ONLY:\nAnalyze the codebase and produce .fluxo/IMPLEMENTATION_PLAN.md for this task:\n\n${taskDescription}`,
            'planner',
            [],
            { ...effectiveConfig, model: config.workerModel || config.model },
            workspacePath,
            abortSignal,
            false,
            undefined,              // no approval callback — planner never asks for approval
            undefined,              // no native edit
            getCodeStructureCallback,
            mcpTools,
            callMcpToolCallback,
            undefined,              // no worktree review
            undefined               // no replace symbol
          );

          for await (const event of plannerGen) {
            plannerEventBuffer.push(event);
          }

          yield { type: 'thinking', text: '━━━ @planner — codebase analysis ━━━' };
          for (const event of plannerEventBuffer) { yield event; }

          const planFile = path.join(workspacePath, '.fluxo', 'IMPLEMENTATION_PLAN.md');
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
                `ERROR: @planner did not produce .fluxo/IMPLEMENTATION_PLAN.md. ` +
                `Retry with a more specific task_description, or delegate directly with create_team.`,
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
                replaceSymbolCallback
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
          }
        }
      } else {
        toolFailureTracker.delete(toolName);
        // Stateless Auditor: only commit to Sherlock's prior-state history on success.
        // Failed calls stay in toolCallHistory (loop detection) but never reach Sherlock,
        // preventing false REDUNDANT_DECLARATION positives on legitimate retries.
        successfulToolCallHistory.push(`${toolName}:${JSON.stringify(args)}`);

        // ── Worktree State Sync (v8.8.0) ────────────────────────────────────────
        if (toolName === 'enter_worktree') {
          try {
            const wts = JSON.parse(fs.readFileSync(wtStateFile, 'utf-8'));
            activeWorktreePath = wts.worktreePath || null;
            debugLog(workspacePath, `[Worktree] Activated: ${wts.branchName} → ${activeWorktreePath}`);
          } catch { /* state file not written — no worktree context */ }
        } else if (toolName === 'exit_worktree') {
          activeWorktreePath = null;
          debugLog(workspacePath, '[Worktree] Deactivated — path redirect cleared');
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
