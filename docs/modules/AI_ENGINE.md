# M05 IA comercial
Objetivo: análisis asistido, no decisor opaco. Entidades: AIRequest, PromptVersion, AIResponse, ModelUsage, Evaluation. Adaptador recibe contexto mínimo, catálogo recuperado y esquema JSON; almacena modelo, versión, tokens, coste, latencia y evidencia. Reglas: no inventar; baja confianza/ambigüedad→revisión humana; PII minimizada. Aceptación: fallback, validación de esquema, trazabilidad y presupuestos por tenant.

## Estado de implementación (P6-01)

Implementada la puerta de entrada neutral (sin proveedor real): ver `planning/PHASE_6_EXECUTION.md` y ADR-028. Endpoints: `POST /ai/analyze` (`ai:use`), `GET /ai/runs`, `GET /ai/usage`, `PUT /ai/budget` (`ai:manage`). Roles con `ai:use`: org_admin, sales_manager, campaign_manager, seller. Entidades: `ai_budgets`, `ai_runs` (append-only).

