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
