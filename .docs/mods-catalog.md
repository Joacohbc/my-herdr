# Catálogo de Mods y Scripts (`my-herdr`)

Inventario empírico de todos los módulos y utilidades presentes en el repositorio.

---

## 1. Mods Personalizados (`mods/`)

### 1.1 `files-search` (`mods/files-search/`)
Explorador de archivos perezoso con buscador estilo VS Code e iconos oficiales de Material Icon Theme.

- **Archivos:** `main.js`, `search.js`, `material-icons.js`, `micons/*.svg`, `chevron-*.svg`, `file.svg`, `folder.svg`, `mod.json`.
- **Búsqueda (`search.js`):**
  - Modos `Text` (contenido) y `Files` (rutas), debounce `180 ms`, secuencia monotónica `searchSeq`, timeout `8 s`, tope `300` coincidencias / `200` archivos.
  - Selección automática de backend en local y SSH: `rg` → `git grep --untracked` → `grep -rnI` (contenido) y `fd` → `git ls-files` → `find -prune` (archivos).
  - Toggles: `Aa` (Match Case), `ab` (Whole Word), `.*` (Regex) y `⋯` (Include, Exclude extra y exclusiones por defecto activadas).
  - La consulta se pasa siempre como argumento posicional (`"$1"`) con `--`.
- **Interacciones:**
  - Clic normal: abre en `file-viewer` dentro de la pestaña actual (reutiliza visor existente o hace split a la derecha).
  - `Ctrl + clic`: abre en nueva pestaña dedicada (`solo: true`).
  - `Shift + clic`: abre un split adicional de `file-viewer`.
  - **Clic derecho:** abre menú contextual popup (`Copy Relative Path`, `Copy Absolute Path`, `Copy Name`, `Open in New Tab`) usando `cx.write_to_clipboard()`.
- **Límites de RAM:** `PER_FOLDER = 250`, `TOTAL = 1500`, `MAX_OPEN_FOLDERS = 24` (LRU), `MAX_SAVED_CONTEXTS = 8` (máx. 10 carpetas), `MAX_SCANS = 4`, evicción automática tras `30 s` oculto o señal `herdr.gc`.

### 1.2 `file-viewer` (`mods/file-viewer/`)
Visor y editor multi-formato con hibernación automática y zoom interactivo (`Ctrl + rueda`, pinch y botones en `pane-custom`).

- **Archivos:** `main.js`, `preview.js`, `mod.json` (`"focusable": true`).
- **Formatos soportados:**
  - **Markdown (`.md`, `.markdown`, `.mdx`):** `TextView.markdown` seleccionable y scrolleable con resaltado `.highlight_range(...)` + toggle `Preview` / `Raw` editable.
  - **Imágenes y SVG (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.bmp`, `.ico`, `.svg`, `.avif`):** symlink local o decodificación base64 remota (máx. 6 MB) en `data/fv-preview/`; los `.svg` se reescalan a `1024 px` manteniendo `viewBox` y permiten toggle `Preview` / `Raw` editable.
  - **CSV / TSV (`.csv`, `.tsv`):** parser RFC-4180 con autodetección de delimitador (`,`, `;`, `\t`), tabla estilo Excel paginada (`200` filas/página, máx. `5000 × 60`), columnas resizables (`56–640 px`), ordenamiento numérico/alfabético por columna, filtro Excel multiselección por columna (`▾`), buscador global con autocompletado `@Col:val1,val2` (comillas, `Tab`/`Shift+Tab` + `Enter`, caché LRU de 200 valores únicos) y edición de celdas con barra de fórmula + toggle `Preview` / `Raw`.
  - **PDF (`.pdf`):** `pdfinfo` + `pdftoppm` página a página (`← Prev` / `Next →`), borrando el PNG anterior inmediatamente.
  - **Código / Texto:** `EditorState` editable (solo lectura si supera `250 KB`), syntax highlighting con tokens de `theme()`, `Wrap` y salto a línea/columna.
- **Edición segura:** estado `*` en título (`meta.dirty`), barra `* Unsaved changes` con `✓ Save (Ctrl+S)` y `↺ Discard`, y bloqueo de hibernación mientras existan cambios sin guardar.

### 1.3 `changes-history` (`mods/changes-history/`)
Panel de Source Control estilo VS Code compatible con repositorios locales y SSH.

- **Archivos:** `main.js`, `material-icons.js` (solo iconos de archivo, sin tabla de carpetas), `changes.svg`, `mod.json`.
- **Funcionalidades:**
  - Caja superior de commit + botón `✓ Commit` + acciones rápidas (`S+` Stash, `↓` Pull, `↑` Push, `↻` Refresh).
  - Panel superior scrolleable (`Staged Changes` y `Changes`) separado por un **divisor horizontal resizable** (`localStorage["sc.bottomH"]`) del panel inferior (`Stashes` y `Graph`).
  - `Ctrl + clic` en archivos de `Changes` / `Staged Changes` o en commits de `Graph` abre el diff virtualizado dedicado en una nueva pestaña (con hibernación automática en segundo plano).
  - Confirmación obligatoria en rojo (cancelable con `Esc`) antes de `Discard`, `Delete untracked file` o `Drop stash`.
  - Publica `shared("changes.badge")` continuamente (con verificación liviana cada `15 s` cuando el panel está oculto).

### 1.4 `pane-custom` (`mods/pane-custom/`)
Encabezado unificado para todos los paneles del layout `my-herdr`.

- **Archivos:** `main.js`, `mod.json` (incluye entradas `palette` para `Close tab` y `Reopen closed tab`), `close.svg`, `split-down.svg`, `split-right.svg`, `zoom.svg`, `unzoom.svg`.
- **Responsabilidades:** muestra icono, nombre (con `* ` si `meta.dirty`), subtítulo, estado del agente, controles de `file-viewer` (`Preview`/`Raw`, `Wrap`, zoom del visor) o zoom global en terminales, y los 4 botones de acción montados de forma fija (`opacity: 0.4` en reposo → `1` en hover/zoom para evitar `layout shift`). Gestiona el historial acotado (máx. 8) de cierre/reapertura de paneles y pestañas y poda `file-viewer.meta` huérfano.

### 1.5 `tabs-custom` (`mods/tabs-custom/`)
Clon personalizado de la barra de pestañas `tabs`.

- **Archivos:** `main.js`, `mod.json`, `win-close.svg`, `win-max.svg`, `win-min.svg`, `win-restore.svg`.
- **Responsabilidades:** conserva el comportamiento nativo de pestañas y añade un **badge circular flotante** en la esquina superior derecha del botón `Changes` leyendo `shared("changes.badge")`.

### 1.6 `system-monitor` (`mods/system-monitor/`)
Monitor en vivo de CPU, RAM y árbol de procesos en la barra lateral izquierda + motor de limpieza automática.

- **Archivos:** `main.js`, `mod.json`, `icons/*.svg` (Java 32×32, Papirus-Dark, Devicon, Herdr).
- **Responsabilidades:**
  - Muestreo compacto vía `ps` + `awk` (`/proc/stat`, `/proc/meminfo` incluyendo Swap), polling adaptativo (`3 s` activo, `8 s` sin foco, pausado si la ventana no es visible).
  - Atribución profunda por `pid`/`ppid` bajo la aplicación raíz (indicador `+N` y desglose expandible al hacer clic).
  - Modo rail compacto (`width < 140 px`): `C % / R %` + iconos 16×16 con alertas visuales (`<4%`, `4–10%`, `10–20%`, `≥20%`).
  - Limpieza automática cada `60 s` (y botón manual `GC`): purga terminales `finished` con `hc rm`, poda metadatos huérfanos y emite `herdr.gc`.

---

## 2. Scripts y Configuración (`scripts/`, `install.sh`, `layouts/`)

| Archivo | Propósito |
| --- | --- |
| `install.sh` | Crea los symlinks de `layouts/my-herdr.json` y los 6 mods hacia `~/.config/herdr-app/`, ejecuta `scripts/apply-keys.js` y valida todos los mods con `herdr-app check`. |
| `scripts/apply-keys.js` | Sincroniza atajos de flechas (`Alt + ←/↓/↑/→`, `Alt + Shift + ←/↓/↑/→`) y pestañas (`Ctrl+T`, `Ctrl+W`, `Ctrl+Shift+T`) en `"global"`, `"layout:my-herdr"` y `"terminal"` dentro de `~/.config/herdr-app/keys.json`. |
| `scripts/build-icons.js` | Compacta el mapa de Material Icon Theme desde `mods/files-search/material-icons.js` a tablas invertidas perezosas con `releaseIconCache()` para `files-search` (archivos + carpetas) y `changes-history` (solo archivos). |
| `layouts/my-herdr.json` | Definición del árbol de layout activo en Herdr App. |
