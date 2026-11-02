# Instrucciones de agentes

Leer primero `context/CURRENT_STATUS.md`, este archivo y sólo los documentos listados en la tarea. No cargar el árbol completo.

- Trabajar en una tarea con responsable y criterio de aceptación; no editar archivos ajenos sin coordinación.
- Mantener TypeScript, modular monolith, contratos versionados, aislamiento por `organization_id`, RBAC y auditoría.
- Nunca asumir consentimiento, inventar datos comerciales/precios ni eludir controles de proveedores.
- Antes de integrar: pruebas pertinentes, revisión cruzada y actualización de `logs/DEVELOPMENT_LOG.md` y estado.
- Cambios de arquitectura: registrar ADR breve en `context/PROJECT_DECISIONS.md`.

Fase actual: ver `context/CURRENT_STATUS.md`. Fase 1 cerrada; Fase 2 (identidad/tenancy) en curso. Sin proveedores externos, credenciales reales ni push sin autorización explícita.

## Regla de orden: frontend al final
El trabajo de interfaz web (`apps/web`) se hace **al final**, después de que el backend (API, RLS, contratos, pruebas, operación) esté completo y auditado. Mientras tanto, la web sólo recibe correcciones mínimas para no romper el contrato; no se abren módulos nuevos de interfaz ni se pule la UX. Si una tarea mezcla ambos, se hace primero la parte backend y la web queda en `WEB_EXECUTION.md` como pendiente.
