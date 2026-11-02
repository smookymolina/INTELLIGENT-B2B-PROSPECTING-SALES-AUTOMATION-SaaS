# Log de desarrollo

| Fecha | Fase | Acción | Evidencia | Estado |
|---|---|---|---|---|
| 2026-10-30 | 0 | Auditoría inicial | sólo `promptmaestro.txt`; no `.git` | COMPLETED |
| 2026-10-30 | 0 | Base documental | archivos Markdown de contexto/docs/planning/agents | IN_REVIEW |
| 2026-10-30 | 1 | Autorización e inicio | autorización explícita de usuario; Git local inicializado, remoto registrado sin push | COMPLETED |
| 2026-10-30 | 1 | Fundación monorepo | en curso: workspaces, quality gates y contenedores locales | IN_PROGRESS |
| 2026-10-30 | 1 | Quality gate | `npm run check` pasó: lint, tipos, 1 test y builds | COMPLETED |
| 2026-10-30 | 1 | CI y seguridad | workflow CI, threat model y bitácora viva creados | COMPLETED |
| 2026-10-30 | 1 | Infraestructura local | Compose válido; PostgreSQL/Redis saludables y detenidos tras prueba | COMPLETED |
| 2026-10-30 | 1 | Cierre técnico | Fase pasa a IN_REVIEW; falta revisión independiente/documental | IN_REVIEW |
| 2026-10-30 | 1 | Cierre de fase | `npm run check` re-ejecutado (exit 0); fila de secretos corregida; Fase 1 COMPLETED | COMPLETED |
| 2026-10-30 | 2 | Esquema + migraciones | Prisma 7.10.1; `init_identity` y `rls_identity`; `migrate deploy` en BD vacía; sin deriva | COMPLETED |
| 2026-10-30 | 2 | Auth, tenant, RBAC, auditoría | módulos API + contratos zod; hallazgo: `/health` quedó privado por guard global → `@Public()` | COMPLETED |
| 2026-10-30 | 2 | Pruebas de aislamiento | 48/48 (24 BD como `app_runtime`, 24 HTTP); mutación: RLS off en `memberships` → 9 fallos | COMPLETED |
| 2026-10-30 | 2 | CI y documentación | `ci.yml` con PostgreSQL; docs/api/IDENTITY_API.md; ADR-008…012; CI remoto sin ejecutar | IN_REVIEW |
| 2026-10-30 | 2 | P2-12 throttle de login | migración `login_throttle` + `LoginThrottleService`; defecto hallado y corregido (`void` con `$queryRaw` → 500); `npm run test:int` 56/56 | COMPLETED |
| 2026-10-30 | 2 | P2-13 contrato operativo | filtro de errores, request id, idempotencia (migración `idempotency`), OpenAPI generado + paridad; `test:int` 73/73; ajustes de pruebas propias (longitud de contraseña, JSON malformado → 400 VALIDATION_FAILED) | COMPLETED |
| 2026-10-30 | 2 | P2-11 invitaciones | 3 migraciones (tabla, RLS+`invitation_accept`, corrección de ambigüedad plpgsql); defecto propio: `String.replace` convirtió `$$` en `$` al generar la migración → `migrate resolve --rolled-back` y regeneración; `test:int` 97/97 con BD de prueba recreada | COMPLETED |
| 2026-10-30 | 2 | P2-14 | cambio de organización implementado (`switch.int.spec.ts` 4 pruebas); `saas_admin` BLOCKED con opciones documentadas; Fase 2 → IN_REVIEW; `test:int` 101/101; `npm run check` exit 0 | IN_REVIEW |
| 2026-10-30 | 2 | Commit local | `11fe9d9` Fase 2 (incluye Fases 0–1 por no haber commits previos); sin push; `.gitattributes` fija LF | COMPLETED |
| 2026-10-30 | 3 | P3-01 perfil y sedes | migración `company_profile` (RLS + checks); `company.int.spec.ts` 24 pruebas; `test:int` 125/125; BLOCKED P3-05 (almacenamiento/antivirus) | COMPLETED |
| 2026-10-30 | 3 | P3-02 catálogo base | migración `catalog_base` (3 tablas, RLS, triggers); `catalog.int.spec.ts` 28 pruebas; ajuste propio de una prueba (FK vs regla de borrador único); `test:int` 153/153; matriz ADR-018 | COMPLETED |
| 2026-10-30 | 3 | Commit local | `5f61096` P3-01 + P3-02; sin push | COMPLETED |
| 2026-10-30 | 3 | P3-03 listas de precios | migración `price_lists`; `pricing.int.spec.ts` 40 pruebas; mutación: trigger de entradas desactivado → falla la prueba de inmutabilidad BD, restaurado → verde; `test:int` 193/193 | COMPLETED |
| 2026-10-30 | 3 | Commit local | `b6f51e8` P3-03; sin push | COMPLETED |
| 2026-10-30 | 3 | P3-04 importación CSV | refactor `…Tx` del catálogo (193/193 sin regresión); migración `import_jobs`; `csv.spec.ts` 6 + `import.int.spec.ts` 29; `test:int` 222/222 | COMPLETED |
| 2026-10-30 | 3 | Commit local | `99d9c41` P3-04; sin push | COMPLETED |
| 2026-10-30 | 3 | P3-06 evidencia | `evidence.service/controller` (sólo lectura, sin migración); `evidence.int.spec.ts` 23 pruebas; `test:int` 245/245; Fase 3 → IN_REVIEW (P3-05 BLOCKED) | COMPLETED |
| 2026-10-30 | 3 | Commit local | `9841477` P3-06; sin push | COMPLETED |
| 2026-10-30 | Web | W-01 cimientos | BFF Next.js (cookie httpOnly, Origin check, cabeceras), login/registro/salida, vistas de lectura; 9 unitarias; `npm run test:e2e` 10 pasos sobre API compilada + `next start`; CI ampliado | COMPLETED |
| 2026-10-30 | Web | W-02 catálogo con escritura | acciones por formularios con lista cerrada de operaciones y Origin check; 13 unitarias; E2E 12 pasos (admin completo + lector forzado → 403); hito 20 % (≈22 %) | COMPLETED |
| 2026-10-30 | 4 | P4-01 prospectos | migraciones `prospects` + `import_jobs_by_kind`; defecto hallado por la matriz de roles (RLS de import_jobs) corregido; `prospects.int.spec.ts` 22; `test:int` 267/267 | COMPLETED |
| 2026-10-30 | Web | W-03, W-04, W-F4 | precios, importaciones y prospectos en la web; `test:e2e` 15 pasos (incluye lector con peticiones forzadas); rebalanceo de pesos de la interfaz; hito 30 % (≈31 %) | COMPLETED |
| 2026-10-30 | 5/8 | P5-01 scoring + P8-01 leads | migraciones `scoring_and_leads` (+ RLS/triggers); motor y clasificador puros con 8 unitarias; `scoring-leads.int.spec.ts`; `test:int` 296/296; tres errores propios corregidos en pruebas (conteo, tipos SQL, caso de baja) | COMPLETED |
| 2026-10-30 | Web | W-F5 | scoring, atributos, respuestas y leads en la web; `test:e2e` 17 pasos; hito 40 % (≈40 %) | COMPLETED |
| 2026-10-30 | 9 | P9-01 CRM | migración `crm` (RLS por propietario, máquina de etapas, historial por trigger); `crm.int.spec.ts`; la tabla de transiciones del contrato = función de PostgreSQL (81 pares) | COMPLETED |
| 2026-10-30 | 10 | P10-01 cotizaciones | migración `quotes`; BigInt half-up cruzado con PostgreSQL; hallazgos propios corregidos en pruebas (etapas, parámetros SQL); `test:int` 333/333 | COMPLETED |
| 2026-10-30 | Web | W-F9, W-F10 | pipeline, enrutamiento, cotizaciones y ventas en la web; `test:e2e` 20 pasos; hito 50 % (≈54 %) | COMPLETED |
| 2026-10-30 | 11 | P11-01 analítica | servicio de lectura sin migraciones; `analytics.spec.ts` + `analytics.int.spec.ts`; `test:int` 345/345; web `/analytics` con E2E de 21 pasos | COMPLETED |
| 2026-10-30 | Web | W-05, W-06 | migración `my_organizations` + `GET /me/organizations` (prueba de integración); empresa editable, `/team`, aceptación de invitaciones y selector de organización; el código de invitación sólo viaja en la respuesta `no-store`; `test:int` 346/346, unitarias 20+16, `test:e2e` 24 pasos; hito 60 % (≈60 %) | COMPLETED |
| 2026-10-30 | Web | W-07 (parcial) CSP con nonces | `apps/web/proxy.ts` genera nonce por petición y fija la CSP (script-src 'self' nonce strict-dynamic; style-src nonce; style-src-attr inline sólo para atributos); CSP estática movida fuera de `next.config.mjs`; foco visible en textarea; `test:e2e` 25 pasos (nonce distinto por petición, todos los scripts con nonce, sin unsafe-inline/eval); a11y en navegador real y Playwright pendientes | IN_PROGRESS |
| 2026-10-30 | 12 | P12-01 cuenta, P12-02 operación | migración `account_security`; sesiones propias, cambio de contraseña con revocación global y throttle compartido; `/health/ready` y `/health/metrics` (token); web `/account`; `test:e2e` 26 pasos; detalle en `planning/PHASE_12_EXECUTION.md` | COMPLETED |
| 2026-10-30 | 9/11 | P9-02 tareas, P11-02 exportación | migración `crm_tasks` (RLS + trigger); `tasks.int.spec.ts` 6, `export.int.spec.ts` 3, `csv.spec.ts` 3; web `/tasks`, `/export/*`; `test:e2e` 28 pasos | COMPLETED |
| 2026-10-30 | 6 | P6-01 puerta de entrada de IA | migración `ai_gateway`; permisos `ai:use`/`ai:manage`; presupuesto deny-by-default, evidencia aprobada, PII, esquema, cifras, libro append-only; adaptador `mock` únicamente; `test:int` 380/380, unitarias 33+16, `test:e2e` 29 pasos; ADR-028 | COMPLETED |
| 2026-10-30 | 7 | P7-01 contactos/consentimiento, P7-02 campañas | migraciones `campaigns_consent` + `contacts_optout_guard`; elegibilidad en 4 momentos, baja pública firmada, canal sandbox; hallazgo propio: `null ?? x` trataba «elegible» como «sin dato» (corregido y cubierto); `test:int` 391/391, unitarias 33+16, `test:e2e` 30 pasos; ADR-029; hito 70 % | COMPLETED |
| 2026-10-30 | 12 | P12-03 guarda de roles; reconciliación de documentos | arranque verifica `app_runtime` y rechaza conexión privilegiada con `REQUIRE_UNPRIVILEGED_DB_ROLE=1`; `CURRENT_STATUS.md` reescrito (era obsoleto); métrica doble interno/operable (60–70 % / ≈30 %) tras revisión independiente | COMPLETED |
| 2026-10-31 | 12 | Contenedores + logs estructurados | `Dockerfile` multi-etapa (targets `migrate`, `api`, `web`, usuario no root), `docker-compose.yml` con perfil `app`, `scripts/db-provision-login-role.mjs` (rol `app_login` sin superusuario/BYPASSRLS), `API_HOST`, `StructuredLogger` con redacción (4 pruebas). Verificado: build de las 3 imágenes, stack completo healthy con `REQUIRE_UNPRIVILEGED_DB_ROLE=1`, registro + `GET /prospects` por la conexión de mínimo privilegio, web 200 con CSP | COMPLETED (local; sin escaneo de imágenes ni registro remoto) |
| 2026-11-02 | 10 | PDF de cotización | `GET /quotes/{id}/pdf` (renderer propio sin dependencias, importes del servidor, `no-store`, auditado `quote.pdf_downloaded`, RLS); `quote-pdf.spec.ts` 3 + prueba de integración (tenant ajeno 404, sin token 401); OpenAPI regenerado; `test:int` 400/400. Sin firma ni envío por correo | COMPLETED |
