# Esquema de datos

Convenciones: UUID, `organization_id`, `created_at`, `updated_at`, soft-delete sólo cuando sea necesario y `audit_events` append-only. Índices compuestos comienzan por `organization_id`; FK, checks y unique scopes previenen corrupción.

Dominios: identidad (`organizations/users/memberships/roles`); catálogo (`products/price_lists`); prospectos (`prospects/source_records/attribute_values`); campañas (`campaigns/enrollments/messages`); ventas (`leads/opportunities/quotes/sales`); plataforma (`plans/usage_ledger`); transversal (`audit_events/outbox_events/idempotency_keys`). Datos de alta sensibilidad se cifran a nivel aplicación/columna cuando aplique.
