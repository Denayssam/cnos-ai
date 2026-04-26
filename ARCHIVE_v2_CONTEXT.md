# ⬡ CNOS AI — MASTER CONTEXT (v2.6.0)

This document is a comprehensive technical blueprint of the CNOS AI extension.
Feed it into any LLM (Gems, Claude, GPT) to provide full context for maintenance, task orchestration, or Phase 3.0 implementation.

---

## 1. MISSION STATEMENT
CNOS AI is a fully autonomous, extension-native agent swarm for VS Code. It replicates the "Claude Code" experience but focuses on multi-agent collaboration (Swarm Intelligence) and a glassmorphic UI. It uses the user's own OpenRouter API key — no subscription required.

---

## 2. SYSTEM ARCHITECTURE

Built on **Node.js + VS Code Extension API + OpenRouter**.

### A. The Three Pillars

| File | Role | What It Does |
|---|---|---|
| `src/tools.ts` | **The Hands** | Atomic file/shell/search handlers. Exports `TOOL_DEFINITIONS`, `executeTool`, `parseToolCalls`, `buildToolsSystemPrompt` |
| `src/agents.ts` | **The Personalities** | Agent router + 5 specialized agents + Sherlock Auditor prompt |
| `src/agentEngine.ts` | **The Brain** | Recursive autonomous loop. Parses tool calls, executes them, feeds `<tool_result>` back into context |

### B. Available Tools (injected into agent system prompts)

| Tool | Purpose |
|---|---|
| `read_file` | Read full file contents (handles UTF-16, truncates at 60KB) |
| `write_file` | Create or fully overwrite a file (XML format to avoid JSON escaping) |
| `edit_file` | **Surgical find/replace** — preferred over write_file for existing files |
| `create_dir` | Create directory tree |
| `list_dir` | List directory contents |
| `run_command` | Execute shell commands (Windows-safe, 30s timeout, blocks dangerous patterns) |
| `delete_file` | Delete a single file |
| `delete_dir` | Recursively delete a directory |
| `propose_plan` | Write IMPLEMENTATION_PLAN.md for complex tasks |
| `search_in_files` | Grep-style search across workspace files |
| `search_images` | Get free Lorem Picsum image URLs |

### C. Agents

| Agent | Emoji | Trigger Keywords | Focus |
|---|---|---|---|
| `coder` | 💻 | code, bug, fix, archivo, npm | General coding, files, commands |
| `designer` | 🎨 | diseño, css, imagen, tailwind | UI/UX, styling, layouts |
| `dashboard` | 📊 | chart, gráfica, analytics, kpi | Data visualization |
| `payments` | 💳 | pago, stripe, checkout | Payment integrations |
| `manager` | 🧭 | manager, debug, complejo, stuck | Orchestration, complex planning |

Routing: keyword scoring → falls back to `coder`. Explicit `@mention` overrides.

### D. Sherlock Auditor (The Safety Layer)
A secondary AI call that reviews the agent's plan before execution.

**Currently blocks:**
1. Rogue UI component creation (unrequested Button.jsx, Card.jsx, etc.)
2. Sandbox hallucination ("I cannot run commands")
3. Ghost execution (narrating success without calling the tool)
4. Looping (same tool call repeated with same args)
5. Siloed changes (modifying without checking usages)
6. Tech stack drift (importing wrong packages not used by the codebase)
7. write_file fallback (using write_file on existing file after edit_file fails)

**Explicitly allowed (do NOT block):**
- Modifying translation/i18n files when the task involves UI text changes

### E. UI/WebView (`media/main.js` + `media/style.css`)
- Glassmorphism design: blurry backgrounds, high-contrast typography
- Response wrapper pattern: tool activity in a `<details>` block always above the text bubble
- Smart scrolling: auto-scroll only if user is at bottom
- Token wheel: character-count gauge, click to compress context
- Agent badge: colored pill showing which agent is active

---

## 3. CURRENT STATE: v2.6.0

### What's Stable
- Tool integrity: robust regex parsing for `<tool_call>` and `<write_file>`
- Git mastery: resolves "no tracking info" errors by auditing remotes
- Windows-optimized: uses `fs.rmSync` for directory cleanup
- Response wrapper: tool activity cards are ordered correctly above the AI text bubble
- `edit_file` tool: two-strategy engine (exact match → fuzzy line match), avoids full-file rewrites
- **Output Separation Protocol**: every agent is required to wrap all internal reasoning in `<reasoning>` tags; the UI renders them as a collapsible "🧠 Proceso mental" block so users only see clean summaries

### Known Limitations (READ BEFORE GIVING CNOS TASKS)
1. **Max tokens truncation**: When asked to rewrite a large file, the model may hit max_tokens mid-generation and hallucinate the rest from training memory — using wrong package names, wrong imports.
   - **Mitigation**: Never ask CNOS to rewrite files over ~200 lines. Break into targeted edits.

2. **edit_file find strings**: Keep `find` to 5-10 lines max. The fuzzy engine handles indentation differences, but can't match across large gaps. If it fails twice, read the file and pick a shorter unique anchor.

3. **Loop detector is aggressive**: After 3 identical tool calls, it switches to Manager agent. This is correct behavior but can interrupt a task mid-way.

4. **Sherlock can over-block**: The Auditor sees each plan in isolation and may flag legitimate helper steps. Known exception: i18n/translation file changes are whitelisted.

---

## 4. HOW TO GIVE CNOS AI TASKS EFFECTIVELY (GEM ORCHESTRATION GUIDE)

This section is for **any AI orchestrator** (Gem, Claude, GPT) helping the user delegate work to CNOS AI.

### Golden Rules

**Rule 1 — Surgical over wholesale**
> Never ask CNOS to "rewrite X file." Instead ask: "In file X, change [specific thing] to [specific thing]."
> CNOS should use `edit_file`, not `write_file`, on existing files.

**Rule 2 — Name the anchor**
> Give CNOS a unique string it can use as the `find` anchor. Example:
> ✅ "Find the line with `{t('dash_occupancy')}` and wrap it in a conditional..."
> ❌ "Update the occupancy section in the dashboard"

**Rule 3 — Break multi-file tasks into steps**
> Tell CNOS exactly which files to touch in which order. Don't say "add this feature" — say:
> 1. "In `types.ts`, add field X"
> 2. "In `translations.ts`, add keys A and B"
> 3. "In `Dashboard.tsx`, find line `{t('dash_occupancy')}` and replace with..."

**Rule 4 — Check the tech stack before assigning**
> The main project (CoHostHQ / airbnb-pro) uses:
> - **Icons**: `lucide-react` (NOT @heroicons/react)
> - **i18n**: custom `useLanguage()` hook from `../i18n/LanguageContext` (NOT react-i18next)
> - **State**: React `useState`/`useMemo` (NOT zustand, jotai, etc.)
> - **Styling**: Tailwind CSS
> - **Backend**: Firebase Firestore via `src/services/cloudService.ts`
> Include these constraints in your task description so CNOS doesn't drift.

**Rule 5 — Translation keys always go in both languages**
> `src/i18n/translations.ts` has `es` and `en` objects. Any new UI text needs a key in both. Example prompt addition: "Also add the Spanish and English translation keys to translations.ts."

**Rule 6 — After a CNOS failure, don't fix it yourself**
> If CNOS breaks something, describe the broken state to CNOS and let it fix its own work. This builds CNOS's reliability over time and avoids manual patches that CNOS doesn't know about.

### Task Template for GEM → CNOS Delegation

```
@coder In [filename], find the line that contains "[unique anchor text]".
Replace it with:
[new code block — keep it short]

Tech stack reminder: icons = lucide-react, i18n = useLanguage(), styling = Tailwind.
If you need to add translation keys, update both `es` and `en` in src/i18n/translations.ts.
Use edit_file, not write_file.
```

---

## 5. COHOSTHQ PROJECT (Primary Test Target)

CNOS AI is frequently used to maintain **CoHostHQ** (`D:\CNOS_Mirror\03_EXPERIMENTAL\airbnb-pro`), a Firebase + React + Vite app for property finance management.

### CoHostHQ Tech Stack
- **Framework**: React 18 + TypeScript + Vite
- **Styling**: Tailwind CSS (`brand-*` color tokens)
- **Icons**: `lucide-react`
- **i18n**: `useLanguage()` from `src/i18n/LanguageContext.tsx`, keys in `src/i18n/translations.ts`
- **Backend**: Firebase Firestore via `src/services/cloudService.ts`
- **Auth**: Firebase Auth (`auth.currentUser`)

### Key Files
| File | Purpose |
|---|---|
| `src/types.ts` | All TypeScript interfaces (`Property`, `Transaction`, `Reminder`, etc.) |
| `src/App.tsx` | Root component, routing between views |
| `src/components/Dashboard.tsx` | Resumen tab — summary cards, occupancy, upcoming bills, charts |
| `src/components/PropertyConfigView.tsx` | Property creation/edit form with type selector (rental vs household) |
| `src/components/AIAssistant.tsx` | In-app AI chat powered by Firebase Functions |
| `src/services/cloudService.ts` | All Firestore read/write — critical: `saveProperty` must include ALL fields in `finalData` or they'll be silently dropped |
| `src/i18n/translations.ts` | All UI strings in `es` and `en` |

### Property Type Feature (Completed)
Properties have `propertyType?: 'rental' | 'household'`. When `household`:
- Strategic Context labels change (no Airbnb-specific labels)
- AI auto-fill block is hidden in PropertyConfigView
- Dashboard should show budget info instead of occupancy/nights stats
- Property card shows 🏡 badge instead of 🏠

### Firestore Rules Pattern
All Firestore security rules use `request.auth.token.email.lower()` — always lowercase emails.

---

## 6. PHASE 3.0 — VISION & ROADMAP

### Key Features to Implement
1. **Autonomous Visual QA (The Eyes)**: Screenshot tool or DOM-tree scraper. Agent "sees" the app and fixes layout bugs.
2. **Real-Time Self-Healing**: Monitor terminal/dev-server errors. Swarm auto-intervenes on build failures.
3. **Long-Term Vector Memory**: Local Vector DB (ChromaDB/Pinecone). Remembers architectural decisions across projects.
4. **Proactive Suggestions**: Agent suggests Performance/Security/SEO improvements before being asked.
5. **edit_file improvements**: Replace `String.prototype.replace()` with a proper diff/patch engine for multi-line edits.

---

## 7. TECHNICAL CONSTRAINTS FOR ALL AI AGENTS

- **Language**: TypeScript (source), Vanilla JS/CSS (media/WebView)
- **Tool call format**:
  - Standard: `<tool_call>{"name": "...", "args": {...}}</tool_call>`
  - Write: `<write_file path="...">CODE</write_file>`
- **No hallucinations**: NEVER use `<tool_code>` or simulate results
- **Path safety**: Always use `path.resolve` and check for traversal
- **Windows compatibility**: Quote all paths in shell commands, use `delete_dir` not `rd`
- **edit_file find strings**: 1-3 lines max, pick a unique anchor

---

**Current Version**: 2.6.0
**Status**: Stable. Phase 3.0 in progress.
**Last updated**: 2026-04-23
