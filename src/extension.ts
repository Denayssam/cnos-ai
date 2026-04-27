import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { runAgentLoop, ChatMessage, EngineConfig, summarizeHistory } from './agentEngine';
import { routeToAgent, getAgentList } from './agents';
import { Sentinel } from './sentinel';

// ─── State Management ─────────────────────────────────────────────────────────

let _panel: vscode.WebviewPanel | undefined;
let _conversationHistory: ChatMessage[] = [];
let _currentAbortController: AbortController | undefined;
let _extensionUri: vscode.Uri;
let _context: vscode.ExtensionContext;
let _sentinel: Sentinel | undefined;
let _sentinelHasError = false;

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

function cleanupLogsOnActivation(): void {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) { return; }
  const wsPath = folders[0].uri.fsPath;

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
      if (msg.text && msg.model) {
        const txt = msg.text.trim().toLowerCase();
        if (txt === '/new' || txt === '/clear') {
          _conversationHistory = [];
          context.workspaceState.update(STORAGE_KEY, []);
          _postToPanel({ type: 'chatCleared' });
          break;
        }
        _handleSendMessage(msg.text, msg.model, context).catch(e => {
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

    case 'saveModel':
      if (msg.model) { context.globalState.update('fluxo.selectedModel', msg.model); }
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

async function _handleSendMessage(userText: string, model: string, context: vscode.ExtensionContext): Promise<void> {
  const config = await _buildConfig();
  config.model = model;

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

    const nativeEditCallback = async (relPath: string, searchSnippet: string, replaceSnippet: string) =>
      applyNativeEdit(relPath, searchSnippet, replaceSnippet, workspacePath);

    for await (const event of runAgentLoop(
      userText,
      agentId,
      _conversationHistory,
      engineConfig,
      workspacePath,
      _currentAbortController.signal,
      _sentinelHasError,
      approvalCallback,
      nativeEditCallback
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
  apiKey: string; model: string; maxTokens: number; streamingEnabled: boolean;
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
  return {
    apiKey,
    deepseekApiKey: deepseekApiKey || undefined,
    geminiApiKey: geminiApiKey || undefined,
    model: savedModel || vscodeConfig.get<string>('defaultModel') || 'google/gemini-2.5-flash',
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
      <span class="header-subtitle">v7.9.8</span>
      <span id="agent-badge" class="agent-badge hidden"></span>
    </div>
    <div class="header-right">
      <select id="model-select" class="model-select"></select>
      <button id="sentinel-btn" class="header-btn sentinel-btn" title="Sentinel Guard — Protege contra comandos peligrosos. Click para activar/desactivar."><span class="sentinel-icon">👁</span><span class="sentinel-label">Guard</span></button>
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

// ─── Activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  _extensionUri = context.extensionUri;
  _context = context;

  // Initialize conversation persistence
  _conversationHistory = context.workspaceState.get<ChatMessage[]>(STORAGE_KEY) || [];

  // Session cleanup — trim logs and prune old backups on every new session
  cleanupLogsOnActivation();

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
      _handleSendMessage(msg, config.model, context).catch(console.error);
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
    })
  );

  // Re-send model list when API keys change so dropdown updates live
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async e => {
      if (e.affectsConfiguration('fluxo') && _panel) {
        const models = await _buildModelList();
        const cfg = await _buildConfig();
        _postToPanel({ type: 'modelsUpdate', models, model: cfg.model });
      }
    })
  );

  console.log('[Fluxo AI] v7.9.8 — Auto-Save & Git Safety Net');
}

export function deactivate(): void {
  _currentAbortController?.abort();
}
