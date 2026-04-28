# 📜 Changelog - Fluxo AI

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
