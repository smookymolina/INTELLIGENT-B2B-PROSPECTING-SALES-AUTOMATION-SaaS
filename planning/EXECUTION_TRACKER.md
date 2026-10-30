# Bitácora viva de ejecución

Última actualización: 2026-10-30 (Fase 1 cerrada; Fase 2 IN_REVIEW: `planning/PHASE_2_EXECUTION.md`). Este archivo es el índice operativo: evita releer historial conversacional. Detalle de Fase 1: `planning/PHASE_1_EXECUTION.md`; decisiones: `context/PROJECT_DECISIONS.md`; cambios: `logs/DEVELOPMENT_LOG.md`.

## Hecho

- Fase 0: especificación documental completa y tarea de auditoría independiente preparada.
- Fase 1: Git local/remote configurado sin push; monorepo npm (`web`, `api`, `contracts`); API `/v1/health`; web inicial; lockfile; `.env.example`; Compose PostgreSQL/Redis validado en estado `healthy` y detenido; CI; modelo de amenazas inicial.
- Validación 2026-10-30: `npm run check` pasó (lint, tipos, 1 prueba, builds API/web).

- Fase 1: COMPLETED (re-verificada con `npm run check`).
- Fase 2 (núcleo): esquema, migraciones, RLS, auth, RBAC, auditoría y contratos, throttle, idempotencia, OpenAPI, invitaciones y cambio de organización con 101/101 pruebas de integración.

- Fase 11: P11-01 analítica COMPLETED (345 integración; E2E 21 pasos). Web W-05 (empresa) y W-06 (equipo/organizaciones) COMPLETED (346 integración; E2E 24 pasos). W-07 parcial (CSP con nonces; E2E 25 pasos). Progreso global ≈61 % (`planning/PROGRESS.md`).
- Fases 9/10: P9-01 CRM/asignación y P10-01 cotizaciones/ventas COMPLETED (333 integración + 21 unitarias API + 18 web; E2E 20 pasos). Web W-F9/W-F10 COMPLETED. Progreso global ≈54 % (`planning/PROGRESS.md`).
- Fases 5/8 (internas): P5-01 scoring y P8-01 leads COMPLETED (296 integración + E2E 17 pasos); P5-02/P8-02 BLOCKED (proveedores/IA/canales). Progreso global ≈40 % (`planning/PROGRESS.md`).
- Fase 4: P4-01 prospectos internos COMPLETED (267 integración); P4-02 conectores BLOCKED. Web W-03/W-04/W-F4 COMPLETED (E2E 15 pasos). Progreso global ≈31 % (`planning/PROGRESS.md`).
- Fase 3: IN_REVIEW. P3-01…P3-04 y P3-06 COMPLETED (245 integración + 7 unitarias); P3-05 BLOCKED. Interfaz web W-01 COMPLETED (BFF seguro + vistas de lectura, E2E 10 pasos). W-02 catálogo con escritura COMPLETED (E2E 12 pasos). Progreso global ≈22 % (`planning/PROGRESS.md`). Detalle: `planning/PHASE_3_EXECUTION.md`.

## En curso

- Fase 2: IN_REVIEW. P2-01…P2-09, P2-11, P2-12, P2-13, P2-14a COMPLETED (101/101 pruebas de integración, `npm run check` exit 0). Pendientes: P2-10 (CI remoto), P2-14b `saas_admin` BLOCKED (decisión humana), revisión independiente.

## Siguiente, en orden (vigente 2026-10-30)

1. Estado y métricas vigentes: `context/CURRENT_STATUS.md` (las líneas «Progreso global» de arriba son historial por bloque, no el estado actual).
2. Trabajo local restante (sin decisión humana): cierre de documentación/consistencia, PDF de cotización local, retención y derechos del titular sobre contactos/consentimientos (requiere decisión de plazos), fusión de duplicados de prospectos.
3. Desbloqueos humanos, por impacto: producción (nube/IdP), proveedores de correo/WhatsApp, proveedor de IA, privacidad/retención, adjuntos/pagos, push para CI remoto, Playwright, `saas_admin`, revisión independiente.
4. Ningún proveedor externo se activa sin credenciales, aprobación y cumplimiento.

## Bloqueos/decisiones humanas

No bloquean la Fase 1: ICP/vertical inicial, proveedor cloud/IdP/pagos, política de retención, jurisdicciones, aviso de privacidad y cuentas de proveedor. No existe aún revisión independiente de Codex: la tarea está en `planning/CODEX_AUDIT_TASK.md`.
- Fase 12 (parte interna): P12-01 y P12-02 COMPLETED (`planning/PHASE_12_EXECUTION.md`). Progreso global ≈63 %.
- P9-02 (tareas) y P11-02 (exportación CSV) COMPLETED. Progreso global ≈63 %.
- Fase 6 (interna): P6-01 COMPLETED; P6-02/P6-03 BLOCKED por proveedor (`planning/PHASE_6_EXECUTION.md`). Progreso global ≈66 %.
- Fase 7 (interna): P7-01 y P7-02 COMPLETED; P7-03/P7-04 BLOCKED (`planning/PHASE_7_EXECUTION.md`). Progreso global ≈70 %. El 80 % ya no es alcanzable con trabajo interno: lo que falta depende de proveedores/decisiones (ver PROGRESS).
