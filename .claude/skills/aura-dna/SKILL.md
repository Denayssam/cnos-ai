---
name: aura-dna
description: >-
  El ADN de Aura: las filosofías centrales de Producto/UX e Ingeniería que rigen
  todo Fluxo AI. Cárgalo y aplícalo de forma persistente antes de diseñar flujos,
  escribir o refactorizar código — Libertad por Defecto, Fricción Cero, Hábitos
  Atómicos, Revelación Progresiva (Producto/UX) y Estado Dorado, Air Gap, Cero
  Duplicación, Cohesión Sistémica (Ingeniería).
---

# 🧬 El ADN de Aura — Filosofías Centrales de Fluxo AI

Reglas **inmutables** que definen cómo se *siente* el producto y cómo se *construye*
el código. No son sugerencias: son el ADN. Aplícalas sin esperar a que te lo pidan.

---

## 🧠 Producto y UX (cómo se siente Aura)

### 1. Libertad por Defecto — "Freedom First" (Excel Killer)
- **La IA sugiere, nunca impone.** El usuario tiene siempre la autoridad final;
  actúas como facilitador/conserje, jamás como un dictador que bloquea acciones.
- **Brújula, no jaula.** Nada de "hard caps" que impidan registrar la realidad.
  Si el usuario excede el presupuesto, **muéstralo** visualmente — nunca bloquees
  la transacción. El Ledger (libro mayor) es la verdad absoluta.

### 2. Fricción Cero — Regla de los "< 2 clics"
- Toda acción clave (registrar un gasto, completar un hábito, ajustar un
  presupuesto) debe lograrse en **menos de 2 clics**.
- **Visual Cues primero.** El cerebro lee posición y color antes que texto:
  prioriza tarjetas flotantes, edición en línea (inline edit) y botones
  contextuales. Evita modales burocráticos y formularios pesados.

### 3. Hábitos Atómicos — "Atomic Habits"
- **Accesible, no obligatorio.** El progreso es progreso mientras apunte al
  objetivo. Premia la consistencia y la creación de riqueza; nunca castigues las
  caídas.
- **Dopamina retroactiva (gamificación positiva).** Recompensa el esfuerzo real
  (niveles, rachas, ahorro visualizado) de forma orgánica y **anclada 100 % en
  datos reales** — jamás números inventados.

### 4. Revelación Progresiva — "Progressive Disclosure"
- No abrumes. Las acciones destructivas y la configuración avanzada se esconden
  tras zonas de toque secundarias.
- El **estado de reposo** (resting state) de la interfaz es siempre minimalista,
  limpio y libre de ruido visual.

---

## 🏗️ Ingeniería y Arquitectura (leyes inmutables)

### 1. Proteger el Estado Dorado — "Protect the Golden State"
- El último despliegue funcional de la rama principal es **sagrado**: no se
  compromete con hacks rápidos.
- Todo cambio debe ser **atómico, reversible y acotado** al problema. No
  refactorices código que ya funciona (Conservation of Code).

### 2. Air Gap — Separación de Responsabilidades
- El frontend es **"Dumb UI"**: se limita a renderizar el estado.
- Toda lógica de negocio, matemática, cálculos o mutaciones de datos vive
  **exclusivamente** en la capa de dominio (servicios, hooks dedicados, Cloud
  Functions).

### 3. Cero Duplicación — Ingeniería Pragmática
- **No dupliques herramientas.** Si ya existe un componente/servicio que cumple la
  función, **reutilízalo**. Nunca clones código para un flujo nuevo.
- **Eficiencia radical.** Prohibido añadir librerías pesadas (WYSIWYG, gráficos
  extra) si las APIs nativas del navegador, CSS o Tailwind ya bastan.

### 4. Cohesión Sistémica — "Systemic Cohesion"
- **Contratos estrictos + Ubiquitous Language.** Frontend y backend hablan el
  mismo idioma (esquemas TypeScript rígidos). Eleva términos genéricos a conceptos
  de negocio claros ("The Vault", "Wealth Engines").
- **Diseño tokenizado.** Todo color, sombra, borde o radio deriva de variables CSS
  semánticas (`bg-card`, `shadow-neo`) — la app debe ser agnóstica al tema.

---

## ✅ Auto-chequeo obligatorio (ANTES de escribir código)

Antes de escribir o refactorizar **cualquier** línea de código, valida mentalmente
que tu solución respeta este ADN:

- [ ] **¿Libera o restringe?** ¿Sugiero sin bloquear al usuario?
- [ ] **¿< 2 clics?** ¿El flujo es de fricción mínima y visual?
- [ ] **¿Premia sin castigar?** ¿La gamificación se ancla en datos reales?
- [ ] **¿Revelación progresiva?** ¿El estado de reposo queda limpio?
- [ ] **¿Protejo el Estado Dorado?** ¿El cambio es atómico, reversible y acotado?
- [ ] **¿Respeto el Air Gap?** ¿La lógica vive en el dominio, no en la UI?
- [ ] **¿Cero duplicación?** ¿Reutilizo en vez de clonar? ¿Evito librerías pesadas?
- [ ] **¿Cohesión sistémica?** ¿Contratos TS rígidos y design tokens semánticos?

Si una sola casilla falla, **rediseña antes de escribir**. El ADN no se negocia.
