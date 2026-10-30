# API v1

REST JSON bajo `/v1`; OAuth/sesión o API key con scopes; tenant derivado de credencial. Recursos: organizations, members, catalog, searches, prospects, enrichments, campaigns, messages, leads, opportunities, quotes, analytics. Comandos mutables aceptan `Idempotency-Key`; respuestas incluyen `request_id`; errores: `{code,message,details}` sin secretos. OpenAPI será el contrato ejecutable en Fase 1. Paginación cursor, filtros allowlist y rate limit por tenant/actor.
