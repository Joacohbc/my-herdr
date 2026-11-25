# Arquitectura de `my-herdr`

## 1. Visión General

`my-herdr` es un repositorio Git (`/home/joaco/projects/my-herdr`) que concentra toda la personalización de **Herdr App** (`herdr-app`, interfaz nativa en Rust/GPUI) sobre la máquina local y hosts SSH conectados a `herdr-core` (`rbpil`, `rbpi8gbl`). El script `install.sh` enlaza mediante symlinks el layout, `command-aliases.json` y los 12 mods personalizados dentro de `~/.config/herdr-app/` y sincroniza `~/.config/herdr-app/keys.json`.

```text
root (row)
├── sidebar (column, 268px, colapsable a 44px)
│   ├── brand            → mod: workspace-chrome        [NATIVO]
│   ├── sidebar-lists (column)
│   │   ├── spaces         → mod: spaces                [NATIVO]
│   │   ├── agents         → mod: agents-custom         [CUSTOM]
│   │   ├── system-monitor → mod: system-monitor        [CUSTOM]
│   │   ├── ports-monitor  → mod: ports-monitor         [CUSTOM]
│   │   ├── docker         → mod: docker-monitor        [CUSTOM]
│   │   └── usage          → mod: ai-usage              [CUSTOM]
│   └── sidebar-footer   → mod: workspace-chrome        [NATIVO]
└── work (column)
    ├── tabs             → mod: tabs-custom             [CUSTOM]
    ├── work-body (row)
    │   ├── main         → tab: active, pane header → pane-custom [CUSTOM]
    │   │                  (contiene terminales, file-viewer o changes-history standalone)
    │   └── panel (stack, hidden por defecto)
    │       ├── files    → mod: files-search            [CUSTOM]
    │       └── changes  → mod: changes-history         [CUSTOM]
    └── status           → mod: workspace-status        [NATIVO]
```

---

## 2. Contratos de Comunicación Inter-Mod (`shared`)

Los mods de Herdr corren en contextos aislados dentro de `gpui-shell` y se comunican únicamente mediante `shared(key)` / `setShared(key, value)` y comandos `run(...)`.

| Clave `shared` | Productor | Consumidor(es) | Contrato / Propósito |
| --- | --- | --- | --- |
| `file-viewer.open` | `files-search`, `changes-history` | `file-viewer` (no `solo`) | `{ file, root, on, tab, pane, line, col, matchLen, seq }`. Actualiza un visor existente en la pestaña actual sin abrir paneles duplicados. |
| `file-viewer.meta` | `file-viewer` | `pane-custom`, `system-monitor` | Mapa `{ [paneId]: { file, root, on, line, md, hasPreview, preview, wrap, zoomPct, dirty } }`. Permite que el encabezado unificado muestre controles y `*` sin duplicar barras. |
| `file-viewer.cmd` | `pane-custom` | `file-viewer` | `{ pane, action: "toggle_preview" \| "toggle_wrap" \| "zoom_in" \| "zoom_out" \| "zoom_reset", seq }`. |
| `web-launcher.profile` | `web-launcher` | `web-launcher` | ID del último perfil de Chrome seleccionado (`"clean"`, `"Default"`, `"Profile 2"`, etc.). |
| `ports.http` | `ports-monitor` | `web-launcher` | Lista acotada (máx. `32`) de puertos HTTP/HTTPS activos `[{ url, port, proto, exposure, service, process }]` publicada solo cuando cambia. |
| `changes.badge` | `changes-history` | `tabs-custom` | `{ count, space }`. Contador de archivos con cambios sin commitear para el badge flotante del botón `Changes`. |
| `herdr.gc` | `system-monitor` | `files-search`, `file-viewer`, `changes-history`, `ports-monitor` | `{ seq, at, reason }`. Señal de limpieza global que dispara evicción inmediata de cachés e hibernación de pestañas inactivas. |
| `tiling.closedPanes` / `tiling.closedTabs` | `pane-custom` | `pane-custom` | Pilas acotadas a 8 elementos deduplicados para `pane-custom.reopen_pane` y `pane-custom.reopen_tab` (`Ctrl + Shift + T`). |
| `files-search.refresh` | `command-palette` | `files-search` | `{ seq, expand, root, on }`. Notifica al árbol de `Files` tras crear un archivo/carpeta para refrescar y expandir automáticamente la ruta padre. |
| `command-palette.recent` | `command-palette` | `command-palette` | Historial acotado (máx. `10`) de comandos ejecutados recientemente mediante el prefijo `>`. |

---

## 3. Presupuesto de RAM y Ciclo de Vida de Limpieza Automática

Cada mod gestiona su memoria en tres capas complementarias:

1. **Pausa por visibilidad:** `files-search` y `changes-history` inspeccionan el árbol de `layout()` (`panel.hidden` y `panel-body.active`) y `window()?.visible`. Al ocultarse, cancelan `watchFolder` al instante y detienen el polling rápido.
2. **Evicción e hibernación por inactividad:**
   - Paneles laterales ocultos (`files-search`, `changes-history`): vacían cachés (`entries`, `marks`, `commits`, `rows`, `scans`, `releaseIconCache()`) tras `30 s`.
   - Bloques del sidebar (`docker-monitor`, `ai-usage`): muestrean más lento al colapsarse (`15 s` / `5 min`), no muestrean con el sidebar oculto y vacían contenedores, historial de CPU y resumen de uso tras `30 s` oculto.
   - Pestañas en segundo plano (`file-viewer`, `changes-history` standalone): hibernan tras `45 s` liberando `EditorState`, texto, tabla CSV y archivos temporales en `data/fv-preview/`, excepto cuando `isDirty()` es verdadero.
3. **Recolección coordinada (`system-monitor`):**
   - Cada `60 s` (y al iniciar) ejecuta `hc ls --all --json` y purga terminales con `state === "finished"` vía `hc rm`.
   - Poda entradas huérfanas de `file-viewer.meta` cuyos `paneId` ya no existen en `panes()`.
   - Cuando la RAM del sistema alcanza `>= 75 %`, tras limpiar terminales o al pulsar el botón manual `GC`, incrementa `shared("herdr.gc")`.

---

## 4. Decisiones de Arquitectura (`D1`–`D19`)

| ID | Decisión | Alternativa descartada y motivo |
| --- | --- | --- |
| **D1** | Nunca editar layouts o mods nativos de Herdr (`main.json`, `files`, `pane`, `tabs`, `changes`); trabajar siempre sobre clones enlazados por symlink. | Editar archivos nativos provocaba pérdida de cambios o renombrado automático a `*-edited` en cada inicio/actualización de Herdr App. |
| **D2** | Reemplazar el modo Tiling (`tiling-mode` + `Ctrl+Space`) por atajos directos de pestañas (`Ctrl+T`, `Ctrl+W`, `Ctrl+Shift+T`) y navegación/intercambio de paneles con flechas (`Alt + ←/↓/↑/→`, `Alt + Shift + ←/↓/↑/→`). | El HUD modal de tiling añadía fricción innecesaria frente al flujo directo de pestañas y flechas; además se sincronizan en `"global"` y `palette` para que `Ctrl+Shift+P` refleje las asignaciones reales. |
| **D3** | Compactar `material-icons.js` con formato invertido y carga perezosa (`Map` + `releaseIconCache()`), generando una copia sin carpetas para `changes-history`. | Los objetos literales originales ocupaban `842 KB` entre dos VMs y asignaban ~51.500 propiedades al arranque aunque el panel derecho estuviera oculto. Además, el sandbox de Herdr prohíbe importar `.js` fuera del directorio del propio mod. |
| **D4** | Unificar todos los controles del visor (`Preview`/`Raw`, `Wrap`, `− % +`, `zoom`, splits, `×`) en la única barra superior de `pane-custom` y mantener los 4 botones de acción montados con opacidad `0.4` en reposo. | Tener barra propia en `file-viewer` duplicaba encabezados, y montar los botones solo en hover causaba saltos horizontales (`layout shift`) debajo del cursor. |
| **D5** | Buffer único en `file-viewer`: `Uint32Array` para saltos de línea en código y creación diferida de `EditorState` mediante `cx.spawn` + `await cx.sleep(0)` al pasar de `Preview` a `Raw`. | Mantener `rawText` + `EditorState` duplicaba el consumo de RAM; además, GPUI prohíbe invocar `EditorState.new(...)` y `cx.notify()` de forma síncrona dentro de `render()`. |
| **D6** | Previsualizar imágenes/SVG/PDF mediante staging temporal en `~/.config/herdr-app/data/fv-preview/`, con symlinks locales (cero copia) y reescalado de `width`/`height` a `1024 px` preservando `viewBox` en archivos `.svg`. | `gpui-kit` resuelve `image(...)` relativo a `~/.config/herdr-app/` y rasteriza los SVG a su tamaño intrínseco (p. ej. `24×24`), produciendo imágenes borrosas al ampliarlas sin reescribir las dimensiones. |
| **D7** | Renderizado de PDF página a página con `pdfinfo` + `pdftoppm`, conservando un único PNG activo en disco y borrando el anterior al cambiar de página o hibernar. | Convertir todo el PDF de golpe multiplicaría el uso de disco y RAM en documentos extensos. |
| **D8** | Grilla CSV/TSV paginada de a `200` filas (`MAX_CSV_ROWS = 5000`, `MAX_CSV_COLS = 60`), con caché LRU de hasta `200` valores únicos escaneando máximo `2500` filas, filtros Excel por columna, autocompletado `@Col:val1,val2` con soporte de comillas y navegación `Tab`/`Enter`. | `v_virtual_list` colapsaba a altura cero con celdas interactivas dentro de scroll horizontal; la paginación de 200 filas garantiza altura estable, interacción completa y RAM acotada. |
| **D9** | Edición en `file-viewer` (tanto en modo `Raw`/código como en celdas CSV) con indicador `*`, `Ctrl+S` para guardar vía `writeTextFile` (o `exec` en SSH), `Discard` para revertir y bloqueo de hibernación mientras exista estado sucio. | Evita pérdidas accidentales de edición y protege archivos truncados (`> 250 KB`) dejándolos en solo lectura. |
| **D10** | Confirmación explícita obligatoria en `changes-history` antes de descartar cambios (`git checkout`), borrar archivos sin seguimiento (`git clean -fd`) o eliminar stashes (`git stash drop`). | Un clic accidental en `↺` o `×` destruía trabajo local de forma irreversible. |
| **D11** | Propagar la fuente global `settings().font_family ?? settings().font` en la raíz de todos los mods personalizados. | Sin `.font_family(...)` explícito, GPUI aplicaba la fuente UI por defecto (`Geist`) ignorando la fuente elegida por el usuario en `settings.json`. |
| **D12** | Leer props de mod siempre con `(initialProps && Object.keys(initialProps).length ? initialProps : null) ?? props()` y truncar `args` de `ps` mediante `awk` en `system-monitor`. | En `tab.new { mod, props }`, `init(initialProps)` puede llegar vacío mientras `props()` contiene el payload real; además, `ps` sin truncar generaba ~85 KB de texto cada 3 s. |
| **D13** | Integrar búsqueda e inspección de Pull Requests de GitHub en `mods/changes-history/github.js` mediante `gh` CLI bajo demanda (carga perezosa al abrir la sección `Pull Requests`). | Consumir la API REST/GraphQL manualmente exigiría almacenar tokens propios y duplicar autenticación; `gh` reutiliza el keyring local y funciona de forma transparente en repositorios SSH vía `exec(..., { cwd, on })` sin consumo en segundo plano cuando la sección está cerrada. |
| **D14** | Reemplazar cualquier intento de navegador embebido por el popup ligero `mods/web-launcher/` (abierto desde el botón `Web` de `tabs-custom`), con detección automática de URL en el portapapeles, selector de perfiles reales de Chrome (`~/.config/google-chrome/Local State`) + `Clean` efímero, y lanzamiento como pestaña normal o ventana `--app`. | GPUI (`gpui-kit`) carece de WebView nativo; renderizar páginas por capturas JPEG no reemplaza la fluidez/audio de un navegador real y consume procesos extra. Un lanzador popup efímero aporta cero RAM en reposo y acceso en un clic al navegador real con el perfil deseado. |
| **D15** | Incorporar `mods/ports-monitor/` como bloque independiente en la barra lateral izquierda (junto a `system-monitor` y `agents-custom`), haciendo que los tres bloques soporten colapso/modo compacto vía `layout.resize` y deteniendo por completo el polling de `system-monitor` y `ports-monitor` cuando están minimizados. | Unificar puertos dentro de `system-monitor` saturaría el panel y acoplaría dos responsabilidades distintas; mantenerlos separados con colapso real y pausa de muestreo (`ss`/`ps`) garantiza bajo consumo de CPU/RAM y máximo espacio útil en el sidebar. |
| **D16** | Enlazar `Ctrl + Shift + P` al overlay efímero `mods/command-palette/` con soporte de prefijo `>`, aliases configurables en `command-aliases.json` y diálogo de creación/edición rápida (`micro`/`nano`), manteniendo además entradas `"palette"` en los `mod.json` para compatibilidad con `app.palette`. | La paleta nativa `app.palette` solo filtra comandos estáticos y no permite interceptar `>` para ejecutar comandos arbitrarios en terminal ni cargar aliases desde un archivo externo configurable. Un overlay efímero (`"place": "none"`) consume cero RAM en reposo y funciona incluso cuando el panel `Files` está oculto. |
| **D17** | Configurar `sidebar-lists` con `"resizable": false`, definir `agents`, `system-monitor` y `ports-monitor` en `px` con `spaces` como único bloque elástico (`weight: 1`, `min: 90`), e implementar un manejador superior de *resize por empuje* (`stack-resize.js` duplicado por mod debido al sandbox). | El divisor nativo de GPUI/Herdr solo redimensiona bloques inmediatamente adyacentes, por lo que quedaba bloqueado cuando el bloque superior estaba en su mínimo o encogía al vecino en lugar de empujarlo hacia arriba preservando su tamaño actual. |
| **D18** | Montar `docker-monitor` y `ai-usage` como bloques `docker` y `usage` al final de `sidebar-lists` (en `px`, mínimo `64`), con modo compacto/colapsado, *resize por empuje* (`STACK` ampliado en las 5 copias de `stack-resize.js`) y filas Docker de una línea (nombre, CPU, RAM) que se expanden al pasar el mouse. | Como hijos del stack derecho `panel-body` quedaban ocultos tras un botón y competían con `Files`/`Changes`; el usuario quiere verlos siempre junto a `system-monitor` y `ports-monitor`. El colapso reduce el muestreo para acotar el costo de mantenerlos visibles. |
| **D19** | Agregar el uso de IA en `mods/ai-usage/collect.mjs` (Node resuelto desde `ai-usage.json` → `command -v` → `$SHELL -ic 'which …'`) con caché incremental en `data/ai-usage/`, y obtener las cuotas con los comandos locales `claude -p /usage --no-session-persistence` y `agy -p /usage --output-format json`. | Leer ~200 MB de JSONL o abrir SQLite dentro del sandbox GPUI disparaba la RAM del mod y el runtime no tiene `node:sqlite`. El endpoint OAuth no documentado (`api/oauth/usage`) exigía leer el token de `~/.claude/.credentials.json`; los CLIs oficiales responden sin turno de modelo (0 tokens). `claude /usage` solo entrega texto, por lo que su parser puede romperse si cambia el formato: ante error se muestran las estimaciones locales. |
| **D20** | Ajustar el stack del sidebar al alto de la ventana con `fitStackToViewport()` (en `stack-resize.js`): lee `globalThis.window.viewport_size()` de GPUI, conserva el bloque recién expandido y achica los demás de abajo hacia arriba hasta `MINS`; `ai-usage` lo reevalúa cada 1 s para cubrir redimensionados de ventana. | Con cinco bloques en `px` fijos, expandirlos todos superaba el alto del sidebar y los últimos (`docker`, `usage`) quedaban fuera de pantalla; `window()` de herdr no expone dimensiones y el `window` importado oculta al global de GPUI. |
