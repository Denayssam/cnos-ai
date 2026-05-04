git add .github/workflows/release.yml
git commit -m "fix: grant write permissions for gh release"
git push origin main

git push --delete origin v8.16.1
git tag -d v8.16.1

git tag v8.16.1
git push origin v8.16.1
Si prefieres la terminal en lugar de hacer clics, puedes usar: git reset --hard HEAD~N (donde N es la cantidad de commits de fluxo-auto-checkpoint que quieres retroceder)
git reset --hard HEAD~N
---

# 🛠️ Cheat-sheet: comandos que uso al desarrollar Fluxo AI

Todo se ejecuta desde la raíz del proyecto:
`d:\CNOS_Mirror\03_EXPERIMENTAL\cnos-extension`

## 1. Compilar TypeScript

Convierte `src/*.ts` en `out/*.js`. Es el paso obligatorio antes de empacar o probar.

```bash
npm run compile
```

Modo continuo (recompila al guardar — útil cuando estás iterando código):

```bash
npm run watch
```

Si compile falla, lee los errores `TSxxxx` y corrige; nunca empaques con errores de compilación.

## 2. Empacar el VSIX

Genera el archivo instalable `fluxo-ai-X.Y.Z.vsix`:

```bash
npx vsce package
```

Para regenerar limpio borra antes el VSIX viejo (sintaxis bash de Git Bash / VS Code terminal):

```bash
rm -f fluxo-ai-*.vsix && npx vsce package
```

En PowerShell:

```powershell
Remove-Item fluxo-ai-*.vsix -Force; npx vsce package
```

## 3. Instalar el VSIX en VS Code

### Opción A — Desde tu máquina local (más rápido)

El VSIX se genera en la raíz del proyecto. Instálalo así:

- **GUI:** `Ctrl+Shift+P` → *Extensions: Install from VSIX…* → selecciona `fluxo-ai-8.16.11.vsix`
- **Terminal:**
  ```bash
  code --install-extension fluxo-ai-8.16.11.vsix
  ```
  (reemplaza el número de versión por el que acabas de empacar)

### Opción B — Descargar desde GitHub Releases (el día que el VSIX local no exista)

Cuando se hace `git push origin vX.Y.Z`, el workflow de GitHub Actions compila
y publica el VSIX automáticamente como un GitHub Release con el archivo como Asset.

1. Ve a `https://github.com/Denayssam/cnos-ai/releases`
2. Encuentra el release `vX.Y.Z`
3. Descarga `fluxo-ai-X.Y.Z.vsix` desde la sección **Assets**
4. Instala con `Ctrl+Shift+P → Extensions: Install from VSIX…`

> Si el release no aparece todavía, el workflow puede tardar 1–2 minutos.
> Ve a `https://github.com/Denayssam/cnos-ai/actions` para ver el progreso.

## 4. Bumpear versión

Edita manualmente `package.json` línea `"version": "X.Y.Z"`.
Convención que venimos usando:

* **patch** (último número) — bug fix o ajuste pequeño: `8.16.7 → 8.16.8`
* **minor** (medio) — feature nueva o herramienta nueva: `8.16.x → 8.17.0`
* **major** (primero) — cambio arquitectónico grande: `8.x → 9.0.0`

Después del bump, **siempre** actualiza `CHANGELOG.md` con una entrada nueva al tope siguiendo el formato `## [vX.Y.Z] - Título` + `**Objetivo:**` + bullets.

## 5. Commit + push a main

```bash
git status --short
git add <archivos específicos>
git commit -m "feat(vX.Y.Z): descripción corta"
git push origin main
```

Evita `git add .` o `git add -A` — pueden colar binarios o archivos contextuales (notebooklm_*.md, gitcommands.md). Mejor stage explícito:

```bash
git add CHANGELOG.md package.json src/agents.ts out/agents.js out/agents.js.map src/tools/...
```

> **Nota:** `out/` está en `.gitignore` pero los archivos compilados ya están trackeados desde el historial legacy.
> Usa `git add -f out/agents.js out/agents.js.map` si git rechaza el add sin `-f`.

## 6. Tag + release automático (GitHub Actions)

El workflow en `.github/workflows/release.yml` se dispara con cualquier tag `v*` y publica el VSIX como GitHub Release automáticamente.

```bash
git tag v8.16.11
git push origin v8.16.11
```

Verificar el release una vez que GitHub Actions termina:

* Ve a `https://github.com/Denayssam/cnos-ai/actions` para ver el progreso del build.
* Ve a `https://github.com/Denayssam/cnos-ai/releases` para descargar el VSIX publicado.

## 7. Borrar y rehacer un tag (si te equivocaste)

```bash
git push --delete origin v8.16.11
git tag -d v8.16.11

git tag v8.16.11
git push origin v8.16.11
```

## 8. Flujo completo end-to-end

Esta es la secuencia exacta que ejecuto cuando termino una versión:

```bash
# 1. Verificar que compila limpio
npm run compile

# 2. Empacar el VSIX
rm -f fluxo-ai-*.vsix && npx vsce package

# 3. Stage explícito + commit
git add CHANGELOG.md package.json src/agents.ts src/tools/...
git add -f out/agents.js out/agents.js.map
git commit -m "feat(v8.16.11): descripción"

# 4. Push a main
git push origin main

# 5. Tag + push del tag (dispara el release)
git tag v8.16.11
git push origin v8.16.11

# 6. Instalar el VSIX local para probar
code --install-extension fluxo-ai-8.16.11.vsix
```

## 9. Inspeccionar estado y diff

```bash
git status --short            # qué archivos cambiaron
git diff                      # ver diff sin stagear
git diff --staged             # ver diff de lo ya stageado
git log --oneline -10         # últimos 10 commits
git show HEAD                 # último commit completo
git show --stat HEAD          # último commit con resumen de archivos
```

## 10. Recuperación / rollback

Si algo se rompe en main y necesitas volver al commit anterior **sin perder el código actual**:

```bash
git revert HEAD               # crea un commit que deshace el último — seguro
```

Si necesitas borrar cambios sin commitear (¡destructivo!):

```bash
git restore <archivo>         # descarta cambios de un archivo
git stash                     # guarda los cambios para después
git stash pop                 # los restaura
```

`git reset --hard HEAD~1` — **NO usar** salvo emergencia. Borra el último commit y todos los cambios. Si lo usas, asegúrate de que no hay trabajo sin pushear.

## 11. Ver qué hay en el VSIX antes de publicar

```bash
npx vsce ls --tree
```

Si ves archivos sensibles (`.env`, `credentials.json`, `notebooklm_*`), añádelos a `.vscodeignore` antes de empacar.

## 12. Limpieza ocasional

```bash
rm -rf out                    # borra el directorio compilado
npm run compile               # recompila desde cero
```

Útil cuando TypeScript se queda con artefactos viejos y los tipos parecen romperse sin razón.

---

## Notas rápidas

* `notebooklm_context_part*.md` y `gitcommands.md` están en `.gitignore` o los ignoramos manualmente — nunca van al repo.
* `out/` está en `.gitignore` pero los archivos compilados ya están trackeados desde antes (legacy). Cuando hagas `git add` específico, está bien incluirlos para mantener consistencia con el historial.
* El VSIX final pesa ~7.8 MB. Si crece mucho, revisa `.vscodeignore`.
* Los releases de GitHub Actions tardan 1–2 minutos. Si no aparecen, revisa que el workflow tenga permisos `contents: write`.
