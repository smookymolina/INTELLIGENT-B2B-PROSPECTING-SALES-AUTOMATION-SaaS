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

## Listas de precios (P3-03)

Mismos permisos que el catálogo (ADR-018/019). Base `/v1/catalog/price-lists`.

- **Lista:** nombre único por organización (case-insens), **moneda ISO-4217 fija al crearla**, vigencia opcional (`validFrom/validUntil`, fechas `YYYY-MM-DD`), estados `draft → approved → archived`. Aprobada o archivada es **inmutable** (para cambiar: `clone`).
- **Precio:** un `unitPrice` por (lista, ítem), siempre **cadena decimal** (`"120.5"`; hasta 14 enteros y 4 decimales; sin números JSON, signos, exponentes ni comas); se devuelve normalizado a 4 decimales. No se modelan escalas, impuestos ni descuentos (el negocio no los ha definido).
- **Aprobar** (`org_admin`): exige ≥1 precio y que **cada ítem esté aprobado y no archivado**; si no, 409 con `details.skus` (hasta 20). El mismo control lo repiten triggers en BD.

| Ruta | Permiso | Notas |
|---|---|---|
| `GET/POST /catalog/price-lists`, `GET/PATCH …/{id}` | read / manage | cursor por `id`; PATCH sólo en borrador (nombre, vigencia) |
| `POST …/{id}/clone` | manage | nueva lista borrador con moneda, vigencia y todos los precios; sirve para cualquier estado |
| `POST …/{id}/approve`, `POST …/{id}/archive` | approve | 409 si el estado no lo permite |
| `GET …/{id}/entries` | read | cursor por `id` |
| `PUT …/{id}/entries/{itemId}` | manage | alta/actualización idempotente en borrador; ítem ajeno → 404; archivado → 409 |
| `DELETE …/{id}/entries/{itemId}` | manage | sólo en borrador |
| `GET …/{id}/approved-prices` | read | **vista de consumo** para cotizaciones/IA: lista aprobada (si no, 409) y sólo ítems **hoy** aprobados y no archivados; nombre y versión salen de la versión aprobada vigente |

Concurrencia: cada mutación bloquea la lista (`FOR UPDATE`); las entradas toman `FOR SHARE` en trigger, así una edición tardía durante la aprobación se rechaza en vez de perderse. Auditoría: `pricing.list_created|updated|cloned|approved|archived`, `pricing.price_set|updated|removed` con ids, nunca importes.
