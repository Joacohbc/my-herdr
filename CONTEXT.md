# CONTEXT.md — Arquitectura y Contexto de `my-herdr`

Documentación técnica del estado actual de la customización de **Herdr App** (`herdr-app`) en esta máquina: dónde vive cada archivo, cómo se conectan los mods, qué repositorios/fuentes de iconos se utilizan y cómo funciona cada componente.

---

## 1. Entorno y Rutas Principales

| Recurso | Ruta | Rol |
|---|---|---|
| Repositorio Git (fuente de verdad) | `/home/joaco/projects/my-herdr/` | Contiene `layouts/`, `mods/`, `install.sh`, `AGENTS.md` y `CONTEXT.md` |
| Home de Herdr App (live) | `~/.config/herdr-app/` | Symlinks creados por `./install.sh` apuntando a este repo (hot-reload en vivo) |
| Layout personalizado activo | `layouts/my-herdr.json` → `~/.config/herdr-app/layouts/my-herdr.json` | Clon de `main` (v0.1.18), inmune a updates |
| Binario Herdr App | `~/.local/bin/herdr-app` → `~/.local/share/herdr-app/herdr-app` | Interfaz gráfica nativa GPUI |
| Core de terminales | `~/.local/bin/herdr-core` | Daemon persistente local y en hosts SSH (`rbpil`, `rbpi8gbl`) |

---

## 2. Repositorios y Fuentes Externas Utilizadas

| Fuente / Repo | Origen exacto | Uso en `my-herdr` |
|---|---|---|
| **VS Code Material Icon Theme** | [`material-extensions/vscode-material-icon-theme`](https://github.com/material-extensions/vscode-material-icon-theme) (extraído de `~/.vscode/extensions/pkief.material-icon-theme-5.40.0`) | 100% de la iconografía del panel **Files** (2.156 nombres exactos, 1.391 extensiones, 4.674 carpetas abiertas/cerradas) + iconos nítidos 16/32 px de lenguajes y Docker en **System Monitor** |
| **Devicon** | [`devicons/devicon`](https://github.com/devicons/devicon) (`cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/...`) | Logos oficiales a color `-original.svg` para bases de datos (PostgreSQL, MySQL, MongoDB, Redis), .NET, Podman y respaldo de lenguajes |
| **Papirus-Dark** | Tema de iconos del sistema (`/usr/share/icons/Papirus-Dark/48x48/apps/`) | Logos a color de aplicaciones de escritorio (VS Code, Chrome, Vivaldi, Brave, Firefox, Slack, Discord, Spotify, Telegram, WhatsApp, Teams, Obsidian, Postman, DBeaver, CopyQ, Ulauncher, OBS, VLC, Steam, Blender, GIMP, Thunderbird, Bitwarden, 1Password, Alacritty, Kitty) |
| **Herdr App Built-in Icons** | `~/.config/herdr-app/icons/` y `~/.local/share/herdr-app/herdr-app.svg` | Logos de agentes AI (`claude.svg`, `antigravity.svg`, `codex.svg`, `cursor.svg`, `gemini.svg`, `ollama.svg`), logo de `herdr.svg` y fallbacks (`shell.svg`, `program.svg`) |
| **Custom SVG local** | `~/.config/herdr-app/mods/system-monitor/icons/java.svg` | Tacita clásica de Java azul con vapor naranja optimizada a `32×32` px |

---

## 3. Estructura del Layout `my-herdr.json`

```text
root (row)
├── sidebar (column, 268px, colapsable a 44px)
│   ├── brand            → mod: workspace-chrome
│   ├── sidebar-lists (column)
│   │   ├── spaces         → mod: spaces
│   │   ├── agents         → mod: agents
│   │   └── system-monitor → mod: system-monitor   [CUSTOM]
│   └── sidebar-footer   → mod: workspace-chrome (footer: true)
└── work (column)
    ├── tabs             → mod: tabs
    ├── work-body (row)
    │   ├── main         → tab: active, pane header → mod: pane-custom [CUSTOM]
    │   └── panel (stack)
    │       ├── files    → mod: files-search       [CUSTOM]
    │       └── changes  → mod: changes
    └── status           → mod: workspace-status
```

---

## 4. Inventario de Mods Personalizados

### 4.1 `files-search` (`~/.config/herdr-app/mods/files-search/`)
Clon extendido del panel `files` con buscador estilo VS Code e iconografía Material Icons.

| Archivo | Responsabilidad |
|---|---|
| `main.js` | Vista principal: árbol lazy de archivos, barra de búsqueda, toggles (`Aa`, `ab`, `.*`, `⋯`), resultados agrupados por archivo, y apertura en `file-viewer` |
| `search.js` | Motor de búsqueda optimizado (`searchContent`, `searchFiles`, `splitMatchHighlight`, `offsetForLineCol`, listas de exclusión por defecto) |
| `material-icons.js` | Mapa auto-generado desde `pkief.material-icon-theme-5.40.0/dist/material-icons.json` (`fileIcon`, `folderIcon`) |
| `micons/*.svg` | Copia local de todos los SVGs de Material Icon Theme |
| `mod.json` | Configuración del mod (`"place": "none"`) |

**Interacciones:**
- **Clic:** abre el archivo en `file-viewer` dentro de la tab actual (reutiliza el visor existente o hace split a la derecha).
- **`Ctrl + clic`:** abre el archivo solo en una nueva tab (`tab.new` con `solo: true`).
- **`Shift + clic`:** abre un nuevo split `file-viewer` adicional en la tab actual.

**Pipeline de búsqueda (local y SSH remoto):**
- **Contenido (`Text`):** `rg` → `git grep --untracked` → `grep -rnI`, cortado a 300 matches (`head -n 301`), timeout 8 s, debounce 180 ms.
- **Archivos (`Files`):** `fd` → `git ls-files --cached --others --exclude-standard` → `find ... -prune`, con scoring (match exacto > prefijo > substring > subsecuencia) y tope de 200 resultados.
- **Exclusiones por defecto:** `.git`, `node_modules`, `target`, `dist`, `build`, `out`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.cache`, `.parcel-cache`, `__pycache__`, `.venv`, `venv`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `vendor`, `coverage`, `.nyc_output`, `.gradle`, `.idea`, `.vscode`, `bower_components`, `Pods`, `.dart_tool`, `.zig-cache`, `zig-out`, `bin`, `obj`, `.terraform`, `.serverless`, lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`) y `*.min.js` / `*.min.css` / `*.map`.

---

### 4.2 `file-viewer` (`~/.config/herdr-app/mods/file-viewer/`)
Visor dedicado que se abre como panel separado desde `files-search`.

| Archivo | Responsabilidad |
|---|---|
| `main.js` | Carga archivos locales y remotos (`readTextFile`), renderiza Markdown con `TextView.markdown` y código con `Editor` |
| `mod.json` | `"place": "none", "focusable": true` |

**Capacidades:**
- **Preview Markdown (`.md`, `.markdown`, `.mdx`):** activo por defecto con texto seleccionable, scroll nativo, resaltado de coincidencias de búsqueda (`highlight_range`) y botón `Preview` / `Raw`.
- **Zoom por visor:** botones `A−`, indicador de `px` (clic para resetear), `A+`, **`Ctrl + ruedita del mouse`** y gesto **pinch**.
- **Controles de pane:** `Zoom` / `Unzoom` (`pane.zoom`), `Wrap` (en modo código/raw) y cerrar (`×`).
- **Comunicación:** escucha el estado compartido `shared("file-viewer.open")` para actualizarse sin abrir panes duplicados (excepto cuando `solo: true` en tabs dedicadas).

---

### 4.3 `pane-custom` (`~/.config/herdr-app/mods/pane-custom/`)
Clon del encabezado `pane` aplicado a todos los paneles del layout `my-herdr`.

| Archivo | Responsabilidad |
|---|---|
| `main.js` | Barra superior unificada: icono, nombre, ruta, estado del agente, controles integrados de `file-viewer` (`Preview`/`Raw`, `Wrap`, zoom del visor), zoom global en terminales (`−` / `%` / `+` + `Ctrl + ruedita`), `pane.zoom`, splits, cierre, y listener `nextCommand()` para cerrar/reabrir panes y tabs con historial (`tiling.closedPanes` / `tiling.closedTabs`) |
| `*.svg` | Iconos de control (`split-right`, `split-down`, `zoom`, `unzoom`, `close`) |

---

### 4.5 `tiling-mode` (`~/.config/herdr-app/mods/tiling-mode/` + `tiling-config.json`)
Modo Tiling Manager & Resize HUD activado con `Ctrl+Space` (o `Ctrl+Alt+R`), más atajos directos configurables desde `tiling-config.json` vía `scripts/apply-tiling-keys.js`.

| Archivo | Responsabilidad |
|---|---|
| `tiling-config.json` | Define `base_modifier` (`ctrl-alt`), `leader_key` (`ctrl-space`), `layout` y `resize_step_px` |
| `scripts/apply-tiling-keys.js` | Aplica los atajos en `"layout:my-herdr"` dentro de `~/.config/herdr-app/keys.json` sin alterar el resto |
| `mods/tiling-mode/main.js` | HUD flotante modal con modo **Tiling** (flechas foco, `Shift+flechas` swap, `Ctrl+flechas` resize, `v/s/z/q/Q/w/W/[/]/{/}/n`) y modo **Resize** (`r` + flechas ±40px, `Shift` ±16px, `Ctrl` ±90px) |

---

### 4.4 `system-monitor` (`~/.config/herdr-app/mods/system-monitor/`)
Monitor en vivo de CPU y RAM ubicado en la barra lateral izquierda debajo de `Agents`.

| Archivo | Responsabilidad |
|---|---|
| `main.js` | Muestreo cada 3 s (`/proc/stat`, `/proc/meminfo`, `nproc`, `ps`), agrupación por aplicación, vista expandida y vista compacta con alertas de color |
| `icons/*.svg` | Iconos locales a color (Java clásico, Papirus-Dark, Devicon, Herdr) |
| `mod.json` | `"place": "none"` |

**Vistas y alertas:**
- **Expandida (`width ≥ 140 px`):** barras de CPU total y RAM total (`usado / total (%)`), botones de orden `RAM` / `CPU`, colapso de lista al hacer clic en `System` y hasta 16 apps agrupadas con iconos 16×16 px.
- **Minimizada (`width < 140 px`):** bloque compacto `C % / R %` (clic alterna orden `RAM`/`CPU`) + top 8 apps por icono con fondo y borde de alerta según `max(ramPct, cpuNorm)`:
  - `< 4%`: neutro (`surface` / `border`)
  - `4–10%`: acento (`accent`)
  - `10–20%`: advertencia (`blocked`)
  - `≥ 20%`: alerta crítica (`ansi1`)

---

## 5. Cómo Actualizar o Regenerar Iconos de Material Icon Theme

Si actualizás la extensión `pkief.material-icon-theme` en VS Code, podés resincronizar los SVGs y `material-icons.js` apuntando al nuevo directorio de versión en `~/.vscode/extensions/pkief.material-icon-theme-*`:

1. Copiar `icons/` de la extensión a `~/.config/herdr-app/mods/files-search/micons/`.
2. Regenerar `~/.config/herdr-app/mods/files-search/material-icons.js` desde `dist/material-icons.json` limpiando el prefijo `/^(\.\/)?\.\.\/icons\//`.
3. Validar con `herdr-app check ~/.config/herdr-app/mods/files-search`.
