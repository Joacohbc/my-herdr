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

- **Archivos:** `main.js`, `github.js`, `material-icons.js` (solo iconos de archivo, sin tabla de carpetas), `changes.svg`, `mod.json`.
- **Funcionalidades:**
  - Caja superior de commit + botón `✓ Commit` + acciones rápidas (`S+` Stash, `↓` Pull, `↑` Push, `↻` Refresh) y enlace directo `↗` en la píldora de rama cuando existe rama remota rastreada (`@{u}` o `origin/<rama>`).
  - Panel superior scrolleable (`Staged Changes` y `Changes`) separado por un **divisor horizontal resizable** (`localStorage["sc.bottomH"]`) del panel inferior (`Stashes`, `Graph` y `Pull Requests`).
  - **`Graph`:** muestra la fecha (`YYYY-MM-DD`) junto al hash corto en cada commit, incluye buscador por mensaje (`git log --fixed-strings --regexp-ignore-case --grep=...` con debounce de `220 ms`), selector desplegable de rama (`Current`, `All branches`, locales y remotas hasta `150` ramas) y paginación por fecha (`--before=<epoch>`, límite explícito de `1000` commits por página con navegación `← Newer` / `Latest` / `Older commits →`).
  - **`Pull Requests` (`github.js`):** integración bajo demanda con GitHub mediante `gh` CLI en el repositorio actual (local y SSH) con buscador (`280 ms` debounce), filtro por estado (`Open`, `Merged`, `Closed`, `All`), apertura directa en navegador (`↗` vía `cx.open_url`), vista de detalle con archivos/diff virtualizado y `Checkout` (`gh pr checkout`).
  - `Ctrl + clic` en archivos de `Changes` / `Staged Changes`, commits de `Graph` o PRs de `Pull Requests` abre la vista de diff virtualizado dedicada en una nueva pestaña (con hibernación automática en segundo plano tras `45 s`).
  - Confirmación obligatoria en rojo (cancelable con `Esc`) antes de `Discard`, `Delete untracked file` o `Drop stash`.
  - Publica `shared("changes.badge")` continuamente (con verificación liviana cada `15 s` cuando el panel está oculto).

### 1.4 `pane-custom` (`mods/pane-custom/`)
Encabezado unificado para todos los paneles del layout `my-herdr`.

- **Archivos:** `main.js`, `mod.json` (incluye entradas `palette` para `Close tab` y `Reopen closed tab`), `close.svg`, `split-down.svg`, `split-right.svg`, `zoom.svg`, `unzoom.svg`.
- **Responsabilidades:** muestra icono, nombre (con `* ` si `meta.dirty`), subtítulo, estado del agente, controles de `file-viewer` (`Preview`/`Raw`, `Wrap`, zoom del visor) o zoom global en terminales, y los 4 botones de acción montados de forma fija (`opacity: 0.4` en reposo → `1` en hover/zoom para evitar `layout shift`). Gestiona el historial acotado (máx. 8) de cierre/reapertura de paneles y pestañas y poda `file-viewer.meta` huérfano.

### 1.5 `tabs-custom` (`mods/tabs-custom/`)
Clon personalizado de la barra de pestañas `tabs`.

- **Archivos:** `main.js`, `mod.json`, `web.svg`, `win-close.svg`, `win-max.svg`, `win-min.svg`, `win-restore.svg`.
- **Responsabilidades:** conserva el comportamiento nativo de pestañas, añade el botón `Web` (abre el popup `web-launcher`) y muestra un **badge circular flotante** en la esquina superior derecha del botón `Changes` leyendo `shared("changes.badge")`.

### 1.6 `system-monitor` (`mods/system-monitor/`)
Monitor en vivo de CPU, RAM y árbol de procesos en la barra lateral izquierda + motor de limpieza automática.

- **Archivos:** `main.js`, `mod.json`, `icons/*.svg` (Java 32×32, Papirus-Dark, Devicon, Herdr).
- **Responsabilidades:**
  - Muestreo compacto vía `ps` + `awk` (`/proc/stat`, `/proc/meminfo` incluyendo Swap), polling adaptativo (`3 s` activo, `8 s` sin foco, pausado si la ventana no es visible o cuando el panel está minimizado).
  - Colapsable a barra de `32 px` (`System ▸` / `System ▾` vía `layout.resize`), persistido en `localStorage["sys.collapsed"]`.
  - Atribución profunda por `pid`/`ppid` bajo la aplicación raíz (indicador `+N` y desglose expandible al hacer clic).
  - Modo rail compacto (`width < 140 px`): `C % / R %` + iconos 16×16 con alertas visuales (`<4%`, `4–10%`, `10–20%`, `≥20%`).
  - Limpieza automática cada `60 s` (y botón manual `GC`): purga terminales `finished` con `hc rm`, poda metadatos huérfanos y emite `herdr.gc`.

### 1.7 `web-launcher` (`mods/web-launcher/`)
Modal centrado (`430×420`) para abrir el navegador o un enlace en un perfil específico de Google Chrome o en una sesión limpia.

- **Archivos:** `main.js`, `mod.json` (`"place": "none"`, `"focusable": true`, overlay `430×420`).
- **Funcionalidades:**
  - Detecta automáticamente si hay una URL (`http://`, `https://` o `localhost`) en el portapapeles (`cx.read_from_clipboard()`) y la pre-rellena en el campo de entrada (o recibe `props().url` al abrirse desde `ports-monitor`).
  - Muestra chips clicables de los puertos HTTP/HTTPS activos publicados en `shared("ports.http")`.
  - Lista dinámicamente los perfiles instalados en `~/.config/google-chrome/Local State` junto a la opción `Clean` (perfil temporal aislado en `/tmp/herdr-web-clean-*`), recordando la última selección en `shared("web-launcher.profile")`.
  - Permite abrir en pestaña normal (`Abrir navegador ↗` / `Abrir link ↗`, también con `Enter`) o como ventana minimalista (`App ❐` vía `--app`). Cero procesos ni timers en segundo plano.

### 1.8 `ports-monitor` (`mods/ports-monitor/`)
Monitor en tiempo real de puertos en escucha en la barra lateral izquierda con clasificación de sistema, detección de protocolo e integración directa con `web-launcher`.

- **Archivos:** `main.js`, `detector.js`, `mod.json`, `icons/*.svg` (`http`, `https`, `db`, `mq`, `tcp`, `udp`, `sys`).
- **Funcionalidades:**
  - Muestreo en tiempo real vía `ss -H -tulnp` (`1.5 s` activo, `5 s` sin foco; detenido por completo cuando está minimizado o la ventana oculta), actualizando GPUI solo cuando cambia la firma de puertos.
  - Diferencia puertos de sistema (puertos conocidos como DNS `53`, mDNS `5353`, CUPS `631`, Tailscale `41641`, `127.0.0.53/54`, daemons OS) con toggle `Sys N`.
  - Identifica protocolos (`HTTP`, `HTTPS`, `DB`, `MQ`, `TCP`, `UDP`) mediante tabla conocida + sonda HTTP/HTTPS perezosa (`curl`, caché acotada `MAX_PROBE_CACHE = 128`, limpiada en `herdr.gc`), filtros por protocolo (`All | HTTP | DB | TCP | UDP`) y badge de exposición (`localhost`, `0.0.0.0`, `tailscale`).
  - Clic en puertos HTTP/HTTPS abre el modal `web-launcher` pre-rellenado; clic en otros puertos copia `host:port`. Publica `shared("ports.http")` (máx. `32`).
  - Colapsable a barra de `32 px` (`Ports ▸` / `Ports ▾` vía `layout.resize`) y modo rail compacto (`width < 140 px`) con iconos + número de puerto.

### 1.9 `agents-custom` (`mods/agents-custom/`)
Clon personalizado del panel `agents` de la barra lateral izquierda.

- **Archivos:** `main.js`, `mod.json`.
- **Funcionalidades:** conserva agrupación/prioridad, sub-agentes y pines del mod nativo, hereda la fuente global (**D11**) y añade un **modo compacto vertical** (al pulsar `Agents ▾` o achicar el panel a `< 86 px`, `min: 60 px`) que muestra solo los iconos de los agentes uno al lado del otro con borde/punto de color según estado (`working`, `blocked`, `done`, `idle`).

---

## 2. Scripts y Configuración (`scripts/`, `install.sh`, `layouts/`)

| Archivo | Propósito |
| --- | --- |
| `install.sh` | Crea los symlinks de `layouts/my-herdr.json` y los 9 mods hacia `~/.config/herdr-app/`, ejecuta `scripts/apply-keys.js` y valida todos los mods con `herdr-app check`. |
| `scripts/apply-keys.js` | Sincroniza atajos de flechas (`Alt + ←/↓/↑/→`, `Alt + Shift + ←/↓/↑/→`) y pestañas (`Ctrl+T`, `Ctrl+W`, `Ctrl+Shift+T`) en `"global"`, `"layout:my-herdr"` y `"terminal"` dentro de `~/.config/herdr-app/keys.json`. |
| `scripts/build-icons.js` | Compacta el mapa de Material Icon Theme desde `mods/files-search/material-icons.js` a tablas invertidas perezosas con `releaseIconCache()` para `files-search` (archivos + carpetas) y `changes-history` (solo archivos). |
| `layouts/my-herdr.json` | Definición del árbol de layout activo en Herdr App. |
