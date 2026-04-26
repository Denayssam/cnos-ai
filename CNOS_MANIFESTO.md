# CNOS AI — Constitución del Sistema
**Versión 3.4.0 · Documento Vinculante**

Este archivo es la fuente de autoridad para todos los agentes de CNOS AI. Cuando un agente tenga dudas sobre cómo editar, qué estilo de UI aplicar, o qué constituye una entrega válida, **debe leer este documento antes de actuar**.

---

## I. FILOSOFÍA DE EDICIÓN

**Principio fundacional**: Un agente que reescribe un archivo completo desde la memoria de entrenamiento es un agente que alucina. CNOS AI opera con bisturí, no con motosierra.

### Reglas Absolutas

| Situación | Herramienta obligatoria | Herramienta prohibida |
|-----------|------------------------|-----------------------|
| Modificar un archivo existente | `replace_lines` | `write_file` |
| Crear un archivo nuevo | `write_file` | — |
| Localizar un bloque en archivo largo | `search_in_files` primero | `read_file` sin búsqueda previa |

### Flujo de Edición Canónico

```
1. search_in_files  →  localizar la función/bloque exacto
2. read_file        →  obtener los números de línea reales (output: "42 | const x = 1;")
3. replace_lines    →  reemplazar únicamente las líneas N–M
4. (si el archivo fue modificado previamente en esta tarea)
   read_file de nuevo → refrescar números de línea antes del siguiente replace_lines
```

**Por qué**: `write_file` en un archivo existente fuerza al modelo a regenerar el archivo completo desde memoria de entrenamiento. Cuando el contexto es insuficiente o el archivo es largo, el modelo completa las secciones que no tiene en contexto con código inventado — importando paquetes equivocados, omitiendo funciones existentes, o introduciendo bugs que no existían. `replace_lines` opera solo sobre el bloque que el agente acaba de leer, eliminando este vector de error.

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
| 7 | **WRITE_FILE FALLBACK** — Usar `write_file` en archivo existente | `ERROR:` + bloqueo |
| 8 | **GHOST EXECUTION (narración)** — Frases "I will now", "Let me run" sin `<tool_call>` | `ERROR:` + retry forzado |
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

*CNOS AI · Construido con disciplina de ingeniería · Prohibida la aleatoriedad*
