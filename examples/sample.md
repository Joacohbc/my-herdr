# Demo de Preview Markdown

Este archivo sirve para validar el visor **Markdown** en `file-viewer` (`Preview` / `Raw` + zoom con `Ctrl + ruedita`).

## Características validadas

- [x] Renderizado nativo con `TextView.markdown`
- [x] Texto seleccionable y scroll suave
- [x] Toggle `Preview` / `Raw` sin doble buffer en RAM
- [x] Hibernación automática tras 45 s en tabs inactivas

## Ejemplo de código

```js
export function greet(name) {
  return `Hola ${name}, desde my-herdr!`;
}
```

> **Tip:** Probá hacer `Ctrl + clic` sobre cualquier archivo en `examples/` para abrirlo en una tab dedicada.
