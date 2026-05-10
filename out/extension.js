"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const cp = __importStar(require("child_process"));
const agentEngine_1 = require("./agentEngine");
const agents_1 = require("./agents");
const sentinel_1 = require("./sentinel");
const client_1 = require("./services/mcp/client");
const mcpRegistry_1 = require("./utils/mcpRegistry");
const mcpConfigWriter_1 = require("./utils/mcpConfigWriter");
const gitSafety_1 = require("./utils/gitSafety");
const cleanupRegistry_1 = require("./utils/cleanupRegistry");
// ─── State Management ─────────────────────────────────────────────────────────
let _panel;
let _conversationHistory = [];
let _currentAbortController;
let _extensionUri;
let _context;
let _sentinel;
let _sentinelHasError = false;
let _mcpClient;
// Worktree Human Review (v8.3.0) — resolved when the user clicks Approve/Discard in the webview
let _pendingWorktreeReview;
const STORAGE_KEY = 'fluxo.chatHistory';
const LOG_FILE = 'fluxo_errors.log';
// ─── Sidebar Provider (Left Launcher) ─────────────────────────────────────────
class FluxoSidebarProvider {
    constructor(_extensionUri) {
        this._extensionUri = _extensionUri;
    }
    resolveWebviewView(webviewView, _context, _token) {
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
FluxoSidebarProvider.viewType = 'fluxo.sidebar';
// ─── Logging Utility ──────────────────────────────────────────────────────────
function logError(message, details) {
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
        }
        catch { /* log file doesn't exist yet */ }
        fs.appendFileSync(logPath, logEntry, 'utf-8');
    }
    catch (err) {
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
function ensureGitignoreLogs(wsPath) {
    try {
        const gitignorePath = path.join(wsPath, '.gitignore');
        let needsAppend = true;
        if (fs.existsSync(gitignorePath)) {
            const contents = fs.readFileSync(gitignorePath, 'utf-8');
            const hasLogPattern = contents
                .split(/\r?\n/)
                .some(line => line.trim() === '*.log');
            if (hasLogPattern) {
                needsAppend = false;
            }
        }
        if (needsAppend) {
            const prefix = fs.existsSync(gitignorePath) ? '\n' : '';
            fs.appendFileSync(gitignorePath, `${prefix}*.log\n`, 'utf-8');
            console.log('[Fluxo Sanitizer] Appended *.log to .gitignore');
        }
    }
    catch (err) {
        console.error('[Fluxo Sanitizer] .gitignore update failed:', err?.message ?? err);
    }
    try {
        cp.execSync('git rm --cached *.log -q', {
            cwd: wsPath,
            stdio: 'ignore',
            windowsHide: true,
        });
    }
    catch { /* expected when no logs are tracked or not a git repo */ }
}
// ─────────────────────────────────────────────────────────────────────────────
function cleanupLogsOnActivation() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
        return;
    }
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
                try {
                    fs.unlinkSync(path.join(backupDir, f.name));
                }
                catch { /* skip locked files */ }
            });
        }
    }
    catch { /* non-fatal */ }
    // ── v8.27.0 — Orphaned-Worktree Auto-Cleanup (Phase 3.3) ──────────────────
    // Background janitor sweeps any .fluxo/worktrees/<branch> directory whose
    // branch is not the currently-active one (per .fluxo/active_worktree.json).
    // Idempotent + silent — zero orphans ⇒ no-op. Failures inside the helper
    // are isolated per-orphan so a single stuck worktree never blocks the rest.
    // Wrapped in try/catch here so even a catastrophic exception in the helper
    // never blocks extension activation (the entire cleanup pass is best-effort).
    try {
        const destroyed = (0, cleanupRegistry_1.cleanupOrphanedWorktrees)(wsPath);
        if (destroyed.length > 0) {
            console.log(`[Fluxo Cleanup] Destroyed ${destroyed.length} orphan worktree(s): ${destroyed.join(', ')}`);
        }
    }
    catch (err) {
        console.error('[Fluxo Cleanup] Orphan-worktree sweep failed:', err?.message ?? err);
    }
}
// ─── Panel Manager ────────────────────────────────────────────────────────────
function getOrCreatePanel(context) {
    if (_panel) {
        _panel.reveal(vscode.ViewColumn.Beside, true);
        return _panel;
    }
    _panel = vscode.window.createWebviewPanel('fluxo.chatPanel', '🐾 Fluxo AI', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(_extensionUri, 'media')],
    });
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
async function _handleMessage(msg, context) {
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
                agents: (0, agents_1.getAgentList)(),
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
                if (editor) {
                    editor.edit(eb => eb.replace(editor.selection, msg.code));
                }
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
                    }
                    catch {
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
                    }
                    catch {
                        // Fallback: open the file in the editor if the Git extension is unavailable
                        try {
                            const doc = await vscode.workspace.openTextDocument(fileUri);
                            await vscode.window.showTextDocument(doc);
                        }
                        catch {
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
                    await vscode.commands.executeCommand('vscode.diff', originalUri, worktreeUri, `Diff: ${msg.filePath} — Original vs Cambios de Fluxo`);
                }
                catch (e) {
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
            const choice = await vscode.window.showWarningMessage('⟲ Restore Workspace Only\n\n' +
                'Vas a revertir TODO lo que el agente cambió desde el último checkpoint ' +
                '(git reset --hard HEAD~1). Cualquier edición manual previa al checkpoint ' +
                'fue auto-guardada como WIP commit y SE PRESERVA. Esta acción no se puede ' +
                'deshacer desde la UI.\n\n¿Continuar?', { modal: true }, 'Restaurar');
            if (choice !== 'Restaurar') {
                _postToPanel({ type: 'restoreResult', success: false, output: 'Restauración cancelada por el usuario.' });
                break;
            }
            const result = (0, gitSafety_1.rollbackToLastCheckpoint)(wsPath);
            _postToPanel({ type: 'restoreResult', success: result.success, output: result.output });
            if (result.success) {
                vscode.window.showInformationMessage('✓ Workspace restaurado al último checkpoint.');
            }
            else {
                vscode.window.showErrorMessage(`Restore falló: ${result.output}`);
            }
            break;
        }
        // ─────────────────────────────────────────────────────────────────────────
        case 'saveModel':
            if (msg.managerModel) {
                context.globalState.update('fluxo.selectedModel', msg.managerModel);
            }
            if (msg.workerModel !== undefined) {
                context.globalState.update('fluxo.workerModel', msg.workerModel || '');
            }
            break;
        case 'openSettings':
            vscode.commands.executeCommand('workbench.action.openSettings', 'fluxo');
            break;
        case 'showStreamingInfo':
            vscode.window.showInformationMessage('🌊 Streaming: las respuestas aparecen gradualmente mientras el modelo genera, en lugar de esperar la respuesta completa. Si ves respuestas cortadas, desactívalo en Ajustes → Fluxo AI → Streaming Enabled.');
            break;
        case 'sentinelToggle': {
            const isNowActive = _sentinel?.toggle() ?? false;
            _context.globalState.update('fluxo.sentinelActive', isNowActive);
            _postToPanel({ type: 'sentinelStatus', active: isNowActive });
            vscode.window.showInformationMessage(isNowActive ? '🟢 Sentinel activated — monitoring terminal' : '⚫ Sentinel deactivated');
            break;
        }
    }
}
// ─── Core: Engine Integration ───────────────────────────────────────────────
async function _handleSendMessage(userText, model, workerModel, context) {
    const config = await _buildConfig();
    config.model = model;
    if (workerModel) {
        config.workerModel = workerModel;
    }
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
    const agentId = (0, agents_1.routeToAgent)(userText);
    _currentAbortController?.abort();
    _currentAbortController = new AbortController();
    _postToPanel({ type: 'streamStart' });
    try {
        const engineConfig = {
            apiKey: config.apiKey,
            model: config.model,
            workerModel: config.workerModel,
            maxTokens: config.maxTokens,
            streamingEnabled: config.streamingEnabled,
            deepseekApiKey: config.deepseekApiKey,
            geminiApiKey: config.geminiApiKey,
        };
        let fullAssistantText = '';
        const approvalCallback = async (summary, details) => {
            const answer = await vscode.window.showInformationMessage(`🛡️ Fluxo Bodyguard — Permiso Requerido\n\nIntención: ${summary}\n\nDetalles: ${details}`, { modal: true }, '✅ Approve', '❌ Reject');
            return answer === '✅ Approve';
        };
        // v8.33.0 — Discovery Mode (planner-only). The engine reroutes the
        // planner's ask_user_approval calls to this callback. We surface the
        // questions in a showInputBox so the user TYPES their answers; the engine
        // then injects those answers verbatim into the planner's tool result and
        // the planner ships the plan informed by them in the same sub-loop.
        const discoveryAnswerCallback = async (questions) => {
            const answer = await vscode.window.showInputBox({
                title: '🔎 Fluxo Discovery — el @planner necesita clarificación',
                prompt: questions,
                placeHolder: 'Escribe tus respuestas aquí (una línea por pregunta o todo junto — el planner las lee verbatim)',
                ignoreFocusOut: true,
            });
            return answer ?? null;
        };
        const nativeEditCallback = async (relPath, searchSnippet, replaceSnippet) => applyNativeEdit(relPath, searchSnippet, replaceSnippet, workspacePath);
        const getCodeStructureCallback = async (absolutePath) => {
            try {
                // ── Robust Path Sanitization (v7.14.0) ──────────────────────────────
                // Handles ALL known LLM path hallucinations:
                //   1. Docker-bias:   /workspace/src/file.tsx
                //   2. Overlap:       /workspace/d:\real\path\file.tsx  (Docker prefix + Windows absolute)
                //   3. Pure relative: src/file.tsx
                //   4. Pure absolute: d:\real\path\file.tsx (correct — no modification needed)
                let cleanPath = absolutePath;
                // Strip /workspace/ prefix (Docker-bias hallucination)
                if (cleanPath.startsWith('/workspace/')) {
                    cleanPath = cleanPath.substring(11);
                }
                else if (cleanPath.startsWith('workspace/')) {
                    cleanPath = cleanPath.substring(10);
                }
                else if (cleanPath.startsWith('\\workspace\\')) {
                    cleanPath = cleanPath.substring(11);
                }
                const driveIndex = cleanPath.search(/[a-zA-Z]:/);
                if (driveIndex > 0) {
                    cleanPath = cleanPath.substring(driveIndex);
                }
                cleanPath = path.normalize(cleanPath);
                // Resolve to an absolute path inside the workspace
                let finalPath;
                const resolvedClean = path.resolve(cleanPath);
                const resolvedWs = path.resolve(workspacePath);
                // Case-insensitive comparison on Windows (d: vs D:)
                if (resolvedClean.toLowerCase().startsWith(resolvedWs.toLowerCase())) {
                    finalPath = resolvedClean; // Already inside the workspace — use as-is
                }
                else if (path.isAbsolute(cleanPath)) {
                    // Absolute path outside the workspace — reject to prevent LSP scope escape
                    return {
                        success: false,
                        output: `PATH ERROR: "${absolutePath}" apunta fuera del workspace actual. ` +
                            `Usa una ruta relativa al workspace (ej. "src/pages/MiArchivo.jsx") o llama list_dir(".") para descubrir la estructura real.`,
                    };
                }
                else {
                    finalPath = path.join(workspacePath, cleanPath);
                }
                const uri = vscode.Uri.file(finalPath);
                await vscode.workspace.openTextDocument(uri);
                // Retry loop — TS/JS Language Server may not have finished parsing the AST yet.
                // Poll up to 4 times (2 s total) before giving up.
                const MAX_LSP_ATTEMPTS = 4;
                let symbols;
                for (let attempt = 1; attempt <= MAX_LSP_ATTEMPTS; attempt++) {
                    symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
                    if (symbols && symbols.length > 0) {
                        break;
                    }
                    if (attempt < MAX_LSP_ATTEMPTS) {
                        await new Promise(r => setTimeout(r, 500));
                    }
                }
                if (!symbols || symbols.length === 0) {
                    return {
                        success: false,
                        output: 'LSP ERROR: El servidor de lenguaje no pudo extraer los símbolos a tiempo. Usa read_file como fallback.',
                    };
                }
                function mapSymbols(syms) {
                    return syms.map(s => {
                        const entry = {
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
            }
            catch (err) {
                return { success: false, output: `get_code_structure error: ${err.message ?? String(err)}` };
            }
        };
        const mcpTools = _mcpClient.getMcpTools();
        const mcpToolCategories = _mcpClient.getMcpToolCategories();
        // ── LSP Symbol Replace callback (v8.5.0) ─────────────────────────────────
        // Uses VS Code's Language Server to locate a named AST symbol and replace it
        // atomically — no line numbers, no string matching, no brace counting.
        const replaceSymbolCallback = async (relPath, symbolName, newCode) => {
            try {
                const fullPath = path.isAbsolute(relPath) ? relPath : path.join(workspacePath, relPath);
                const uri = vscode.Uri.file(fullPath);
                const document = await vscode.workspace.openTextDocument(uri);
                // Retry loop — Language Server may still be indexing the file
                const MAX_ATTEMPTS = 4;
                let symbols;
                for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                    symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
                    if (symbols && symbols.length > 0) {
                        break;
                    }
                    if (attempt < MAX_ATTEMPTS) {
                        await new Promise(r => setTimeout(r, 500));
                    }
                }
                if (!symbols || symbols.length === 0) {
                    return {
                        success: false,
                        output: `LSP ERROR: El servidor de lenguaje no pudo extraer los símbolos de ${relPath}. Verifica que el archivo tiene extensión .ts/.tsx/.js/.jsx y espera a que el Language Server termine de cargar. Usa replace_block como fallback.`,
                    };
                }
                function findSymbol(syms, name) {
                    for (const sym of syms) {
                        if (sym.name === name) {
                            return sym;
                        }
                        const found = findSymbol(sym.children, name);
                        if (found) {
                            return found;
                        }
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
                    .replace(/\basync\s+async\b/g, 'async')
                    .replace(/\bconst\s+const\b/g, 'const')
                    .replace(/\blet\s+let\b/g, 'let')
                    .replace(/\bvar\s+var\b/g, 'var')
                    .replace(/;{2,}/g, ';');
                // ─────────────────────────────────────────────────────────────────────
                const edit = new vscode.WorkspaceEdit();
                edit.replace(uri, target.range, sanitizedCode);
                const applied = await vscode.workspace.applyEdit(edit);
                if (!applied) {
                    return { success: false, output: `VS Code WorkspaceEdit failed for ${relPath}. The file may be read-only.` };
                }
                await document.save();
                const kind = vscode.SymbolKind[target.kind];
                const lines = target.range.end.line - target.range.start.line + 1;
                return {
                    success: true,
                    output: `replace_symbol: "${symbolName}" (${kind}) in ${relPath} — replaced ${lines} line(s) at L${target.range.start.line + 1}–L${target.range.end.line + 1}.\n\nEDICIÓN EXITOSA — Símbolo reemplazado vía LSP. Verifica el resultado y continúa con tu siguiente herramienta.`,
                };
            }
            catch (err) {
                return { success: false, output: `replace_symbol error: ${err.message ?? String(err)}` };
            }
        };
        // ─────────────────────────────────────────────────────────────────────────
        // ── Worktree Human Review callback (v8.3.0) ──────────────────────────────
        // Called by the engine just before executing exit_worktree(action='merge').
        // Gets changed files from git, posts the review card to the webview, and
        // suspends the agent loop until the user clicks Approve or Discard.
        const worktreeReviewCallback = async (branch, worktreePath) => {
            let changedFiles = [];
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
            }
            catch { /* git unavailable or worktree path invalid — proceed without file list */ }
            _postToPanel({ type: 'worktreeReview', branch, worktreePath, changedFiles });
            return new Promise(resolve => {
                _pendingWorktreeReview = resolve;
            });
        };
        // ─────────────────────────────────────────────────────────────────────────
        // ── HITL — Human-in-the-Loop for run_command (v8.10.0) ───────────────────────
        // Presents a modal VSCode dialog before any non-whitelisted shell command executes.
        // The Promise resolves only after the user clicks Permitir or Rechazar.
        const hitlCommandCallback = async (command) => {
            const choice = await vscode.window.showWarningMessage(`⚠️ El agente quiere ejecutar un comando de shell:\n\n${command}`, { modal: true }, 'Permitir', 'Rechazar');
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
        const getDiagnosticsCallback = async (relPaths) => {
            if (!Array.isArray(relPaths) || relPaths.length === 0) {
                return [];
            }
            const out = [];
            const settleMs = 300;
            try {
                for (const rel of relPaths.slice(0, 5)) {
                    if (typeof rel !== 'string' || !rel.trim()) {
                        continue;
                    }
                    let cleanPath = rel.trim();
                    // Strip /workspace/ Docker-bias and worktree-prefix hallucinations
                    // mirror the same heuristics get_code_structure uses.
                    if (cleanPath.startsWith('/workspace/')) {
                        cleanPath = cleanPath.substring(11);
                    }
                    else if (cleanPath.startsWith('workspace/')) {
                        cleanPath = cleanPath.substring(10);
                    }
                    else if (cleanPath.startsWith('\\workspace\\')) {
                        cleanPath = cleanPath.substring(11);
                    }
                    const finalPath = path.isAbsolute(cleanPath) ? cleanPath : path.join(workspacePath, cleanPath);
                    if (!fs.existsSync(finalPath)) {
                        continue;
                    }
                    const uri = vscode.Uri.file(finalPath);
                    try {
                        await vscode.workspace.openTextDocument(uri);
                        await new Promise(r => setTimeout(r, settleMs));
                    }
                    catch { /* continue with whatever diagnostics already exist */ }
                    const diags = vscode.languages.getDiagnostics(uri);
                    for (const d of diags) {
                        if (d.severity !== vscode.DiagnosticSeverity.Error && d.severity !== vscode.DiagnosticSeverity.Warning) {
                            continue;
                        }
                        const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
                        const line = d.range.start.line + 1;
                        const msg = (d.message || '').replace(/\s+/g, ' ').trim().slice(0, 240);
                        out.push(`${cleanPath}:${line} [${sev}] ${msg}`);
                        if (out.length >= 10) {
                            break;
                        }
                    }
                    if (out.length >= 10) {
                        break;
                    }
                }
            }
            catch (err) {
                // Defensive: never throw — engine treats absence/empty as "no LSP".
                console.error('[Fluxo LSP Passive] callback error:', err);
                return [];
            }
            return out;
        };
        // ─────────────────────────────────────────────────────────────────────────────
        for await (const event of (0, agentEngine_1.runAgentLoop)(userText, agentId, _conversationHistory, engineConfig, workspacePath, _currentAbortController.signal, _sentinelHasError, approvalCallback, nativeEditCallback, getCodeStructureCallback, mcpTools, async (name, args) => await _mcpClient.callMcpTool(name, args), worktreeReviewCallback, replaceSymbolCallback, hitlCommandCallback, mcpToolCategories, getDiagnosticsCallback, 
        // v8.26.0 — Phase 3.4 MCP resource discovery. The McpSwarmClient owns
        // the live stdio transports, so the engine routes list_mcp_resources
        // calls back here to reach them.
        async (serverName) => await _mcpClient.listResources(serverName), 
        // v8.33.0 — Discovery Mode (planner-only). Forwarded by the engine to
        // the planner sub-loop so the @planner can collect text answers from
        // the user via showInputBox during clarifying questions.
        discoveryAnswerCallback)) {
            _postToPanel({ ...event });
            if (event.type === 'streamChunk') {
                fullAssistantText += event.text;
            }
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
        if (_conversationHistory.length > 50) {
            _conversationHistory = _conversationHistory.slice(-50);
        }
        context.workspaceState.update(STORAGE_KEY, _conversationHistory);
    }
    catch (err) {
        if (err.name !== 'AbortError') {
            logError(err.message, { stack: err.stack });
            _postToPanel({ type: 'error', text: `❌ ${err.message}` });
        }
    }
    _currentAbortController = undefined;
}
async function _handleCompression(context) {
    const config = await _buildConfig();
    // Resolve the effective key for the currently selected model —
    // mirrors resolveEndpointAndKey() logic in agentEngine.ts.
    const isDeepseekDirect = !config.model.includes('/') && config.model.startsWith('deepseek-');
    const isGeminiDirect = !config.model.includes('/') && config.model.startsWith('gemini-');
    const effectiveKey = isDeepseekDirect ? (config.deepseekApiKey || config.apiKey)
        : isGeminiDirect ? (config.geminiApiKey || config.apiKey)
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
        const summary = await (0, agentEngine_1.summarizeHistory)(_conversationHistory, {
            apiKey: config.apiKey,
            deepseekApiKey: config.deepseekApiKey,
            geminiApiKey: config.geminiApiKey,
            model: config.model,
            maxTokens: 1024,
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
    }
    catch (err) {
        logError('Compression failed', err);
        _postToPanel({ type: 'error', text: `❌ Compression failed: ${err.message}` });
        vscode.window.showErrorMessage(`Failed to compress history: ${err.message}`);
    }
}
// ─── Model List Builder ───────────────────────────────────────────────────────
async function _buildModelList() {
    const config = await _buildConfig();
    const baseModels = vscode.workspace.getConfiguration('fluxo').get('customModels') || [
        "google/gemini-2.5-flash", "google/gemini-2.5-flash-lite", "google/gemini-2.5-pro",
        "deepseek/deepseek-v3.2", "anthropic/claude-3.7-sonnet", "anthropic/claude-3.5-haiku", "openai/gpt-4o"
    ];
    const models = [...baseModels];
    if (config.geminiApiKey) {
        ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"].forEach(m => {
            if (!models.includes(m)) {
                models.push(m);
            }
        });
    }
    if (config.deepseekApiKey) {
        // Bare names (no slash) → routed to api.deepseek.com directly by agentEngine
        ["deepseek-chat", "deepseek-reasoner"].forEach(m => {
            if (!models.includes(m)) {
                models.push(m);
            }
        });
    }
    return models;
}
// ─── Helpers ──────────────────────────────────────────────────────────────────
function _postToPanel(payload) {
    _panel?.webview.postMessage(payload);
}
function _sendWorkspaceInfo() {
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
async function _buildConfig() {
    const vscodeConfig = vscode.workspace.getConfiguration('fluxo');
    let apiKey = vscodeConfig.get('openrouterApiKey') || '';
    let deepseekApiKey = vscodeConfig.get('deepseekApiKey') || '';
    let geminiApiKey = vscodeConfig.get('geminiApiKey') || '';
    if (!apiKey || !deepseekApiKey || !geminiApiKey) {
        const folders = vscode.workspace.workspaceFolders;
        if (folders?.length) {
            const envPath = path.join(folders[0].uri.fsPath, '.env');
            try {
                if (fs.existsSync(envPath)) {
                    const envContent = fs.readFileSync(envPath, 'utf-8');
                    if (!apiKey) {
                        const m = envContent.match(/OPENROUTER_API_KEY\s*=\s*(.+)/);
                        if (m) {
                            apiKey = m[1].trim();
                        }
                    }
                    if (!deepseekApiKey) {
                        const m = envContent.match(/DEEPSEEK_API_KEY\s*=\s*(.+)/);
                        if (m) {
                            deepseekApiKey = m[1].trim();
                        }
                    }
                    if (!geminiApiKey) {
                        const m = envContent.match(/GEMINI_API_KEY\s*=\s*(.+)/);
                        if (m) {
                            geminiApiKey = m[1].trim();
                        }
                    }
                }
            }
            catch { /* ignore */ }
        }
    }
    const savedModel = _context?.globalState.get('fluxo.selectedModel');
    const savedWorkerModel = _context?.globalState.get('fluxo.workerModel');
    return {
        apiKey,
        deepseekApiKey: deepseekApiKey || undefined,
        geminiApiKey: geminiApiKey || undefined,
        model: savedModel || vscodeConfig.get('defaultModel') || 'google/gemini-2.5-flash',
        workerModel: savedWorkerModel || undefined,
        maxTokens: vscodeConfig.get('maxTokens') || 4096,
        streamingEnabled: vscodeConfig.get('streamingEnabled') ?? true,
    };
}
// ─── Native Edit (Fase 8) ─────────────────────────────────────────────────────
function fuzzyFindOffsets(text, snippet) {
    const norm = (s) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const normLine = (s) => s.trim().replace(/\s+/g, ' ');
    const content = norm(text);
    const snip = norm(snippet);
    const fileLines = content.split('\n');
    const rawSnip = snip.split('\n');
    let si = 0, ei = rawSnip.length - 1;
    while (si <= ei && rawSnip[si].trim() === '') {
        si++;
    }
    while (ei >= si && rawSnip[ei].trim() === '') {
        ei--;
    }
    const snippetLines = rawSnip.slice(si, ei + 1);
    if (snippetLines.length === 0) {
        return null;
    }
    const snipNorm = snippetLines.map(normLine);
    const n = snippetLines.length;
    const matches = [];
    outer: for (let i = 0; i <= fileLines.length - n; i++) {
        for (let j = 0; j < n; j++) {
            if (normLine(fileLines[i + j]) !== snipNorm[j]) {
                continue outer;
            }
        }
        matches.push(i);
    }
    if (matches.length !== 1) {
        return null;
    }
    const startLine = matches[0];
    const endLine = matches[0] + n - 1;
    const startIndex = fileLines.slice(0, startLine).reduce((s, l) => s + l.length + 1, 0);
    const length = fileLines.slice(startLine, endLine + 1)
        .reduce((s, l, i, arr) => s + l.length + (i < arr.length - 1 ? 1 : 0), 0);
    return { startIndex, length };
}
const MAX_DIFF_LINES = 25;
function buildNativeDiffBlock(search, replace) {
    const norm = (s) => s.replace(/\r\n/g, '\n').trimEnd();
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
async function applyNativeEdit(relPath, searchSnippet, replaceSnippet, workspacePath) {
    const fullPath = path.isAbsolute(relPath) ? relPath : path.join(workspacePath, relPath);
    const uri = vscode.Uri.file(fullPath);
    let document;
    try {
        document = await vscode.workspace.openTextDocument(uri);
    }
    catch {
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
        startIndex = fuzzy.startIndex;
        matchLength = fuzzy.length;
    }
    const startPos = document.positionAt(startIndex);
    const endPos = document.positionAt(startIndex + matchLength);
    const range = new vscode.Range(startPos, endPos);
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
function getNonce() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
function _buildHtml(webview) {
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(_extensionUri, 'media', 'style.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(_extensionUri, 'media', 'main.js'));
    const nonce = getNonce();
    return /* html */ `<!DOCTYPE html>
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
function ensureGitignore(workspacePath) {
    const gitignorePath = path.join(workspacePath, '.gitignore');
    const entry = '.fluxo/';
    try {
        let content = '';
        if (fs.existsSync(gitignorePath)) {
            content = fs.readFileSync(gitignorePath, 'utf-8');
            const lines = content.split('\n').map(l => l.trim());
            // Already ignored under either form — nothing to do
            if (lines.some(l => l === '.fluxo/' || l === '.fluxo')) {
                return;
            }
        }
        // Ensure we start on a fresh line whether the file is empty or not
        const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
        fs.appendFileSync(gitignorePath, `${prefix}\n# Fluxo AI Engine Data\n${entry}\n`, 'utf-8');
    }
    catch { /* non-fatal — read-only workspace or no .gitignore yet */ }
}
// ─── Activation ───────────────────────────────────────────────────────────────
function activate(context) {
    _extensionUri = context.extensionUri;
    _context = context;
    // v8.19.0 — pass the workspace root so the client also reads
    // .fluxo/mcp_servers.json (per-project MCP config) on top of the
    // user-scoped fluxo.mcpServers VSCode setting.
    const _initWsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    _mcpClient = new client_1.McpSwarmClient(_initWsPath);
    _mcpClient.initialize();
    // Initialize conversation persistence
    _conversationHistory = context.workspaceState.get(STORAGE_KEY) || [];
    // Session cleanup — trim logs and prune old backups on every new session
    cleanupLogsOnActivation();
    // Zero Footprint — ensure .fluxo/ is gitignored before any agent writes to it
    const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (wsPath) {
        ensureGitignore(wsPath);
    }
    // ─── Sentinel: Real-Time Self-Healing ──────────────────────────────────────
    _sentinel = new sentinel_1.Sentinel(async (errorText) => {
        // Don't interrupt an agent that is currently running
        if (_currentAbortController) {
            return;
        }
        _sentinelHasError = true;
        getOrCreatePanel(context);
        _postToPanel({ type: 'sentinelAlert', errorText });
        const config = await _buildConfig();
        const msg = `@manager 🔴 Sentinel detectó un error de compilación en la terminal:\n\n\`\`\`\n${errorText}\n\`\`\`\n\nToma el control. Identifica qué edición reciente causó este error y dirige al @coder para corregirlo de inmediato con read_file → replace_lines.`;
        // Small delay so the WebView renders the alert bubble before streamStart fires
        setTimeout(() => {
            _handleSendMessage(msg, config.model, config.workerModel, context).catch(console.error);
        }, 150);
    });
    // Restore sentinel state from last session (default: off)
    if (context.globalState.get('fluxo.sentinelActive', false)) {
        _sentinel.activate();
    }
    context.subscriptions.push({ dispose: () => _sentinel?.dispose() });
    // Register Panel Serializer — reopens the panel automatically after Developer: Reload Window
    vscode.window.registerWebviewPanelSerializer('fluxo.chatPanel', {
        async deserializeWebviewPanel(webviewPanel, _state) {
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
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(FluxoSidebarProvider.viewType, new FluxoSidebarProvider(_extensionUri)));
    // Register Commands
    context.subscriptions.push(vscode.commands.registerCommand('fluxo.openPanel', () => getOrCreatePanel(context)), vscode.commands.registerCommand('fluxo.newChat', () => {
        _conversationHistory = [];
        context.workspaceState.update(STORAGE_KEY, []);
        _postToPanel({ type: 'chatCleared' });
    }), vscode.commands.registerCommand('fluxo.clearChat', () => {
        _conversationHistory = [];
        context.workspaceState.update(STORAGE_KEY, []);
        _postToPanel({ type: 'chatCleared' });
    }), vscode.commands.registerCommand('fluxo.openSettings', () => {
        vscode.commands.executeCommand('workbench.action.openSettings', 'fluxo');
    }), vscode.commands.registerCommand('fluxo.askAboutSelection', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        const selection = editor.document.getText(editor.selection);
        if (!selection.trim()) {
            return;
        }
        getOrCreatePanel(context);
        _postToPanel({ type: 'prefillPrompt', text: `About this code:\n\`\`\`\n${selection}\n\`\`\`` });
    }), vscode.commands.registerCommand('fluxo.toggleSentinel', () => {
        const isNowActive = _sentinel?.toggle() ?? false;
        context.globalState.update('fluxo.sentinelActive', isNowActive);
        _postToPanel({ type: 'sentinelStatus', active: isNowActive });
        vscode.window.showInformationMessage(isNowActive
            ? '🟢 Sentinel activated — monitoring terminal for errors'
            : '⚫ Sentinel deactivated');
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
        const items = (0, mcpRegistry_1.listRegistry)().map(e => ({
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
        if (!pick) {
            return;
        }
        const result = (0, mcpConfigWriter_1.addServer)(wsPath, pick.alias);
        if (!result.ok) {
            vscode.window.showErrorMessage(`Fluxo MCP: ${result.reason}`);
        }
        else {
            vscode.window.showInformationMessage(result.reason ?? `✅ Added "${result.alias}" to .fluxo/mcp_servers.json. Reload the window for the new server to take effect.`);
        }
    }), vscode.commands.registerCommand('fluxo.mcp.remove', async () => {
        const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsPath) {
            vscode.window.showWarningMessage('Fluxo MCP: open a workspace folder first.');
            return;
        }
        const configured = (0, mcpConfigWriter_1.listConfigured)(wsPath);
        const aliases = Object.keys(configured).sort();
        if (aliases.length === 0) {
            vscode.window.showInformationMessage('Fluxo MCP: no servers configured in this workspace.');
            return;
        }
        const pick = await vscode.window.showQuickPick(aliases, {
            placeHolder: 'Select an MCP server to remove',
        });
        if (!pick) {
            return;
        }
        const result = (0, mcpConfigWriter_1.removeServer)(wsPath, pick);
        if (!result.ok) {
            vscode.window.showErrorMessage(`Fluxo MCP: ${result.reason}`);
        }
        else {
            vscode.window.showInformationMessage(result.reason ?? `🗑️ Removed "${pick}" from .fluxo/mcp_servers.json. Reload the window to disconnect.`);
        }
    }), vscode.commands.registerCommand('fluxo.mcp.list', async () => {
        const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsPath) {
            vscode.window.showWarningMessage('Fluxo MCP: open a workspace folder first.');
            return;
        }
        const configured = (0, mcpConfigWriter_1.listConfigured)(wsPath);
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
    }));
    // Re-send model list when API keys change so dropdown updates live
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration('fluxo') && _panel) {
            const models = await _buildModelList();
            const cfg = await _buildConfig();
            _postToPanel({ type: 'modelsUpdate', models, model: cfg.model, workerModel: cfg.workerModel });
        }
    }));
    console.log('[Fluxo AI] v8.10.0 — The Shield Patch: HITL + DeleteTool guards + Iron Rule');
}
function deactivate() {
    _currentAbortController?.abort();
    _mcpClient?.destroy();
}
//# sourceMappingURL=extension.js.map