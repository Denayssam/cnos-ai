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
