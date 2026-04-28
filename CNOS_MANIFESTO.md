# CNOS AI — Constitución del Sistema
**Versión 7.9.11 · Documento Vinculante**

Este archivo es la fuente de autoridad para todos los agentes de CNOS AI. Cuando un agente tenga dudas sobre cómo editar, qué estilo de UI aplicar, o qué constituye una entrega válida, **debe leer este documento antes de actuar**.

---

## I. FILOSOFÍA DE EDICIÓN

**Principio fundacional**: Un agente que reescribe un archivo completo desde la memoria de entrenamiento es un agente que alucina. CNOS AI opera con bisturí, no con motosierra.

### Reglas Absolutas

| Situación | Herramienta obligatoria | Herramienta prohibida |
|-----------|------------------------|-----------------------|
| Modificar un archivo existente | `search_and_replace` | `write_file`, `replace_lines` |
| Crear un archivo nuevo | `write_file` | — |
| Localizar un bloque en archivo largo | `search_in_files` primero | `read_file` sin búsqueda previa |

### Flujo de Edición Canónico

```
1. search_in_files    →  localizar la función/bloque exacto
2. read_file          →  obtener el contenido actual del bloque a modificar
3. search_and_replace →  copiar el bloque exacto como search_snippet (2–3 líneas de contexto)
                          definir replace_snippet con el nuevo contenido
                          ⚡ El archivo se guarda automáticamente tras cada edición exitosa
                          🔍 El Chat muestra un Diff rojo/verde de los cambios aplicados
```

**Por qué `search_and_replace` y no `write_file`**: `write_file` en un archivo existente fuerza al modelo a regenerar el archivo completo desde memoria de entrenamiento — con alta probabilidad de importar paquetes equivocados, omitir funciones existentes, o introducir bugs que no existían. `search_and_replace` opera exclusivamente sobre el bloque que el agente acaba de leer, con fuzzy-matching para tolerancia de indentación, backup automático en `.fluxo/backups/`, y visualización inmediata del diff al usuario.

---

## II. PROTOCOLO DE SEGURIDAD

### Sherlock Auditor

El **Sherlock Auditor** es una capa de validación LLM independiente que se ejecuta después de cada respuesta del agente, antes de que se ejecuten las herramientas. Verifica 9 reglas:

| # | Regla | Acción si detecta |
|---|-------|-------------------|
| 1 | **ROGUE DESIGNER** — Crear componentes UI no solicitados | `ERROR:` + bloqueo |
| 2 | **SANDBOX HALLUCINATION** — Afirmar que no puede ejecutar comandos | `ERROR:` + bloqueo |
| 3 | **GHOST EXECUTION (intención)** — Narrar éxito sin llamar la herramienta | `ERROR:` + bloqueo |
| 4 | **LOOPING** — Repetir el mismo tool call con los mismos args | `ERROR:` + escalación al Manager |
| 5 | **SILOED CHANGES** — Modificar sin buscar usages | `ERROR:` + bloqueo |
| 6 | **TECH STACK DRIFT** — Importar paquetes que no existen en el codebase | `ERROR:` + bloqueo |
| 7 | **WRITE_FILE FALLBACK** — Usar `write_file` en archivo existente (la herramienta correcta es `search_and_replace`) | `ERROR:` + bloqueo |
| 8 | **GHOST EXECUTION (narración)** — Frases "I will now", "Let me run" sin tool call real | `ERROR:` + retry forzado |
| 9 | **SENTINEL_BLOCK / BUILD_BLOCK** — Intentar cerrar tarea con build roto | `ERROR:` + bloqueo con output del compilador |

### Sentinel — Vigilante de Terminal en Tiempo Real

El **Sentinel** monitorea el output del terminal del desarrollador usando `vscode.window.onDidWriteTerminalData`. Cuando detecta un error de compilación:

1. Aplica un buffer rotativo de 4 KB con limpieza ANSI.
2. Compara contra 15 patrones regex (TypeScript, Vite, OXC, SyntaxError, etc.).
3. Espera 2 segundos de silencio (debounce) antes de disparar.
4. Activa un cooldown de 30 segundos para evitar bucles de re-trigger.
5. Envía la alerta al **Manager** con prefijo `@manager` para routing forzado.

**Patrones activos**:
- `error TS\d+:` — TypeScript compiler
- `failed to compile` / `failed to resolve import`
- `[vite] error` — HMR runtime
- `[plugin:vite:oxc]` — Parser OXC (Vite 6+)
- `\bparse_error\b` — OXC / SWC / esbuild
- `\bSyntaxError\b`, `\bReferenceError\b`, `\bTypeError\b`
- `build failed` / `compilation failed`
- `npm err!`, `✗.*\berror\b`

### Bloqueo Físico ante Build Roto

Cuando `SENTINEL_HAS_ERROR: true` o `BUILD_FAILED: true` está activo en el contexto:
- El agente **no puede emitir un Execution Report** (Sherlock Rule #9 lo rechaza).
- **Excepción**: Si el agente está activamente llamando `read_file`, `replace_lines`, o `run_command`, el bloqueo no se activa — el agente está trabajando en la solución.
- El agente sale del bloqueo únicamente cuando el build termina con exit code 0.

---

## III. ESTÁNDARES SOP DE WEB

Estos estándares se aplican **automáticamente** en cada proyecto web. No esperar a que el usuario los solicite.

### 1. LLMO & SEO
- Crear o verificar `/llms.txt` en la raíz del proyecto (índice para crawlers de IA).
- Cada ruta HTML o React debe incluir:
  - `<script type="application/ld+json">` con Schema Markup (LocalBusiness, WebSite, etc.)
  - Tags OpenGraph: `og:title`, `og:description`, `og:image`, `og:url`
  - `<meta name="description">` con descripción keyword-rich

### 2. Performance — Lazy Loading
```tsx
// OBLIGATORIO para componentes pesados, rutas, dashboards, mapas, gráficas
const HeavyPage = React.lazy(() => import('./HeavyPage'));

<Suspense fallback={<div className="animate-pulse bg-white/10 rounded-xl h-40" />}>
  <HeavyPage />
</Suspense>
```

### 3. UI/UX — Mobile-First + Design System

**Breakpoints**: Siempre `sm:` → `md:` → `lg:` → `xl:`. Nunca diseñar desktop-first.

**Estética Glassmorphism** (sistema de diseño oficial):
```css
/* Card estándar */
bg-white/10 backdrop-blur-md border border-white/20 rounded-2xl shadow-xl

/* Botón primario */
bg-gradient-to-r from-blue-500 to-purple-600 text-white rounded-xl px-6 py-3

/* Input */
bg-white/5 border border-white/20 rounded-xl text-white placeholder-white/50
```

**Librería de iconos**: `lucide-react` **exclusivamente**.
```tsx
// ✅ Correcto
import { Home, User, Settings } from 'lucide-react';

// ❌ Prohibido
import { HomeIcon } from '@heroicons/react/24/outline';
import { FaHome } from 'react-icons/fa';
```

---

## IV. FIRMA DE CALIDAD — BUILD VERIFICATION

### Cuándo es obligatorio ejecutar `npm run build`

Un cambio es **estructural** si incluye cualquiera de:
- Archivos nuevos o eliminados
- Cambios en imports o exports
- Modificación de tipos TypeScript, interfaces, o firmas de función
- Cambios en routing, entry points, o archivos de configuración (`vite.config`, `tsconfig`, `package.json`)

### Protocolo

```
1. Completar todos los edits (replace_lines / write_file)
2. run_command → "npm run build"
   ├─ Exit code 0  → ✅ Build limpio → Execution Report permitido
   └─ Exit code ≠ 0 → ❌ Build roto  → FORBIDDEN emitir Execution Report
                        Leer output del compilador
                        Identificar archivo + línea exacta de cada error
                        Corregir con read_file → replace_lines
                        Volver al paso 2
```

**El Execution Report es el certificado de entrega. No se extiende con el build roto.**

---

## V. SEPARATION PROTOCOL — Estructura de Respuesta

Cada respuesta del agente sigue esta estructura obligatoria:

```
<reasoning>
  [Todo el razonamiento interno, plan, debugging — invisible para el usuario]
</reasoning>

[Una línea de estado opcional si se está esperando resultado de herramienta]

<tool_call>{"name": "...", "args": {...}}</tool_call>
          — O —
✅ Tarea completada. Resumen de cambios:
- **path/to/file.ext**: Reemplazadas líneas N–M. _(Propósito: razón técnica concisa)_
```

**Regla absoluta**: Si la respuesta contiene un `<tool_call>`, ese tag debe ser el **último contenido** del mensaje. Nada después.

---

## VI. SISTEMA `.fluxo/` — Memoria y Telemetría

Fluxo AI mantiene una carpeta oculta `.fluxo/` en la raíz de cada workspace. Es la capa de persistencia del enjambre.

| Archivo / Carpeta | Propósito | Quién escribe |
|---|---|---|
| `.fluxo/memory.md` | Reglas, convenciones y decisiones arquitectónicas del proyecto | Manager (`update_memory`) |
| `.fluxo/improvements.md` | Bitácora de fricción y telemetría del enjambre | Motor (automático en cada fallo de herramienta) |
| `.fluxo/backups/` | Backup automático de cada archivo editado con `search_and_replace` (máx. 30 archivos, rotación automática) | Motor (automático) |

### Inyección de Memoria

El contenido de `.fluxo/memory.md` se inyecta **automáticamente** al inicio de cada sesión en el `systemPrompt` de **todos** los agentes, bajo el encabezado `--- WORKSPACE MEMORY & RULES ---`. Las reglas ahí escritas son vinculantes sin que el usuario tenga que repetirlas.

### Herramientas Exclusivas del Manager

| Herramienta | Acción |
|---|---|
| `update_memory` | Crea o sobreescribe `.fluxo/memory.md` (merge manual antes de escribir) |
| _(motor automático)_ | El engine registra cada `success: false` en `.fluxo/improvements.md` sin intervención del agente |

---

## VII. AGENTES DEL ENJAMBRE — Referencia Rápida

| Agente | Herramientas exclusivas | Rol |
|---|---|---|
| **Coder** 💻 | `search_and_replace`, `propose_plan`, `ask_user_approval` | Edición de código, bugs, features |
| **Designer** 🎨 | `search_images` | UI/UX, CSS, layouts |
| **Dashboard** 📊 | — | Gráficas, analytics, KPIs |
| **Payments** 💳 | — | Stripe, PayPal, pasarelas |
| **Manager** 🧭 | `update_memory`, `search_and_replace`, `propose_plan`, `ask_user_approval` | Orquestación, debugging, telemetría |

El **Router** (Gemini Flash) analiza cada mensaje y selecciona el agente. Las `@menciones` explícitas anulan el routing automático.

---

*CNOS AI · Construido con disciplina de ingeniería · Prohibida la aleatoriedad*
