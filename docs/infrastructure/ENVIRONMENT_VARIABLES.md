# Variables de entorno

Convención: sólo nombres, sin valores en repositorio: `DATABASE_URL`, `REDIS_URL`, `APP_URL`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `S3_*`, `OPENAI_*`, `ANTHROPIC_*`, `RESEND_*`, `META_WHATSAPP_*`, `WEBHOOK_SIGNING_SECRET`. Gestionarlas en vault; validar al arrancar; rotar y restringir por entorno/tenant.

## Variables añadidas (2026-10-30)

| Variable | Obligatoria | Efecto |
|---|---|---|
| `REQUIRE_UNPRIVILEGED_DB_ROLE` | **sí en producción** (`1`) | la API no arranca si `DATABASE_URL` usa un rol SUPERUSER/BYPASSRLS |
| `METRICS_TOKEN` | no (≥ 32 caracteres) | habilita `GET /v1/health/metrics` con Bearer; sin él responde 404 |
| `AI_PROVIDER`, `AI_FALLBACK_PROVIDER` | no | proveedor de IA (`mock` sólo para desarrollo/pruebas); sin él, 503 |
| `EMAIL_PROVIDER` | no | adaptador de correo (`sandbox` sólo para desarrollo/pruebas); sin él, el envío responde 503 |
| `PUBLIC_BASE_URL` | recomendada | base de los enlaces de baja en los mensajes (por defecto `http://localhost:3000`) |

