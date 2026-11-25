# Hoja de Ruta (`my-herdr`)

Única lista viva de trabajo pendiente, decisiones abiertas y deuda técnica. Al completar cualquier elemento, debe eliminarse de este archivo en el mismo commit.

---

## Decisiones Abiertas

- Ninguna bloqueante actualmente.

## Backlog

- **Limpieza de archivos temporales huérfanos en `data/fv-preview/`:** añadir en `system-monitor.runAutoCleanup()` una purga periódica (`find ~/.config/herdr-app/data/fv-preview -type f -mmin +30 -delete`) para recoger archivos temporales que queden tras un cierre abrupto de `herdr-app`.
- **Sincronización automática de `scripts/build-icons.js` desde VS Code:** extender `build-icons.js` para aceptar un argumento opcional `--from-vscode <ruta-material-icons.json>` que regenere `micons/` y `material-icons.js` directamente al actualizar la extensión `pkief.material-icon-theme`.
- **Resaltado de sintaxis mejorado en modo edición:** evaluar soporte de `Ctrl+Z` / `Ctrl+Shift+Z` explícito o indicador de línea/columna del cursor en `file-viewer`.

## Deuda Técnica

- `mods/file-viewer/main.js` supera las 1.800 líneas al concentrar lógica de CSV (autocompletado, filtros por columna, edición) junto al visor general; conviene extraer la lógica de estado/renderizado CSV a `mods/file-viewer/csv-view.js`.
- `examples/` se mantiene localmente sin trackear para pruebas manuales; conviene añadir `examples/` a `.gitignore` si se desea conservar permanentemente en local sin riesgo de inclusión accidental en `git add`.
