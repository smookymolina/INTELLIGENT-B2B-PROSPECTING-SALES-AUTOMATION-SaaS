# Intelligent B2B Prospecting & Sales Automation SaaS

Base documental de un SaaS B2B multiempresa para descubrir, calificar y convertir prospectos con contacto autorizado. Estado: **Fase 0 / IN_REVIEW**. No hay código ni integraciones activas.

## Estado y arranque local

Estado actual: **Fase 1 / IN_REVIEW**. Hay una base web/API sin funcionalidades de negocio ni proveedores activos.

```powershell
npm ci --no-audit
npm run check
docker compose up -d
```

Servicios locales: PostgreSQL en `5432` y Redis en `6379`. Detenerlos con `docker compose stop`; no uses valores de `.env.example` en producción.

## Lectura mínima por tarea

1. `context/CURRENT_STATUS.md`, `AGENTS.md` y el documento del área.
2. El contrato o decisión enlazado por ese documento.
3. Actualizar estado y log al cerrar una tarea.

Índice: visión en `context/`; diseño en `docs/`; ejecución en `planning/`; coordinación en `agents/`.
