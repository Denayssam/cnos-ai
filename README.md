# 🌊 Fluxo Tech AI — VS Code Agent Extension

Fluxo AI no es solo otro autocompletador de código. Es un **Motor Cognitivo (Tier-1)** integrado nativamente en Visual Studio Code, diseñado para Managers, Arquitectos y Tech Leads que requieren una colaboración segura y guiada (Human-in-the-Loop) con modelos de lenguaje.

![Version](https://img.shields.io/badge/version-v8.28.0-blue)
![Architecture](https://img.shields.io/badge/architecture-Structural_Isolation-orange)
![Status](https://img.shields.io/badge/status-Active_Development-success)
![License](https://img.shields.io/badge/license-MIT-green)

---

## ✨ Filosofía Core: "Human-in-the-Loop"

Los LLMs actuales son brillantes creando código desde cero, pero deficientes haciendo cirugías a ciegas en bases de código complejas. Fluxo AI resuelve esto actuando como un "Pair Programmer" disciplinado: **La IA propone, el Arquitecto dispone.**

---

## 🚀 Características Principales (Motor v8.20.0 — Seamless UX & MCP Registry)

| Característica | Descripción |
|---|---|
| 🧭 **Parallel Agent Swarm** | `@manager` orquesta `@coder`, `@designer`, `@planner` en paralelo vía `create_team`. FileLockManager previene colisiones de escritura en multi-agente. |
| 📋 **Planning Gate (v8.5.3)** | El `@manager` tiene PROHIBIDO delegar sin un plan. `enter_plan_mode` spawna un `@planner` que analiza el repo y produce `.fluxo/IMPLEMENTATION_PLAN.md` antes de cualquier edición. |
| 🧩 **Community Skills (v8.6.0)** | Biblioteca de recetas JSON en `skills/`. El `@manager` detecta integraciones conocidas (Stripe, Firebase…) y aplica el blueprint completo con un solo `skill(action='apply')`. |
| 🖥️ **OS Awareness (v8.7.0)** | Detección dinámica de `process.platform` — en Windows inyecta tabla de equivalencias (dir/ls, del/rm, move/mv) y prohibición de comandos Unix. Pipe-filtering (`build \| grep`) desbloqueado. |
| 🧹 **Clean Output Rendering (v8.7.1)** | Texto intermedio (CoT leak) redirigido al status bar. Bloques `<thinking>` renderizados como acordeón colapsable. La burbuja de chat solo muestra el Orchestrator's Report final. |
| 🌳 **Structural Isolation (v8.8.0)** | `enter_worktree` activa un sandbox git aislado. El motor redirige silenciosamente TODAS las operaciones de archivo al worktree — el agente usa rutas normales. `exit_worktree(merge/discard)` con Human Review. |
| 🔬 **AST-Native Editing (v8.5.0)** | `replace_symbol` delega la localización de bloques al Language Server Protocol (LSP) de VS Code — el agente nombra el símbolo, el LSP calcula el rango exacto. Cero riesgo de llaves desbalanceadas. |
| 🌳 **Git Worktree Isolation** | `enter_worktree` crea un branch aislado antes de refactorizaciones de alto riesgo. `exit_worktree(merge/discard)` incluye Human Review con diff nativo de VS Code. |
| 🛡️ **Sherlock Auditor** | Doble capa de seguridad: bloquea re-declaraciones redundantes, Tech Stack Drift, Modal Collision y Ghost Loops antes de escribir al disco. |
| 🔍 **GlobTool / GrepTool** | Herramientas nativas de exploración (puro Node.js, sin CLI). Reemplazan `ls`, `find`, `grep` en `run_command`. Path normalization middleware silencia la "Amnesia Espacial". |
| 🟢 **Sentinel Auto-Heal** | Monitorea el terminal en tiempo real. Build roto → intercepta y dirige al `@coder` automáticamente. |
| 🔌 **MCP Support** | Conecta servidores MCP externos (SQLite, filesystem, APIs) vía configuración JSON en Settings. |
| 🧬 **Syntax Shield — AST Validation (v8.16.x)** | Valida la sintaxis de TypeScript/JSX en memoria antes de escribir en disco. Corrupción de código fuente imposible: si el AST falla, la escritura se aborta con diagnóstico de error. |
| ⏱️ **Time Machine — Auto-Checkpoint (v8.16.x)** | Checkpointing silencioso de Git antes de cada tarea. Rollback instantáneo a un estado limpio sin intervención manual. |
| 🔒 **Quality Gate & Escape Hatch (v8.16.x)** | Ciclo cerrado: el motor exige que el código pase `npm run build` antes de declarar una tarea completa. Si el agente falla 3 veces consecutivas, el **Circuit Breaker** paraliza el bucle y fuerza una pausa HITL — el agente debe pedir aprobación humana antes de continuar. |

---

## 🧩 Community Skills — Cómo Contribuir

Los Skills son recetas JSON pre-construidas que describen la implementación completa de una integración estándar. Cuando el `@manager` detecta que una tarea coincide con un skill disponible, lo aplica directamente — sin necesidad de análisis manual del repo.

### Estructura de un Skill

```json
{
  "name": "mi-integracion",
  "description": "Una línea clara explicando qué integra este skill y qué cubre.",
  "recipe": "# Implementation Plan — Mi Integración\n\n## Objective\n...\n\n## Sequential Steps\n..."
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `name` | `string` | Identificador kebab-case único. El agente lo llama con `skill(action='apply', skill_name='mi-integracion')`. |
| `description` | `string` | Una línea para el listado. El agente la lee en `skill(action='list')` para decidir si el skill es relevante. |
| `recipe` | `string` | Markdown completo del plan. Sigue el formato obligatorio (ver abajo). |

### Formato Obligatorio del Recipe

```markdown
# Implementation Plan — [Nombre de la Integración]

## Objective
[Una oración: qué se construye y por qué.]

## Files to Modify
| File | Action | Reason |
|------|--------|--------|
| src/api/endpoint.ts | Create | [razón] |

## Sequential Steps

### Step 1: [Nombre del Paso]
- **File**: src/api/endpoint.ts
- **Action**: Create new file
- **Symbol/Block**: [nombre exacto del símbolo o bloque a editar]
- **Details**: [qué agregar, cambiar o eliminar — ser preciso]

### Step 2: ...

## Integration Points
- [Dependencias entre pasos — ej: "Step 3 requiere que Step 1 haya creado el endpoint X"]

## Dependencies & Risks
- [Breaking changes, dependencias externas, comandos de testing local]

## Agent Assignment
- @coder: Steps [N, N, N]
- @designer: Steps [N, N]
```

### Cómo Agregar un Skill

1. Crea un archivo `skills/tu-integracion.json` siguiendo la estructura de arriba.
2. Usa `\n` para saltos de línea dentro del string `recipe` (es JSON, no YAML).
3. Asegúrate de que cada paso tenga un **File** y un **Action** concretos — los pasos vagos ("actualizar el componente") no son accionables.
4. Haz un Pull Request al repositorio con tu skill. Si la comunidad lo valida, se incluye en la próxima versión de la extensión.

### Skills Disponibles

| Skill | Descripción |
|-------|-------------|
| `stripe-payment-flow` | Stripe Checkout completo: session endpoint, webhook con raw-body, checkout button, success/cancel pages. |

---

## 🛠️ Arquitectura Interna (v8.6.0)

```
src/
├── agentEngine.ts   — Motor cognitivo: loop, Hard Brake, Planning Gate, Skills intercept
├── agents.ts        — Swarm: @coder, @designer, @planner, @manager + Sherlock Auditor
├── extension.ts     — Bridge VS Code: LSP callbacks, worktree review, applyNativeEdit
├── sentinel.ts      — Monitor de terminal en tiempo real
skills/              — 📁 Community Skills Library (JSON recipes — root level, VSIX-included)
│   └── stripe-payment-flow.json
└── tools/
    ├── SkillTool/         — skill: list / apply
    ├── EnterPlanModeTool/ — enter_plan_mode: spawna @planner
    ├── TeamCreateTool/    — create_team: Parallel Swarm
    ├── ReplaceSymbolTool/ — replace_symbol: LSP-native AST edits
    ├── GlobTool/          — glob: pattern file finder (no CLI)
    ├── GrepTool/          — grep: regex search across project (no CLI)
    ├── SendMessageTool/   — send_message: inter-agent mailbox
    ├── SearchReplaceTool/ — search_and_replace: native VS Code edit
    ├── FileReadTool/
    ├── FileWriteTool/     — write_file: mutex-protected
    ├── ReplaceBlockTool/  — replace_block: search_snippet / replace_snippet
    └── ...

media/
├── main.js          — WebView UI: tool cards, worktree review, model selector
└── style.css        — Glassmorphism design system
```

---

## 💡 Flujo de Trabajo Ideal (v8.6.0)

```
1. Describe tu feature en el chat → @manager detecta el tipo de tarea
2. Si es una integración conocida → skill(action='list') → skill(action='apply')
   Si es una tarea custom → enter_plan_mode → @planner analiza el repo
3. IMPLEMENTATION_PLAN.md generado en .fluxo/
4. @manager llama create_team → @coder y @designer ejecutan en paralelo
5. Cambios vía replace_symbol (LSP) o replace_block → diff visual en VS Code
6. exit_worktree(merge) → Human Review del diff → aprueba o descarta
```

---

## 🚀 Instalación Rápida

Fluxo AI utiliza **GitHub Releases** para una distribución limpia. Los binarios `.vsix` ya no se rastrean en el repositorio.

1. Ve a la pestaña **[Releases](https://github.com/Denayssam/cnos-ai/releases)** de este repositorio.
2. Descarga el último archivo `.vsix` (ej. `fluxo-ai-8.16.1.vsix`).
3. Instálalo en VS Code arrastrándolo a la vista de **Extensiones**, o usa el comando:
   `Extensions: Install from VSIX...`
4. Configura tu API Key en **VS Code Settings → busca "Fluxo AI"** → pega tu OpenRouter / Gemini / DeepSeek key.

---

## 🤝 Agentes del Swarm

| Agente | Emoji | Especialidad | Toolset |
|--------|-------|--------------|---------|
| `coder` | 💻 | Código, bugs, archivos, comandos | replace_symbol, replace_block, glob, grep, worktree |
| `designer` | 🎨 | UI/UX, Tailwind, glassmorphism | replace_symbol, replace_block, search_images |
| `dashboard` | 📊 | Charts, analytics, KPIs | write_file, run_command |
| `payments` | 💳 | Stripe, PayPal, webhooks | write_file, run_command |
| `planner` | 📋 | Análisis de repo + plan | read_file, glob, grep, get_code_structure, **skill** |
| `manager` | 🧭 | Orquestación, emergencias | create_team, enter_plan_mode, **skill** |

---

## 📁 Documentación

| Archivo | Descripción |
|---------|-------------|
| [INSTALL.md](INSTALL.md) | Guía completa de instalación y configuración |
| [CNOS_MANIFESTO.md](CNOS_MANIFESTO.md) | Constitución del sistema — reglas vinculantes para agentes |
| [CHANGELOG.md](CHANGELOG.md) | Historial técnico completo de versiones |

---

*Construido para domar el caos de la IA generativa.*
*Built by **Denayssam** & Fluxo Tech AI · [fluxotechai.com](https://fluxotechai.com)*
