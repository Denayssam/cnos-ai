# 🌊 Fluxo Tech AI — VS Code Agent Extension

Fluxo AI no es solo otro autocompletador de código. Es un **Motor Cognitivo (Tier-1)** integrado nativamente en Visual Studio Code, diseñado para Managers, Arquitectos y Tech Leads que requieren una colaboración segura y guiada (Human-in-the-Loop) con modelos de lenguaje.

![Version](https://img.shields.io/badge/version-v7.8.2-blue)
![Architecture](https://img.shields.io/badge/architecture-Router--Worker_Swarm-orange)
![Status](https://img.shields.io/badge/status-Active_Development-success)
![License](https://img.shields.io/badge/license-MIT-green)

---

## ✨ Filosofía Core: "Human-in-the-Loop"

Los LLMs actuales son brillantes creando código desde cero, pero deficientes haciendo cirugías a ciegas en bases de código complejas. Fluxo AI resuelve esto actuando como un "Pair Programmer" disciplinado: **La IA propone, el Arquitecto dispone.**

---

## 🚀 Características Principales (Motor v7.8.2)

| Característica | Descripción |
|---|---|
| 🛑 **Hard Brake & Manager Mediation** | El agente JAMÁS edita tu código sin un plan. Ante prompts ambiguos, se detiene, genera un `IMPLEMENTATION_PLAN.md` y requiere tu aprobación explícita. |
| 👁️ **Native Visual Diffing** | Usa la API nativa de VS Code (`WorkspaceEdit`) para inyectar cambios via `search_and_replace`. El archivo queda "sucio" (`●`) para tu revisión antes de guardar. |
| 🛡️ **Sherlock Auditor & AST-Guard** | Doble capa de seguridad: bloquea llaves desequilibradas, re-declaraciones redundantes y Ghost Loops en tiempo real antes de escribir al disco. |
| 🧠 **Multi-Model Swarm** | Compatible con **Gemini 2.5 Flash/Pro (AI Studio)**, **Claude 3.5/3.7 (OpenRouter)**, **GPT-4o (OpenRouter)** y **DeepSeek (Direct/OpenRouter)**. |
| 🔗 **The Contextual Grip (v7.8.2)** | Reglas de agente estrictas: prohíbe props huérfanos, importaciones olvidadas y URLs hardcodeadas (`yourwebsite.com`). |
| 🧭 **Manager Mediation Protocol** | Si el agente intenta cerrar una tarea con un `IMPLEMENTATION_PLAN.md` activo, el motor inyecta un override automático de verificación de pasos. |
| 📋 **Fuzzy Search & Replace** | Tolerancia a diferencias de indentación/espacios al buscar bloques de código. El LLM no necesita copiar con precisión quirúrgica. |
| 🟢 **Sentinel Auto-Heal** | Monitorea el terminal en tiempo real. Si detecta un error de compilación, intercepta y dirige al `@manager` automáticamente. |

---

## ✅ / ❌ Manifiesto de Capacidades Reales

### Lo que Fluxo AI PUEDE hacer:
- **Orquestación de Planes:** Generar un `IMPLEMENTATION_PLAN.md` estructurado antes de tocar código.
- **Auto-Regulación (Hard Brake):** Pausar ejecución para esperar aprobación humana explícita.
- **Prevención de Desastres:** Detectar llaves desequilibradas, code rot y bucles infinitos.
- **Edición Visual:** Visual Diff nativo — el archivo queda abierto y sin guardar para que tú decidas.
- **Creación desde Cero:** Generar componentes, lógicas y archivos nuevos con alta precisión.

### Lo que Fluxo AI NO PUEDE hacer (todavía):
- **Refactorización Ciega Masiva:** Por eso `replace_lines` y `replace_block` están deprecadas para el Coder — el Visual Diff es el paso de seguridad obligatorio.
- **Telepatía de Lógica de Negocio:** Sin contexto explícito, puede inventar rutas o datos (`undefined`, `yourwebsite.com`).
- **Autonomía 100% sin fricción:** No puede (ni debe) modificar el estado de la app sin que un humano revise el diff en cada paso crítico.

---

## 🛠️ Arquitectura Interna

```
src/
├── agentEngine.ts   — Motor cognitivo: loop de iteraciones, Hard Brake, Error Anchoring, Plan Verification
├── agents.ts        — Personalidades del swarm + MANDATORY LOGIC RULES + Sherlock Auditor prompt
├── extension.ts     — Bridge VS Code: applyNativeEdit, panel serializer, model persistence
├── sentinel.ts      — Monitor de terminal en tiempo real
└── tools/
    ├── SearchReplaceTool/   — Fuzzy search_and_replace (herramienta primaria de edición)
    ├── FileReadTool/
    ├── FileWriteTool/
    ├── ReplaceLinesTool/    — Legado (Manager únicamente)
    ├── ReplaceBlockTool/    — Legado (Manager únicamente)
    ├── ProposePlanTool/
    ├── RunCommandTool/
    └── ...

media/
├── main.js          — WebView UI: tool activity cards, Visual Diff renderer, Model Labels
└── style.css        — Glassmorphism design system
```

---

## 💡 Flujo de Trabajo Ideal

```
1. Describe tu feature en el chat → El agente genera IMPLEMENTATION_PLAN.md
2. Revisa y edita el plan en tu editor
3. Aprueba el plan en la UI (o escribe cambios)
4. El agente aplica cambios vía search_and_replace → archivo queda ● (sin guardar)
5. Revisa el Visual Diff en VS Code → Ctrl+S para consolidar, o da feedback para iterar
```

---

## 🚀 Instalación Rápida

```bash
# 1. Build
cd cnos-extension
npm install && npm run compile && npm run package

# 2. Install
code --install-extension fluxo-ai-7.8.2.vsix --force

# 3. Configura tu API Key
# VS Code Settings → busca "Fluxo AI" → pega tu OpenRouter/Gemini/DeepSeek key
```

Ver [INSTALL.md](cnos-extension/INSTALL.md) para guía completa.

---

## 🤝 Agentes del Swarm

| Agente | Emoji | Especialidad |
|---|---|---|
| `coder` | 💻 | Código, bugs, archivos, comandos — usa `search_and_replace` exclusivamente |
| `designer` | 🎨 | UI/UX, Tailwind, glassmorphism, layouts |
| `dashboard` | 📊 | Charts, analytics, KPIs, data viz |
| `payments` | 💳 | Stripe, PayPal, Mercado Pago, webhooks |
| `manager` | 🧭 | Orquestación compleja, emergencias, Sentinel alerts |

---

## 📁 Documentación

| Archivo | Descripción |
|---|---|
| [INSTALL.md](cnos-extension/INSTALL.md) | Guía completa de instalación y configuración |
| [CNOS_MANIFESTO.md](cnos-extension/CNOS_MANIFESTO.md) | Constitución del sistema — reglas vinculantes para agentes |
| [ARCHIVE_v2_CONTEXT.md](cnos-extension/ARCHIVE_v2_CONTEXT.md) | Blueprint técnico para orquestación LLM externa |
| [Fase 8.MD](cnos-extension/Fase%208.MD) | Arquitectura del Native Diff & Search-Replace system |

---

*Construido para domar el caos de la IA generativa.*
*Built by **Denayssam** & Fluxo Tech AI · [fluxotechai.com](https://fluxotechai.com)*
