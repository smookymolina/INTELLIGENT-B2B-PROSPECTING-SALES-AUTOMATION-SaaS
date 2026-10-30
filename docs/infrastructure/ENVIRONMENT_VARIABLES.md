# Variables de entorno

Convención: sólo nombres, sin valores en repositorio: `DATABASE_URL`, `REDIS_URL`, `APP_URL`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `S3_*`, `OPENAI_*`, `ANTHROPIC_*`, `RESEND_*`, `META_WHATSAPP_*`, `WEBHOOK_SIGNING_SECRET`. Gestionarlas en vault; validar al arrancar; rotar y restringir por entorno/tenant.
