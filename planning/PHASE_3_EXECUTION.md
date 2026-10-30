# Fase 3 — perfil de empresa y catálogo

Estado: **IN_PROGRESS** (inicio 2026-10-30). Se inicia con Fase 2 en `IN_REVIEW` por indicación expresa del usuario; Fase 2 no se da por aceptada (CI remoto, `saas_admin`, revisión independiente pendientes). Fuente: `docs/modules/COMPANY_MANAGEMENT.md` y `docs/modules/PRODUCT_CATALOG.md`.

Reglas del módulo: precio, condiciones y disponibilidad sólo desde registros **aprobados**; catálogo versionado; importación idempotente con errores por fila; la IA citará IDs y responderá "sin evidencia" si faltan datos. No se inventan productos, precios ni datos comerciales: el catálogo nace vacío.

| ID | Trabajo | Estado | Evidencia / siguiente paso |
|---|---|---|---|
| P3-01 | Perfil de empresa (1:1) y sedes (alta, edición, deshabilitar; sin borrado) | COMPLETED | migración `company_profile`; `company.int.spec.ts` 24 pruebas (PUT idempotente, validación país/moneda/URL/zona horaria, 409 nombre duplicado case-insensitive, RBAC por rol, aislamiento API + RLS, auditoría sin valores). Suite 125/125 |
| P3-02 | Catálogo base: categorías, productos/servicios, características; `draft → approved → archived`; versiones inmutables | COMPLETED | migración `catalog_base` (RLS, grants por columna, triggers de inmutabilidad/rol/una-sola-borrador, FK compuesta tenant); `catalog.int.spec.ts` 28 pruebas: ciclo de versiones, 409 de transiciones, archivar/restaurar, concurrencia (1×200+1×409), inmutabilidad incl. dueño de tabla, `sales_manager` sin aprobar ni por SQL, matriz de 6 roles, aislamiento API+RLS, paginación por cursor, validación (rechaza `price`). Suite 153/153. Contrato: `docs/api/CATALOG_API.md` |
| P3-03 | Listas de precios y precios (decimal, moneda ISO 4217) sólo consumibles si el ítem y la lista están aprobados | NOT_STARTED | Depende de P3-02 |
| P3-04 | Importación CSV validada: dry-run, errores por fila, idempotente (hash de archivo + claves naturales) | NOT_STARTED | XLSX diferido (ADR pendiente: superficie de ataque de parsers) |
| P3-05 | Documentos adjuntos (escaneados) | **BLOCKED** | Requiere decisión humana: almacenamiento de objetos y escáner antivirus (sin proveedor definido) |
| P3-06 | Recuperación de evidencia para IA (IDs citables / "sin evidencia") | NOT_STARTED | Depende de Fase 6; sólo se deja el contrato de lectura aprobada |

## Decisiones tomadas en P3-01

- Escritura de perfil y sedes con el permiso existente `organization:update` (sólo `org_admin`); lectura con `organization:read` (todos los roles). RLS repite la regla de rol.
- Sedes no se borran (futuros registros las referenciarán): se deshabilitan. Unicidad por `name_key` normalizado (NFKC + minúsculas).
- `PUT /organization/profile` reemplaza el perfil completo; campos omitidos o `null` se limpian. La auditoría registra nombres de campos modificados, no valores.

## Evidencia (2026-10-30)

`npm run check` y `npm run db:test:setup && npm run test:int` (125/125, BD con 9 migraciones) — ver `logs/DEVELOPMENT_LOG.md`.
