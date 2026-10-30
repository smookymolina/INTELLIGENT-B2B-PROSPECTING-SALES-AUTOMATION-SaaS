# Fase 3 — perfil de empresa y catálogo

Estado: **IN_REVIEW** (inicio 2026-10-30; P3-01…P3-04 y P3-06 completos, P3-05 BLOCKED). Se inicia con Fase 2 en `IN_REVIEW` por indicación expresa del usuario; Fase 2 no se da por aceptada (CI remoto, `saas_admin`, revisión independiente pendientes). Fuente: `docs/modules/COMPANY_MANAGEMENT.md` y `docs/modules/PRODUCT_CATALOG.md`.

Reglas del módulo: precio, condiciones y disponibilidad sólo desde registros **aprobados**; catálogo versionado; importación idempotente con errores por fila; la IA citará IDs y responderá "sin evidencia" si faltan datos. No se inventan productos, precios ni datos comerciales: el catálogo nace vacío.

| ID | Trabajo | Estado | Evidencia / siguiente paso |
|---|---|---|---|
| P3-01 | Perfil de empresa (1:1) y sedes (alta, edición, deshabilitar; sin borrado) | COMPLETED | migración `company_profile`; `company.int.spec.ts` 24 pruebas (PUT idempotente, validación país/moneda/URL/zona horaria, 409 nombre duplicado case-insensitive, RBAC por rol, aislamiento API + RLS, auditoría sin valores). Suite 125/125 |
| P3-02 | Catálogo base: categorías, productos/servicios, características; `draft → approved → archived`; versiones inmutables | COMPLETED | migración `catalog_base` (RLS, grants por columna, triggers de inmutabilidad/rol/una-sola-borrador, FK compuesta tenant); `catalog.int.spec.ts` 28 pruebas: ciclo de versiones, 409 de transiciones, archivar/restaurar, concurrencia (1×200+1×409), inmutabilidad incl. dueño de tabla, `sales_manager` sin aprobar ni por SQL, matriz de 6 roles, aislamiento API+RLS, paginación por cursor, validación (rechaza `price`). Suite 153/153. Contrato: `docs/api/CATALOG_API.md` |
| P3-03 | Listas de precios y precios (decimal exacto, moneda ISO 4217) sólo consumibles si el ítem y la lista están aprobados | COMPLETED | migración `price_lists` (RLS, FK compuestas por tenant, triggers de inmutabilidad y de aprobación); `pricing.int.spec.ts` 40 pruebas: vista de consumo, inmutabilidad API+BD (incl. dueño), aprobación bloqueada con ítems no aprobados (API y SQL), carrera aprobar vs. editar, clon, validación decimal estricta, matriz de 6 roles, aislamiento API+RLS+FK, paginación, auditoría sin importes. Suite 193/193. Contrato: `docs/api/CATALOG_API.md` |
| P3-04 | Importación CSV validada: dry-run, errores por fila, idempotente | COMPLETED | migración `import_jobs`; parser RFC 4180 propio (`csv.spec.ts` 6 pruebas) e `import.int.spec.ts` 29 pruebas: dry-run sin efectos, apply sólo borradores, idempotencia por contenido e `Idempotency-Key`, actualización vía borradores, columnas gestionadas, todo-o-nada, 300 filas < 60 s, carrera de importaciones, errores por fila sin eco, rechazo de archivo (10 casos), límites/413, RBAC de 6 roles, aislamiento. Suite 222/222 + 7 unitarias. XLSX diferido |
| P3-05 | Documentos adjuntos (escaneados) | **BLOCKED** | Requiere decisión humana: almacenamiento de objetos y escáner antivirus (sin proveedor definido) |
| P3-06 | Contrato de evidencia para IA (refs citables / "sin evidencia") | COMPLETED | `GET /catalog/evidence`, `POST /catalog/evidence/resolve`; `evidence.int.spec.ts` 23 pruebas: nada se adivina, borradores nunca expuestos, versiones/archivado/restauración, precios (lista borrador/archivada/ajena/sin precio), citas current/superseded/archived/no_evidence, refs inventadas como respuesta, límites, 6 roles, aislamiento. Suite 245/245. El consumo real llega en Fase 6/10 |

## Decisiones tomadas en P3-01

- Escritura de perfil y sedes con el permiso existente `organization:update` (sólo `org_admin`); lectura con `organization:read` (todos los roles). RLS repite la regla de rol.
- Sedes no se borran (futuros registros las referenciarán): se deshabilitan. Unicidad por `name_key` normalizado (NFKC + minúsculas).
- `PUT /organization/profile` reemplaza el perfil completo; campos omitidos o `null` se limpian. La auditoría registra nombres de campos modificados, no valores.

## Evidencia (2026-10-30)

`npm run check` y `npm run db:test:setup && npm run test:int` (125/125, BD con 9 migraciones) — ver `logs/DEVELOPMENT_LOG.md`.
