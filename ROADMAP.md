# Fluxo AI - Architectural Roadmap

---

## Nivel 1: Memoria Persistente y Extracción de Contexto (memdir & extractMemories)

**Lo que tienes:** Actualmente, tu botón Token Wheel comprime el contexto de la conversación actual.

**La evolución (Monolito):** Claude Code tiene un sistema completo en `src/memdir/` y `src/services/extractMemories/`. En lugar de olvidar todo al cerrar VS Code, el agente extrae de manera proactiva lecciones aprendidas (ej. *'A este usuario no le gustan los default exports'*) y las guarda en una carpeta oculta (`.memdir`).

**Cómo aplicarlo:** Tu agente Manager debe invocar una nueva herramienta invisible al final de cada sesión que redacte un resumen de las convenciones arquitectónicas acordadas y las guarde en memoria persistente.

---

## Nivel 2: Visión Semántica con LSP (LSPTool)

**Lo que tienes:** Usas `search_in_files` y dependes de que la IA acierte con los números de línea para usar `replace_lines`.

**La evolución (Monolito):** El monolito tiene un `LSPTool` (Language Server Protocol) gestionado en `src/services/lsp/LSPClient.ts`. Esto significa que el agente no solo lee texto plano, sino que 'entiende' el código como el compilador (conoce dónde empieza y termina una función exacta, qué variables no se usan, etc.).

**Cómo aplicarlo:** Integrar un cliente LSP ligero en tu extensión para que el agente Coder pueda consultar el árbol de sintaxis abstracta (AST), reduciendo a cero los errores de inyección de código.

---

## Nivel 3: Ejecución en Paralelo (TeamCreateTool & TaskCreateTool)

**Lo que tienes:** Tus agentes trabajan de forma secuencial. El usuario pide algo, el Manager lo delega, espera y devuelve.

**La evolución (Monolito):** Claude usa `src/tools/TeamCreateTool/` y `src/tools/TaskCreateTool/`. Puede instanciar 'equipos' que trabajan al mismo tiempo.

**Cómo aplicarlo:** Si pides un *'Módulo de Login'*, el Manager usa `TeamCreateTool` para que el Designer programe la UI en React, mientras el Backend Dev programa la base de datos en paralelo, uniendo el trabajo al final.

---

## Nivel 4: Conexión con el Mundo Exterior (MCPTool e Integración de Navegador)

**Lo que tienes:** Agentes encerrados en tu editor de código.

**La evolución (Monolito):** El monolito usa extensamente el Model Context Protocol (`src/services/mcp/`) y `src/tools/MCPTool/`.

**Cómo aplicarlo:** Permitirá que tu agente se conecte a tu base de datos de producción para revisar esquemas, o que consulte directamente la documentación viva de herramientas como Stripe sin salir del entorno.
