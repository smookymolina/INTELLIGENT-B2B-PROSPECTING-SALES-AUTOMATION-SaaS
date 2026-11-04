# Auditoría de accesibilidad W-07 (WCAG 2.1 AA, automática propia + teclado)

Fecha: 2026-11-04. Script: `scripts/a11y-audit.mjs` (`node scripts/a11y-audit.mjs [--json]`, `--selftest` para el control negativo). Sale con código 1 si hay hallazgos críticos o serios.

## Método

- Chrome instalado en modo headless con `--remote-debugging-port` y perfil temporal (se borra al terminar). El script habla CDP por el `WebSocket` global de Node; sin dependencias nuevas (no se usó Playwright, axe ni jsdom).
- Registra una cuenta de prueba nueva en `/register` con credenciales aleatorias (no se imprimen ni se guardan) y crea un prospecto para disponer de página de detalle.
- Por página, en el DOM renderizado y con estilos computados: `html lang`, `title`, un `h1` y orden de encabezados, landmarks `main`/`nav`, nombre accesible de botones/enlaces/campos (label, aria-label, aria-labelledby, title), `alt` de imágenes, ids duplicados, `aria-*`/`role` inválidos o con referencias rotas, `aria-hidden` con contenido enfocable, tablas (th, scope, nombre), contraste de texto (4.5:1 normal, 3:1 grande; mezcla de fondos con alfa), tamaño de objetivo (24 px con la excepción de espaciado de 2.5.8), avisos sin región viva, formularios sin botón de envío y desbordamiento horizontal a 375 px.
- Teclado: hasta 90 pulsaciones de Tab reales (eventos de entrada CDP) por página; comprueba indicador de foco visible (outline o box-shadow), foco en elementos no visibles, trampas de foco y que el primer Tab llegue al enlace "Saltar al contenido".
- Control negativo (`--selftest`): una página deliberadamente defectuosa produce 15 tipos de hallazgo, así que el auditor no es ciego.

## Páginas (28)

Públicas: login, register. Autenticadas: inicio, prospectos (lista, alta, importar, supresiones, detalle), borradores (lista, alta), privacidad, ventas, precios, equipo, analítica (+ registros), empresa, cuenta, catálogo, pipeline, leads, tareas, campañas, puntuación, IA, 404 dentro del área autenticada (`/prospects/<uuid inexistente>`, `/drafts/new` sin contacto), 404 raíz y vista de 375 px. Rol: propietario de una organización nueva (vacía); `/quotes/[id]` y `/drafts/[id]` no se auditaron por no existir datos.

## Hallazgos antes / después

| Severidad | Antes | Después |
|---|---|---|
| Crítico | 1 (html sin `lang` en páginas 404) | 0 |
| Serio | 3 (404 sin h1/main; `/analytics/events` sin h1 en estados de error) | 0 |
| Moderado | 22 (enlace "IA" de 15x24 px; ver nota) | 0 |
| Menor | 0 | 0 |

Causas y correcciones:

1. **404 dentro del área autenticada sin `lang`, `h1` ni `main`**: la página servía el cascarón de error de desarrollo de Next porque el navegador accedía por `127.0.0.1` y Next bloqueaba recursos `/_next/*` entre orígenes (sin hidratación). Se añadió `allowedDevOrigins: ["127.0.0.1"]` en `apps/web/next.config.mjs` (solo afecta a desarrollo) y se crearon `apps/web/app/not-found.tsx` y `apps/web/app/(app)/not-found.tsx` con `h1`, texto y enlace de salida (el segundo sin `main` propio porque el layout ya lo aporta).
2. **`/analytics/events` sin `h1`** en los estados "sin permiso" y "métrica desconocida": se añadió un `h1` en `apps/web/app/(app)/analytics/events/page.tsx`.
3. **Objetivos pequeños** (enlace "IA" 15x24 px): el criterio 2.5.8 admite objetivos menores de 24 px si un círculo de 24 px centrado en ellos no toca otro objetivo; la barra de navegación tiene separación de 1 rem. El auditor se corrigió para aplicar esa excepción; no se cambió estilo. Es un ajuste del auditor, no del producto.
4. Falsos positivos descartados: el portal de herramientas de desarrollo de Next (`nextjs-portal`) captura el foco en dev y se excluye del recorrido por teclado; una página con un único elemento enfocable no cuenta como trampa de foco.

Base ya correcta (sin cambios): `lang="es-MX"`, enlace de salto, `nav aria-label`, `main#content`, etiquetas visibles en todos los campos, `caption`/`scope` en tablas, `role="alert"` en errores, anillo de foco de 3 px en todos los controles, contrastes por encima del mínimo.

## Verificación

`npm run lint`, `npm run typecheck` y `npm test` (20 unitarias) del workspace web pasan. No se ejecutó `test:e2e` por compartir puertos/BD.

## Límites honestos

- Es una auditoría automática propia más recorrido por teclado. **No sustituye** una prueba con lector de pantalla (NVDA/VoiceOver/JAWS), ni a axe-core/Lighthouse completos, ni a una revisión manual de WCAG.
- No cubre: orden de lectura semántico real, calidad del texto alternativo/etiquetas, comprensibilidad de errores, zoom 200 %/400 % más allá del chequeo de desbordamiento a 375 px, modo de alto contraste, movimiento reducido, estados temporales (toasts, diálogos), ni contraste de elementos no textuales (1.4.11) ni de fondos con imagen o degradado.
- Se ejecutó con un único rol (propietario) y datos mínimos: los estados "sin permiso" y las páginas con muchos datos (listas largas, tablas con filas) no se recorrieron todos. Los estados de error de otras páginas que usan un `<p role="alert">` sin `h1` no se ejercitaron.
- Se midió contra el servidor de desarrollo; el cascarón de error visto en 404 es una característica de dev y la corrección de `allowedDevOrigins` no cambia producción. Los 404 deberían reverificarse en una compilación de producción.
