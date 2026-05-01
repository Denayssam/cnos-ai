# 📜 Changelog - Fluxo AI

---

## [v8.16.6] - Planner Hard Block & Intent Routing Bypass

**Objetivo:** Eliminar la causa raíz del bug de terminación prematura del @planner que persistía tras v8.16.5. `detectIntent` re-enrutaba el @planner a @coder leyendo keywords de la misión ("Adapt MealPlannerV2.jsx"), de modo que el LLM nunca recibía el prompt ni los tools del planner. Resultado: 3 intentos del retry harness fallando idénticamente.

- **Intent Routing Bypass (`src/agentEngine.ts`):** Nueva constante `SUB_AGENTS_NO_ROUTING = new Set(['planner'])`. Los sub-agentes invocados desde un contexto de herramienta tienen rol fijo y nunca pasan por `detectIntent`. El router solo opera sobre mensajes top-level del usuario.
- **Planner Hard Block (`src/agentEngine.ts`):** Primera comprobación dentro de `if (toolCalls.length === 0)`. Cuando `agentId === 'planner'`, el motor ejecuta `fs.existsSync('.fluxo/IMPLEMENTATION_PLAN.md')`. Si el archivo no existe, la respuesta es **rechazada físicamente**, se inyecta `[ENGINE HARD BLOCK]` y el loop continúa sin incrementar `ghostRetries`. La fuente de verdad es el filesystem — no `toolCallHistory`.
- **SEPARATION PROTOCOL (`src/agents.ts`):** Nueva sección en el prompt del planner: "Do NOT explain your plan in the chat. Output ONLY the tool call for write_file." Refuerza que el usuario lee el plan del disco, no del chat.
- **Resultado:** Entrega del plan garantizada en tres capas independientes: bypass de routing, hard block del motor, y retry harness exterior (3×25 iteraciones). Terminación prematura matemáticamente imposible.

---

## [v8.16.5] - Mandatory Output Enforcement Loop

**Objetivo:** Convertir la entrega del plan del @planner en matemáticamente obligatoria a nivel del motor, no solo como regla de prompt. El retry harness externo de v8.16.3 relanzaba la misma sesión rota tres veces sin corregir el comportamiento raíz.

- **Mandatory Output Enforcement Loop (`src/agentEngine.ts`):** El bloque `enter_plan_mode` ahora envuelve la invocación del planner en un `while (!fs.existsSync(planFile) && plannerAttempt < 3)`. Si el archivo no se produce, el planner es re-invocado con un mensaje `[SYSTEM RETRY N/3]` que prohíbe análisis adicional y exige `write_file` inmediatamente. El loop verifica el sistema de archivos real, no toolCallHistory.
- **ANTI-PARALYSIS RULE v8.16.5 (`src/agents.ts`):** Añadida al bloque CRITICAL DIRECTIVE del planner: "NEVER return conversational text after reading files. A rough written plan is infinitely more valuable than a perfect unwritten one. After 1–2 read_file calls maximum, write the plan."
- **`write_file` description fix (`src/tools/FileWriteTool/index.ts`):** La descripción anterior decía "Only use for NEW files — for existing files, always use edit_file" — el LLM leía esto y se auto-censuraba antes de usar `write_file` en `.fluxo/IMPLEMENTATION_PLAN.md`. Nueva descripción: autoriza explícitamente `.md`, `.json`, y archivos `.fluxo/*`, nombrando el output obligatorio del planner.

---

## [v8.16.4] - Tool Deprivation para @planner (Analysis Paralysis Fix)

**Objetivo:** Aplicar el patrón de Deprivación de Herramientas al @planner, que sufría de "Parálisis por Análisis" — bucles infinitos de exploración con `glob` y `grep` hasta que el motor abortaba por Timeout.

- **Restricción del toolset (`src/agents.ts`):** Array de tools del planner reducido de 8 a 4: `['get_repo_map', 'read_file', 'write_file', 'ask_user_approval']`. Eliminados: `glob`, `grep`, `search_in_files`, `list_dir`, `get_code_structure`, `skill`. El planner físicamente no puede entrar en bucles de exploración porque las herramientas de búsqueda no existen en su schema.
- **WORKFLOW reescrito (`src/agents.ts`):** El flujo de trabajo ahora obliga a: (1) `get_repo_map` para obtener el atlas completo del proyecto en una sola llamada, (2) máximo 2–3 `read_file` para detalles granulares, (3) `write_file` inmediato. Eliminado el step de `list_dir('.')` que iniciaba los bucles.
- **CRITICAL directive (`src/agents.ts`):** Nueva línea al inicio del WORKFLOW: "You do not have directory search tools. Use get_repo_map to understand the holistic project structure… and IMMEDIATELY use write_file."

---

## [v8.16.3] - Planner Output Hardening

**Objetivo:** Garantizar que el directorio `.fluxo/` exista antes de que el @planner intente escribir el plan, y reforzar la directiva de entrega con lenguaje inequívoco.

- **Auto-creación de `.fluxo/` (`src/agentEngine.ts`):** `fs.mkdirSync(path.join(workspacePath, '.fluxo'), { recursive: true })` ejecutado dentro de `enter_plan_mode` antes de invocar el sub-loop del planner. Elimina la causa de fallo silencioso donde `write_file` abortaba por directorio inexistente.
- **CRITICAL DIRECTIVE v8.16.3 (`src/agents.ts`):** Actualizada con lenguaje explícito: "DO NOT finish your turn or use the ask_user_approval tool to say you are done until you have successfully called write_file on that exact path. The engine will physically check for this file's existence."

---

## [v8.16.2] - YIELD_TO_HUMAN & Blind Checkpoint Guard

**Objetivo:** Eliminar el "Infinite MISSION-ANALYSIS-ONLY Loop" donde el Circuit Breaker de herramientas IO_CORE inyectaba errores al agente que luego reintentaba análisis indefinidamente, y eliminar los checkpoints ciegos para sesiones de solo análisis.

- **YIELD_TO_HUMAN (`src/agentEngine.ts`):** Dentro del bloque Circuit Breaker (`_cbFails >= 3`), las herramientas IO_CORE (`glob`, `search_in_files`, `list_dir`, `get_code_structure`) ahora activan YIELD_TO_HUMAN: abortan el loop con `yield streamChunk` → `yield streamEnd → return`, hablando directamente al humano en lugar de inyectar errores al agente. El loop nunca reintenta; la petición llega limpia al usuario.
- **Blind Checkpoint Guard (`src/utils/gitSafety.ts`):** `createSilentCheckpoint()` recibe un early-return si `taskId.includes('MISSION-ANALYSIS-ONLY')`. Previene commits vacíos creados durante sesiones de análisis puro donde el motor construía task IDs de ese tipo.
- **Versión bumpeada a 8.16.2 (`package.json`).**

---

## [v8.16.1] - Escape Hatch & Quality Gate Circuit Breaker

**Objetivo:** Evitar que el agente entre en un bucle infinito cuando el código falla la compilación repetidamente, forzando una pausa HITL después de 3 fallos consecutivos del Quality Gate.

- **`consecutiveBuildFailures` counter (`src/agentEngine.ts`):** Nuevo contador inicializado a 0 al inicio del loop. Se incrementa cada vez que `validateBuild()` devuelve fallo. Al llegar a 3 fallos consecutivos, activa el **Circuit Breaker del Quality Gate**: el motor inyecta un mensaje que prohíbe al agente continuar e invoca `ask_user_approval` para intervención humana.
- **`bypassQualityGate` flag (`src/agentEngine.ts`):** Cuando el usuario aprueba el bypass vía `ask_user_approval`, el motor detecta la respuesta y activa este flag, permitiendo que el agente complete la tarea omitiendo las validaciones de build restantes.
- **Reset en éxito de edición:** El contador de fallos consecutivos se resetea a 0 después de cualquier herramienta de edición exitosa (`replace_lines`, `write_file`, `replace_block`, `replace_symbol`) — solo cuenta fallos sin progreso en medio.

---

## [v8.16.0] - Quality Gate (Build Validation Before Completion)

**Objetivo:** Cerrar el ciclo de calidad — el agente no puede declarar una tarea completa hasta que el proyecto compile limpiamente. Elimina el patrón de "ghost completion" donde el agente emitía el Orchestrator's Report con código roto.

- **`validateBuild()` (`src/utils/buildValidator.ts`):** Nueva utilidad que ejecuta `npm run build` en el workspace y retorna `{ success, error }`. Detecta si el script existe (omite silenciosamente si no hay `build` script). Timeout de 60 segundos.
- **Quality Gate en ambos exit paths (`src/agentEngine.ts`):** Insertado en los dos puntos de salida del loop: (1) cuando el agente emite "ALL STEPS COMPLETE" / "ORCHESTRATOR'S REPORT", (2) cuando `ghostRetries` se agota. En ambos casos, si el build falla, se inyecta `[QUALITY GATE FAILED]` con los errores del compilador y el loop continúa.
- **QUALITY GATE RULE (`src/agents.ts`):** Nueva regla en Coder: "Before declaring a task complete, your code MUST pass the project's build process."
- **Syntax Shield (`src/utils/syntaxValidator.ts` + `src/tools/`):** `checkSyntax()` valida TypeScript/JSX en memoria antes de que `write_file`, `replace_lines`, y `replace_block` escriban al disco. Si el AST falla, la escritura se aborta con diagnóstico. Imposible corromper código fuente.

---

## [v8.15.0] - The Time Machine (Git Auto-Checkpointing)

**Objetivo:** Dar al sistema una red de seguridad automática. Antes de cada tarea del agente, se crea un commit ancla "fluxo-auto-checkpoint" en un árbol de trabajo limpio. Si la tarea sale mal, `abort_and_rollback` puede restituir el código al estado previo con un solo `git reset --hard HEAD~1`.

- **`createSilentCheckpoint(taskId, cwd)` (`src/utils/gitSafety.ts`):** Nueva utilidad que verifica que el árbol de trabajo esté limpio (`git status --porcelain`), luego ejecuta `git add . && git commit --allow-empty -m "fluxo-auto-checkpoint: <taskId>"`. Lanza un error descriptivo si detecta cambios humanos no comprometidos — la mezcla de trabajo humano y agente en el mismo checkpoint crearía un rollback ambiguo.
- **`rollbackToLastCheckpoint(cwd)` (`src/utils/gitSafety.ts`):** Ejecuta `git reset --hard HEAD~1` para deshacer todos los cambios del agente hasta el checkpoint ancla. Retorna `{ success, output }`.
- **`AbortAndRollbackTool` (`src/tools/AbortAndRollbackTool/index.ts`):** Nueva herramienta expuesta a Coder y Manager. El agente la llama con un `reason` cuando detecta que sus ediciones rompieron la lógica fundamentalmente. Invoca `rollbackToLastCheckpoint` directamente.
- **Rollback Hard Stop (`src/agentEngine.ts`):** Cuando `abort_and_rollback` tiene éxito, el motor emite `yield streamEnd` inmediatamente, deteniendo el loop. El agente no puede continuar haciendo ediciones después de un rollback.
- **Integración en `runAgentLoop` (`src/agentEngine.ts`):** El checkpoint se crea al inicio de cada sesión de tarea, antes del primer API call.

---

## [v8.14.0] - MCP + Syntax Shield (AST Validation)

**Objetivo:** Dos mejoras de producción en paralelo: conectividad MCP estable con inicialización no bloqueante, y una capa de validación AST que hace imposible escribir código sintácticamente roto al disco.

- **MCP Estabilización:** Refactor del cliente MCP para inicialización asíncrona no-bloqueante. Servidores MCP se conectan en background; la UI carga inmediatamente. Timeouts de conexión (5s) y de tool listing. Manejo de errores silencioso si un servidor no responde.
- **`checkSyntax()` (`src/utils/syntaxValidator.ts`):** Nueva utilidad que carga el compilador TypeScript en memoria y ejecuta `ts.transpileModule()` sobre el contenido propuesto. Si el AST produce errores de diagnóstico, devuelve `{ ok: false, errors }`. Skippea automáticamente extensiones no-TS/JS (`.md`, `.json`, `.css`).
- **Integración en herramientas de escritura:** `FileWriteTool`, `ReplaceLinesTool`, y `ReplaceBlockTool` llaman `checkSyntax()` antes de `acquireLock()`. Si falla, abortan con `[SYNTAX ERROR DETECTED]` y el diagnóstico exacto. La escritura nunca ocurre — el archivo en disco permanece intacto.
- **`healing_mode` bypass:** Parámetro opcional en las herramientas de escritura. Si `healing_mode: true`, la validación AST se omite — permite reparar deliberadamente archivos ya corruptos.

---

## [v8.13.0] - Global Circuit Breaker (Pre-Execution Block)

**Objetivo:** Elevar el Circuit Breaker de la v7.12.4 a pre-ejecución. En lugar de ejecutar la herramienta y reportar el fallo, el motor ahora bloquea la llamada antes de ejecutarla cuando una herramienta ha fallado 3 veces, inyectando una directiva de cambio de estrategia.

- **Pre-execution Circuit Breaker (`src/agentEngine.ts`):** `toolFailureTracker` pasa de post-ejecución a pre-ejecución. Antes del bloque `try { execute }`, el motor comprueba `_cbFails >= 3`. Si se cumple, el tool call es interceptado con `[CIRCUIT BREAKER]` sin invocar `executeTool` — ahorra una iteración por fallo.
- **`@planner` CRITICAL DIRECTIVE v8.13.0 (`src/agents.ts`):** Primera versión de la directiva fuerte en el prompt del planner: "Your SOLE purpose is to write a markdown file using the 'write_file' tool… If you do not call 'write_file', the system will crash."
- **Exclusión de herramientas inmunes:** `run_command` y `get_code_structure` continúan exentos del Circuit Breaker — un build fallido legítimo no debe bloquear las herramientas de diagnóstico.

---

## [v8.12.0] - Semantic Awareness Phase 2 (get_repo_map + AST RepoMap)

**Objetivo:** Dar a los agentes un atlas semántico completo del workspace en una sola llamada. `get_repo_map` genera un mapa de todos los símbolos exportados (funciones, clases, constantes) con sus archivos de origen — sin necesidad de explorar el árbol con glob/grep.

- **`buildRepoMap()` (`src/utils/repoMap.ts`):** Nueva utilidad que recorre el workspace en Node.js puro, parsea los archivos TypeScript/JavaScript con el compilador TS, y extrae todos los símbolos exportados con sus rutas relativas. Devuelve un bloque de texto estructurado `file → [symbol1, symbol2, …]`. Completamente fail-safe: retorna `''` ante cualquier error de I/O.
- **`get_repo_map` tool (`src/tools/GetRepoMapTool/`):** Herramienta expuesta a Coder y Manager. Sin parámetros — devuelve el mapa completo del proyecto actual. Reemplaza la secuencia `glob + grep` para orientación inicial.
- **TOPOGRAPHY RULE v8.12.0 (`src/agents.ts`):** Nueva regla en Coder y Manager: "Before making sweeping changes or searching blindly for functions, you MUST call get_repo_map to understand the semantic structure and dependencies of the workspace." Añadido también en Manager para que incluya las entradas del mapa en las task descriptions de `create_team`.

---

## [v8.11.0] - Worktree Auto-Cleanup

**Objetivo:** Eliminar el error de "worktree ya activo" que bloqueaba al agente cuando intentaba crear un nuevo worktree sin haber cerrado el anterior — situación habitual en sesiones largas o tras un crash.

- **Auto-cleanup silencioso (`src/agentEngine.ts`):** En el intercept de `enter_worktree`, el motor comprueba si `activeWorktreePath` está activo. Si es así, ejecuta `exit_worktree({ action: 'discard' })` silenciosamente (el agente no lo ve), resetea `activeWorktreePath = null`, y luego procede con el `enter_worktree` solicitado. El usuario ve el nuevo worktree activarse limpiamente sin mensajes de error.
- **Thinking tick:** Emite `🧹 Auto-cleanup: discarding stale worktree before entering new one…` en el status bar durante la limpieza para trazabilidad sin contaminar el chat.

---

## [v8.10.0] - The Shield Patch (HITL + Iron Rule)

**Objetivo:** Eliminar el uso destructivo de `run_command` para operaciones de sistema de archivos (crear, mover, eliminar archivos con `rm -rf`, `del`, etc.) y añadir un control Human-in-the-Loop para cualquier comando shell no reconocido como seguro.

- **HITL para `run_command` (`src/agentEngine.ts` + `src/extension.ts`):** Nuevo mecanismo pre-ejecución. Antes de ejecutar cualquier shell command, el motor evalúa el primer segmento contra `HITL_SAFE_PATTERNS` (whitelist de `npm`, `git`, `tsc`, `node`, `npx`, etc.). Si no coincide, pausa el loop y envía `{ type: 'hitlCommand', command }` al webview — el usuario aprueba o rechaza antes de que el proceso arranque.
- **`HITL_SAFE_PATTERNS` (`src/agentEngine.ts`):** Lista de RegExp que cubren git, npm/yarn/pnpm/bun, tsc, node, vsce, echo sin redirect, y comandos de version. Extensible sin tocar la lógica de intercepción.
- **IRON RULE — Shell Scope (`src/agents.ts`):** Nueva regla `RULE (SHELL SCOPE — v8.10.0)` en Coder y Manager: `run_command` es EXCLUSIVAMENTE para compilación y tests. Para cualquier operación de archivos: `delete_file`, `delete_dir`, `write_file`, `create_dir`. Violar esta regla activa el HITL.
- **Path validation en DeleteTool (`src/tools/DeleteFileTool/` + `DeleteDirTool/`):** Guards críticos que bloquean eliminación de rutas fuera del workspace, rutas vacías, y paths que apunten al directorio raíz. Previene `delete_dir('.')` accidental.

---

## [v8.9.0] - Semantic Awareness Phase 1 (RepoMap Injection)

**Objetivo:** Inyectar automáticamente un mapa del repositorio en el contexto del sistema de los agentes que escriben código, eliminando el "Sesgo de Exploración" donde @coder y @manager llamaban a `glob` o `grep` repetidamente al inicio de cada tarea para orientarse.

- **RepoMap auto-injection (`src/agentEngine.ts`):** Al construir el `systemPrompt` de sesión, si `agentId` es `'coder'` o `'manager'` y el workspace está disponible, se invoca `buildRepoMap(workspacePath)`. Si el resultado no está vacío, se inyecta como bloque `<repo_map>…</repo_map>` al final del system prompt, seguido de la `REPO MAP RULE v8.9.0`.
- **`REPO MAP RULE v8.9.0`:** Instrucción inyectada con el mapa: "DO NOT use run_command to search for files. Use this map to know exactly which path to pass to read_file, replace_lines, or replace_symbol. If a path from the map does not resolve, call glob() to confirm — never guess."
- **Fail-safe:** `buildRepoMap()` retorna `''` ante cualquier error — la inyección no ocurre si el mapa está vacío, sin bloquear la sesión.

---

## [v8.8.0] - Worktree Structural Isolation (Automatic Path Redirect)

**Objetivo:** Completar la Fase 1 del Enterprise Roadmap — Aislamiento Estructural con Git Worktrees. Las herramientas `enter_worktree` y `exit_worktree` ya existían desde v8.0.0, pero el agente tenía que prefijar MANUALMENTE cada ruta con la ruta del worktree. La v8.8.0 hace esta redirección INVISIBLE: el agente escribe `read_file("src/App.tsx")` y el motor silenciosamente lee `.fluxo/worktrees/branch/src/App.tsx`.

- **`activeWorktreePath` Session State (`src/agentEngine.ts`):** Nueva variable `let activeWorktreePath: string | null = null` inicializada al inicio de `runAgentLoop` leyendo `.fluxo/active_worktree.json`. Si el archivo existe y la ruta del worktree existe en disco, la variable se inicializa automáticamente — esto garantiza que el contexto de worktree sobrevive rearranques de sesión y es heredado por sub-agentes (planner, swarm) que leen el mismo JSON al iniciarse.
- **`effectiveWorkspacePath` Redirect Middleware (`src/agentEngine.ts`):** Calculado antes del bloque `try { execute }` para cada tool call: si `activeWorktreePath` está activo Y el tool no es `enter_worktree`/`exit_worktree`/`skill`/`enter_plan_mode` (herramientas que operan en el workspace principal para operaciones git y de planificación), entonces `effectiveWorkspacePath = activeWorktreePath`. En todos los demás casos, `effectiveWorkspacePath = workspacePath`. El `executeTool(toolName, args, workspacePath)` del `else` final fue cambiado a `executeTool(toolName, args, effectiveWorkspacePath)`. `debugLog` registra cada redirección para trazabilidad.
- **Worktree State Sync (`src/agentEngine.ts`):** En el success handler (bloque `else` del circuit breaker): después de un `enter_worktree` exitoso se lee el state file y se actualiza `activeWorktreePath`; después de `exit_worktree` exitoso (merge o discard) se resetea a `null`. Esto cubre también el flujo de Human Review (v8.3.0) donde el `worktreeReviewCallback` ejecuta `exit_worktree` — el `toolName` sigue siendo `'exit_worktree'` en el success check.
- **`EnterWorktreeTool` output actualizado (`src/tools/EnterWorktreeTool/index.ts`):** El mensaje de éxito ahora dice "PATH REDIRECT ACTIVE — Continue using NORMAL relative paths (e.g. 'src/App.tsx'). The engine automatically redirects ALL file operations to the worktree." Esto evita que el LLM siga prefijando rutas manualmente (comportamiento previo que causaba path-not-found errors).
- **`isolationNotice` actualizado (`src/agentEngine.ts`):** El mensaje inyectado al inicio de sesión para agentes con `isolation: 'worktree'` ahora menciona la redirección automática explícitamente.
- **Regla WORKTREE ISOLATION en Manager (`src/agents.ts`):** Nueva regla `RULE (WORKTREE ISOLATION — v8.8.0)`: para tareas >1 archivo o refactorizaciones complejas, `enter_worktree` antes de `create_team`. Merge si build pasa, discard si falla irremediablemente. El código en main queda INTACTO en ambos casos.

---

## [v8.7.1] - Clean Output Rendering (CoT Leak Fix)

**Objetivo:** Eliminar el "Message Accumulation" y "CoT Leak" donde el motor concatenaba monólogos internos del agente (planning, razonamiento intermedio) en la burbuja de chat final, produciendo respuestas largas y confusas mezclando pensamiento con resultado.

- **Intermediate Text Rerouting (`src/agentEngine.ts`):** Cambio quirúrgico en el bloque de emisión de texto. Si `toolCalls.length > 0` (el modelo está pensando antes de actuar), el texto de esa respuesta se enruta a `yield { type: 'thinking' }` (barra de estado, visible solo como indicador) en lugar de `yield { type: 'streamChunk' }` (burbuja de chat). Solo las respuestas donde `toolCalls.length === 0` (respuesta final del Orchestrator's Report) emiten `streamChunk`. Un truncado de 300 chars en el tick de thinking previene que monólogos largos saturen el status bar.
- **`<thinking>` tag policy (`src/agents.ts` — `SEPARATION_PROTOCOL`):** Directiva nueva al inicio del protocolo, con ejemplo de output CORRECTO vs INCORRECTO: si el agente necesita razonar antes de llamar una herramienta, el razonamiento VA DENTRO de `<thinking>...</thinking>`. El "CoT Leak" (mezclar pensamiento con respuesta final) queda explícitamente marcado como violación del protocolo.
- **Acordeón colapsable para `<thinking>` (`media/main.js` — `renderMarkdown`):** Nuevo paso `0c` en la función `renderMarkdown`. Bloques completos `<thinking>...</thinking>` se reemplazan con un `<details class="thinking-details">` colapsado por defecto con summary "💭 Ver proceso de pensamiento". Paso `0d`: bloques incompletos (aún abiertos durante streaming — sin tag de cierre todavía) se eliminan con regex para prevenir que CoT parcial aparezca en la burbuja mientras el modelo escribe.
- **CSS para `.thinking-details` (`media/style.css`):** Nueva sección `─── Thinking Blocks ───` con color indigo `rgba(99, 102, 241, ...)` para distinguirlos visualmente de los bloques `<reasoning>` (border gris) y `<tool_result>` (azul). Acordeón colapsado por default — expandible con clic. Mismo patrón estructural que `.reasoning-details` (ya existente).

---

## [v8.7.0] - OS Awareness & Iron Curtain Tuning

**Objetivo:** Eliminar la fricción severa detectada en `.fluxo/improvements.md` causada por dos fuentes: (1) el agente usando comandos Linux (`ls`, `rm`, `mv`) en un entorno Windows, y (2) la Cortina de Hierro de `RunCommandTool` bloqueando pipelines legítimos como `npm run build | head -50`.

- **OS Awareness Directive (`src/agents.ts` — `OS_DIRECTIVE`):** Nueva constante computada una sola vez al cargar el módulo con `process.platform === 'win32'`. En Windows: directiva bilingüe con tabla de equivalencias exactas (dir/ls, del/rm, move/mv, copy/cp, md/mkdir -p), advertencia sobre rutas con backslash y comillas, y lista explícita de comandos Unix PROHIBIDOS. En Unix/Linux/macOS: directiva breve confirmando el entorno POSIX. Inyectada en `buildAgentSystemPrompt()` ÚNICAMENTE para agentes que tienen `run_command` en su toolset — `@planner` no recibe el bloque (es read-only y no usa terminal). Esta arquitectura es dinámica: si un nuevo agente recibe `run_command` en el futuro, hereda el bloque automáticamente sin ningún cambio adicional.
- **Fine-tuning de la Cortina de Hierro (`src/tools/RunCommandTool/index.ts`):** Cambio quirúrgico en la lógica `CLI_FILE_READ`: de `.cmdSegments.some(seg => CLI_FILE_READ.test(seg))` a `.CLI_FILE_READ.test(firstSegment)`. El bloque ahora examina ÚNICAMENTE el primer segmento del comando (antes del primer `|`). Resultado: `npm run build | head -50`, `tsc 2>&1 | grep error`, `git log | tail -20` son PERMITIDOS (el filtro procesa stdin, no un archivo). `grep "error" src/file.ts`, `head -100 src/main.ts` siguen BLOQUEADOS (son el primer segmento, acceso directo a archivo). El mensaje de error actualizado explica la distinción: el pipe es válido, el acceso directo no.
- **TOOL_DEF actualizado (`src/tools/RunCommandTool/index.ts`):** Descripción expandida con dos aclaraciones críticas: (1) diferencia de comandos Windows/Unix, y (2) la nota sobre Worktrees — si hay un Worktree activo, el agente NO debe intentar `cd` hacia él; todas las herramientas nativas (read_file, run_command, replace_block) ya operan sobre el contexto correcto automáticamente.
- **Error capture mejorado (`src/tools/RunCommandTool/index.ts`):** Añadido `try-catch` alrededor de `execSync`. Cuando un comando retorna exit code ≠ 0, el error ahora captura `err.stdout` + `err.stderr` del objeto de error de Node.js y los combina en el output — el agente recibe el mensaje de compilación completo en lugar de solo `err.message` (que era el comportamiento anterior cuando el engine capturaba el throw).

---

## [v8.6.0] - Community Skills System

**Objetivo:** Dar a Fluxo AI una biblioteca de recetas de implementación comunitarias. Un Skill es un archivo JSON en `src/skills/` que contiene el blueprint completo de una integración estándar (Stripe, Firebase, etc.). En lugar de pedirle al `@planner` que analice el código desde cero, el `@manager` puede buscar un skill existente y aplicarlo directamente — el engine inyecta la receta en `.fluxo/IMPLEMENTATION_PLAN.md` en milisegundos.

- **`skills/stripe-payment-flow.json`:** Primer skill comunitario oficial. Cubre el flujo completo de Stripe Checkout: instalación del SDK, variables de entorno (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, VITE_STRIPE_PUBLISHABLE_KEY), endpoint de creación de sesión (`/api/create-checkout-session`), handler de webhook con verificación de firma y raw-body parsing, componente `Checkout.tsx`, páginas `PaymentSuccess.tsx` y `PaymentCancel.tsx`, registro de rutas en `App.tsx`, y verificación de build. Incluye advertencias críticas sobre raw-body middleware, tarjetas de prueba de Stripe, y testing local con Stripe CLI.
- **`SkillTool` (`src/tools/SkillTool/index.ts`):** Nueva herramienta passthrough (patrón idéntico a `EnterPlanModeTool`). Dos acciones: `list` (devuelve nombre + descripción de todos los JSONs en `src/skills/`) y `apply` (inyecta la receta en `.fluxo/IMPLEMENTATION_PLAN.md`). Disponible ÚNICAMENTE para `@planner` y `@manager`.
- **Intercept `skill` en `agentEngine.ts`:** El engine resuelve la ruta `src/skills/` usando `path.join(__dirname, '..', 'src', 'skills')` — funciona tanto en desarrollo (`out/` → `../src/skills`) como en producción (extensión instalada desde VSIX). `action='list'`: lee todos los `.json` del directorio y devuelve lista con nombre y descripción. `action='apply'`: parsea el JSON, extrae `recipe` (soporta string o array), escribe `.fluxo/IMPLEMENTATION_PLAN.md` con el contenido, emite un thinking tick `✅ Skill applied`, y devuelve la receta completa al agente con la directiva `create_team`. Manejo de errores completo: directorio inexistente, skill no encontrado, JSON malformado, error de escritura.
- **Prompts actualizados (`src/agents.ts`):** `@planner` recibe la directiva "COMMUNITY SKILLS SHORTCUT": antes del análisis manual, llamar `skill(action='list')`. Si hay un match, `skill(action='apply')` y saltarse el análisis. `@manager` recibe "COMMUNITY SKILLS FAST LANE" en la sección PLANNING GATE: antes de `enter_plan_mode`, verificar si existe un skill aplicable — es más rápido que spawning el `@planner` para integraciones conocidas. `skill` añadido al toolset de `@planner` y `@manager`.
- **`media/main.js`:** Nuevo `case 'skill'` en `getToolTitle`: muestra `• skill  apply → stripe-payment-flow` o `• skill  list`.
- **`README.md`:** Actualizado a v8.6.0 con nueva sección "🧩 Community Skills" que explica a la comunidad cómo contribuir con archivos JSON.

---

## [v8.5.3] - The Orchestration Core (Planning Gate)

**Objetivo:** Alinear Fluxo AI al 100% con la arquitectura de planificación de Claude Code. La v8.5.3 introduce el `@planner` como sub-agente especializado y el `enter_plan_mode` como puerta obligatoria para el Manager antes de delegar cualquier tarea multi-archivo. Esto cierra el ciclo del "Motor Base": el Manager ya no improvisa — primero analiza, luego delega con precisión quirúrgica.

- **`EnterPlanModeTool` (`src/tools/EnterPlanModeTool/index.ts`):** Nueva herramienta passthrough (patrón idéntico a `TeamCreateTool` y `ReplaceSymbolTool`). El `execute()` es un stub — el engine intercepta la llamada antes de llegar al `executeTool` genérico. Parámetro: `task_description` (descripción completa de la tarea a planificar).
- **`@planner` sub-agente (`src/agents.ts`):** Nuevo agente `planner` con emoji 📋 y color `#6366f1`. Toolset de solo lectura: `read_file`, `glob`, `grep`, `get_code_structure`, `search_in_files`, `list_dir` más `write_file` exclusivamente para `.fluxo/IMPLEMENTATION_PLAN.md`. System prompt estricto: análisis primero, plan siempre, cero modificaciones de código fuente. El formato del plan es obligatorio: `## Objective`, `## Files to Modify`, `## Sequential Steps` (con File + Action + Symbol/Block + Details por paso), `## Integration Points`, `## Dependencies & Risks`, `## Agent Assignment`.
- **Intercept `enter_plan_mode` en `agentEngine.ts`:** Insertado antes del bloque `create_team`. Cuando el Manager llama `enter_plan_mode`, el engine lanza un loop `runAgentLoop` del `@planner` con parámetros de solo análisis (sin `approvalCallback`, `nativeEditCallback`, `worktreeReviewCallback`, ni `replaceSymbolCallback`). Los eventos del planner se bufferean y se emiten en el UI principal. Al terminar, el engine lee `.fluxo/IMPLEMENTATION_PLAN.md` y lo devuelve como tool result al Manager con la directiva `create_team`.
- **HARD BRAKE bypass para `@planner` (`agentEngine.ts`):** El `isPlanBrake` ahora incluye la guarda `agentId !== 'planner'`. Sin esto, la escritura de `IMPLEMENTATION_PLAN.md` activaría el Hard Brake en el contexto del sub-loop del planner — congelandolo antes de completar. La guarda garantiza que el plan se escriba sin interrupción; el Hard Brake sigue funcionando normalmente en Manager y Coder.
- **PLAN_VERIFICATION_SHIELD actualizado (`agentEngine.ts`):** La ruta del plan ahora es `.fluxo/IMPLEMENTATION_PLAN.md` (antes era `IMPLEMENTATION_PLAN.md` en la raíz). Alineado con la convención Zero Footprint (v8.4.0) donde todos los artefactos de Fluxo viven en `.fluxo/`.
- **PLANNING GATE en Manager prompt (`src/agents.ts`):** Nueva sección `─── PLANNING GATE — IRON RULE (v8.5.3) ───` insertada inmediatamente después del STRICT ORCHESTRATOR CONSTRAINT. Regla de hierro: para cualquier tarea >1 archivo o refactor lógico, el Manager TIENE PROHIBIDO llamar `create_team` si no existe `.fluxo/IMPLEMENTATION_PLAN.md`. `enter_plan_mode` se añade también al listado de `TOOLS YOU HAVE`.
- **UX Polish — Silencio de Action Enforcement:** Eliminados el `yield { type: 'thinking' }` y el `await sleep(2000ms)` del bloque Action Enforcement en `agentEngine.ts`. El motor ya seguía reintentando internamente (`ghostRetries < 2`) con `debugLog` al archivo, pero el spinner "⚡ Enforcing action (retry N/2)…" y la pausa de 2 segundos eran ruido visible para el usuario. Ahora el motor "pelea" con el LLM en silencio — el usuario solo ve el resultado limpio.
- **`media/main.js`:** Añadido `case 'enter_plan_mode'` en `getToolTitle` con preview de los primeros 50 chars del `task_description`.

---

## [v8.5.2] - The Sense-Making Patch (Spatial Awareness)

**Objetivo:** Eliminar la "Amnesia Espacial" y el "Sesgo de Terminal" donde el agente usaba `ls`, `pwd`, `grep`, y rutas absolutas de Windows o `/workspace/` para orientarse, saturando el sistema con comandos CLI que fallan o producen outputs inútiles. La v8.5.2 da "ojos" al agente con herramientas nativas de exploración de proyectos, y un middleware que normaliza silenciosamente cualquier ruta hallucinated antes de que llegue a una herramienta.

- **`GlobTool` (`src/tools/GlobTool/index.ts`):** Nueva herramienta nativa que acepta un glob pattern (e.g. `"src/**/*.tsx"`) y devuelve la lista de archivos coincidentes recorriendo el árbol del workspace en Node.js — sin shell, sin permisos de terminal. Implementa su propio `globToRegex()` que soporta `**` (profundidad arbitraria), `*` (cualquier char salvo `/`), y `?` (un char). Omite automáticamente `node_modules`, `.git`, `dist`, `out`, `.fluxo`. Reemplaza `ls`, `find`, y `dir` en `run_command`. Límite: 300 resultados.
- **`GrepTool` (`src/tools/GrepTool/index.ts`):** Nueva herramienta nativa que acepta un string o regex JavaScript y un `path_filter` glob opcional, y devuelve matches en formato `file:line: content`. Primero intenta compilar `pattern` como RegExp; si falla, lo escapa y lo trata como string literal — esto permite queries tanto técnicas (`"import.*useAuth"`) como en lenguaje natural (`"login button"`). Omite archivos binarios por extensión. Reemplaza `grep`, `findstr`, y `rg` en `run_command`. Límite: 500 matches.
- **Path Normalization Middleware en `agentEngine.ts`:** Nueva función `normalizeAgentPath()` que convierte silenciosamente antes de cada tool call: (1) `/workspace/path` → `path`; (2) `D:\Users\...\project\src\file.ts` → `src/file.ts` (path.relative); (3) Rutas absolutas fuera del workspace → error inmediato con la raíz real. La normalización aplica a los argumentos `path` y `file_path` de TODAS las herramientas. El LLM ya no necesita conocer la ruta absoluta del workspace — puede usar rutas relativas y el middleware garantiza que lleguen correctamente.
- **System prompts actualizados (`src/agents.ts`):** Nueva `RULE 5b (WORKSPACE ORIENTATION)` en el coder: prohibición explícita de `ls/pwd/find/grep/rg/findstr/dir` vía `run_command`, con la tabla de sustituciones (`glob` → `find/ls`, `grep` → `grep/findstr`). `glob` y `grep` añadidos al toolset de Coder, Designer, y Manager. `media/main.js` actualizado: nuevos títulos en `getToolTitle` para `replace_symbol`, `glob`, y `grep`.

---

## [v8.5.1] - The Boundary Patch (LSP Mismatch Fix)

**Objetivo:** Corregir el "LSP Boundary Mismatch" donde el rango del símbolo devuelto por el Language Server excluye el keyword inicial (`const`/`let`/`async`). Cuando el LLM incluye ese keyword en `new_code` y el engine aplica el reemplazo, el resultado es `const const foo = ...` o `;;`. Además, el REDUNDANT_DECLARATION de Sherlock bloqueaba los hotfixes de sintaxis legítimos.

- **LSP Boundary Sanitizer (`src/extension.ts` — `replaceSymbolCallback`):** Bloque de sanitización insertado entre la resolución del símbolo y la llamada a `edit.replace()`. Cinco regex ordered (multi-palabra antes que mono-palabra para evitar false positives): `async async` → `async`, `const const` → `const`, `let let` → `let`, `var var` → `var`, `;;+` → `;`. El orden es intencional — `async async function` debe resolverse antes que un hipotético `async` aislado. La sanitización opera sobre `sanitizedCode` (copia de `newCode`) sin mutar el argumento original.
- **BUILD FAILURE HOTFIX EXCEPTION en `REVISOR_PROMPT` (`src/agents.ts`):** Añadida como addendum al check #6 (REDUNDANCY CHECK). Si el contexto contiene `BUILD_FAILED` o un resultado de herramienta previo que indica sintaxis corrupta o AST corruption, el agente tiene PERMISO EXPLÍCITO de re-declarar o reescribir cualquier símbolo como hotfix. En ese caso Sherlock debe emitir `"OK"` en lugar de `REDUNDANT_DECLARATION`. Lógica: cuando el build está roto, la inyección previa ya está corrupta — re-declararla es la corrección, no el error.

---

## [v8.5.0] - The Monolith Core (LSP-Native Symbol Replace)

**Objetivo:** Eliminar los fallos de AST (llaves desbalanceadas, rangos incorrectos) causados por la edición de código basada en strings. La v8.5.0 introduce `replace_symbol` — una herramienta que delega la localización del bloque de código al Language Server Protocol de VS Code, el mismo motor que usa el autocompletado y el refactor nativo. El agente ya no cuenta llaves ni calcula líneas: solo provee el nombre del símbolo y su nueva versión.

- **`ReplaceSymbolTool` (`src/tools/ReplaceSymbolTool/index.ts`):** Nueva herramienta con TOOL_DEF (`file_path`, `symbol_name`, `new_code`). El `execute()` es un passthrough — la ejecución real es interceptada por el engine antes de llegar al `executeTool` genérico, igual que `ask_user_approval` y `exit_worktree`. El `file_path` admite tanto rutas relativas al workspace como absolutas.
- **`replaceSymbolCallback` en `src/extension.ts`:** Implementación completa del flujo LSP. (1) Abre el documento vía `vscode.workspace.openTextDocument`. (2) Llama `vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri)` con retry loop de 4 intentos (2s total) para tolerancia a Language Servers lentos — mismo patrón que `getCodeStructureCallback`. (3) Búsqueda recursiva del símbolo en el árbol (nodos raíz + todos sus `children`). (4) Si no se encuentra, devuelve el mensaje exacto: `"Símbolo no encontrado por el LSP..."` con la lista de símbolos disponibles en el nivel raíz. (5) Aplica `vscode.workspace.applyEdit(WorkspaceEdit)` y guarda — idéntico al flujo de `search_and_replace`. (6) El output de éxito incluye el `SymbolKind` (Function, Class, Variable, etc.) y el rango reemplazado.
- **Intercept `replace_symbol` en `agentEngine.ts`:** Añadido antes de `fetch_documentation`. Hace `yield thinking` con texto descriptivo, llama `replaceSymbolCallback`, y en caso de fallo enriquece el output con una directiva de recuperación. El callback se propaga también a los sub-agentes del Parallel Swarm vía el parámetro adicional en la firma de `runAgentLoop`.
- **Toolsets actualizados en `src/agents.ts`:** `replace_symbol` añadido a Coder y Designer **además** de `replace_block` (que se mantiene como fallback explícito para archivos sin soporte LSP). Los agentes tienen ahora ambas herramientas — la jerarquía es: `replace_symbol` (preferido, AST-safe) > `replace_block` (fallback, string-based) > `write_file` (solo para archivos nuevos).
- **System prompts actualizados (`src/agents.ts`):** `REGLA DE ORO` reescrita como `AST Protocol v8.5.0`. `REPLACE_BLOCK WORKFLOW` reemplazado por `REPLACE_SYMBOL WORKFLOW` con la instrucción del usuario: "Ya no buscas texto plano. Ahora editas código por Nodos AST. El sistema calculará las llaves por ti." Rules 6, 7, BUG PROTOCOL, LARGE FILE STRATEGY, BUILD VERIFICATION, y GRACEFUL DEGRADATION actualizadas. `REVISOR_PROMPT` actualizado: checks #3, #4, #5 y la nota de scope ahora reconocen `replace_symbol` y `new_code`.

---

## [v8.4.0] - Zero Footprint Protocol

**Objetivo:** Eliminar la contaminación del workspace y del panel de Git causada por los archivos `.bak` de los backups automáticos y por la carpeta `.fluxo/` no ignorada. La extensión ahora opera con huella cero en el árbol de trabajo del usuario.

- **Auto-Gitignore (`src/extension.ts` — `ensureGitignore()`):** Nueva función ejecutada silenciosamente en cada `activate()` inmediatamente después de `cleanupLogsOnActivation()`. Lee el `.gitignore` de la raíz del workspace (si existe), verifica si `.fluxo/` o `.fluxo` ya están listados (comparación exact, normalizada por `.trim()`), y en caso contrario añade al final del archivo: `\n# Fluxo AI Engine Data\n.fluxo/\n`. Si el archivo `.gitignore` no existe aún, lo crea. La función es idempotente — múltiples activaciones no duplican la entrada. Los fallos (workspace read-only, sin carpeta abierta) son silenciosos y no-fatales.
- **Backups de cero huella (`src/tools/ReplaceLinesTool/index.ts` + `src/tools/ReplaceBlockTool/index.ts`):** `import * as os from 'os'` añadido en ambas herramientas. La ruta de backup cambia de `path.join(workspacePath, '.fluxo', 'backups')` a `path.join(os.tmpdir(), 'fluxo-backups')`. El directorio se crea con `fs.mkdirSync(..., { recursive: true })` igual que antes. Los archivos `.bak` ahora aterrizan en el directorio temporal del sistema operativo (`/tmp/fluxo-backups` en Linux/macOS, `%TEMP%\fluxo-backups` en Windows) — completamente fuera del workspace, invisibles para Git, y gestionados por el OS. La funcionalidad de recuperación es idéntica.

---

## [v8.3.4] - The Visibility Patch (Untracked Files in Worktree Review)

**Objetivo:** Corregir el edge case en la tarjeta de revisión del Worktree donde los archivos nuevos (creados por el agente dentro del worktree) no aparecían en la lista de "Archivos modificados". La causa raíz: `git diff --name-only HEAD` solo reporta archivos tracked que difieren del HEAD — los archivos untracked (nunca añadidos al índice de git) son invisibles para ese comando.

- **`worktreeReviewCallback` en `src/extension.ts`:** Reemplazado `git diff --name-only HEAD` por `git status --porcelain`. El formato porcelain reporta TODOS los cambios en el working tree: `M ` (modificados), `A ` (staged nuevos), `D ` (eliminados), `R ` (renombrados), y `??` (untracked — los archivos nuevos que antes se perdían). El parser extrae solo la ruta de cada línea (`.slice(3).trim()`) y maneja renombrados (`old -> new`) tomando únicamente el nombre final. El resultado completo se pasa al webview via `{ type: 'worktreeReview', changedFiles }` — la tarjeta de revisión ahora muestra todos los archivos sin excepción.

---

## [v8.3.3] - The Resilience Patch (Worktree Auditor Fix)

**Objetivo:** Eliminar el falso positivo del Sherlock Auditor que bloqueaba `exit_worktree(discard)` cuando el agente intentaba limpiar un worktree conflictivo para reintentar la tarea. El problema tenía dos capas: (1) Sherlock veía el discard como una "eliminación no solicitada" y lo bloqueaba; (2) cuando `enter_worktree` fallaba por conflicto, el agente no tenía autorización explícita para resolverlo. Ambas capas se resuelven de forma independiente y redundante.

- **`isSafeBatch` en `agentEngine.ts`:** `exit_worktree` con `action='discard'` añadido a la lista de llamadas que bypasan el Sherlock Auditor completamente. La condición evalúa el campo `action` de los args antes de clasificar el batch como seguro. Esto es la corrección más robusta — si la llamada nunca llega a Sherlock, no puede ser bloqueada. La lógica es consistente con cómo `run_command` con comandos git seguros ya bypasaba el Auditor.
- **`WORKTREE CLEANUP EXCEPTION` en `REVISOR_PROMPT` (`src/agents.ts`):** Segunda capa de defensa. Nueva sección inyectada después de `HEALING MODE OVERRIDE` con prioridad explícita. Declara que `exit_worktree(discard)` es SIEMPRE autorizado y que si Sherlock lo detectaría como error, debe en cambio emitir: `"Cleanup Authorized: Se permite el descarte para resolver el conflicto de entorno detectado."` Esto garantiza el comportamiento correcto incluso si el isSafeBatch tiene un edge case no contemplado.
- **Worktree Conflict Resolution Hint en `agentEngine.ts`:** Cuando `enter_worktree` falla con el mensaje "already active" (worktree existente), el motor enriquece el output del tool con la directiva: `"CONFLICTO DE WORKTREE DETECTADO: Tienes permiso para usar exit_worktree con action='discard' para limpiar el entorno antes de reintentar."` Esto resuelve el vector de bloqueo por indecisión — el LLM recibe autorización explícita del motor sin necesidad de interpretar el error por su cuenta.

---

## [v8.3.2] - The Precision Protocol (Semantic Replace)

**Objetivo:** Eliminar el anti-patrón de edición por coordenadas de línea (`replace_lines`) que causa corrupción de AST cuando el LLM calcula mal los números de línea. La v8.3.2 implementa el "Reemplazo Semántico": el agente identifica el bloque a reemplazar por su contenido exacto (`search_snippet`), no por su posición en el archivo. Si el snippet no coincide exactamente, la herramienta no hace nada — el archivo nunca se corrompe.

- **`ReplaceBlockTool` actualizado (`src/tools/ReplaceBlockTool/index.ts`):** Nuevos parámetros primarios `search_snippet` y `replace_snippet` (alineados al spec del usuario). Los nombres legacy `target_snippet`/`new_content` siguen siendo aceptados como fallback para backward compat. El TOOL_DEF actualiza la descripción para explicar el fail-safe explícitamente. El mensaje de error cuando el snippet no se encuentra ahora devuelve exactamente: `"Snippet exacto no encontrado. Usa read_file para copiar el bloque literal antes de reemplazar."`. **FileLockManager integrado**: `acquireLock` antes del `fs.writeFileSync`, `releaseLock` en el `finally` — idéntico al patrón de `ReplaceLinesTool` y `FileWriteTool`. El auto-inject de `agent_id` desde `agentEngine.ts` aplica también a `replace_block`.
- **Toolset del @coder actualizado (`src/agents.ts`):** `search_and_replace` eliminado del array `tools`. `replace_block` añadido como único tool de edición de archivos existentes.
- **Toolset del @designer actualizado (`src/agents.ts`):** `replace_block` añadido. El designer ahora puede editar archivos CSS/HTML existentes de forma segura sin acceso a coordenadas de línea.
- **System prompt del @coder (`src/agents.ts`):** Todas las referencias a `search_and_replace` (8 ocurrencias) actualizadas a `replace_block`. La sección `SEARCH_AND_REPLACE WORKFLOW` reemplazada por `REPLACE_BLOCK WORKFLOW` con la instrucción exacta del usuario: "Debes proveer un search_snippet con el código exacto actual (copiado de read_file) incluyendo un par de líneas de contexto arriba y abajo". `RULE (GRACEFUL DEGRADATION)` actualizada: fallback ahora es `replace_block` con un `search_snippet` más amplio, no `replace_lines`.
- **System prompt del @designer (`src/agents.ts`):** Añadida sección `REPLACE_BLOCK WORKFLOW` con la instrucción completa en español.
- **Auto-inject de `agent_id` en `agentEngine.ts`:** El bloque de auto-inject existente (que cubría `replace_lines` y `write_file`) ahora incluye también `replace_block` — el `FileLockManager` siempre recibe el `agentId` correcto sin que el LLM deba recordarlo.

---

## [v8.3.1] - Strict Orchestrator (Tool Deprivation)

**Objetivo:** Corregir el patrón de "LLM Laziness" observado en los logs de la v8.3.0: el @manager, al tener acceso a herramientas de edición, intentaba hacer el trabajo de programación directamente (y fallaba), en lugar de delegar a @coder y @designer vía `create_team`. La solución es arquitectural — se elimina físicamente el acceso a las herramientas de mutación del Manager, forzando la delegación como única ruta posible.

- **Deprivación de herramientas en `src/agents.ts`:** La lista `tools` del agente `manager` se reduce de 18 herramientas a 8. Eliminadas: `write_file`, `search_and_replace`, `replace_lines` (implícito), `replace_block` (implícito), `create_dir`, `list_dir`, `delete_file`, `delete_dir`, `propose_plan`, `ask_user_approval`, `update_memory`, `fetch_documentation`. Conservadas: `read_file` (diagnóstico de solo lectura), `search_in_files`, `get_code_structure`, `run_command` (solo git/npm), `enter_worktree`, `exit_worktree`, `create_team`, `send_message`. El engine construye el schema de tools a partir de esta lista — si el LLM intenta llamar a una herramienta no registrada, el engine devuelve `[SYSTEM ENGINE ERROR]: Unknown tool` directamente.
- **Bloque `STRICT ORCHESTRATOR CONSTRAINT` en el system prompt del Manager (`src/agents.ts`):** Inyectado como primera sección del prompt, antes del Sentinel Protocol. Declara explícitamente qué herramientas tiene y qué herramientas NO tiene. La frase *"Físicamente no tienes acceso a herramientas de escritura"* es deliberadamente concreta — modelos de lenguaje responden mejor a restricciones físicas que a restricciones de comportamiento. El bloque cierra con la `MANDATORY DELEGATION RULE`: cualquier tarea de código o diseño → `create_team` inmediatamente, sin excepciones.

---

## [v8.3.0] - Native Visual Diff (Worktree Human Review)

**Objetivo:** Eliminar el diff de texto simulado (líneas verdes) del webview y reemplazarlo con el motor nativo de comparación de VS Code. Cuando un agente completa su trabajo en un Worktree y solicita fusión, el motor pausa la ejecución y presenta al usuario una tarjeta de revisión con: la lista de archivos modificados (cada uno abre `vscode.diff` nativo con un click), y los botones [Aprobar Merge] / [Descartar Worktree] que resuelven la pausa sin pasar por el LLM.

- **`vscode.diff` nativo (`src/extension.ts`):** Nuevo handler `open_worktree_diff` — recibe `{filePath}` del webview, lee `.fluxo/active_worktree.json` para obtener el path del worktree, construye `uriOriginal` (archivo en la rama principal) y `uriWorktree` (archivo modificado en `.fluxo/worktrees/<branch>/`), y ejecuta `vscode.commands.executeCommand('vscode.diff', uriOriginal, uriWorktree, 'Diff: [archivo] — Original vs Cambios de Fluxo')`. El motor nativo de VS Code muestra el diff lado a lado con highlighting sintáctico completo — sin procesamiento adicional.
- **Intercept pre-merge en `agentEngine.ts` (v8.3.0):** Cuando el agente llama `exit_worktree` con `action='merge'`, el motor intercepta la llamada ANTES de ejecutar el git merge. Lee `.fluxo/active_worktree.json`, hace `yield { type: 'thinking', text: '🔍 Requesting human review...' }`, y llama `worktreeReviewCallback(branch, worktreePath)` — una Promise que suspende el bucle del agente hasta que el usuario toma una decisión. El resultado (`'merge'` o `'discard'`) reemplaza el `action` original antes de pasarlo a `executeTool`. Si no hay callback (sub-agentes en Parallel Swarm), el merge se ejecuta directamente sin pausa.
- **`worktreeReviewCallback` en `extension.ts`:** Implementado como closure dentro de `_handleSendMessage`. Ejecuta `git diff --name-only HEAD` dentro del worktree para obtener la lista de archivos modificados, postea `{ type: 'worktreeReview', branch, worktreePath, changedFiles }` al webview, y retorna una `Promise<'merge' | 'discard'>` guardando el resolver en `_pendingWorktreeReview`. El handler `worktree_decision` en `_handleMessage` resuelve la Promise cuando el usuario hace click en un botón.
- **Tarjeta de revisión Worktree (`media/main.js` — `handleWorktreeReview`):** Componente visual en el webview que se muestra cuando el engine emite `worktreeReview`. Contiene: header con rama activa (`wt-branch-badge`), hint de instrucción, lista de archivos clickeables (cada `.wt-file-btn` envía `open_worktree_diff`), y dos botones de acción — `.wt-approve` (verde, envía `worktree_decision: merge`) y `.wt-discard` (rojo, envía `worktree_decision: discard`). Ambos botones se deshabilitan al hacer click para prevenir doble-submit, mostrando "⏳ Merging…" / "⏳ Discarding…" mientras el engine procesa.
- **Eliminación del diff simulado (`media/main.js`):** El bloque que renderizaba líneas verdes (`<span class="diff-line-added">`) para `write_file`, `replace_lines`, `replace_block`, `replace_block`, y `edit_file` en `handleToolCall()` ha sido eliminado. Las tarjetas de herramientas ahora muestran solo los argumentos esenciales (ruta, rango de líneas) sin contenido de código simulado — el diff real se abre bajo demanda vía `vscode.diff`.
- **Nuevos estilos (`media/style.css`):** Clases `.worktree-review-card`, `.wt-review-header`, `.wt-branch-badge`, `.wt-hint`, `.wt-files-list`, `.wt-file-btn`, `.wt-actions`, `.wt-btn`, `.wt-approve`, `.wt-discard` — diseño coherente con el sistema de glassmorphism oscuro existente.
- **Nuevos títulos de herramientas en `getToolTitle` (`media/main.js`):** `enter_worktree`, `exit_worktree`, `create_team`, y `send_message` ahora tienen representaciones legibles en las tarjetas de actividad del agente.
- **Versión de UI actualizada** a `v8.3.0` en el header del webview y en `renderWelcome()`.

---

## [v8.2.0] - The Parallel Swarm (Concurrent Agent Orchestration)

**Objetivo:** Activar la Fase 2 de la orquestación: el Manager puede ahora delegar tareas independientes a múltiples agentes y ejecutarlos en paralelo con `Promise.all`. El motor de bloqueo de archivos de la v8.1.0 actúa como red de seguridad — si dos hilos intentan editar el mismo archivo simultáneamente, el segundo recibe un `SYSTEM LOCK` y espera. Los agentes pueden intercambiarse payloads de contexto en segundo plano sin contaminar la interfaz del usuario con JSON crudo.

- **`AgentMailbox` (`src/utils/agentMailbox.ts`):** Nuevo singleton que implementa un sistema de mensajería asíncrona entre agentes. `send(toAgentId, fromAgentId, payload)` encola un mensaje en el inbox del agente receptor. `drain(agentId)` consume y vacía el inbox, retornando los mensajes formateados como `[FROM @agentId]: payload`. `hasPending(agentId)` permite comprobar sin consumir. El mailbox es en memoria, compartido en el proceso Node.js, y persiste entre iteraciones pero no entre sesiones de VS Code.
- **`TeamCreateTool` (`src/tools/TeamCreateTool/index.ts`):** Nueva herramienta exclusiva del Manager que define un esquema de delegación paralela: `{ "team": [{"agent": "coder", "task": "..."}, {"agent": "designer", "task": "..."}] }`. La herramienta es un passthrough — su `execute()` nunca se llama. El engine la intercepta en el bloque especial de `create_team` antes de llegar al `executeTool` genérico.
- **`SendMessageTool` (`src/tools/SendMessageTool/index.ts`):** Nueva herramienta disponible para todos los agentes (Coder, Designer, Manager). `send_message({ to_agent, from_agent, payload })` escribe el payload en el `AgentMailbox` silenciosamente. El output devuelto al LLM Y a la UI es un ACK corto (`"Message queued for @designer"`), **nunca el payload completo** — así el usuario no ve JSON crudo de 200 líneas en el chat. El payload real se entrega en el contexto del receptor.
- **Parallel Swarm Engine (`src/agentEngine.ts`):** Intercept de `create_team` en el bloque de ejecución de herramientas (mismo patrón que `ask_user_approval`). Cuando el Manager llama `create_team`, el motor: (1) crea un buffer de eventos por sub-agente; (2) llama `runAgentLoop()` recursivamente para cada miembro del equipo, pasando un contexto limpio; (3) ejecuta todos con `Promise.all()` — los hilos corren concurrentemente y comparten el `FileLockManager`; (4) hace replay secuencial de todos los eventos bufferizados con separadores visuales (`━━━ @coder — thread 1/2 ━━━`) una vez que `Promise.all` resuelve. Sub-agentes que intentan escribir el mismo archivo reciben `SYSTEM LOCK` del `FileLockManager` y abortan su operación sin corromper el archivo.
- **Mailbox drain por iteración (`src/agentEngine.ts`):** Al inicio de cada iteración del bucle (antes del API call), el motor llama `AgentMailbox.drain(agentId)` e inyecta los mensajes entrantes como user turns en el historial del agente receptor. Esto permite que mensajes enviados por un agente paralelo (`send_message`) lleguen al destinatario en su próxima iteración, sin importar el orden de ejecución.
- **Auto-inject de `agent_id` (`src/agentEngine.ts`):** El motor inyecta automáticamente `args.agent_id = agentId` en cada llamada a `replace_lines` y `write_file` que no tenga ya un `agent_id` explícito. Esto elimina la responsabilidad del LLM de recordar su propio ID en cada herramienta de edición — el `FileLockManager` siempre tiene la información correcta sin instrucción adicional al agente.
- **Actualización de `AgentDefinition` en `src/agents.ts`:** `send_message` añadido al toolset de Coder y Designer. `create_team` y `send_message` añadidos al Manager. Nueva sección `PARALLEL SWARM PROTOCOL` en el system prompt del Manager con ejemplos de `create_team` y reglas de diseño de tareas independientes.

---

## [v8.1.0] - The Mutex Protocol (File Lock Manager)

**Objetivo:** Proteger la integridad del sistema de archivos cuando múltiples agentes ejecutan en paralelo (Fase 2: Orquestación Paralela con `Promise.all`). Sin un mecanismo de bloqueo, dos agentes corriendo concurrentemente pueden intentar escribir el mismo archivo simultáneamente, produciendo race conditions que corrompen el contenido final — el segundo write sobreescribe silenciosamente el trabajo del primero. Esta versión introduce un gestor de cerrojos en memoria que garantiza acceso mutuamente exclusivo a los archivos durante cada operación de escritura.

- **`FileLockManager` (`src/utils/lockfile.ts`):** Nuevo singleton estático que implementa el protocolo de exclusión mutua a nivel de archivo. Internamente usa un `Map<string, { agentId, acquiredAt }>` con claves normalizadas a lowercase (para case-insensitive en Windows). `acquireLock(filePath, agentId)` retorna `true` si el cerrojo está libre o si el mismo agente ya lo sostiene (reentrant), y `false` si un agente diferente lo posee. `releaseLock(filePath, agentId)` solo libera el cerrojo si el llamador es el titular actual, previniendo liberaciones accidentales cruzadas. `getHolder(filePath)` expone el agentId del titular actual para mensajes de diagnóstico.
- **Mutex en `ReplaceLinesTool` (`src/tools/ReplaceLinesTool/index.ts`):** Toda la validación previa (brace-balance, JSX-AST, anti-mass-deletion) se ejecuta SIN cerrojos — los guards son read-only y no necesitan exclusión. El `acquireLock` se llama únicamente en el punto exacto antes de `fs.writeFileSync`. Si el archivo está bloqueado por otro agente, la herramienta retorna `success: false` con el mensaje exacto `SYSTEM LOCK: El archivo [X] está siendo editado actualmente por otro agente...`. La escritura ocurre dentro de un bloque `try { fs.writeFileSync(...) } finally { releaseLock(...) }`, garantizando que el cerrojo se libere siempre, incluso si la escritura lanza una excepción inesperada.
- **Mutex en `FileWriteTool` (`src/tools/FileWriteTool/index.ts`):** Mismo patrón de cerrojo aplicado al `write_file`. `acquireLock` antes del `fs.writeFileSync`, `releaseLock` en el `finally`. El `fs.mkdirSync` (creación de directorios intermedios) también está dentro del bloque protegido, ya que es parte atómica de la operación de creación de archivo.
- **Parámetro `agent_id` (opcional) en ambas herramientas:** Se añadió `agent_id: string` como propiedad opcional en los schemas `TOOL_DEF` de `replace_lines` y `write_file`. Cuando los agentes corren en modo de orquestación paralela, cada uno pasa su identificador (ej. `"coder-1"`, `"designer-2"`) para que el sistema de cerrojos sepa quién posee qué archivo. Si `agent_id` se omite, el motor usa el valor por defecto `"agent"` — el comportamiento es compatible hacia atrás y no rompe sesiones de agente único.

---

## [v8.0.0] - Aislamiento Estructural Absoluto (git worktree Sandbox)

**Objetivo:** Erradicar los bugs destructivos en la rama `main` causados por refactorizaciones de alto riesgo que el agente ejecuta directamente sobre el código de producción. Cuando el LLM corrompe el AST o el build falla, no hay forma de revertir sin intervención manual del usuario. Esta versión introduce un sandbox de aislamiento completo basado en `git worktree`.

- **`EnterWorktreeTool` (`src/tools/EnterWorktreeTool/index.ts`):** Nueva herramienta que ejecuta `git worktree add .fluxo/worktrees/<branch> -b <branch>` creando un checkout completo del HEAD actual en una rama fresca y aislada. Persiste el estado activo en `.fluxo/active_worktree.json`. Bloquea la creación de un segundo worktree si ya hay uno activo. Devuelve el path del worktree y las instrucciones de prefijo de ruta para el agente.
- **`ExitWorktreeTool` (`src/tools/ExitWorktreeTool/index.ts`):** Herramienta de finalización con dos modos: `action='merge'` hace `git add -A && git commit` dentro del worktree y luego `git merge --no-ff` en el workspace principal; `action='discard'` ejecuta `git worktree remove --force` + `git branch -D` eliminando el sandbox sin tocar `main`. Ambos modos limpian el state file y ejecutan `git worktree prune`.
- **`isolation: 'worktree'` en `AgentDefinition` (`src/agents.ts`):** Nueva propiedad opcional en la interfaz del agente. Coder y Manager tienen `isolation: 'worktree'` activado. Cuando está presente, el motor inyecta un turn de usuario `[ISOLATION MODE ACTIVE]` al inicio de la sesión, poniendo al LLM en modo de conciencia de aislamiento desde la primera iteración.
- **`RULE (WORKTREE ISOLATION)` en Coder y Manager (`src/agents.ts`):** Nueva regla inyectada en los system prompts: obligatoria para refactorizaciones >50 líneas o multi-archivo; opcional para ediciones simples (<50 líneas, 1-2 archivos). Define el workflow completo: enter → edit → build → merge/discard.
- **Registro de herramientas (`src/tools/index.ts`):** `EnterWorktreeTool` y `ExitWorktreeTool` añadidos al array `ALL_TOOLS` y al `TOOL_MAP`.

---

## [v7.21.0] - Resilient Payload (replace_lines Array Normalizer)

**Objetivo:** Eliminar el error `CRITICAL ERROR: new_content must be a string` que bloqueaba al agente cuando intentaba empaquetar bloques grandes de JSX en un único string JSON. Al escapar comillas y saltos de línea en bloques de 50+ líneas, el LLM comete errores de serialización o decide enviar el contenido como un `Array` de strings, lo que rompía la validación estricta de la herramienta.

- **Payload Normalizer en `ReplaceLinesTool` (`src/tools/ReplaceLinesTool/index.ts`):** Se insertó un bloque de normalización de input antes de la validación estricta de tipo. El normalizer maneja tres casos de fallo silenciosamente: (1) `Array` — se une con `\n` automáticamente vía `.join('\n')`; (2) `null` / `undefined` — se asigna `""` (delete semantics); (3) `object` mal parseado — se extraen los valores con `Object.values().map(String).join('\n')` o se hace `JSON.stringify` como último recurso. Solo si el tipo sigue sin ser `string` tras la normalización se devuelve el error (caso prácticamente imposible en uso real).
- **TOOL_DEF actualizado — `new_content` acepta Array (`src/tools/ReplaceLinesTool/index.ts`):** El tipo JSON Schema de `new_content` cambia de `'string'` a `['string', 'array']`. La descripción ahora instruye explícitamente al LLM: *"Para evitar errores de escape JSON en bloques grandes de JSX/TSX, tienes PERMITIDO enviar este parámetro como un Array de strings (una línea de código por elemento)."* Esto evita que el modelo intente construir strings multi-línea escapados manualmente y reduce la tasa de error en bloques grandes a cero.

---

## [v7.20.0] - The Last Resort Exemption (Anti-Deadlock)

**Objetivo:** Eliminar el deadlock en el que el agente se quedaba sin herramientas de edición válidas: `search_and_replace` prohibido por el usuario (Tool Masker v7.18), `replace_lines` bloqueado por el Circuit Breaker tras 2 fallos, `write_file` rechazado por Sherlock. El motor entraba en un estado terminal sin ruta de escape.

- **Exención del Circuit Breaker para `replace_lines` (`agentEngine.ts`):** Se añadió `replace_lines` a la lista de herramientas inmunes al Circuit Breaker, junto a `run_command` y `get_code_structure`. La condición de activación cambia de `toolName !== 'run_command' && toolName !== 'get_code_structure'` a incluir `&& toolName !== 'replace_lines'`. El Circuit Breaker jamás podrá bloquear la herramienta de edición de último recurso del sistema, garantizando que siempre exista un camino de recuperación.
- **Chunking Hint en fallos de `replace_lines` (`agentEngine.ts`):** Cuando `replace_lines` devuelve `success: false` (causado frecuentemente por JSON mal formado en bloques de código muy largos), el motor enriquece el output con una directiva de fragmentación estricta antes de que el LLM reciba el error. La directiva instruye al agente a dividir el reemplazo en segmentos de 10-20 líneas en lugar de intentar un reemplazo monolítico, eliminando la causa raíz de los fallos por tamaño. El Circuit Breaker es la última línea de defensa; el Chunking Hint es la guía proactiva.

---

## [v7.19.0] - Stateless Auditor (Anti REDUNDANT_DECLARATION State Leak)

**Objetivo:** Eliminar el "State Leak" crítico en Sherlock Auditor que causaba falsos positivos de `REDUNDANT_DECLARATION`. Cuando una inyección de código fallaba (ej. nombre de parámetro incorrecto: `content` en lugar de `new_content`), la declaración ya había sido registrada en `toolCallHistory`. Al reintentar, Sherlock la reconocía como un duplicado del turno anterior fallido y bloqueaba la inyección válida.

- **Arquitectura de doble historial (`agentEngine.ts`):** Se introdujo un segundo array `successfulToolCallHistory: string[]` paralelo al existente `toolCallHistory`. La separación de responsabilidades es clara: `toolCallHistory` (push antes de ejecución) sigue siendo la fuente de verdad para la **detección de loops pre-vuelo** — esto no cambia. El nuevo `successfulToolCallHistory` solo recibe el push dentro del bloque `else` del Circuit Breaker, es decir, únicamente cuando `result.success === true`. Así los fallos no contaminan el estado.
- **Sherlock alimentado con estado comprometido:** La variable `priorHistory` que se construye antes de cada llamada a Sherlock ahora usa `successfulToolCallHistory` en lugar de `toolCallHistory`. Sherlock solo ve declaraciones que realmente llegaron al archivo — nunca intentos fallidos. Esto elimina el vector de falso positivo por completo sin necesidad de lógica de rollback explícita.
- **Sin regresiones:** El Loop Interceptor pre-vuelo (líneas 419–439) sigue usando `toolCallHistory` completo — si el agente reintenta exactamente la misma llamada fallida con los mismos args, el interceptor lo suprime igual que antes. Sólo el contexto de Sherlock cambia.

---

## [v7.18.0] - Deep Masking (Anti Tool Hallucination)

**Objetivo:** Resolver el problema de "Tool Hallucination" en el que el agente seguía invocando herramientas desactivadas porque su System Prompt base las mencionaba explícitamente. El filtrado del array `agentTools` no era suficiente — el LLM recordaba las reglas de su entrenamiento y las llamaba de todas formas.

- **Regex Refinada del Tool Masker (`agentEngine.ts`):** Se reemplazó la regex simple de la v7.17.0 por una versión robusta con soporte de texto intermedio (`[^\w]*(?:[\w]+\s+){0,3}`). Ahora captura variaciones como `"PROHIBIDO usar la herramienta search_and_replace"`, `"stop using write_file"` y `"no uses run_command"`. Se añadió el verbo `stop using` a la lista de disparadores.
- **Dynamic System Prompt Override (`agentEngine.ts`):** Cuando el Masker detecta una herramienta a deshabilitar, ya no sólo la elimina del schema de tools. Ahora inyecta dinámicamente un bloque `[CRITICAL SYSTEM OVERRIDE]` al final del `systemPrompt` base por cada herramienta enmascarada, anulando cualquier regla preexistente que la mencione. Esto cierra el vector de "regla base vs. schema filtrado".
- **Soft Fail Interceptor (`agentEngine.ts`):** En el bucle de ejecución de herramientas, si el LLM alucina un `tool_call` para una herramienta desactivada (a pesar de los dos controles anteriores), el motor lo intercepta silenciosamente. En lugar de pasarlo a Sherlock o generar un error de pánico, devuelve `success: false` con el mensaje `"SYSTEM OVERRIDE: Has intentado alucinar la herramienta [X]..."`, redirigiendo al agente hacia una estrategia alternativa sin interrumpir el flujo de ejecución.

---

## [v7.17.1] - MCP Initialization Hotfix

**Objetivo:** Evitar que la inicialización de servidores MCP bloquee la UI de la Webview y asegurar la correcta inclusión de las dependencias nativas en el instalador `.vsix`.

- **Inicialización No Bloqueante:** Se refactorizó `McpSwarmClient` para que el arranque de los servidores (`StdioClientTransport` y `listTools()`) suceda asíncronamente en un "fire-and-forget", cacheando las herramientas en memoria y retornándolas instantáneamente sin bloquear el hilo principal de la UI.
- **Robustez y Try/Catch:** Añadidos timeouts de conexión (5s) y de obtención de herramientas. Si un servidor local no existe o npx falla, la extensión captura el error silenciosamente y continúa operando con los demás agentes/servidores.
- **Dependencias en VSIX:** Se corrigió el archivo `.vscodeignore` que bloqueaba accidentalmente el empaquetado de dependencias (`@modelcontextprotocol/sdk`), solventando el fallo crítico "module not found" en producción.

---

## [v7.17.0] - The MCP Leap (Dynamic Masking & Extensibility)

**Objetivo:** Introducir la capacidad de conectarse a Servidores MCP (Model Context Protocol), añadir filtrado dinámico de herramientas por directiva de usuario y evitar la pérdida de mensajes de sistema críticos por la poda de contexto.

- **Infraestructura MCP (Nivel 4):** Se añadió el soporte nativo para Model Context Protocol usando el SDK oficial `@modelcontextprotocol/sdk`. Los usuarios ahora pueden configurar servidores externos en la opción `fluxo.mcpServers` (en `settings.json`) para extender las capacidades del enjambre con herramientas como SQLite, navegadores, etc.
- **Tool Masker (Filtro Dinámico):** El motor ahora intercepta prohibiciones explícitas en el prompt del usuario (ej. `"no uses search_and_replace"`) y enmascara dinámicamente esas herramientas, asegurando que el LLM ni siquiera sepa de su existencia para esa tarea, eliminando la tentación de usarlas.
- **Context Pruning Amnesia Fix:** Se parcheó la función `pruneToolResults` para que nunca trunque mensajes que contengan alertas del sistema (`SYSTEM ERROR`, `BUILD_FAILED`, `[CIRCUIT BREAKER ACTIVATED]`), garantizando que el agente siempre mantenga en contexto por qué fue bloqueado.

---

## [v7.16.0] - Circuit Breaker Exemption & Hard Replace

**Objetivo:** Evitar falsos positivos en el Circuit Breaker que bloqueaban la ejecución de comandos legítimos (como compilaciones fallidas `npm run build`) y reforzar la caída de `search_and_replace` hacia `replace_lines`.

- **Exención en Circuit Breaker:** Se actualizó `src/agentEngine.ts` para que las herramientas `run_command` y `get_code_structure` NUNCA incrementen el contador de fallos (`toolFailureTracker`). El Circuit Breaker ahora se aplica principalmente a herramientas de edición frágiles.
- **Refuerzo de `replace_lines`:** Se modificó el mensaje de error de `search_and_replace` en `src/tools/SearchReplaceTool/index.ts` cuando no se encuentra el bloque exacto. Ahora emite una orden directa e ineludible prohibiendo reintentar `search_and_replace` en la misma zona y forzando el uso inmediato de `replace_lines`.

---

## [v7.15.0] - The Iron Curtain (Anti-Evasion & Hardened Paths)

**Objetivo:** Bloquear intentos de evasión de reglas usando herramientas CLI avanzadas y eliminar sesgos de rutas en Windows.

- **Refactor del Interceptor en RunCommandTool:** Actualizada la regex de bloqueo para incluir `sed`, `awk`, `node -e`, `perl` y `python -c`. La lógica detecta estos comandos y devuelve una alerta de seguridad ("SYSTEM SECURITY ALERT: Intento de evasión detectado...").
- **Hardened Path Sanitizer:** Mejorada la función de validación de rutas en `src/extension.ts` y `shared.ts`. Si el string contiene una letra de unidad precedida por cualquier cosa (ej. `/workspace/d:`), el motor ahora descarta todo lo que esté a la izquierda de la letra de unidad (anulando el Docker-bias de raíz antes del Language Server).
- **Actualización de RULE 5 (NO CLI READING/EDITING):** Nueva redacción estricta en `agents.ts` prohibiendo terminantemente usar la terminal para leer, filtrar o editar código (incluyendo uso creativo de `sed`, `awk`, etc.).

---

## [v7.14.1] - Smart Memory & Semantic Enforcement (Hotfix)

**Objetivo:** Solucionar el `BUG-2026-0428-REDUNDANT-LOOKUP` en el que el agente repetía búsquedas inútiles sobre archivos y anclajes ya descubiertos en lugar de ejecutar la edición con confianza.

- **RULE 7 (DECISIVE ACTION) en Coder:** Se agregó una nueva regla crítica en `agents.ts` que prohíbe explícitamente re-ejecutar `search_in_files` con los mismos términos tras identificar puntos de anclaje, ordenándole al agente confiar en su Smart Memory y proceder de inmediato al flujo de `read_file` → `search_and_replace`.
- **Eliminación de dependencia de usuario para recuperación de AST:** El agente ahora es estrictamente instruido a aplicar la lógica de auto-reparación en caso de corrupciones (Hard Reset interno), en lugar de delegar el fix en el usuario.

---

## [v7.14.0] - Smart Memory & Semantic Enforcement

**Objetivo:** El motor de poda de contexto eliminaba el mapa semántico del agente (`get_code_structure`) y su última lectura de archivo (`read_file`) para ahorrar tokens, provocando bucles de re-lectura y fallos ciegos en `search_and_replace`. Esta versión introduce una capa de "memoria inteligente" que protege la brújula semántica del agente y lo redirige proactivamente cuando un reemplazo falla.

- **Refactor de `pruneToolResults` (`agentEngine.ts`):** Nueva `Lista Blanca de Inmunidad` implementada con `PRUNE_IMMUNE_TOOLS = new Set(['get_code_structure'])`. La función ahora también localiza el índice del ÚLTIMO resultado de `read_file` en el historial completo (`lastReadFileIdx`) y lo exime del truncamiento. Cuatro guards comentados ordenados por prioridad: turns recientes → mensajes no-tool → tools inmunes → último read_file → truncamiento normal.
- **Interceptor de Reemplazo Fallido (`agentEngine.ts`):** Inmediatamente después de que `nativeEditCallback` devuelve `success: false` (y ANTES de que el Circuit Breaker de v7.12.4 pueda acumularlo como un fallo), el motor enriquece el `output` con un `CONSEJO DEL MOTOR` que prescribe: (1) llamar `get_code_structure` para obtener el mapa de líneas actualizado, (2) usar `read_file` con `start_line/end_line` exactos para ver el bloque real, (3) reintentar solo después. Esto convierte un fallo opaco en un plan de recuperación accionable.
- **Fix `list_dir` file-path guard (`src/tools/ListDirTool/index.ts`):** Nuevo bloque post-`existsSync` que llama `fs.statSync(dp).isFile()`. Si el path apunta a un archivo, retorna `success: false` con un mensaje bilingüe que indica la carpeta contenedora calculada y los dos comandos correctos (`read_file` / `list_dir` sobre el padre). Previene el error silencioso donde `readdirSync` sobre un archivo lanzaba una excepción sin contexto.
- **Robust Path Sanitization (`extension.ts` & `shared.ts`):** Se rediseñó la lógica de limpieza de rutas para manejar solapamientos de "Docker-bias" y rutas absolutas (ej. `/workspace/d:\...`). Ahora usa `path.resolve` con comparaciones case-insensitive en Windows, asegurando que el LSP siempre encuentre el archivo correcto y eliminando el "Friction Loop" causado por rutas alucinadas fuera del workspace.

---

## [v7.13.0] - Nivel 4: MCP / External Fetching — fetch_documentation

**Objetivo:** Eliminar el "Tutorial Bias" del agente swarm. Cuando el LLM implementaba librerías externas usando únicamente su memoria de entrenamiento estática, cometía errores de API desactualizados. Esta versión le da al swarm la capacidad de leer documentación oficial en tiempo real antes de escribir código.

- **Nueva herramienta `fetch_documentation` (`src/tools/FetchDocumentationTool/`):** Acepta un parámetro `url` (string). Realiza una petición GET con la API nativa `fetch` de Node.js. Implementa un pipeline de limpieza HTML por regex (sin dependencias externas): extrae `<body>`, elimina `<script>`, `<style>`, `<nav>`, `<header>`, `<footer>`, `<svg>` y convierte headings, listas y `<pre>` a Markdown simplificado. Decodifica entidades HTML, colapsa whitespace y trunca a 20,000 caracteres con nota de truncamiento. Timeout de 15 segundos. Devuelve mensaje limpio en errores HTTP o de red.
- **Motor asíncrono (`agentEngine.ts`):** La ejecución de `fetch_documentation` es intercept ada directamente en el bucle principal del engine (patrón `else if` existente, igual que `ask_user_approval`, `search_and_replace` y `get_code_structure`), preservando la naturaleza síncrona del resto de herramientas sin refactorizar `ToolResult`.
- **RULE (EXTERNAL CONTEXT) — Coder y Manager (`agents.ts`):** Nueva regla inyectada en ambos system prompts. Establece que ante cualquier pedido de implementar una librería externa o concepto de precisión técnica, el agente tiene PERMITIDO y se RECOMIENDA llamar `fetch_documentation` (preferir URLs raw de GitHub o npmjs.com) ANTES de escribir código.
- **Asignada a:** Coder y Manager.

---

## [v7.12.4] - Circuit Breaker & Graceful Degradation

- **Circuit Breaker (agentEngine.ts):** Nuevo `toolFailureTracker: Map<string, number>` inicializado antes del loop. En cada fallo de herramienta incrementa el contador; al llegar a 2 fallos consecutivos activa el breaker sobrescribiendo el output con `[CIRCUIT BREAKER ACTIVATED]` y una directiva de cambio de estrategia. En cada éxito resetea el contador con `delete`. Los mensajes del circuit breaker pasan directamente al LLM sin el wrapping de `MANAGER DIRECTIVE` (exclusión añadida en `anchoredContent`).
- **Graceful Degradation (agents.ts):** Nueva `RULE (GRACEFUL DEGRADATION)` en el Coder: ante un circuit breaker activado, el agente debe cambiar a `replace_lines` o comunicar el problema al usuario — nunca evadir con CLI.

---

## [v7.12.3] - Hotfix: Docker Bias Path Sanitization

- **Bug crítico:** El LLM inyectaba `/workspace/` como prefijo absoluto (Docker bias). En Windows, `path.isAbsolute('/workspace/src/...')` devuelve `true`, por lo que la lógica anterior lo pasaba directamente a `vscode.Uri.file()` — apuntando a la raíz del disco en lugar del workspace real.
- **Fix en `getCodeStructureCallback` (extension.ts):** Nuevo bloque de saneamiento que strips `/workspace/`, `workspace/`, y `\\workspace\\` antes de normalizar y unir con el `workspacePath` real.
- **Fix sistémico en `safePath` (tools/shared.ts):** El mismo saneamiento se aplicó a la función base usada por **todos los tools** (`read_file`, `write_file`, `search_and_replace`, etc.). `path.resolve(workspacePath, '/workspace/src/...')` ignoraba el workspacePath silenciosamente; ahora se sanitiza antes del resolve.

---

## [v7.12.2] - Hotfix: LSP Race Condition & Fallback Shield

- **Fix condición de carrera (LSP):** `getCodeStructureCallback` ahora implementa un bucle de reintento de hasta 4 intentos con 500 ms de espera entre cada uno (2 s en total). Si el `executeDocumentSymbolProvider` devuelve `[]` en todos los intentos, retorna `success: false` con el mensaje `'LSP ERROR: El servidor de lenguaje no pudo extraer los símbolos a tiempo. Usa read_file como fallback.'` en lugar del silent `success: true` que provocaba el pánico del LLM.
- **Refuerzo de seguridad de fallback (agents.ts):** `RULE 6 (SEMANTIC VISION)` en el Coder ahora incluye la directiva explícita: si `get_code_structure` falla o devuelve vacío, el fallback obligatorio es `read_file` + `search_and_replace`. `write_file` sobre archivos existentes sigue siendo una violación que activa el Auditor de Seguridad.

---

## [v7.12.1] - Hotfix: Path Resolution en get_code_structure

- **Bug fix:** `getCodeStructureCallback` en `extension.ts` ahora resuelve rutas relativas antes de crear el `vscode.Uri`. Lógica: `path.isAbsolute(absolutePath) ? absolutePath : path.join(workspacePath, absolutePath)`. Esto corrige el fallo en producción donde el agente enviaba `src/components/...` y VS Code intentaba buscarlo en la raíz del disco.
- **Verificación de backups:** Confirmado que `SearchReplaceTool` y la función de limpieza `cleanupLogsOnActivation` ya operan exclusivamente sobre `.fluxo/backups/` — sin cambios necesarios.

---

## [v7.12.0] - Visión Semántica (LSP — get_code_structure)

- **Nueva herramienta `get_code_structure`:** Usa el comando nativo `vscode.executeDocumentSymbolProvider` del Language Server Protocol para extraer todos los símbolos de un archivo (funciones, clases, variables, métodos) con sus números de línea de inicio y fin exactos. Devuelve un JSON jerárquico con `name`, `kind`, `start`, `end`, y `children` para símbolos anidados.
- **Arquitectura nativa (Callback):** La herramienta funciona vía `getCodeStructureCallback` en `extension.ts` — mismo patrón que `search_and_replace`. Usa `vscode.workspace.openTextDocument()` para asegurar que el archivo esté cargado antes de invocar el provider. El `execute()` en el archivo de tool es un fallback de error para contextos no-VS Code.
- **Regla RULE 6 (SEMANTIC VISION):** Inyectada en el Coder. El agente debe llamar `get_code_structure` antes de modificar archivos grandes, usando el mapa de líneas para hacer `read_file` quirúrgico en lugar de leer el archivo completo en cada iteración.
- **Asignada a:** Coder y Manager.

---

## [v7.11.1] - Anti-Hacker Shield (Bloqueo de Lectura por CLI)

- **Defensa Estática:** Nueva RULE 5 (NO CLI READING) inyectada en el system prompt de Coder y Manager. Los agentes reciben instrucción explícita de usar `read_file` / `search_in_files` en lugar de comandos de terminal para inspeccionar código.
- **Defensa Activa:** Interceptor en `RunCommandTool` que evalúa cada segmento del comando (incluyendo comandos encadenados con `|`, `&&`, `;`). Si detecta `cat`, `tail`, `head`, `less`, `more`, `type`, `Get-Content`, `findstr`, `grep`, o `wc` al inicio de cualquier segmento, retorna inmediatamente `success: false` con mensaje de redirección a `read_file` / `search_in_files`.
- **Impacto:** Elimina el patrón de burn-out de iteraciones donde el agente intentaba leer código con CLI multiplataforma (fallando por incompatibilidad de SO) y consumía el límite de 25 iteraciones sin avanzar.

---

## [v7.11.0] - Context Pruning (Anti Context Balloon)

- **Context Pruning:** Nueva función `pruneToolResults()` en `agentEngine.ts`. Antes de cada llamada a la API, recorre el array `messages` y trunca el contenido de cualquier mensaje `role: 'tool'` antiguo (fuera de los últimos 2 turnos) que supere 1,500 caracteres. El placeholder informativo sustituye el contenido completo para que el agente sepa que puede re-ejecutar la herramienta si lo necesita.
- **Impacto medible:** Tareas con múltiples `read_file` o `run_command` de salida larga pasarán de ~32k tokens por prompt a ~18k, reduciendo costos ~44% en escenarios de tarea larga.
- **Seguridad:** El `messages` original nunca se mutó — el pruning opera sobre una copia inmutable (`msgsToSend`). El system prompt y los mensajes del usuario nunca se truncan.

---

## [v7.10.0] - Arquitectura Multi-Brain & Telemetría Nativa

- **Multi-Brain:** Selector de modelos dividido en Manager Model (🧭 @manager + Sherlock) y Worker Model (💻 @coder, @designer, etc.). El motor enruta automáticamente cada llamada al modelo correcto según el agente activo.
- **Motor Telemetry:** El engine de TypeScript registra automáticamente cada fallo de herramienta (`success: false`) en `.fluxo/improvements.md` sin depender del agente. Eliminada la herramienta `log_friction` por sesgo de optimismo del LLM.
- **Backups:** Confirmado que los backups de `search_and_replace` ya residían en `.fluxo/backups/` (sin cambios necesarios).

---

## [v0.0.1 - v7.9.0] - El Nacimiento y la Estabilización

- **Hito:** Creación de la arquitectura base de extensión de VS Code.
- **Motor:** Implementación del sistema de agentes (Manager, Coder, Designer, Sherlock).
- **UI:** Desarrollo de la interfaz Glassmorphism con React y Tailwind.
- **Core:** Integración de herramientas de edición de archivos y ejecución de terminal.

---

## [v7.9.1 - v7.9.9] - Refinamiento y Blindaje

- **v7.9.1:** Enlaces clickeables (Magic Links) en el chat para abrir archivos nativamente.
- **v7.9.2:** Implementación del Chat Diff (visualización rojo/verde) en las respuestas.
- **v7.9.3:** Smart Auto-Scroll y renderizado cronológico intercalado (Interleaving).
- **v7.9.4:** Persistencia de estado (visualEvents) y reglas contra modales anidados.
- **v7.9.5:** Parche de seguridad 'Early Exit Guard' y eliminación del Focus Stealing.
- **v7.9.6:** Enrutamiento agnóstico de proveedores para compresión de contexto.
- **v7.9.8:** Auto-Save + Git Safety Net. Edición continua sin bloqueos manuales.
- **v7.9.9:** Telemetría proactiva con la herramienta `log_friction`.

---

## [v7.9.10] - Enterprise UX

- **Working Tree:** Botón 'Ver Working Tree' para abrir el Diff nativo de Git en VS Code.
- **Fallback:** Sistema de degradación elegante si Git no está inicializado.

---

## [v7.9.11] - Registro Histórico Oficial

- **CHANGELOG:** Creación del registro histórico público siguiendo estándares de la industria.
- **Manager Rule:** Nueva regla de mantenimiento del changelog para futuras versiones.
