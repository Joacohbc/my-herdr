# AGENTS.md — Directrices de Customización de Herdr (`my-herdr`)

Este documento define las reglas, estándares y procedimientos obligatorios para mantener y extender esta configuración personalizada de **Herdr App** (`herdr-app`).

Para el inventario completo de archivos, mods, repositorios de iconos y arquitectura actual, consultar [CONTEXT.md](./CONTEXT.md).

---

## 1. Reglas de Seguridad y Persistencia

1. **Nunca editar layouts o mods nativos de Herdr directamente** (`main.json`, `files`, `pane`, `spaces`, `agents`, etc.). Herdr los sobrescribe en cada actualización/inicio.
   - Trabajar siempre sobre los clones propios: layout `my-herdr` y mods propios (`files-search`, `file-viewer`, `system-monitor`, `pane-custom`).
   - Si se necesita personalizar otro mod nativo, clonarlo primero con:
     ```bash
     herdr-app do mod.clone '{"name":"<origen>","as":"<nuevo-nombre>"}'
     ```
2. **Nunca editar `~/.config/herdr-app/AGENTS.md`, `gpui-kit.d.ts` ni `herdr.d.ts`** (son regenerados automáticamente por la app).
3. **Respetar las restricciones del runtime `gpui-kit`:**
   - No existe DOM, HTML, CSS, `setTimeout` ni `setInterval`. Usar `cx.timer` y `cx.spawn`.
   - Nunca guardar `cx` fuera del callback actual; usar siempre el `cx` recibido por cada handler.
   - Nunca pasar `"transparent"` a `.bg(...)`; usar `.when(cond, el => el.bg(color))` o colores de `theme()` / hex `#rgb`, `#rrggbb`, `#rrggbbaa`.
   - Usar `checking()` de `"herdr"` en `init()` y `render()` para evitar efectos secundarios (`exec`, timers, watchers) durante `herdr-app check`.
   - Liberar siempre `EditorState`, `InputState` y cancelar `watchFolder` en `close()`.

---

## 2. Directrices Funcionales del Usuario

### Panel lateral derecho — Files (`files-search`)
- **Buscador estilo VS Code** siempre accesible arriba del árbol de archivos:
  - Debe soportar búsqueda de **contenido (`Text`)** y de **nombres/rutas (`Files`)**.
  - Toggles obligatorios: `Aa` (Match Case), `ab` (Whole Word), `.*` (Regex) y panel `⋯` (Include, Exclude extra, y toggle de exclusiones por defecto).
  - **Optimización obligatoria:**
    - Debounce (180 ms) + secuencia monotónica (`searchSeq`) para descartar resultados obsoletos.
    - Exclusiones por defecto activadas: `.git`, `node_modules`, `target`, `dist`, `build`, `out`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.cache`, `__pycache__`, `.venv`, `venv`, `vendor`, `coverage`, `.gradle`, `.idea`, `.vscode`, lockfiles y `*.min.*` / `*.map`, además de respetar `.gitignore`.
    - Selección automática de backend más rápido disponible en el host (local o SSH remoto): `rg` → `git grep --untracked` → `grep -rnI` / `find -prune`.
    - Límite estricto de resultados en origen (`head -n 301`) y timeout acotado (8 s).
    - Pasar siempre la query como argumento posicional (`"$1"`) con `--`, nunca interpolada en el script shell.
- **Comportamiento al abrir archivos:**
  - **Clic normal:** abrir el archivo en un panel separado (`file-viewer`) dentro de la **tab actual** (reutilizando el visor existente en esa tab o abriendo split a la derecha), sin reemplazar nunca el panel `Files`.
  - **`Ctrl + clic`:** abrir el archivo **solo en su propia tab nueva** (`tab.new` con `solo: true`), protegido para que otros clics normales no lo sobrescriban.
  - **`Shift + clic`:** abrir un panel split adicional en la tab actual.
- **Iconografía exacta de VS Code Material Icon Theme:**
  - Usar el mapeo y los SVGs de la extensión oficial `material-extensions/vscode-material-icon-theme` (`pkief.material-icon-theme`).
  - Los iconos deben renderizarse con `image(...)` a **16×16 px** (15×15 en cabeceras compactas) para mantener nitidez exacta.

### Visor de archivos (`file-viewer`)
- **Preview de Markdown (`.md`, `.markdown`, `.mdx`):**
  - Debe abrir por defecto en vista renderizada usando `TextView.markdown(...)` con `.selectable(true)`, `.scrollable(true)` y `.raw_html(false)`.
  - Si se abre desde un resultado de búsqueda con línea/columna, resaltar el rango con `.highlight_range(...)`.
  - Incluir botón `Preview` / `Raw` para alternar al código fuente con syntax highlighting.
- **Zoom interactivo:**
  - Soportar **`Ctrl + ruedita del mouse`** y gesto **pinch** para ajustar el tamaño de fuente del visor (`fontDelta`), además de los botones `A−`, reset (`px`) y `A+`.
  - Incluir botón `Zoom` / `Unzoom` (`pane.zoom`), `Wrap` (en modo código) y cerrar (`×`).

### Encabezado unificado de paneles (`pane-custom`) y Visor (`file-viewer`)
- Todos los controles del visor (`Preview`/`Raw`, `Wrap`, `−` / `%` / `+`, `pane.zoom`, split y `×`) deben vivir **en la única barra superior de `pane-custom`** sin duplicar barras en `file-viewer`.
- En paneles `file-viewer`, `−` / `%` / `+` y `Ctrl + ruedita` ajustan el zoom del visor (`fontDelta` vía `shared("file-viewer.cmd")`); en terminales ajustan `app.zoom_out` / `app.zoom_reset` / `app.zoom_in`.
- `pane-custom` también escucha `nextCommand()` en el panel enfocado para cerrar y reabrir panes/tabs con historial (`close_pane`, `reopen_pane`, `close_tab`, `reopen_tab`).

### Atajos de Tabs (`scripts/apply-keys.js`)
- `Ctrl + T`: crear nueva tab (`tab.new`).
- `Ctrl + W`: cerrar tab actual guardándola en el historial (`pane-custom.close_tab`).
- `Ctrl + Shift + T`: reabrir última tab cerrada (`pane-custom.reopen_tab`).
- Aplicados en `"layout:my-herdr"` y `"terminal"` dentro de `~/.config/herdr-app/keys.json`.

### Panel de cambios, Stash e historial Git estilo VS Code (`changes-history`)
- Diseño estilo **VS Code Source Control**:
  - Caja de mensaje + botón ancho `✓ Commit` en la parte superior (hace commit solo de staged si existen, o stagea todo y commitea si no hay staged) + barra de acciones rápidas (`S+` Stash, `↓` Pull, `↑` Push, `↻` Refresh).
  - Secciones colapsables: **Staged Changes** (con `−` Unstage / Unstage All), **Changes** (con iconos Material Icons 16×16, abrir en `file-viewer` `↗`, `↺` Discard y `+` Stage / Stage All), **Stashes** (`+` crear stash con `-u`, `Apply`, `Pop`, `×` Drop) y **Graph** (historial de commits `git log`, clic para abrir archivos modificados y diff virtualizado con `git show`).

### Monitor de sistema en el lateral izquierdo (`system-monitor`)
- Mostrar **CPU total** y **RAM total** (uso / total / % con barra de color dinámico) + **procesos agrupados por aplicación** ordenables por `RAM` o `CPU`.
- **Modo minimizado (rail colapsado `< 140 px`):**
  - Mostrar resumen `C % / R %` (clic para alternar orden `RAM` / `CPU`).
  - Mostrar cada app principal por su **icono SVG** con **color de fondo y borde de alerta** según el % del total de RAM/CPU que consume esa app (`<4%` neutro, `4–10%` acento, `10–20%` advertencia, `≥20%` alerta roja) y su porcentaje debajo.
- **Iconos a color y nítidos (16×16 px):**
  - Nunca usar iconos monocromáticos negros con `image(...)` sobre fondo oscuro.
  - **Java:** usar la tacita clásica azul con vapor naranja (`mods/system-monitor/icons/java.svg`).
  - **Docker:** usar la ballena azul clásica.
  - **Lenguajes/runtimes:** usar SVGs optimizados a 16/32 px a color (Material Icons / Devicon).
  - **Apps de escritorio:** usar SVGs a color (Papirus-Dark / logos oficiales).
- Pausar el polling cuando `window()?.visible === false`.

---

## 3. Estándares de Código y Organización

- **Modularidad:** separar lógica de negocio/búsqueda/datos (`search.js`, `material-icons.js`) de la vista GPUI (`main.js`).
- **Flujo plano:** preferir guard clauses y funciones pequeñas con nombres autoexplicativos; evitar anidamiento innecesario.
- **Tematización:** usar siempre tokens de `theme()` (`background`, `chrome`, `surface`, `hover`, `selected`, `border`, `foreground`, `muted`, `dim`, `accent`, `selection`, `ansi1..6`, `blocked`, `done`, `working`) para mantener compatibilidad con cualquier tema de Herdr.
- **Tamaños de SVG:** usar siempre múltiplos/divisores enteros de los viewBox (`16×16` px) para evitar pixelación por escalado fraccional.

---

## 4. Flujo de Validación Obligatorio

Antes de dar por terminado cualquier cambio en mods o layouts:

1. Validar sintaxis, elementos GPUI y render inicial de cada mod tocado:
   ```bash
   herdr-app check ~/.config/herdr-app/mods/files-search
   herdr-app check ~/.config/herdr-app/mods/file-viewer
   herdr-app check ~/.config/herdr-app/mods/system-monitor
   herdr-app check ~/.config/herdr-app/mods/pane-custom
   ```
2. Verificar estado en vivo y ausencia de errores:
   ```bash
   herdr-app status
   ls ~/.config/herdr-app/*.error 2>/dev/null
   ```
   Confirmar `"layout": "my-herdr"` y `"errors": []`.
3. Inspeccionar visualmente el resultado real cuando haya cambios de UI/iconos:
   ```bash
   herdr-app shot /tmp/herdr-verify.png
   ```
