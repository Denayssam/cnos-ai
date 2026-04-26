import * as fs from 'fs';
import * as path from 'path';
import { executeTool, getNativeTools, NativeTool } from './tools';
import { AGENTS, buildAgentSystemPrompt, ROUTER_PROMPT, REVISOR_PROMPT, SUMMARIZER_PROMPT } from './agents';

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
  model: string;
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
  nativeEditCallback?: (filePath: string, searchSnippet: string, replaceSnippet: string) => Promise<{ success: boolean; output: string }>
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
  const agentTools: NativeTool[] = getNativeTools(agent.tools);

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

  const messages: ChatMessage[] = [
    { role: 'system', content: buildAgentSystemPrompt(agentId) },
    ...prunedHistory,
    { role: 'user', content: userMessage },
  ];

  let iterations = 0;
  const toolCallHistory: string[] = [];
  let buildFailureCtx = '';
  let lastEditedFile: string | null = null;
  let consecutiveGhostCount = 0;
  let ghostRetries = 0;
  let planCheckCount = 0;

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

    // API call — streaming when enabled (fallback to blocking if tools present)
    let apiResponse: ApiResponse;
    let alreadyStreamedText = false;
    try {
      if (config.streamingEnabled) {
        const textChunks: string[] = [];
        apiResponse = await callOpenRouterStreaming(
          messages, config, abortSignal, agentTools,
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
        apiResponse = await callOpenRouterBlocking(messages, config, abortSignal, agentTools, consecutiveGhostCount > 0);
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

    // Emit text only if not already yielded chunk-by-chunk above
    if (!alreadyStreamedText && textContent.trim()) {
      yield { type: 'streamChunk', text: textContent };
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
      // Allow clean exit if the agent explicitly confirmed plan completion.
      if (textContent && /\bALL\s+STEPS\s+COMPLETE\b/i.test(textContent)) {
        debugLog(workspacePath, 'Plan Verification: ALL STEPS COMPLETE confirmed — exiting loop');
        yield { type: 'streamEnd' };
        return;
      }
      // If an IMPLEMENTATION_PLAN.md is active, ask the agent to verify progress
      // before allowing a no-tool exit. Guard with planCheckCount to prevent infinite loop.
      if (planCheckCount === 0 && workspacePath) {
        const planFilePath = path.join(workspacePath, 'IMPLEMENTATION_PLAN.md');
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
        /ORCHESTRATOR'S REPORT/i,
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
      if (ghostRetries < 2) {
        ghostRetries++;
        debugLog(workspacePath, `Action enforcement #${ghostRetries} — no tools returned, injecting directive`);
        yield { type: 'thinking', text: `⚡ Enforcing action (retry ${ghostRetries}/2)…` };
        await new Promise<void>(resolve => setTimeout(resolve, 2000));
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

      const priorHistory = toolCallHistory.length > 0
        ? `\n\nPRIOR COMPLETED TOOLS (already executed successfully in this session — account for these before judging the current batch):\n${toolCallHistory.map((h, i) => `${i + 1}. ${h}`).join('\n')}`
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

      // Register in history (pre-flight check for future iterations)
      toolCallHistory.push(`${toolName}:${JSON.stringify(args)}`);

      // Display
      const displayArgs = Object.entries(args)
        .filter(([k]) => k !== 'content')
        .map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`)
        .join(', ');
      yield { type: 'toolCall', name: toolName, args, displayArgs };

      // Execute
      const startTime = Date.now();
      let result: { success: boolean; output: string };
      try {
        if (toolName === 'ask_user_approval' && approvalCallback) {
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
        } else {
          result = executeTool(toolName, args, workspacePath);
        }
      } catch (err: any) {
        result = { success: false, output: `[SYSTEM ENGINE ERROR]: ${err.message ?? String(err)}` };
      }
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      yield { type: 'toolResult', name: toolName, success: result.success, output: result.output, duration };
      debugLog(workspacePath, `Tool ${toolName}: success=${result.success}${!result.success ? ` — ${result.output.slice(0, 300)}` : ''}`);

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
      const planFilePath = (args.path as string || '').replace(/\\/g, '/').toLowerCase();
      const isPlanBrake = result.success && (
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
        !result.output.includes('[SYSTEM ENGINE ERROR]'))
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
