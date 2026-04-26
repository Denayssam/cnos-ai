# 📦 APP MANIFEST
* **App Name:** fluxo-ai
* **Version:** 7.6.7
* **Stack:** Vanilla JS
* **Part:** 1
* **Generated At:** 2026-04-26T04:25:37.060Z

---

### 📁 FILE: `media\main.js`
```javascript
/* global acquireVsCodeApi */
// ─── Fluxo AI v7.6.7 — Persistent Swarm WebView ───────────────────────────────
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  // ─── DOM ────────────────────────────────────────────────────────────────────
  const messagesEl      = document.getElementById('messages');
  const promptInput     = document.getElementById('prompt-input');
  const sendBtn         = document.getElementById('send-btn');
  const cancelBtn       = document.getElementById('cancel-btn');
  const modelSelect     = document.getElementById('model-select');
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
  const contextBar      = document.getElementById('context-bar');
  const contextBarFile  = document.getElementById('context-bar-file');
  const contextBarAction = document.getElementById('context-bar-action');

  // ─── State ─────────────────────────────────────────────────────────────────
  let isStreaming = false;
  let currentBubble = null;
  let currentStreamText = '';
  let currentResponseWrapper = null;
  let currentToolActivityItems = null;
  let hasToolCalls = false;
  let agents = [];
  let currentAgentId = 'coder';
  let chatHistory = [];
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
      case 'modelsUpdate':     populateModels(data.models, data.model);                   break;
    }
  });

  // ─── Config & History ───────────────────────────────────────────────────────
  function populateModels(models, preferred) {
    if (!models || !models.length) { return; }
    const current = modelSelect.value;
    modelSelect.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join('');
    const pick = models.includes(preferred) ? preferred : (models.includes(current) ? current : models[0]);
    if (pick) { modelSelect.value = pick; }
  }

  function handleConfig(data) {
    if (data.models) { populateModels(data.models, data.model); }
    else if (data.model) { modelSelect.value = data.model; }
    apiKeyWarning.classList.toggle('hidden', !!data.hasApiKey);
    if (data.agents) { agents = data.agents; buildAgentPills(); }
    if (data.history && data.history.length) {
      chatHistory = data.history;
      renderHistory();
      updateTokenWheel();
    } else {
      renderWelcome();
    }
  }

  function handleHistorySync(data) {
    chatHistory = data.history || [];
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
    read_file:     'leyendo',
    write_file:    'escribiendo',
    replace_lines: 'editando',
    replace_block: 'editando',
    edit_file:     'editando',
    delete_file:   'eliminando',
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
    hasToolCalls = false;
    sendBtn.disabled = true;
    cancelBtn.classList.remove('hidden');
    sendBtn.classList.add('hidden');
    document.querySelector('.input-wrapper')?.classList.add('swarm-active');
    messagesEl.querySelector('.welcome-card')?.remove();

    // Build response wrapper: collapsible tool activity on top, text bubble below
    currentResponseWrapper = document.createElement('div');
    currentResponseWrapper.className = 'response-wrapper';
    currentResponseWrapper.innerHTML = `
      <details class="tool-activity" open>
        <summary class="tool-activity-summary">
          <span class="tool-activity-icon">⟳</span>
          <span class="tool-activity-label">Working…</span>
        </summary>
        <div class="tool-activity-items" id="current-tool-activity-items"></div>
      </details>
      <div class="message assistant">
        <div class="message-role">Fluxo</div>
        <div class="message-bubble" id="streaming-bubble"></div>
      </div>
    `;
    messagesEl.appendChild(currentResponseWrapper);
    currentBubble = currentResponseWrapper.querySelector('#streaming-bubble');
    currentToolActivityItems = currentResponseWrapper.querySelector('#current-tool-activity-items');
    showStatus('Working…', true);
    scrollToBottom();
  }

  function handleStreamChunk(text) {
    document.getElementById('thinking-bubble')?.remove();
    if (currentBubble) {
      currentStreamText += text;
      currentBubble.innerHTML = renderMarkdown(currentStreamText) + '<span class="streaming-cursor"></span>';
      scrollToBottom();
    }
  }

  function handleStreamEnd() {
    isStreaming = false;
    document.getElementById('thinking-bubble')?.remove();

    if (currentBubble) {
      currentBubble.innerHTML = renderMarkdown(currentStreamText);
      attachCodeListeners(currentBubble);
      currentBubble.removeAttribute('id');
      chatHistory.push({ role: 'assistant', content: currentStreamText });
      updateTokenWheel();
    }

    // Finalize tool activity section
    if (currentResponseWrapper) {
      const details = currentResponseWrapper.querySelector('.tool-activity');
      if (details) {
        if (hasToolCalls) {
          details.open = false;
          const count = currentToolActivityItems
            ? currentToolActivityItems.querySelectorAll('.tool-call-card').length : 0;
          const lbl = currentResponseWrapper.querySelector('.tool-activity-label');
          const ico = currentResponseWrapper.querySelector('.tool-activity-icon');
          if (lbl) lbl.textContent = `${count} tool${count !== 1 ? 's' : ''} used`;
          if (ico) ico.textContent = '🔧';
        } else {
          details.remove();
        }
      }
      currentResponseWrapper = null;
      currentToolActivityItems = null;
    }

    sendBtn.disabled = false;
    sendBtn.classList.remove('hidden');
    cancelBtn.classList.add('hidden');
    document.querySelector('.input-wrapper')?.classList.remove('swarm-active');
    hideStatus();
    currentBubble = null;
    scrollToBottom();
  }

  function handleStreamCancelled() {
    isStreaming = false;
    document.getElementById('thinking-bubble')?.remove();
    if (currentResponseWrapper) {
      const details = currentResponseWrapper.querySelector('.tool-activity');
      if (details && !hasToolCalls) details.remove();
      currentResponseWrapper = null;
      currentToolActivityItems = null;
    }
    sendBtn.disabled = false;
    sendBtn.classList.remove('hidden');
    cancelBtn.classList.add('hidden');
    document.querySelector('.input-wrapper')?.classList.remove('swarm-active');
    hideStatus();
    currentBubble = null;
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
    updateTokenWheel();

    promptInput.value = '';
    autoResize();
    scrollToBottom();
    vscode.postMessage({ type: 'sendMessage', text, model: modelSelect.value });
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
      default:                return `• ${name}`;
    }
  }

  function handleToolCall(data) {
    document.getElementById('thinking-bubble')?.remove();
    hasToolCalls = true;

    const args = data.args || {};
    const title = getToolTitle(data.name, args);

    // Update context bar for file-touching tools
    if (FILE_TOOL_ACTIONS[data.name] && args.path) {
      setContextFile(data.name, args.path);
    }

    // Diff rendering for file-write operations; plain args for everything else
    let argsHtml = '';
    if ((data.name === 'edit_file' || data.name === 'replace_lines' || data.name === 'replace_block' || data.name === 'write_file')) {
      const raw = data.name === 'edit_file' ? (args.new_string || '') : (data.name === 'replace_lines' || data.name === 'replace_block') ? (args.new_content || '') : (args.content || '');
      if (raw) {
        const lines = raw.split('\n');
        const preview = lines.slice(0, 20);
        const more = lines.length - preview.length;
        const linesHtml = preview.map(l => `<span class="diff-line-added">${escapeHtml(l)}</span>`).join('');
        const moreHtml = more > 0 ? `<span class="diff-line-added" style="opacity:0.35">  … ${more} more line${more !== 1 ? 's' : ''}</span>` : '';
        argsHtml = `<div class="tool-diff">${linesHtml}${moreHtml}</div>`;
      }
    } else {
      argsHtml = `<div class="tool-args">${escapeHtml(data.displayArgs || '')}</div>`;
    }

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

    (currentToolActivityItems || messagesEl).appendChild(el);

    if (currentResponseWrapper) {
      const lbl = currentResponseWrapper.querySelector('.tool-activity-label');
      if (lbl) lbl.textContent = 'Tool activity';
    }
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

      if (removedMarker && !isEngineError) {
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
    }
    scrollToBottom();
  }

  function handleIterationCount(data) { /* iteration progress shown in status bar */ }

  function handleSentinelStatus(data) {
    if (!sentinelBtn) { return; }
    const active = !!data.active;
    sentinelBtn.classList.toggle('sentinel-active', active);
    sentinelBtn.title = active
      ? '🟢 Sentinel activo — click para desactivar'
      : '👁 Sentinel inactivo — click para activar auto-curación';
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
        <h2 class="welcome-title">Fluxo AI</h2>
        <p class="welcome-subtitle">Persistent Agent Swarm v7.6.7</p>
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

    html = renderMarkdownInner(html);

    reasoningBlocks.forEach((block, i) => {
      html = html.replace(`{{REASONING_BLOCK_${i}}}`, block);
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
      codeBlocks.push(`<div class="code-block"><div class="code-header"><span class="code-lang">${lang || 'txt'}</span><button class="code-btn copy-btn" data-code="${encodeURIComponent(rawC)}">Copy</button></div><pre><code>${c}</code></pre></div>`);
      return placeholder;
    });

    // 2. Protect inline code (`)
    html = html.replace(/`([^`]+)`/g, (_, code) => {
      const placeholder = `{{CODE_BLOCK_${codeBlocks.length}}}`;
      codeBlocks.push(`<code>${code}</code>`);
      return placeholder;
    });

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
    const container = document.getElementById('chat-container');
    if (!container) return;
    const threshold = 150;
    const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;

    if (isStreaming) {
      container.scrollTop = container.scrollHeight;
    } else if (isAtBottom) {
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

```

### 📁 FILE: `package.json`
```json
{
  "name": "fluxo-ai",
  "displayName": "Fluxo AI — Agent Swarm",
  "description": "Autonomous AI coding agent powered by OpenRouter. Writes files, runs commands, routes to specialized agents (Coder, Designer, Dashboard, Payments).",
  "version": "7.6.7",
  "publisher": "fluxotechai",
  "repository": { "type": "git", "url": "https://github.com/fluxotechai/fluxo-ai" },
  "icon": "media/icon.png",
  "engines": { "vscode": "^1.85.0" },
  "categories": ["AI", "Chat", "Programming Languages"],
  "keywords": ["ai", "agent", "openrouter", "code assistant", "autonomous", "fluxo"],
  "activationEvents": ["onStartupFinished"],
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
      { "command": "fluxo.openPanel",          "title": "Fluxo: Open AI Panel",          "icon": "$(robot)" },
      { "command": "fluxo.newChat",             "title": "Fluxo: New Chat",               "icon": "$(add)" },
      { "command": "fluxo.clearChat",           "title": "Fluxo: Clear Chat",             "icon": "$(clear-all)" },
      { "command": "fluxo.askAboutSelection",   "title": "Fluxo: Ask About Selection",    "icon": "$(comment)" },
      { "command": "fluxo.openSettings",        "title": "Fluxo: Settings",               "icon": "$(settings-gear)" },
      { "command": "fluxo.toggleSentinel",      "title": "Fluxo: Toggle Sentinel",        "icon": "$(eye)" }
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
          "items": { "type": "string" },
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
    "@vscode/vsce": "^2.24.0",
    "typescript": "^5.3.0"
  }
}

```

### 📁 FILE: `src\agentEngine.ts`
```typescript
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
  approvalCallback?: (summary: string, details: string) => Promise<boolean>
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

      // Push tool result with proper role for OpenRouter history
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: toolName,
        content: result.output,
      });
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

```

### 📁 FILE: `src\agents.ts`
```typescript

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
}

// ─── Manifesto Reference (injected at the top of every agent system prompt) ──

const MANIFESTO_REF = `CNOS_MANIFESTO: This workspace contains CNOS_MANIFESTO.md at its root. ` +
  `It is the binding constitutional document for all code produced by Fluxo AI — covering ` +
  `Editing Philosophy (read_file → replace_lines for editing existing files, write_file for new files only), Security Protocol ` +
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

THE TECH LEAD TEST — run this BEFORE calling any replace_lines or write_file:
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
    tools: ['read_file', 'write_file', 'replace_lines', 'replace_block', 'create_dir', 'list_dir', 'run_command', 'delete_file', 'delete_dir', 'propose_plan', 'search_in_files', 'ask_user_approval'],
    keywords: [
      'código', 'code', 'función', 'function', 'clase', 'class',
      'bug', 'error', 'fix', 'implementa', 'implement', 'crea',
      'create', 'archivo', 'file', 'componente', 'component',
      'api', 'endpoint', 'ruta', 'route', 'test', 'prueba',
      'refactori', 'migra', 'instala', 'install', 'npm', 'typescript',
    ],
    systemPrompt: `You are Fluxo Coder — an expert full-stack software engineer.

Your role: You are a PROACTIVE, AUTONOMOUS agent. Call tools to get things done — never narrate.

GIT AUTONOMY:
- If 'git pull' fails with "no tracking information", use 'git remote -v' to find the remote (e.g., origin) and use 'git pull origin master' (or the current branch).
- Use 'git status' and 'git checkout' to restore missing files.

GLOBAL WORKSPACE AUDIT:
- Before deleting ANY file, you MUST use 'search_in_files' or 'list_dir' to verify that the file is not a required dependency (e.g., imported in App.jsx). Deleting a file that is in use is a CRITICAL FAILURE.

WINDOWS COMMAND SAFETY:
- On Windows, ALWAYS quote paths in 'run_command' (e.g., "rd /s /q \\"src/pages\\"").
- Use 'delete_dir' instead of 'rd' for safety.

Behavior & CRITICAL CONSTRAINTS:
1. YOU ARE NOT SANDBOXED. Use 'run_command' for 'git', 'npm', 'firebase'.
2. TOOL INTEGRITY: NEVER simulate results. Call the tool and WAIT for the <tool_result>.
3. PLANNING MODE: Use <reasoning> to think and 'propose_plan' to structure your intent.
4. NO NARRATION OF LIMITATIONS: Focus entirely on what you ARE doing.
5. INTEGRITY AUDIT: After deleting files, verify that imports are NOT broken.
${HOLISTIC_DIAGNOSTIC_PROTOCOL}
BUG PROTOCOL: When asked to fix a bug, you MUST:
1. Use search_in_files or read_file to trace the ACTUAL data flow — do NOT assume.
2. Identify the root cause from the real code, NOT from training memory.
3. Use read_file → replace_lines for targeted fixes. Only use write_file if creating a NEW file.
4. After fixing, use search_in_files to verify no other file has the same bug pattern.

CODE-FIRST INVESTIGATION RULE: You are a Senior Software Engineer. When a user asks to modify access, features, or behaviors, NEVER assume it requires external database, admin panel, or third-party service access without checking the code first. ALWAYS use read_file or search_in_files to verify if the logic is hardcoded. If it is in the code, edit it directly — do not suggest external panel solutions when a code edit will work.

REGLA DE ORO: Para modificar código, DEBES usar read_file para obtener números de línea actualizados y luego replace_lines. Está PROHIBIDO intentar editar sin haber leído el archivo en la misma iteración.

REPLACE_LINES WORKFLOW — follow this every time you edit an existing file:
1. Call read_file → the output shows the file content with exact line numbers.
2. Identify start_line and end_line for the block you need to replace.
3. Call replace_lines with path, start_line, end_line, and new_content.
   The engine replaces exactly those lines — no string-matching fragility.
4. NEVER use write_file on an existing file.
5. For multiple edits to the same file, always call read_file again between edits
   to get fresh line numbers — previous replacements shift subsequent lines.
AUTO-VERIFY: replace_lines returns a "LINES REMOVED" preview. Read it — if the removed text is NOT what you intended to delete, call read_file immediately and redo the edit at the correct line range.
DUPLICATE PREVENTION: Before adding a new variable, hook, or import statement, you MUST verify in the file content you just read that it does not already exist. Search for the identifier name explicitly. Re-declaring an existing hook (e.g., const { vertical } = useParams(), useState, useEffect) or variable causes a Runtime Crash (Vite: "Identifier already declared"). If it already exists, skip that injection and continue to the next step.

REPLACE_BLOCK WORKFLOW — use this as an alternative when line numbers are unreliable:
1. Call read_file to get the current content.
2. Copy the exact text block you want to replace verbatim as target_snippet.
3. Call replace_block with path, target_snippet, and new_content.
   The engine does an exact string match — no line number drift.
WHEN TO PREFER replace_block: file is +300 lines | you've had repeated line-shift errors | you need to target a semantically unique block (a function, a JSX component, a config object).

JSX AST INTEGRITY: When editing React/JSX components, NEVER replace fragmented lines containing partial tags. You MUST read and replace the ENTIRE logical JSX block (e.g., from the opening <div> to its matching closing </div>). Replacing partial tags corrupts the AST and crashes the dev server.
HEALING MODE: If you are blocked by SYNTAX_GUARD or AST Corruption errors while trying to fix an ALREADY broken file, use "healing_mode: true" in your next replace_lines or replace_block call. This bypasses the guards and allows your surgical fix to pass.

LARGE FILE STRATEGY — for files longer than ~300 lines:
- Use search_in_files to locate the exact function, class, or variable you need before reading.
- Then call read_file to get the current line numbers, identify start_line/end_line, and call replace_lines.

BUILD VERIFICATION — MANDATORY for structural changes:
Trigger when your changes include ANY of: new/deleted files, changed imports/exports,
modified TypeScript types or function signatures, routing, app entry points, or config files.
Protocol:
1. After making all edits, execute: run_command → "npm run build"
2. Exit code 0 → build passed → proceed to Orchestrator's Report.
3. Exit code non-zero → build failed → DO NOT emit the Orchestrator's Report.
   Parse the compiler output for the exact file and line number of each error.
   Fix each error with read_file → replace_lines. Then run the build again.
   Repeat until exit code is 0. The Orchestrator's Report is ONLY permitted after a clean build.

BODYGUARD PROTOCOL — call ask_user_approval ONLY for high-risk operations:
  ✅ REQUIRE APPROVAL: deleting a file or directory | editing infrastructure files (package.json, vite.config.*, tsconfig.json, firebase.json, .env, any CI/CD config) | request is genuinely ambiguous about which file to touch and you cannot determine it from context or search_in_files | touching 5+ files in a single plan.
  ❌ NO APPROVAL NEEDED: normal feature code edits | bug fixes where the target file is clear | creating new files | running builds/tests | reading files | any routine code change the user explicitly described.
  When in doubt: use search_in_files to resolve ambiguity instead of asking for approval.

Act as a brilliant, silent, and lethal worker.
${WEB_ARCHITECTURE_SOP}`,
  },

  designer: {
    id: 'designer',
    name: 'Designer',
    emoji: '🎨',
    color: '#ec4899',
    description: 'UI/UX design, stock images, CSS, landing pages',
    tools: ['read_file', 'write_file', 'create_dir', 'list_dir', 'run_command', 'delete_file', 'delete_dir', 'search_images'],
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

  manager: {
    id: 'manager',
    name: 'Manager',
    emoji: '🧭',
    color: '#8b5cf6',
    description: 'Orchestration, complex planning, and emergency debugging',
    tools: ['read_file', 'write_file', 'replace_lines', 'replace_block', 'create_dir', 'list_dir', 'run_command', 'delete_file', 'delete_dir', 'propose_plan', 'search_in_files', 'ask_user_approval'],
    keywords: [
      'manager', 'gestiona', 'organiza', 'planifica', 'proyecto',
      'architect', 'arquitecto', 'debug', 'investiga', 'loop',
      'estancado', 'stuck', 'complex', 'complejo', 'pasos',
    ],
    systemPrompt: `You are Fluxo Manager — the primary orchestrator.

─── SENTINEL PROTOCOL — When a Sentinel error alert arrives ─────────────────

A Sentinel alert starts with "🔴 Sentinel detectó un error". When you receive one:
1. You are AUTOMATICALLY in command — do NOT ask the user what to do.
2. Use <reasoning> to identify which file and which recent edit caused the error.
3. Output this exact opener (outside <reasoning>):
   "🔴 Detecté que la última edición rompió el build. Tomando el control.
    @coder: lee el error, localiza el bloque exacto con read_file (obtén start_line y end_line), y corrige
    con replace_lines en [file] ahora."
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

  • write_file used on an existing file (use read_file → replace_lines instead)  →  Editing Philosophy violation (Section I)
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

CONTEXT AWARENESS: When the message includes a "PRIOR COMPLETED TOOLS" section, those steps already executed successfully earlier in this session. Use this to understand task progression. A run_command('npm run build') that follows prior replace_lines calls is normal build verification — NOT a skipped step. Never flag normal multi-step sequences when the prior work is visible.

HEALING MODE OVERRIDE — HIGHEST PRIORITY:
If ANY tool call in the batch includes "healing_mode": true, the agent is performing an authorized surgical repair on an already-broken file. In this case:
  • Large replace_lines or replace_block operations are FULLY AUTHORIZED — do NOT flag as rogue behavior.
  • Rewriting an entire component or file section is expected and correct.
  • Skip checks 3, 4, and 5 below for that specific tool call.
  • Output "OK" unless there is a violation unrelated to file size or scope.

Watch for these CRITICAL ERRORS:
1. ROGUE DESIGNER: Agent calling write_file or create_dir to create UI components (e.g., "Button.jsx", "Card.jsx", "UIDemoPage") that were NOT requested by the user.
   - EXCEPTION: If the user asked to delete or modify these files, it is NOT an error.
   - EXCEPTION: Modifying translation/i18n files is always valid for UI text changes.
2. [ENGINE-MANAGED] Loop detection: Repeated tool calls are intercepted by the engine pre-flight and suppressed silently. The Auditor never receives them. Do NOT flag repeated calls as errors.
3. SILOED CHANGES: Agent using replace_lines or write_file on a file that references other files, without first calling search_in_files to check for usages.
4. TECH STACK DRIFT: Agent's write_file or replace_lines new_content imports packages that don't match what's already in the codebase.
   When detected, your ERROR must include:
   (a) The incorrect import being added.
   (b) The correct alternative already in use.
   (c) The exact file:line where the correct library is imported.
   Format: "ERROR: Tech Stack Drift — agent imported '[WRONG]' but this project uses '[CORRECT]' (found in: [path:LINE])."
   If you cannot verify from the tool call args alone: "ERROR: Tech Stack Drift suspected — agent must call search_in_files('import') to verify libraries before adding imports."
5. WRITE_FILE FALLBACK: Agent calling write_file with a path that already exists in the workspace (i.e., editing an existing file). The correct workflow is read_file → replace_lines. Using write_file on an existing file risks hallucinating the entire file from training memory.
6. REDUNDANCY CHECK: Compare the current tool calls with the "PRIOR COMPLETED TOOLS" section. If the agent is attempting to re-declare a hook (useParams, useState, useEffect, useRef, useContext, useMemo, useCallback, etc.) or a variable (const, let, var declarations) that was already successfully injected in a previous turn of this same session, output:
   ERROR: REDUNDANT_DECLARATION — '[identifier]' was already declared in a prior turn. Re-declaring it will cause a Runtime Crash (duplicate identifier). The agent must skip this injection and proceed to the next pending step.
   SCOPE: ONLY check the actual code logic inside "new_content". DO NOT flag tool names like "replace_block" or "read_file" as redundant declarations. Ignore tool names completely in this check.

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
─── OUTPUT SEPARATION PROTOCOL — MANDATORY ────────────────────────────────────

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
You cannot claim to have made changes unless you successfully executed write_file, replace_lines, or replace_block during this session.
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
  "Texto reemplazado"         → replace_lines edits
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
  Do NOT add the watermark when using replace_lines on an existing file.

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

// ─── Agent Router ──────────────────────────────────────────────────────────────

/** Detect which agent should handle a message based on keywords or @mentions */
export function routeToAgent(message: string): string {
  const lower = message.toLowerCase();

  // Explicit @mention overrides everything
  if (lower.includes('@coder')) { return 'coder'; }
  if (lower.includes('@designer') || lower.includes('@diseñador')) { return 'designer'; }
  if (lower.includes('@dashboard')) { return 'dashboard'; }
  if (lower.includes('@payments') || lower.includes('@pagos')) { return 'payments'; }
  if (lower.includes('@manager')) { return 'manager'; }

  // Score each agent by keyword matches
  const scores: Record<string, number> = { coder: 0, designer: 0, dashboard: 0, payments: 0, manager: 0 };

  for (const [agentId, agent] of Object.entries(AGENTS)) {
    for (const kw of agent.keywords) {
      if (lower.includes(kw)) {
        scores[agentId] = (scores[agentId] || 0) + 1;
      }
    }
  }

  // Find highest scoring agent
  const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] > 0) {
    return top[0];
  }

  return 'coder'; // default
}

/** Build full system prompt for an agent including tools and the shared separation protocol */
export function buildAgentSystemPrompt(agentId: string): string {
  const agent = AGENTS[agentId] || AGENTS.coder;
  return `${MANIFESTO_REF}${agent.systemPrompt}\n${SEPARATION_PROTOCOL}`;
}

/** Get all agents as a list for UI display */
export function getAgentList(): Array<{ id: string; name: string; emoji: string; color: string; description: string }> {
  return Object.values(AGENTS).map(({ id, name, emoji, color, description }) => ({
    id, name, emoji, color, description,
  }));
}

```

### 📁 FILE: `src\extension.ts`
```typescript
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
      if (msg.path) {
        const folders = vscode.workspace.workspaceFolders;
        if (folders?.length) {
          const fullPath = path.join(folders[0].uri.fsPath, msg.path);
          try {
            const doc = await vscode.workspace.openTextDocument(fullPath);
            await vscode.window.showTextDocument(doc);
          } catch {
            vscode.window.showWarningMessage(`Could not open: ${msg.path}`);
          }
        }
      }
      break;

    case 'openSettings':
      vscode.commands.executeCommand('workbench.action.openSettings', 'fluxo');
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

    for await (const event of runAgentLoop(
      userText,
      agentId,
      _conversationHistory,
      engineConfig,
      workspacePath,
      _currentAbortController.signal,
      _sentinelHasError,
      approvalCallback
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
  
  if (!config.apiKey) {
    vscode.window.showErrorMessage('API Key missing. Please configure it in settings.');
    return;
  }

  if (_conversationHistory.length < 2) {
    vscode.window.showInformationMessage('Not enough history to compress yet (minimum 2 messages).');
    return;
  }

  _postToPanel({ type: 'thinking', text: 'Compressing context…' });

  try {
    const summary = await summarizeHistory(_conversationHistory, { 
      apiKey: config.apiKey, 
      model: config.model, 
      maxTokens: 1024, 
      streamingEnabled: false 
    });

    if (!summary) {
      throw new Error('Received empty summary from AI');
    }

    _conversationHistory = [
      { role: 'assistant', content: `🔄 **Context Compressed**. Previous conversation summary:\n\n${summary}` }
    ];
    context.workspaceState.update(STORAGE_KEY, _conversationHistory);
    
    _postToPanel({ type: 'chatCleared' }); // UI resets
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
  return {
    apiKey,
    deepseekApiKey: deepseekApiKey || undefined,
    geminiApiKey: geminiApiKey || undefined,
    model: vscodeConfig.get<string>('defaultModel') || 'google/gemini-2.5-flash',
    maxTokens: vscodeConfig.get<number>('maxTokens') || 4096,
    streamingEnabled: vscodeConfig.get<boolean>('streamingEnabled') ?? true,
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
      <select id="model-select" class="model-select"></select>
      <button id="sentinel-btn" class="header-btn sentinel-btn" title="Sentinel: off — click to activate auto-heal">👁</button>
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

  console.log('[Fluxo AI] v7.5.2 — backup cleanup on session start');
}

export function deactivate(): void {
  _currentAbortController?.abort();
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

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Create or fully overwrite a file with the given content. Only use for NEW files — for existing files, always use edit_file to avoid overwriting unrelated code.',
    parameters: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'File path relative to workspace root.' },
        content: { type: 'string', description: 'Complete file content to write.' },
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
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, args.content, 'utf-8');
  const size = Buffer.byteLength(args.content, 'utf-8');
  return { success: true, output: `Written: ${args.path} (${size} bytes)` };
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
import * as AskApprovalTool   from './AskApprovalTool';
import { ToolResult, NativeTool } from './shared';

export { ToolResult, NativeTool };

// ─── Tool Registry ────────────────────────────────────────────────────────────

const ALL_TOOLS = [
  FileReadTool,
  FileWriteTool,
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
import * as path from 'path';
import { NativeTool, ToolResult, safePath } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'replace_block',
    description: `Replace an exact text block in a file using string-based targeting — no line numbers required.
WHEN TO USE: Prefer over replace_lines when the file is long (+300 lines), line numbers keep shifting, or you need to target a semantically unique block (a function body, JSX component, config object).
MANDATORY WORKFLOW: (1) Call read_file to get the current content. (2) Copy the exact text block you want to replace verbatim as target_snippet. (3) Call replace_block with new_content.
STRICT RULES:
  • target_snippet must match the file EXACTLY — same whitespace, indentation, and newlines.
  • Fails if target_snippet is not found (typo or stale content — call read_file again).
  • Fails if target_snippet appears more than once (ambiguous — add more surrounding lines to make it unique).
  • Use new_content = "" to delete the block without inserting anything.
  • Does NOT bypass guards unless healing_mode: true is set.`,
    parameters: {
      type: 'object',
      properties: {
        path:           { type: 'string',  description: 'File path relative to workspace root.' },
        target_snippet: { type: 'string',  description: 'The exact text block to find and replace. Must be unique in the file. Copy verbatim from read_file output — do not paraphrase or shorten.' },
        new_content:    { type: 'string',  description: 'Text to insert in place of target_snippet. Use empty string "" to delete the block.' },
        healing_mode:   { type: 'boolean', description: 'Set to true ONLY when fixing an already-broken file (syntax error, unbalanced braces, AST corruption). Disables brace-balance and AST guards.' },
      },
      required: ['path', 'target_snippet', 'new_content'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const fp = safePath(workspacePath, args.path);
  if (!fs.existsSync(fp)) {
    return { success: false, output: `File not found: ${args.path}. Use list_dir to verify the path.` };
  }
  if (typeof args.target_snippet !== 'string' || args.target_snippet === '') {
    return { success: false, output: 'CRITICAL ERROR: target_snippet must be a non-empty string. Copy the exact text block from read_file output.' };
  }
  if (typeof args.new_content !== 'string') {
    return { success: false, output: 'CRITICAL ERROR: new_content must be a string. Use empty string "" to delete the block.' };
  }

  const original = fs.readFileSync(fp, 'utf-8');

  // Count occurrences — must be exactly 1
  const parts       = original.split(args.target_snippet);
  const occurrences = parts.length - 1;

  if (occurrences === 0) {
    return {
      success: false,
      output: `MATCH ERROR: target_snippet not found in ${args.path}.\n` +
              `This usually means the file was modified since your last read_file, or the snippet has wrong whitespace/indentation.\n` +
              `ACTION REQUIRED: Call read_file again to get the current content, then re-copy the target text verbatim.`,
    };
  }
  if (occurrences > 1) {
    return {
      success: false,
      output: `AMBIGUOUS MATCH: target_snippet appears ${occurrences} times in ${args.path}.\n` +
              `ACTION REQUIRED: Add more surrounding lines (e.g., include the function signature above or the closing brace below) to make the snippet unique.`,
    };
  }

  const updated = original.replace(args.target_snippet, args.new_content);

  if (updated.trim() === '' && original.trim() !== '') {
    return { success: false, output: 'SAFETY ABORT: replacement would produce an empty file. Verify your target_snippet and new_content.' };
  }

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
                  `ESTRATEGIA: Asegúrate de incluir el bloque JSX completo desde su apertura hasta su cierre en target_snippet.\n` +
                  `Si estás arreglando un archivo YA corrupto, usa "healing_mode: true".`,
        };
      }
    }
  }

  // Auto-backup before write
  try {
    const backupDir = path.join(workspacePath, '.fluxo', 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(backupDir, `${path.basename(fp)}_${timestamp}.bak`), original, 'utf-8');
  } catch { /* non-fatal */ }

  fs.writeFileSync(fp, updated, 'utf-8');

  const removedPreview = args.target_snippet.length > 300
    ? args.target_snippet.slice(0, 300) + '\n…(truncated)'
    : args.target_snippet;

  return {
    success: true,
    output: `replace_block: ${args.path} — 1 block replaced.\n\nBLOCK REMOVED:\n${removedPreview}\n\nEDICIÓN EXITOSA — Verifica que el bloque eliminado es el correcto. Si la tarea no está completa, llama la SIGUIENTE herramienta ahora.`,
  };
}

```

### 📁 FILE: `src\tools\ReplaceLinesTool\index.ts`
```typescript
import * as fs from 'fs';
import * as path from 'path';
import { NativeTool, ToolResult, safePath } from '../shared';

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
        new_content: { type: 'string', description: 'Text to insert in place of the removed lines. Pass an empty string "" to delete the range. Do NOT add a trailing newline — the engine handles line endings.' },
        healing_mode: { type: 'boolean', description: 'Set to true ONLY if you are fixing a syntax error, unbalanced brace, or AST corruption. This temporarily disables the syntax and AST guards to allow surgical fixes on already broken files.' },
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
  if (typeof args.new_content !== 'string') {
    return { success: false, output: 'CRITICAL ERROR: new_content must be a string. Use an empty string "" to delete lines without inserting anything.' };
  }

  const original   = fs.readFileSync(fp, 'utf-8');

  // Black Box auto-backup — save original before any modification
  try {
    const backupDir  = path.join(workspacePath, '.fluxo', 'backups');
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

  fs.writeFileSync(fp, updated, 'utf-8');

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

### 📁 FILE: `src\tools\RunCommandTool\index.ts`
```typescript
import { execSync } from 'child_process';
import { NativeTool, ToolResult } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'run_command',
    description: 'Execute a shell command in the workspace. On Windows, always quote paths containing spaces.',
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

  const BLOCKED = [/rm\s+-rf\s+[/\\~]/, /format\s+[a-z]:/, /del\s+\/[fs]/i, /mkfs/, /dd\s+if=/];
  if (BLOCKED.some(b => b.test(cmd))) {
    return { success: false, output: `Blocked dangerous command: ${cmd}` };
  }

  // Block persistent dev-server processes — they hang spawnSync and cause ETIMEDOUT loops.
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
      output: `CRITICAL: Persistent servers like "npm run dev" hang the swarm. DIRECTIVE: Do not panic. Immediately use "npm run build" instead to verify your changes and continue the workflow.`,
    };
  }

  const output = execSync(cmd, {
    cwd: workspacePath,
    encoding: 'utf-8',
    timeout,
    maxBuffer: 1024 * 1024 * 4,
  });
  return { success: true, output: output || '(command completed with no output)' };
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
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

// ─── Shared Helpers ───────────────────────────────────────────────────────────

export function safePath(workspacePath: string, p: string): string {
  if (!p) { throw new Error('Path is required'); }
  const resolved = path.resolve(workspacePath, p);
  if (!resolved.toLowerCase().startsWith(path.resolve(workspacePath).toLowerCase())) {
    throw new Error(`Path traversal blocked: ${p}`);
  }
  return resolved;
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

