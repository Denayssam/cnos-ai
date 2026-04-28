# 📜 Changelog - Fluxo AI

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
