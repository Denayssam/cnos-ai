# 📦 APP MANIFEST
* **App Name:** fluxo-ai
* **Version:** 8.9.0
* **Stack:** Vanilla JS
* **Part:** 7
* **Generated At:** 2026-04-29T19:52:51.106Z

---

### 📁 FILE: `src\extension.ts`
```typescript
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import { runAgentLoop, ChatMessage, EngineConfig, summarizeHistory } from './agentEngine';
import { routeToAgent, getAgentList } from './agents';
import { Sentinel } from './sentinel';
import { McpSwarmClient } from './mcpClient';

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
      replaceSymbolCallback
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
      <span class="header-subtitle">v8.9.0</span>
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

  _mcpClient = new McpSwarmClient();
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

  console.log('[Fluxo AI] v8.9.0 — Semantic Awareness: RepoMap injected into @coder and @manager');
}

export function deactivate(): void {
  _currentAbortController?.abort();
  _mcpClient?.destroy();
}

```

### 📁 FILE: `src\mcpClient.ts`
```typescript
import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { NativeTool } from './tools';

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export class McpSwarmClient {
  private clients: Map<string, Client> = new Map();
  private transports: Map<string, StdioClientTransport> = new Map();

  private cachedTools: NativeTool[] = [];
  private isInitialized = false;

  public initialize() {
    this._initializeAsync().catch(err => console.error("[Fluxo MCP] Init error:", err));
  }

  private async _initializeAsync() {
    const config = vscode.workspace.getConfiguration('fluxo').get<Record<string, McpServerConfig>>('mcpServers');
    if (!config || Object.keys(config).length === 0) {
      this.isInitialized = true;
      return;
    }

    for (const [serverName, serverConfig] of Object.entries(config)) {
      try {
        const transport = new StdioClientTransport({
          command: serverConfig.command,
          args: serverConfig.args,
          env: { ...process.env, ...serverConfig.env } as Record<string, string>
        });

        const client = new Client(
          { name: 'fluxo-ai', version: '7.17.1' },
          { capabilities: {} }
        );

        await Promise.race([
          client.connect(transport),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 5000))
        ]);

        this.clients.set(serverName, client);
        this.transports.set(serverName, transport);
        console.log(`[Fluxo MCP] Connected to server: ${serverName}`);
      } catch (err: any) {
        console.error(`[Fluxo MCP] Failed to connect to server ${serverName}:`, err);
      }
    }

    await this._cacheTools();
    this.isInitialized = true;
  }

  private async _cacheTools() {
    const allTools: NativeTool[] = [];
    for (const [serverName, client] of this.clients.entries()) {
      try {
        const response = await Promise.race([
          client.listTools(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('listTools timeout')), 5000))
        ]) as any;
        for (const t of response.tools) {
          allTools.push({
            type: 'function',
            function: {
              name: `mcp_${serverName}_${t.name}`,
              description: `[MCP Server: ${serverName}] ${t.description || ''}`,
              parameters: (t.inputSchema as any) || { type: 'object', properties: {} }
            }
          });
        }
      } catch (err) {
        console.error(`[Fluxo MCP] Failed to list tools for ${serverName}:`, err);
      }
    }
    this.cachedTools = allTools;
  }

  public getMcpTools(): NativeTool[] {
    return this.cachedTools;
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
import { NativeTool, ToolResult, safePath } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'delete_dir',
    description: 'Delete a directory and all its contents recursively. Safer than run_command for deletions.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the directory to delete.' },
      },
      required: ['path'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const dp = safePath(workspacePath, args.path);
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
import { NativeTool, ToolResult, safePath } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'delete_file',
    description: 'Delete a single file from the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to delete.' },
      },
      required: ['path'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const fp = safePath(workspacePath, args.path);
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
      'The planner is read-only — it only writes the plan file.',
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
  // ── Validate git repo ─────────────────────────────────────────────────────
  try {
    cp.execSync('git rev-parse --is-inside-work-tree', { cwd: workspacePath, stdio: 'pipe' });
  } catch {
    return {
      success: false,
      output: 'EnterWorktree: This workspace is not a git repository. git worktree requires git init.',
    };
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
  try {
    cp.execSync(
      `git merge "${branchName}" --no-ff -m "Merge worktree '${branchName}': ${commitMsg}"`,
      { cwd: workspacePath, stdio: 'pipe' }
    );
  } catch (e: any) {
    const stderr = (e.stderr?.toString() || e.message || '').slice(0, 400);
    return {
      success: false,
      output:
        `ExitWorktree (merge): git merge failed:\n${stderr}\n\n` +
        `Likely merge conflicts. Resolve them manually, or call exit_worktree with action='discard' to abort.`,
    };
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
import { NativeTool, ToolResult, safePath } from '../shared';

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

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Create or fully overwrite a file with the given content. Only use for NEW files — for existing files, always use edit_file to avoid overwriting unrelated code.',
    parameters: {
      type: 'object',
      properties: {
        path:     { type: 'string', description: 'File path relative to workspace root.' },
        content:  { type: 'string', description: 'Complete file content to write.' },
        agent_id: { type: 'string', description: 'Unique identifier of the calling agent (e.g. "coder-1", "designer-2"). Used by the File Lock Manager to track ownership. Required when running in parallel orchestration mode.' },
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
import { NativeTool, ToolResult } from '../shared';

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
          description: 'Absolute path to the file to analyze (e.g., /workspace/src/App.tsx).',
        },
      },
      required: ['absolute_path'],
    },
  },
};

// Actual execution is handled by the getCodeStructureCallback in extension.ts (requires VS Code API).
export function execute(_args: Record<string, any>, _workspacePath: string): ToolResult {
  return {
    success: false,
    output: '[SYSTEM]: get_code_structure requires the VS Code extension host. This tool cannot run outside of VS Code.',
  };
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
import { ToolResult, NativeTool } from './shared';

export { ToolResult, NativeTool };

// ─── Tool Registry ────────────────────────────────────────────────────────────

const ALL_TOOLS = [
  FileReadTool,
  FileWriteTool,
  SearchReplaceTool,
  ReplaceLinesTool,
  ReplaceBlockTool,
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
import { NativeTool, ToolResult, safePath } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'propose_plan',
    description: 'Create an IMPLEMENTATION_PLAN.md for complex tasks. Use this before making major changes to align on approach.',
    parameters: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'Full markdown content of the implementation plan.' },
      },
      required: ['plan'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const plan = args.plan as string;
  if (!plan) { return { success: false, output: 'Plan content is required.' }; }
  const fp = safePath(workspacePath, 'IMPLEMENTATION_PLAN.md');
  fs.writeFileSync(fp, plan, 'utf-8');
  return { success: true, output: 'IMPLEMENTATION_PLAN.md created. Please review it and confirm if I should proceed.' };
}

```

### 📁 FILE: `src\tools\ReplaceBlockTool\index.ts`
```typescript
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeTool, ToolResult, safePath } from '../shared';
import { FileLockManager } from '../../utils/lockfile';

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
          output: `CRITICAL SYNTAX ERROR: Llaves desequilibradas (${openCount} "{" vs ${closeCount} "}"). El archivo NO fue modificado.\n` +
                  `ANTI-PANIC DIRECTIVE: No reenvíes el mismo bloque. Divide la inserción.\n` +
                  `Si estás arreglando un archivo YA corrupto, usa "healing_mode: true".`,
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
          output: `CRITICAL SYNTAX ERROR: AST/JSX Corruption detected. Etiquetas HTML/JSX desbalanceadas. El archivo NO fue modificado.\n` +
                  `ESTRATEGIA: Asegúrate de incluir el bloque JSX completo desde su apertura hasta su cierre en search_snippet.\n` +
                  `Si estás arreglando un archivo YA corrupto, usa "healing_mode: true".`,
        };
      }
    }
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
          output: `CRITICAL SYNTAX ERROR: Tu 'new_content' tiene llaves desequilibradas (${openCount} "{" vs ${closeCount} "}"). El archivo NO fue modificado.\nANTI-PANIC DIRECTIVE: ESTÁ ESTRICTAMENTE PROHIBIDO enviar el mismo código de nuevo. Tu bloque es demasiado grande.\nNUEVA ESTRATEGIA OBLIGATORIA: Divide la inserción. Primero inserta solo el esqueleto vacío del componente o función. En la SIGUIENTE iteración, rellena el contenido. No intentes inyectar más de 20 líneas de lógica de una sola vez.\nSi estás intentando arreglar un archivo YA corrupto, usa "healing_mode: true" para desactivar los guards.`,
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
          output: `CRITICAL SYNTAX ERROR: AST/JSX Corruption detected. Etiquetas HTML/JSX desbalanceadas. El archivo NO fue modificado. ESTRATEGIA: Selecciona el bloque JSX completo desde su apertura hasta su cierre.\nSi estás intentando arreglar un archivo YA corrupto, usa "healing_mode: true" para desactivar los guards.`,
        };
      }
    }
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

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'run_command',
    description:
      'Execute a shell command in the workspace directory. ' +
      'On Windows use Windows commands (dir, del, move, copy) — never Linux commands (ls, rm -rf, mv, cp). ' +
      'Always quote paths that contain spaces. ' +
      'WORKTREE NOTE: If a Git Worktree is active, do NOT use "cd" to navigate into it. ' +
      'All native tools (read_file, run_command, replace_block) already operate on the correct ' +
      'workspace context automatically — attempting "cd <worktree-path>" will break the working directory.',
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
  try {
    const output = execSync(cmd, {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout,
      maxBuffer: 1024 * 1024 * 4,
    });
    return { success: true, output: output || '(command completed with no output)' };
  } catch (err: any) {
    // execSync throws on non-zero exit — capture both stdout and stderr from the error object
    const stdout = err.stdout ? String(err.stdout).trim() : '';
    const stderr = err.stderr ? String(err.stderr).trim() : '';
    const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
    return { success: false, output: combined || err.message || 'Command failed with no output' };
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
PREFERRED EDITING TOOL: Use this instead of replace_lines or replace_block for all code edits.
STRATEGY: In 'search_snippet', include enough context (2–3 lines before and after the target change) to ensure the match is unique in the file. Minor indentation differences are tolerated via fuzzy whitespace-normalization.
WORKFLOW:
  1. Call read_file to get the current file content.
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
      output: `ERROR: El bloque exacto no se encontró (posible problema de indentación o archivo corrupto). Tienes PROHIBIDO volver a intentar search_and_replace en esta zona. DEBES usar la herramienta replace_lines inmediatamente usando los números de línea.`,
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

### 📁 FILE: `src\utils\repoMap.ts`
```typescript
import * as fs from 'fs';
import * as path from 'path';

// ─── RepoMap Generator (v8.9.0 — Semantic Awareness Phase 1) ─────────────────
// Produces a compressed semantic map of the workspace so agents know where every
// class and function lives without issuing shell commands.

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.fluxo', 'dist', 'out', 'build',
  'coverage', '.vscode', '.nyc_output', '__pycache__', '.next',
  '.nuxt', 'vendor', 'tmp', 'temp', '.turbo', '.cache',
]);

const TARGET_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const MAX_REPO_MAP_CHARS = 15_000;

function extractSignatures(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const seen = new Set<string>();
    const sigs: string[] = [];

    // export default class/function Identifier
    const defaultMatch = content.match(/export\s+default\s+(?:class|function\*?|async\s+function\*?)?\s*(\w+)/);
    if (defaultMatch?.[1]) {
      const sym = `export default ${defaultMatch[1]}`;
      if (!seen.has(sym)) { seen.add(sym); sigs.push(sym); }
    }

    // export (async) function/class/const/let/var Identifier
    for (const m of content.matchAll(/export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+(\w+)/g)) {
      const sym = m[1];
      if (sym && !seen.has(sym)) { seen.add(sym); sigs.push(sym); }
    }

    return sigs.join(', ');
  } catch {
    return '';
  }
}

function scanDir(dirPath: string, workspacePath: string, lines: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') && IGNORE_DIRS.has(entry.name)) { continue; }
    if (IGNORE_DIRS.has(entry.name)) { continue; }

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      scanDir(fullPath, workspacePath, lines);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!TARGET_EXTS.has(ext)) { continue; }

      try {
        const relPath = path.relative(workspacePath, fullPath).replace(/\\/g, '/');
        const sigs = extractSignatures(fullPath);
        lines.push(sigs ? `${relPath}: ${sigs}` : relPath);
      } catch {
        // skip unreadable entries silently
      }
    }
  }
}

export function buildRepoMap(workspacePath: string): string {
  if (!workspacePath) { return ''; }

  try {
    const lines: string[] = [];
    scanDir(workspacePath, workspacePath, lines);
    if (lines.length === 0) { return ''; }

    let result = lines.join('\n');

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

