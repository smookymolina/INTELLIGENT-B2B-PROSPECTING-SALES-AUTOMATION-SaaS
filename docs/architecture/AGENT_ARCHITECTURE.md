# Arquitectura de agentes y del MCP (2026-11-02)

Objetivo: cerrar todo lo que se puede construir y probar **en local** sin decisiones humanas, con agentes de alcance exclusivo, y dejar el software listo para pruebas. Frontend al final (`AGENTS.md`). Mock/sandbox no cuentan como integración real. Eficiencia de tokens: skill `token-efficiency` (lectura mínima, Grep antes que Read, informes ≤150 palabras).

## 1. Agentes, objetivo y propiedad

| Id | Rol | Objetivo (entregable) | Es dueño de (no tocar fuera) |
|---|---|---|---|
| A0 | Arquitecto (orquestador) | Este documento, integración, suite completa, porcentaje, commit | docs/, planning/, logs/, commits |
| B1 | Backend: borradores de mensajes (P7-03) | Borradores personalizados de correo/WhatsApp, con elegibilidad, evidencia y aprobación humana | `apps/api/src/drafts/`, migración `20261102130000_message_drafts` |
| B2 | Backend: privacidad (P12-04) | Política de retención por organización + derechos del titular (acceso, restricción, supresión/anonimización) | `apps/api/src/privacy/`, migración `20261102140000_privacy` |
| O1 | Operaciones: respaldo/restauración (P12-05) | Scripts verificados de respaldo y restauración con prueba de restauración | `scripts/backup*.mjs`, `docs/infrastructure/BACKUP_RESTORE.md` |
| M1 | MCP (P7-04) | Servidor MCP stdio con 3 herramientas acotadas sobre la API de B1 | `apps/mcp/` |
| Q1 | Auditoría de seguridad/consentimiento | Hallazgos sobre B1, B2, M1 (consentimiento, supresión, PII, alcance del token, exfiltración) | sólo lectura (corrige únicamente en su informe) |
| Q2 | Auditoría de calidad funcional | Humo en vivo de todas las rutas nuevas + regresión | sólo lectura |

Compartido (editar sólo con `Edit` mínimo y anclas únicas, releyendo justo antes): `prisma/schema.prisma`, `packages/contracts/src/{index,openapi}.ts`, `apps/api/src/app.module.ts`. Cada agente usa **su propia base de pruebas** (`TEST_DATABASE_URL=postgresql://app:app@localhost:5432/prospecting_<id>_test`, creada con `node scripts/db-test-setup.mjs` con esa variable) y no toca `prospecting_test` ni la BD de desarrollo. Sólo A0 corre la suite completa.

## 2. Solución de 5 pasos (todo agente)
1. **Leer** lo mínimo: este documento, el doc específico y 1 módulo vecino como patrón.
2. **Diseñar** el cambio acotado (tablas, rutas, invariantes en la base) sin salir de su propiedad.
3. **Implementar** con RLS, auditoría, contratos zod y errores 4xx (nunca 500).
4. **Probar**: unitarias + integración propia contra su base; mutación breve de una invariante clave.
5. **Informar** (≤150 palabras): qué funciona (n), qué no, riesgos, archivos tocados. Sin commit ni edición de documentos vivos.

Agentes de auditoría: 1) inventario de rutas nuevas, 2) caso feliz en vivo, 3) abuso (cross-tenant, rol bajo, entradas hostiles), 4) revisión estática dirigida, 5) informe con severidad.

## 3. Dónde entra el MCP (y dónde no)
Uso **únicamente** para redactar mensajes personalizados de correo y WhatsApp, donde un modelo externo aporta valor y hay un humano que aprueba. No se usa para CRUD, analítica, administración, envío ni aprobación.

```
Claude (cliente MCP) ──stdio──> apps/mcp ──HTTPS+Bearer (usuario con campaigns:manage)──> API
   herramientas:                           GET  /contacts/{id}/outreach-context
   1 get_outreach_context                  POST /message-drafts            (author=mcp)
   2 save_message_draft                    GET  /message-drafts/{id}
   3 get_draft_status
```
- La API decide todo: elegibilidad (consentimiento vigente por canal, supresión, no contactar), hechos permitidos (evidencia aprobada), límites de longitud, variables de plantilla. El MCP no recalcula ni omite nada.
- Un borrador nace `pending_review`. **Aprobar/rechazar sólo por la API con `campaigns:approve`** (no existe herramienta MCP para ello). **No hay herramienta de envío**: el envío sigue siendo el canal `sandbox` del módulo de campañas; WhatsApp queda en «borrador» hasta que exista proveedor oficial (Meta Cloud API) y plantillas aprobadas.
- El contexto que sale hacia el modelo está minimizado: sin correo/teléfono completos (enmascarados), sin notas internas, sólo evidencia aprobada. Cada llamada queda auditada (`draft.context_read`, `draft.created` con `authorKind=mcp`).
- Seguridad: token por variable de entorno (nunca en argumentos ni logs), salida sin secretos, entrada validada con zod, límites de tamaño, tiempo de espera, y sólo `localhost` por defecto.

## 4. Orden de ejecución
Ola 1 (paralelo): B1, B2, O1. Ola 2: M1 (necesita el contrato de B1). Ola 3 (paralelo): Q1, Q2. Cierre: A0 (suite completa, OpenAPI, documentos, porcentaje, commit).

## 5. Fuera de alcance (depende de decisiones humanas)
Proveedores reales (datos, IA, correo, WhatsApp Cloud API), nube/IdP, plazos legales de retención (el mecanismo es configurable por organización; **sin plazos por defecto**), `saas_admin`, adjuntos/antivirus, pagos/firma, CI remoto/push.
