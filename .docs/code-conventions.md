# Convenciones de Código y Restricciones de GPUI (`my-herdr`)

Reglas obligatorias al escribir, modificar o revisar cualquier mod o script de este repositorio.

---

## 1. Restricciones Estrictas del Runtime `gpui-kit` / `herdr`

1. **Sin DOM, HTML, CSS ni temporizadores de navegador:** no existen `document`, `window` de navegador, `setTimeout` ni `setInterval`. Usar `cx.timer.every(...)`, `cx.spawn(...)` y `cx.sleep(...)`.
2. **Nunca retener `cx` fuera del callback actual:** cada evento, timer o `cx.spawn` entrega su propio `cx`.
3. **Nunca invocar `cx.notify()` ni `EditorState.new(...)` durante `render()`:**
   - Los helpers invocados desde `render()` deben recibir `fromRender = true` y omitir `cx.notify()`.
   - Cualquier creación de `EditorState` disparada desde `render()` debe ejecutarse en `cx.spawn(async cx => { await cx.sleep(0); ... })` para ceder primero al event loop.
4. **Colores válidos de GPUI:** nunca pasar `"transparent"` a `.bg(...)`. Usar `.when(cond, el => el.bg(color))` y tokens de `theme()` (`background`, `chrome`, `surface`, `raised`, `hover`, `selected`, `border`, `foreground`, `muted`, `dim`, `accent`, `accent_foreground`, `solid`, `solid_foreground`, `selection`, `ansi1..6`, `blocked`, `done`, `working`).
5. **Métodos válidos sobre `image(...)`:** `gpui-kit` no expone `.object_fit(...)`; controlar proporciones mediante `.w(w).h(h)`. Las rutas de `image(...)` y `svg(...)` son siempre relativas a `~/.config/herdr-app/`.
6. **Contenedores con scroll horizontal:** todo `h_flex()` con `.overflow_x_scrollbar()` dentro de un `v_flex()` debe llevar altura explícita (p. ej. `.h(36).flex_none()`) para evitar que se estire ocupando todo el eje vertical.
7. **Protección durante `herdr-app check`:** proteger todos los efectos secundarios (`exec`, `hc`, `writeTextFile`, timers, watchers) con `if (checking()) return;`.
8. **Lectura segura de `props`:** usar `(initialProps && Object.keys(initialProps).length ? initialProps : null) ?? props()`.
9. **Liberación obligatoria en `close()`:** liberar siempre `EditorState`, `InputState`, cancelar `watchFolder`, borrar archivos temporales en `data/fv-preview/` y vaciar cachés (`releaseIconCache()`).
10. **Fuente global y nitidez de SVG:** aplicar `.when(Boolean(fontFamily), el => el.font_family(fontFamily))` en la raíz de cada mod con `settings().font_family ?? settings().font`, y renderizar iconos SVG a múltiplos/divisores enteros (`16×16` o `15×15` px).
11. **Arrastres persistentes (`drag`) y foco por teclado:** todo divisor o resize que pueda salir del área del elemento debe usar `.on_window_mouse_move` + `.on_window_mouse_up("left")` y cancelar el arrastre si `e.pressed_button !== "left"`. Todo mod con `"focusable": true` debe adjuntar `.track_focus(this.handle)` y escuchar `"focus"` en `nextCommand()`.

---

## 2. Diseño de Código (`hbc-code-design`)

- **Modularidad:** separar motores de datos/búsqueda/preview (`search.js`, `preview.js`, `material-icons.js`) de la capa de vista GPUI (`main.js`).
- **Control de flujo plano:** máximo 2 niveles de anidamiento; usar *guard clauses* y extraer funciones con nombres autoexplicativos.
- **Nombres precisos:** funciones como verbos (`parseCsvTable`, `stageImagePreview`), booleanos como preguntas (`isPaneVisible`, `hasLoadedContent`), constantes nombradas con unidades (`HIBERNATE_IDLE_MS`, `MAX_FILE_CHARS`).
- **Cero comentarios redundantes:** solo documentar el *por qué* de una restricción no obvia o contrato externo.
- **Límites explícitos en toda colección en RAM:** toda caché o historial (`Map`, `Set`, array en `shared`) debe tener cota superior y política de evicción (LRU o TTL).
- **Seguridad en shell (`exec`):** nunca interpolar entradas del usuario o nombres de archivo dentro del script shell; pasarlos siempre como argumentos posicionales (`"$1"`, `"$2"`) con `--`.

---

## 3. Estándar de Idiomas y Commits

- **Inglés:** `AGENTS.md`, código fuente, identificadores, textos técnicos/logs, Conventional Commits (`feat`, `fix`, `refactor`, `style`, `docs`, `chore`), `.agents/skills/*/SKILL.md` y `.agents/agents/*.md`.
- **Español neutro estándar:** `.docs/*.md`, `README.md` y conversación con el usuario (sin voseo ni regionalismos).
