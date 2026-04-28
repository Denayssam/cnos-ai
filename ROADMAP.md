# 🌌 FLUXO AI - Enterprise Architecture Roadmap (v8.0.0+)

Este documento define la "Estrella del Norte" de FLUXO AI. Tras consolidar el Nivel 4 (LSP Semántico y MCP Fetching), el objetivo de las siguientes versiones es transformar el enjambre de una herramienta de edición reactiva a un **departamento de ingeniería de software asíncrono, paralelo y autónomo**.

---

## 🛡️ Fase 1: Aislamiento Estructural Absoluto (v8.0.0) ✅ COMPLETADA
**Objetivo:** Erradicar los bugs destructivos y la corrupción en la rama principal (`main`) aislando los experimentos de la IA.

* **[x] Implementar `EnterWorktreeTool`:** `git worktree add .fluxo/worktrees/<branch> -b <branch>`. Estado persistido en `.fluxo/active_worktree.json`. Devuelve path e instrucciones de prefijo al agente.
* **[x] Implementar `ExitWorktreeTool`:** `action='merge'` (commit + merge --no-ff en main) | `action='discard'` (worktree remove --force + branch -D). Main jamás es tocado en un discard.
* **[x] Propiedad `isolation: worktree`:** Añadida a `AgentDefinition`. Coder y Manager la tienen activada. El motor inyecta `[ISOLATION MODE ACTIVE]` al inicio de sesión. `RULE (WORKTREE ISOLATION)` en system prompts: obligatoria >50 líneas, opcional para ediciones simples.

---

## ⚡ Fase 2: Orquestación Paralela Asíncrona (v8.1.0)
**Objetivo:** Eliminar el cuello de botella secuencial. Permitir que múltiples agentes trabajen al mismo tiempo sin destruir los archivos por colisión.

* **[ ] File System Locks (`lockfile.ts`):** Construir un sistema de cerrojos (Locks). Antes de que un agente ejecute `write_file` o `replace_lines`, debe solicitar un cerrojo sobre ese archivo. Si el archivo está en uso por otro subagente, debe entrar en cola de espera.
* **[ ] Implementar `TeamCreateTool`:** Actualizar `agentEngine.ts` para usar `Promise.all()`. El Manager podrá instanciar hilos asíncronos paralelos (ej. Coder arreglando lógica y Designer ajustando CSS al mismo tiempo).
* **[ ] Comunicación Inter-Agente (`SendMessageTool`):** Permitir que los workers intercambien contexto JSON en segundo plano (ej. el Coder le pasa el contrato de la API al Designer sin que el usuario tenga que leerlo en la UI de VS Code).

---

## 🤖 Fase 3: Autonomía Proactiva & Daemon Mode (v9.0.0)
**Objetivo:** Romper la barrera del editor. FLUXO AI funcionará de forma independiente a VS Code como un proceso de sistema.

* **[ ] Feature Flags Core (`DAEMON` / `PROACTIVE`):** Bifurcar la arquitectura del motor para que pueda compilarse y ejecutarse como un servicio nativo de Node.js en segundo plano (independiente de la Webview de VS Code).
* **[ ] Implementar `SleepTool`:** Estado de muy bajo consumo de RAM donde el enjambre se queda "escuchando" eventos del sistema o webhooks.
* **[ ] Implementar `CronCreateTool` (`cronScheduler`):** Capacidad del Manager para programar auto-escaneos. (Ej. Despertar cada 2 horas, correr los tests de la rama principal, arreglarlos en un worktree si fallan, y crear un PR de forma silenciosa).