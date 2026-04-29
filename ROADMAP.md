# 🌌 FLUXO AI - Enterprise Architecture Roadmap (v8.0.0+)

Este documento define la "Estrella del Norte" de FLUXO AI. Tras consolidar el Nivel 4 (LSP Semántico y MCP Fetching), el objetivo de las siguientes versiones es transformar el enjambre de una herramienta de edición reactiva a un **departamento de ingeniería de software asíncrono, paralelo y autónomo**.

---

## 🛡️ Fase 1: Aislamiento Estructural Absoluto (v8.0.0) ✅ COMPLETADA
**Objetivo:** Erradicar los bugs destructivos y la corrupción en la rama principal (`main`) aislando los experimentos de la IA.

* **[x] Implementar `EnterWorktreeTool`:** `git worktree add .fluxo/worktrees/<branch> -b <branch>`. Estado persistido en `.fluxo/active_worktree.json`. Devuelve path e instrucciones de prefijo al agente.
* **[x] Implementar `ExitWorktreeTool`:** `action='merge'` (commit + merge --no-ff en main) | `action='discard'` (worktree remove --force + branch -D). Main jamás es tocado en un discard.
* **[x] Propiedad `isolation: worktree`:** Añadida a `AgentDefinition`. Coder y Manager la tienen activada. El motor inyecta `[ISOLATION MODE ACTIVE]` al inicio de sesión. `RULE (WORKTREE ISOLATION)` en system prompts: obligatoria >50 líneas, opcional para ediciones simples.

---

## ⚡ Fase 2: Orquestación Paralela Asíncrona & Estabilidad (v8.1.0 - v8.3.3) ✅ COMPLETADA
**Objetivo:** Eliminar el cuello de botella secuencial, permitir el trabajo concurrente y asegurar la precisión algorítmica del código generado.

* **[x] The Mutex Protocol (v8.1.0):** Implementación de `lockfile.ts`. Sistema de cerrojos de sistema de archivos para evitar colisiones durante escrituras concurrentes.
* **[x] The Parallel Swarm (v8.2.0):** Refactor de `agentEngine.ts` con `Promise.all()`. Implementación de `TeamCreateTool` para instanciación de hilos y `SendMessageTool` (`AgentMailbox`) para comunicación en segundo plano.
* **[x] Native Visual Diff (v8.3.0):** Integración UX/UI con el motor nativo de Git Diff de VS Code. Pausa de orquestación (`worktreeReviewCallback`) para validación humana antes del merge.
* **[x] Strict Orchestrator (v8.3.1):** Arquitectura de "Deprivación de Herramientas". El `@manager` pierde acceso físico a la mutación de archivos y ejecución de terminal para forzar la delegación obligatoria (`coordinatorMode`).
* **[x] The Precision Protocol (v8.3.2):** Deprecación de la edición por líneas. Implementación de `ReplaceBlockTool` ("Bisturí Semántico" con `search_snippet` / `replace_snippet`) para proteger el AST de errores de conteo de LLMs.
* **[x] The Resilience Patch (v8.3.3):** Feedback loops en fallos de sistema. Sherlock Auditor permite la auto-limpieza (`discard` autorizado) ante conflictos de estado, evitando parálisis del enjambre.

---

## 🤖 Fase 3: Tier 1 Enterprise Autonomy & Daemon Mode (v9.0.0+) ⏳ EN PROGRESO
**Objetivo:** Cerrar la brecha final con los monolitos comerciales (Claude Code). Romper la barrera de VS Code para operar como un proceso de sistema invisible y robustecer la seguridad profunda.

* **[ ] Background Memory & Auto-Cleanup (`cleanupRegistry.ts`):** Servicio silencioso que destruye worktrees huérfanos tras fallos críticos o cierres de ventana, y abstracción de memoria automática (`extractMemories.ts`) sin requerir `update_memory`.
* **[ ] Deep MCP Integration (`services/mcp/`):** Capa de servicios dedicada a *Model Context Protocol*. Soporte para autenticación OAuth por puertos nativos, `officialRegistry.ts`, y herramientas atómicas (`ListMcpResourcesTool`, `McpAuthTool`).
* **[ ] Terminal AST Security (`bash/parser.ts`):** Sistema de parseo sintáctico de comandos de bajo nivel para auditar peticiones de terminal antes de la ejecución (Read-Only Validation) y prevenir inyecciones.
* **[ ] Proactivity & Daemon Core (`DAEMON` flag):** Bifurcar el motor para ejecución nativa en Node.js (fuera de VS Code). Implementación de `SleepTool` y `CronCreateTool` (`cronScheduler.ts`) para auto-escaneos y reparación de CI/CD pipelines en segundo plano.