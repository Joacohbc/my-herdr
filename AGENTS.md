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
- **Previsualizaciones ricas con bajo uso de RAM:**
  - **Markdown (`.md`, `.markdown`, `.mdx`):** vista renderizada con `TextView.markdown` (`.selectable(true)`, `.scrollable(true)`, `.raw_html(false)`) y resaltado `.highlight_range(...)`.
  - **Imágenes (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.bmp`, `.ico`, `.svg`, `.avif`):** preview en vivo vía symlink/staging temporal en `data/fv-preview/` con zoom interactivo y toggle `Preview` / `Raw` en `.svg`.
  - **CSV / TSV (`.csv`, `.tsv`):** tabla virtualizada estilo Excel (`v_virtual_list`, letras de columna `A, B, C...`, filas numeradas, autodetección de delimitador `,` / `;` / `\t`, hasta 5.000 filas × 60 cols) con toggle `Preview` / `Raw`.
  - **PDF (`.pdf`):** renderizado perezoso **página a página** (`pdfinfo` + `pdftoppm`, manteniendo solo 1 PNG activo en disco/RAM) con navegación `← Prev` / `Next →` y zoom.
- **Optimización RAM y limpieza automática:**
  - Buffer único (no mantiene `EditorState` + `rawText` duplicados; usa `Uint32Array` de saltos de línea para código).
  - Hibernación automática tras 45 s en tabs inactivas o ante señal `herdr.gc` (libera `EditorState`, texto, tabla CSV y archivos temporales `data/fv-preview/`, recargando al volver a la tab).
- **Zoom interactivo:**
  - Soportar **`Ctrl + ruedita del mouse`** y gesto **pinch** para ajustar el tamaño de fuente / escala del visor (`fontDelta`), además de los botones `−`, `%` y `+` en `pane-custom`.

### Encabezado unificado de paneles (`pane-custom`) y Barra de Tabs (`tabs-custom`)
- Todos los controles del visor (`Preview`/`Raw`, `Wrap`, `−` / `%` / `+`, `pane.zoom`, split y `×`) viven **en la única barra superior de `pane-custom`** sin duplicar barras en `file-viewer`.
- En paneles `file-viewer`, `−` / `%` / `+` y `Ctrl + ruedita` ajustan el zoom del visor (`fontDelta` vía `shared("file-viewer.cmd")`); en terminales ajustan `app.zoom_out` / `app.zoom_reset` / `app.zoom_in`.
- `tabs-custom` muestra un **puntito con contador** en el botón `Changes` arriba a la derecha cuando hay cambios sin commitear (`shared("changes.badge")`).

### Atajos de Teclado (`scripts/apply-keys.js`)
- Navegación de paneles con flechas: `Alt + ←/↓/↑/→` (`pane.go:{left,down,up,right}`) y `Alt + Shift + ←/↓/↑/→` (`pane.swap:{left,down,up,right}`), reemplazando `hjkl`.
- Tabs: `Ctrl + T` (`tab.new`), `Ctrl + W` (`pane-custom.close_tab`), `Ctrl + Shift + T` (`pane-custom.reopen_tab`).
- Sincronizados en `"global"`, `"layout:my-herdr"` y `"terminal"` dentro de `~/.config/herdr-app/keys.json` (y expuestos en `pane-custom/mod.json` `palette`) para que el menú `Ctrl + Shift + P` muestre siempre las asignaciones actuales.

### Panel de cambios, Stash e historial Git estilo VS Code (`changes-history`)
- Diseño estilo **VS Code Source Control**:
  - Caja de mensaje + botón ancho `✓ Commit` + barra de acciones rápidas (`S+` Stash, `↓` Pull, `↑` Push, `↻` Refresh).
  - **`Ctrl + clic`** tanto en archivos de `Changes` / `Staged Changes` como en commits de `Graph` abre el diff dedicado en una **nueva tab** (con hibernación automática si queda en segundo plano).
  - Limpieza automática: pausa `watchFolder` y libera diffs, commits e iconos cuando el panel está oculto o al colapsar `Graph`, manteniendo solo el contador liviano del badge.

### Monitor de sistema en el lateral izquierdo (`system-monitor`)
- Mostrar **CPU total**, **RAM total** y **procesos agrupados por aplicación** con **atribución profunda por árbol de procesos (`pid`/`ppid`)**: procesos hijos/subprocesos cargados en profundidad se agrupan bajo su app raíz con indicador `+N` y desglose expandible al hacer clic.
- **Limpieza automática cada 60 s (y botón manual `GC`):** elimina terminales finalizadas en `herdr-core` (`hc rm`), poda metadatos huérfanos en `shared` y dispara `herdr.gc` cuando la RAM ≥ 75% o bajo demanda.
- **Modo minimizado (rail colapsado `< 140 px`):** resumen `C % / R %` + iconos SVG 16×16 con fondo y borde de alerta (`<4%` neutro, `4–10%` acento, `10–20%` advertencia, `≥20%` alerta roja).
- Polling adaptativo (`3 s` activo, `8 s` sin foco, pausado si `window()?.visible === false`) con salida `ps`/`awk` compacta.

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
