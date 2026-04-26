/* global acquireVsCodeApi */
// ─── Fluxo AI v7.8.2 — The Contextual Grip ───────────────────────────────────
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

  function populateModels(models, preferred) {
    if (!models || !models.length) { return; }
    const current = modelSelect.value;
    modelSelect.innerHTML = models.map(m =>
      `<option value="${m}">${MODEL_LABELS[m] || m}</option>`
    ).join('');
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
    if ((data.name === 'edit_file' || data.name === 'replace_lines' || data.name === 'replace_block' || data.name === 'write_file' || data.name === 'search_and_replace')) {
      const raw = data.name === 'edit_file' ? (args.new_string || '')
        : data.name === 'search_and_replace' ? (args.replace_snippet || '')
        : (data.name === 'replace_lines' || data.name === 'replace_block') ? (args.new_content || '')
        : (args.content || '');
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
        <p class="welcome-subtitle">Persistent Agent Swarm v7.8.2</p>
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
  document.getElementById('streaming-info-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'showStreamingInfo' }));

})();
