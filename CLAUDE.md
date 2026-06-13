# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Fluxo AI** (`package.json` name `fluxo-ai`, publisher `fluxotechai`) is a VS Code extension — an autonomous, multi-agent ("swarm") AI coding assistant. The repo folder is `cnos-extension`; the product/marketplace name is Fluxo AI. It talks to LLMs via OpenRouter (and optionally Gemini AI Studio / DeepSeek direct), runs a cognitive tool-use loop, and edits the user's workspace through a Human-in-the-Loop UI rendered in a webview.

Note: docs (README, INSTALL, CNOS_MANIFESTO) are written in **Spanish**; source code and comments are in English.

## Critical rules (CNOS Manifesto)

[CNOS_MANIFESTO.md](CNOS_MANIFESTO.md) is the **binding constitution**. These are the non-negotiable rules — both how the agent swarm must behave and the discipline to follow when editing this codebase. When in doubt, the manifesto has the final word.

### Quality Gate — never ship a broken build

- **Never declare a task complete, and never package, while the build fails.** The engine runs `npm run build` (here: `npm run compile`) silently before accepting completion; completion is blocked until exit code 0.
- On failure the agent must read the error and fix it — `consecutiveBuildFailures++`. The counter resets after each successful file edit.
- **Circuit Breaker: after 3 consecutive build failures, stop.** The agent is forbidden from retrying completion and MUST call `ask_user_approval` to escalate (explain the errors, request manual guidance or an explicit bypass). Treat the Circuit Breaker as a mandatory escalation signal, not an engine error.
- Bypass exists only when the user explicitly approves it ("skip build"/"bypass") via `ask_user_approval`; once granted it holds for the rest of the session.
- Applies to you too: do not commit, tag, or `npm run package` this repo with `npm run compile` failing.

### UI/UX SOP — apply automatically on every web project (no need to be asked)

- **Glassmorphism + Tailwind** is the official design system: `bg-white/10 backdrop-blur-md border border-white/20 rounded-2xl shadow-xl`.
- **Mobile-first, always.** Breakpoints flow `sm:` → `md:` → `lg:` → `xl:`. Never desktop-first.
- **`lucide-react` is the exclusive icon library.** `@heroicons`, `react-icons`, and any other icon package are forbidden unless the user explicitly requests one.
- Performance: lazy-load heavy components/routes/dashboards with `React.lazy` + `Suspense`. SEO/LLMO: every route needs `application/ld+json` Schema Markup, OpenGraph tags, and a `<meta name="description">`; maintain `/llms.txt` at project root.

### Editing philosophy — scalpel, not chainsaw

- **`write_file` is for NEW files only.** Edit existing files with `replace_block` / `replace_symbol` / `search_and_replace`. Rewriting a whole file from memory is treated as hallucination (Sherlock blocks it).
- **Explore before editing:** `get_repo_map` → `glob` → `grep` → `read_file` the exact block. Never assume the directory tree — confirm with `list_dir`/`get_repo_map` first. Paths are always relative to repo root (absolute paths are rejected).
- Agent roles are security boundaries: `@manager` orchestrates and never writes code; `@planner` is read-only (produces the plan); `@coder`/`@designer` are the only writers. `@manager` must not declare a task complete while a worktree is unmerged/unreviewed.

## Commands

```bash
npm install            # install deps
npm run compile        # tsc -p ./  → emits to out/ (this is the "build")
npm run watch          # tsc -watch — auto-recompile on save
npm run package        # vsce package → produces fluxo-ai-<version>.vsix
```

- **There is no test framework and no linter.** "Verify it builds" means `npm run compile` passes with zero TS errors (`strict: true`). Always run it before considering a change done.
- To run the extension live: open the repo in VS Code and press **F5** (Extension Development Host). Panel hotkey is `Ctrl+Alt+C`.
- There is no single-test command because there are no tests.

## Release ritual (do not skip steps)

Releases are driven by git tags via [.github/workflows/release.yml](.github/workflows/release.yml) — pushing a `v*` tag triggers GitHub Actions to build and publish a GitHub Release with the `.vsix`. A version bump is **not** done until all of these happen together:

1. Bump `"version"` in [package.json](package.json).
2. Add a [CHANGELOG.md](CHANGELOG.md) entry for the new version.
3. Bump the version badge/subtitle in [README.md](README.md) (and the `vX.X.X` references).
4. `npm run package` to produce the new `.vsix`.
5. `git push origin vX.X.X` (push the **tag**) — this, not `git push origin main`, is what triggers the release pipeline.

## Architecture

Three top-level modules form the spine; everything else supports them.

### 1. `src/extension.ts` — the VS Code host / bridge

The only file that imports `vscode`. Responsibilities:
- `activate()` registers commands (`fluxo.*`), the sidebar `WebviewViewProvider` (`FluxoSidebarProvider`), and creates/manages the main webview panel.
- Hosts the **webview message protocol**: `webview.onDidReceiveMessage` switches on `msg.type` (`sendMessage`, `clearChat`, `compressHistory`, `cancelStream`, `open_git_diff`, `open_worktree_diff`, `worktree_decision`, `sentinelToggle`, etc.); the engine pushes UI updates back via `panel.webview.postMessage`.
- **Injects all VS Code-specific capabilities into the engine as callbacks** (see below) — the engine itself is `vscode`-free and reusable.
- Webview UI assets live in [media/](media/) (`main.js`, `style.css`) — the glassmorphism chat panel, tool cards, model selector, worktree diff review.

### 2. `src/agentEngine.ts` — the cognitive loop (largest file, ~190KB)

`runAgentLoop(...)` is an **`AsyncGenerator<AgentEvent>`** — the heart of the system. It:
- Detects intent / routes to an agent (unless the agent is a sub-agent like `@planner`, which bypasses routing).
- Runs the iterate→call-LLM→execute-tools loop (capped at `MAX_ITERATIONS = 25`, with a "Continuation Audit" that can grant a bounded extension up to `MAX_EXTENSION_ITERATIONS`).
- `yield`s typed `AgentEvent`s (`agentSelected`, `thinking`, `streamChunk`, `toolCall`, `toolResult`, `iterationCount`, `error`, …) that `extension.ts` translates into webview messages.
- `callOpenRouterBlocking()` is the LLM call. `resolveEndpointAndKey()` routes by model slug: bare `deepseek-*` → DeepSeek API, bare `gemini-*` → Gemini AI Studio, anything with a `/` (e.g. `anthropic/claude-sonnet-4.5`, `google/gemini-2.5-flash`) → OpenRouter.
- `summarizeHistory()` powers the context-compression ("Token Wheel") feature.

**The callback bridge** — `runAgentLoop` takes many optional callbacks (`approvalCallback`, `nativeEditCallback`, `getCodeStructureCallback`, `replaceSymbolCallback`, `worktreeReviewCallback`, `hitlCommandCallback`, `getDiagnosticsCallback`, MCP callbacks, `discoveryAnswerCallback`). These are how the engine reaches LSP, native VS Code edits/diffs, HITL modals, and MCP transports without depending on `vscode`. When a callback is absent the engine degrades gracefully (treats the capability as unavailable).

### 3. `src/agents.ts` — the swarm + Sherlock auditor

Defines `AGENTS` (the `AgentDefinition` for `@manager`, `@planner`, `@coder`, `@designer`, `@dashboard`, `@payments`) and the system-prompt builders (`buildAgentSystemPrompt`, `ROUTER_PROMPT`, `REVISOR_PROMPT`, `SUMMARIZER_PROMPT`). Each agent has a fixed `tools: string[]` allow-list and `keywords` for routing; `isolation: 'worktree'` triggers a worktree directive.

Prompt construction layers in: `MANIFESTO_REF` (points agents at `CNOS_MANIFESTO.md`), `OS_DIRECTIVE` (computed from `process.platform` — on Windows it forbids Unix commands and `mkdir`/`type`/`cat`), `WEB_ARCHITECTURE_SOP` (glassmorphism, mobile-first, `lucide-react`, lazy-loading, SEO), and `HOLISTIC_DIAGNOSTIC_PROTOCOL`.

The **Sherlock Auditor** is an independent LLM validation pass that runs on each agent response *before* tools execute, blocking antipatterns: rogue UI, "ghost execution" (narrating success without calling a tool), `write_file` over an existing file, tech-stack drift, looping, siloed changes, sandbox hallucination.

### Tool system — `src/tools/`

Registry pattern. Each tool is a folder `src/tools/<Name>Tool/index.ts` exporting **`TOOL_DEF`** (an OpenAI-function-schema `NativeTool`) and **`execute(args, workspacePath): ToolResult`**. [src/tools/index.ts](src/tools/index.ts) collects them into `ALL_TOOLS`, derives `TOOL_DEFINITIONS` and `TOOL_MAP`, and exposes `executeTool()` / `getNativeTools()`.

**To add a tool:** create the folder + `index.ts` with `TOOL_DEF` and `execute`, then add the import + `ALL_TOOLS` entry in `src/tools/index.ts`, and add its name to the relevant agents' `tools` arrays in `agents.ts`. Some tools (worktree, replace_symbol, MCP, ask_user_approval) are *intercepted in `agentEngine.ts`* and routed to host callbacks rather than running their `execute()` directly — check the engine before assuming a tool's `execute()` is the live path.

[src/tools/shared.ts](src/tools/shared.ts) holds the **path-safety layer that every file tool must use** — treat these as load-bearing invariants:
- `safePath(workspacePath, p)` — normalizes LLM path hallucinations (`/workspace/` prefixes, drive-letter overlaps) and blocks traversal outside the workspace.
- `rejectIfAbsolutePath()` — absolute paths are forbidden; agents must use relative-from-root paths.
- `stripWorktreePrefix()` — silently strips a hallucinated `.fluxo/worktrees/<id>/` prefix so worktree redirection isn't double-nested.

### The four Shields (engine-level, non-negotiable — see CNOS_MANIFESTO.md §III)

1. **Time Machine** — silent `git` checkpoint before iterations (`utils/gitSafety.ts`); `abort_and_rollback` restores it.
2. **Worktree Isolation** — `enter_worktree` creates an isolated git branch; the engine transparently redirects all file ops into it; `exit_worktree(merge|discard)` shows a native diff for human review.
3. **Syntax Shield** — `utils/syntaxValidator.ts` validates the resulting AST in-memory before any write hits disk; invalid TS/JSX aborts the write with a diagnostic.
4. **Quality Gate & Circuit Breaker** — `utils/buildValidator.ts` runs `npm run build` before a task is accepted as complete; 3 consecutive failures trip the Circuit Breaker, forcing `ask_user_approval`.

### Supporting subsystems

- `src/sentinel.ts` — real-time terminal monitor; on a detected build error it auto-routes to the manager ("Sentinel Auto-Heal").
- `src/services/mcp/client.ts` + `src/commands/mcp.ts` + `src/utils/mcp*.ts` — MCP server registry (config in `.fluxo/mcp_servers.json` and VS Code setting `fluxo.mcpServers`), with per-agent **RBAC** (`RBAC_CATEGORIES` in `agentEngine.ts`) gating which MCP tools each role may use.
- `src/utils/` — `condenser.ts` (context compaction), `dagController.ts` (parallel `create_team` orchestration), `repoMap.ts` (`get_repo_map`), `agentMailbox.ts` (inter-agent `send_message`), `lockfile.ts`/`cleanupRegistry.ts` (FileLockManager — prevents multi-agent write collisions).
- `src/services/extractMemories/` — distills durable project facts into `.fluxo/memory.md`.

### `.fluxo/` — per-workspace persistence (gitignored)

Engine-created. `memory.md` (project rules, auto-injected into every agent's system prompt), `IMPLEMENTATION_PLAN.md` (planner output), `improvements.md` (failure telemetry), `backups/` and `worktrees/` (FIFO-rotated / sandbox dirs). **Note this repo has its own `.fluxo/` because Fluxo is dogfooded on itself.**

## Conventions & gotchas

- The editing discipline and Quality Gate above (see "Critical rules") apply when you edit *this* repo too, not just to the agent swarm.
- When changing agent behavior, prompts, or shields, keep [CNOS_MANIFESTO.md](CNOS_MANIFESTO.md) consistent with the change (or update the manifesto deliberately).
- `out/`, `node_modules/`, `*.vsix`, and `.fluxo/` are gitignored. The committed `.vsix` in older history is being phased out in favor of GitHub Releases.
- **Generated context dumps** (`notebooklm_context_part*.md`, `cnos_full_context*`, `FluxoAi_part*.md`) are produced by the root scripts `notebooklm_generator.cjs` and `generate_context.cjs` (`node notebooklm_generator.cjs`) to feed the codebase to NotebookLM/LLMs. They are large, ephemeral artifacts — do not treat them as source and do not hand-edit them.
- Model slugs must be real OpenRouter slugs — wildcard suffixes like `*-latest` don't exist and get silently downrouted to a cheaper model. `fluxo.maxTokens` defaults to 16384; going lower truncates tool calls.

Para cualquier decisión de arquitectura, frontend o experiencia de usuario, debes consultar tus directrices en @.claude/skills/aura-dna/SKILL.md
