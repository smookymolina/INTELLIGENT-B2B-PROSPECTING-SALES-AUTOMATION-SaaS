# Fases

| Fase | Entregable verificable | Dependencia |
|---|---|---|
| 0 | documentación y auditoría | — |
| 1 | repositorio, CI, entornos locales | 0 aprobada |
| 2 | auth, RBAC, RLS probado | 1 |
| 3 | organización/catálogo/importación | 2 |
| 4–6 | datos, scoring e IA evaluada | 3 |
| 7–8 | campañas, canales, intención/leads | 4–6 |
| 9–11 | CRM, cotización, métricas | 8 |
| 12 | billing, seguridad, operación | 9–11 |

Estados permitidos: NOT_STARTED, IN_PROGRESS, BLOCKED, IN_REVIEW, COMPLETED.

## Orden de ejecución (decisión 2026-11-02): frontend al final
Todas las fases de dominio y operación (backend) se cierran y se auditan antes de continuar con la interfaz. La interfaz web es la última fase en ejecutarse; hasta entonces sólo se mantiene compatible con la API. Ver `AGENTS.md` y `planning/WEB_EXECUTION.md`.
