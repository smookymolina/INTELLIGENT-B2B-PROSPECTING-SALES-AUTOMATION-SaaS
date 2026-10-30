# API de catálogo (v1, Fase 3 / P3-02)

Base `/v1/catalog`. Tenant derivado de la sesión. Contrato ejecutable: `docs/api/openapi.v1.json`. Sin precios todavía (P3-03): un campo `price` se rechaza con 400.

## Permisos (ADR-018)

| Permiso | Roles | Permite |
|---|---|---|
| `catalog:read` | los 6 roles | listar y leer categorías, ítems y versiones |
| `catalog:manage` | `org_admin`, `sales_manager` | crear categorías/ítems, editar borrador, iniciar nueva versión |
| `catalog:approve` | `org_admin` | aprobar, archivar, restaurar |

RLS y triggers repiten la regla: `sales_manager` no puede aprobar/archivar ni con SQL directo.

## Modelo

- **Ítem** (`product` | `service`, `sku` único por organización sin distinguir mayúsculas, inmutable) con **versiones**. Estado derivado: `archived` si `archivedAt`; `approved` si hay `approvedVersion`; si no, `draft`.
- Versión: `draft` (editable, una sola abierta) → `approved` (inmutable) → `superseded` (al aprobar la siguiente). Contenido: nombre, descripción, unidad (texto libre), categoría activa, hasta 50 características únicas `{name,value}`.
- `approved` en la respuesta es **la única fuente consumible** por cotizaciones/IA: es `null` si no hay versión aprobada o el ítem está archivado.

## Endpoints

| Ruta | Permiso | Notas |
|---|---|---|
| `GET/POST /catalog/categories`, `PATCH /catalog/categories/{id}` | read / manage | nombre único (case-insens) → 409; `status: disabled` impide asignarla |
| `GET /catalog/items?status&kind&categoryId&limit&cursor` | read | orden y cursor por `sku` (clave en minúsculas); `nextCursor` o `null` |
| `POST /catalog/items` | manage | crea ítem + versión 1 borrador; SKU duplicado → 409; categoría desconocida/ajena → 400 |
| `GET /catalog/items/{id}`, `GET …/versions` | read | 404 si es de otro tenant |
| `PATCH /catalog/items/{id}` | manage | edita el borrador abierto; 409 si no hay |
| `POST …/versions` | manage | nuevo borrador copiado de la última versión; 409 si ya hay uno |
| `POST …/approve` | approve | aprueba el borrador, reemplaza la aprobada previa; 409 sin borrador |
| `POST …/archive`, `POST …/restore` | approve | 409 si ya está en ese estado; archivado no se edita |

Sin DELETE: el historial es permanente. Concurrencia: cada mutación bloquea la fila del ítem (`FOR UPDATE`); aprobaciones o borradores simultáneos → uno gana, otro 409.

Auditoría: `catalog.category_created|updated`, `catalog.item_created|draft_updated|version_created|approved|archived|restored` (ids, versión y nombres de campos; nunca el contenido).
