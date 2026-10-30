# Interfaz web — ejecución

Estado: **IN_PROGRESS** (inicio 2026-10-30). Documento: `docs/modules/WEB_APP.md`.

| ID | Trabajo | Estado | Evidencia / siguiente paso |
|---|---|---|---|
| W-01 | Cimientos: BFF seguro, login/registro/salida, shell, vistas de lectura (inicio, catálogo, detalle, empresa) | COMPLETED | 9 unitarias + E2E 10 pasos sobre el stack real; `npm run check` |
| W-02 | Catálogo con escritura: crear/editar borrador, nueva versión, aprobar/archivar/restaurar, categorías (respetando permisos) | COMPLETED | formularios + route handlers `/actions/catalog/**` (lista cerrada de operaciones, Origin check, vocabulario fijo de errores); 13 unitarias; E2E 12 pasos: flujo completo de admin y lector que no ve controles y cuyas peticiones forzadas la API rechaza (403) |
| W-03 | Listas de precios (crear, precios, aprobar, archivar, clonar, vista de consumo) | COMPLETED | `/pricing/**` + `/actions/pricing/**` (lista cerrada de operaciones); E2E: flujo completo, aprobación bloqueada con ítem no aprobado, lista aprobada inmutable, clon, lector forzado → 403 |
| W-04 | Importación CSV de catálogo y de prospectos (pegar CSV, validar/aplicar, resultado con errores por fila) | COMPLETED | `/catalog/import`, `/prospects/import`; E2E: dry-run, aplicar, rechazo todo-o-nada sin eco de valores |
| W-F5 | Puntuación, atributos, respuestas y leads (`/scoring`, `/leads`, secciones en `/prospects/{id}`) | COMPLETED | E2E 17 pasos: modelo → atributo no verificado no puntúa → verificado puntúa 70 → umbral → evaluar (idempotente) → aceptar; respuesta positiva abre lead, baja lo cierra; viewer/seller sin controles y forzados → 403 |
| W-F4 | Prospectos: lista/filtros, alta, detalle con procedencia y estados, lista de no contactar | COMPLETED | `/prospects/**`; E2E 15 pasos en total (dedupe lleva al registro existente, supresión descalifica al instante, lector sin controles) |
| W-05 | Empresa: editar perfil y sedes | NOT_STARTED | |
| W-06 | Miembros e invitaciones; selector de organización | NOT_STARTED | Requiere `GET /me/organizations` (la API aún no lista las membresías propias con nombre) |
| W-07 | Endurecimiento: CSP con nonces, auditoría de accesibilidad WCAG, pruebas de navegador (Playwright) | NOT_STARTED | |

## Límites conocidos

Sin pruebas de componentes ni de navegador real todavía (W-07); el E2E actual verifica HTML, cabeceras y flujos por HTTP. Sin diseño visual validado con usuarios. Sin internacionalización (todo en es-MX).
