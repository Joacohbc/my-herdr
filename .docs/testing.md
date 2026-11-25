# Validación y Pruebas (`my-herdr`)

Protocolo obligatorio para verificar cualquier cambio antes de darlo por terminado o crear un commit.

---

## 1. Validación Estática y de Render Inicial (`herdr-app check`)

Ejecutar `herdr-app check` sobre cada mod modificado (o sobre los 6 mods tras cambios transversales):

```bash
for mod in files-search file-viewer pane-custom system-monitor changes-history tabs-custom; do
  herdr-app check ~/.config/herdr-app/mods/$mod || exit 1
done
```

> `herdr-app check` valida sintaxis, exportaciones, elementos GPUI y el primer `render()`. **No** ejecuta ramas diferidas (callbacks `on_click`, filas condicionales, previews cargadas asíncronamente), por lo que siempre debe combinarse con recarga en vivo.

---

## 2. Recarga en Vivo con Symlinks

Debido a que `~/.config/herdr-app/mods/*` son symlinks hacia `/home/joaco/projects/my-herdr/mods/*`, `inotify` en Linux no siempre detecta ediciones en el destino del symlink:

- **Para mods montados en el layout** (`files-search`, `changes-history`, `pane-custom`, `tabs-custom`, `system-monitor`):
  ```bash
  herdr-app do layout.switch '{"name":"main"}' && herdr-app do layout.switch '{"name":"my-herdr"}'
  ```
- **Para mods montados dentro de pestañas abiertas** (`file-viewer`, pestañas standalone de `changes-history`):
  ```bash
  touch -h ~/.config/herdr-app/mods/file-viewer && touch /home/joaco/projects/my-herdr/mods/file-viewer/main.js
  ```

---

## 3. Verificación de Estado, Errores y Captura Visual

```bash
herdr-app status
ls ~/.config/herdr-app/*.error 2>/dev/null || true
```

Criterios obligatorios:
- `"layout": "my-herdr"`
- `"errors": []`
- Ningún archivo `*.error` en `~/.config/herdr-app/`.

Cuando existan cambios visuales (UI, iconos, badges, tablas, alineación):

```bash
herdr-app shot /tmp/herdr-verify.png
```

Inspeccionar `/tmp/herdr-verify.png` para confirmar ausencia de recortes, saltos de layout o textos borrosos.

---

## 4. Verificaciones Específicas

- **Equivalencia de iconos tras modificar `scripts/build-icons.js`:** verificar contra la tabla fuente que el 100 % de las entradas (`FILE_NAMES`, `FILE_EXTS`, `FOLDER_NAMES`, `FOLDER_NAMES_OPEN`) devuelven la misma ruta SVG y que `releaseIconCache()` permite recargar sin fallos.
- **Limpieza automática de `herdr-core`:** comprobar que el contador de terminales `finished` se reduce a `0`:
  ```bash
  ~/.local/bin/herdr-core ls --all --json | python3 -c 'import sys,json; d=json.load(sys.stdin); print("total:", len(d["terminals"]), "finished:", sum(1 for t in d["terminals"] if t.get("state")=="finished"))'
  ```
- **Archivos de prueba locales:** el directorio local `examples/` (sin trackear en Git) contiene muestras (`sample.md`, `sample.csv`, `sample.tsv`, `sample.svg`, `sample.png`, `sample.jpg`, `sample.pdf`) para probar manualmente todas las vistas de `file-viewer`. Nunca incluir `examples/` en los commits.
