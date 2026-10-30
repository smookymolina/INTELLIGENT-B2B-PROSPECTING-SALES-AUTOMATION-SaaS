# Fase 4 — prospección

Estado: **IN_PROGRESS** (inicio 2026-10-30). Fuente: `docs/modules/GEO_PROSPECTING.md`, `docs/security/PRIVACY_AND_COMPLIANCE.md`. Guía de API: `docs/modules/PROSPECTING.md`.

Principios: un prospecto es un **candidato**, nunca un permiso de contacto; la procedencia se conserva; la lista de no contactar prevalece sobre cualquier calificación; no se llama a proveedores externos sin aprobación.

| ID | Trabajo | Estado | Evidencia / siguiente paso |
|---|---|---|---|
| P4-01 | Prospectos internos: alta manual, edición, estados, procedencia (append-only), dedupe por dominio o nombre+país, lista de no contactar con descalificación inmediata, importación CSV (dry-run, todo-o-nada, idempotente) | COMPLETED | migraciones `prospects` e `import_jobs_by_kind`; `prospects.int.spec.ts` 22 pruebas (normalización, dedupe, estados, supresión por API y por SQL directo, importación, matriz de 6 roles, aislamiento + RLS + FK/CHECK); E2E web 15 pasos. Suite 267/267. Defecto hallado por la prueba de roles: política de `import_jobs` sólo para gestores de catálogo → corregida por tipo |
| P4-02 | Búsqueda geolocalizada por conectores (colas, cuotas, términos de uso) | **BLOCKED** | Requiere decisión humana: proveedores de datos autorizados, credenciales, términos y cuotas. Existe el registro de conectores (vacío) y `GET /prospects/connectors` |
| P4-03 | Contactos (personas) con base legal y consentimiento por canal | NOT_STARTED | Depende de la decisión de jurisdicciones/aviso de privacidad (datos personales); no se modela hasta entonces |

## Decisiones

- ADR-023: permisos `prospects:read` (6 roles), `prospects:manage` y `suppressions:manage` (`org_admin`, `sales_manager`, `campaign_manager`), `suppressions:remove` (`org_admin`). La restricción "vendedores ven asignados" se aplicará a leads/oportunidades (F8/F9), no a candidatos.
- La clave de deduplicación (dominio, o nombre+país) vive en la base (CHECK de consistencia + unique), no sólo en la aplicación.
- Una entrada nueva en la lista de no contactar descalifica por trigger a los calificados que coinciden; calificar un suprimido se bloquea en API y en trigger.
