---
name: designer-workflow
description: >-
  Aplica el sistema de diseño oficial de Fluxo AI al crear o refactorizar
  componentes de UI. Úsalo siempre que generes, modifiques o revises interfaces
  React/Tailwind (paneles, tarjetas, botones, modales, dashboards): garantiza
  Glassmorphism, layout mobile-first e iconos exclusivamente de lucide-react.
---

# Designer Workflow — Sistema de Diseño Oficial de Fluxo AI

Este skill codifica la sección "UI/UX — Sistema de Diseño Oficial" de
[CNOS_MANIFESTO.md](../../../CNOS_MANIFESTO.md). Es **vinculante**: aplícalo
automáticamente, sin esperar a que el usuario lo pida, en cualquier trabajo de UI.

## Reglas inquebrantables

### 1. Glassmorphism con TailwindCSS — SIEMPRE
Todo contenedor visual (tarjetas, paneles, modales, barras) usa la estética glassmorphism:

```
bg-white/10 backdrop-blur-md border border-white/20 rounded-2xl shadow-xl
```

- No inventes otra estética. No uses CSS plano ni otras librerías de estilos salvo
  petición explícita del usuario.
- Bordes redondeados generosos (`rounded-2xl`) y profundidad con `shadow-xl`.

### 2. Mobile-first — SIEMPRE
Diseña primero para móvil y escala hacia arriba. Los breakpoints fluyen en este orden:

```
sm: → md: → lg: → xl:
```

- Las clases base (sin prefijo) son el estado móvil. **Nunca** diseñes desktop-first.
- Ejemplo: `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`.

### 3. Iconos SOLO de lucide-react — EXCLUSIVO
- Importa íconos únicamente desde `lucide-react`.
- PROHIBIDO: `@heroicons`, `react-icons`, FontAwesome o cualquier otra librería de
  iconos — salvo que el usuario lo pida explícitamente.
- Importa solo los que uses: `import { Sparkles, X } from 'lucide-react';`

### Bonus — Performance
Envuelve componentes pesados / rutas / dashboards en `React.lazy` + `Suspense`, con
fallback glassmorphism: `<div className="animate-pulse bg-white/10 rounded-xl h-40" />`.

## Checklist antes de entregar un componente
- [ ] Contenedores con glassmorphism (`bg-white/10 backdrop-blur-md border border-white/20 rounded-2xl`).
- [ ] Layout mobile-first (clases base = móvil; `sm:`/`md:`/`lg:` escalan).
- [ ] Todos los iconos provienen de `lucide-react`.
- [ ] Componentes pesados envueltos en `React.lazy` + `Suspense`.

## Ejemplo de componente estándar de Fluxo

```tsx
import { Sparkles } from 'lucide-react';

interface FeatureCardProps {
  title: string;
  description: string;
}

export function FeatureCard({ title, description }: FeatureCardProps) {
  return (
    <article
      className="
        bg-white/10 backdrop-blur-md border border-white/20
        rounded-2xl shadow-xl
        p-4 sm:p-6
        flex flex-col gap-3
        w-full max-w-sm sm:max-w-md lg:max-w-lg
        transition hover:bg-white/15
      "
    >
      <div className="flex items-center gap-2">
        <Sparkles className="w-5 h-5 text-white/80" aria-hidden="true" />
        <h3 className="text-base sm:text-lg font-semibold text-white">{title}</h3>
      </div>
      <p className="text-sm sm:text-base text-white/70">{description}</p>
    </article>
  );
}
```

Cumple las tres reglas: glassmorphism en el contenedor, escalado mobile-first
(`p-4 sm:p-6`, `text-base sm:text-lg`, `max-w-sm sm:max-w-md lg:max-w-lg`) e icono
exclusivamente de `lucide-react`.
