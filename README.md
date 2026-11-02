# Intelligent B2B Prospecting & Sales Automation SaaS

Base documental de un SaaS B2B multiempresa para descubrir, calificar y convertir prospectos con contacto autorizado. Estado: **Fase 0 / IN_REVIEW**. No hay código ni integraciones activas.

## Estado y arranque local

Estado actual: **Fase 1 / IN_REVIEW**. Hay una base web/API sin funcionalidades de negocio ni proveedores activos.

```powershell
npm ci --no-audit
npm run check
docker compose up -d
```

Pila completa en contenedores (API, web, migraciones, PostgreSQL, Redis): define `HMAC_SECRET` (≥32), `ENCRYPTION_KEY` (base64 de 32 bytes) y `APP_DB_PASSWORD` (≥16) en `.env` y ejecuta `docker compose --profile app up --build`. La web queda en `http://localhost:3000`; la API no se publica. El paso `migrate` aplica migraciones y crea el rol de login `app_login`, con el que corre la API (`REQUIRE_UNPRIVILEGED_DB_ROLE=1`).

Servicios locales: PostgreSQL en `5432` y Redis en `6379`. Detenerlos con `docker compose stop`; no uses valores de `.env.example` en producción.

## Lectura mínima por tarea

1. `context/CURRENT_STATUS.md`, `AGENTS.md` y el documento del área.
2. El contrato o decisión enlazado por ese documento.
3. Actualizar estado y log al cerrar una tarea.

Índice: visión en `context/`; diseño en `docs/`; ejecución en `planning/`; coordinación en `agents/`.
