# Auditoría independiente — 2026-11-04

## Veredicto

**Regular, con una base local ahora bien demostrada, pero lejos del objetivo operable.** La aplicación demuestra flujos internos, RLS endurecido, RBAC, worker y campañas protegidas. No demuestra el MVP de descubrimiento permitido ni envío por canales oficiales. No hay producción, CI remoto ejecutado, proveedor real ni webhooks. El 74 % interno es plausible sólo como dominio local; el 33 % «operable real» sigue alto: hoy un cliente no puede operar extremo a extremo.

## Requisitos verificables y contraste

| Requisito extraído de visión/alcance/seguridad | Estado | Evidencia independiente |
|---|---|---|
| Catálogo, precios aprobados, CRM, cotización, venta y embudo | CUMPLIDO local | E2E: F10 y F11, 33/33; `apps/api/src/test/quotes.int.spec.ts`, `analytics.int.spec.ts`. |
| Identidad, RBAC y tenant desde sesión, no body | CUMPLIDO local | Las 56 tablas tienen RLS; 52 de negocio tienen `organization_id`, 4 globales (`organizations`, `users`, `sessions`, `login_attempts`) no lo requieren. E2E fuerza escrituras de viewer y las rechaza. |
| RLS y privilegio mínimo | CUMPLIDO local | Las 57 tablas tienen RLS. La nueva prueba `tenant-bypass.int.spec.ts` pasa: 34 tablas tenant con `FORCE RLS`, 18 excepciones documentadas por funciones `SECURITY DEFINER`, sin fuga por rutas ni contexto vacío. |
| Auditoría/trazabilidad e inmutabilidad | CUMPLIDO local | E2E comprueba exportación auditada; respaldo verificó migración y conteos. `audit_events` y los libros de consentimiento se ejercitan en `campaigns.int.spec.ts`. |
| Consentimiento explícito, baja y supresión antes de enviar | CUMPLIDO en sandbox | `campaigns.service.ts:170-182` revalida consentimiento, baja, supresión y frecuencia justo antes de `send`; `campaigns.controller.ts:79-82` exige `campaigns:approve`; E2E F7 pasó. |
| Nada se envía sin aprobación humana | CUMPLIDO en sandbox | Campaña: `campaigns.service.ts:146`; borrador: `drafts.controller.ts:47-51`. El adaptador en `campaigns/channels.ts:16-24` sólo guarda en memoria. |
| Descubrimiento/enriquecimiento permitido | AUSENTE | `prospects.service.ts:42-45` declara que no hay conector; sólo alta manual/CSV. |
| IA con evidencia, minimización y coste por tenant | SOLO MOCK/SANDBOX | E2E F6 pasó, pero `ai/providers.ts:26` es proveedor determinista offline; no hay modelo, tarifa ni evaluación real. |
| Email oficial, entrega/rebote y WhatsApp | AUSENTE | Sólo existe `sandbox` y sin `EMAIL_PROVIDER` devuelve 503 (`channels.ts:28-40`); no hay adaptador oficial ni webhooks. |
| Secuencias, tareas y notificaciones automáticas | CUMPLIDO en sandbox | Worker PostgreSQL con leases, `SKIP LOCKED`, reintento, DLQ, métricas y auditoría; `worker.int.spec.ts` pasó dentro de 489/489. No está desplegado ni usa canal real. |
| Privacidad, retención y derechos | PARCIAL | Mecanismo y rutas existen; faltan jurisdicción, aviso y plazos de retención decididos. No es cumplimiento legal verificable. |
| Respaldo/restauración | CUMPLIDO local | Ejecutado contra `prospecting_audit_test`: 56 tablas, 14.422 filas; SHA-256, conteos y última migración coinciden; BD temporal eliminada. Sin cifrado/copia externa. |
| Web accesible y operación productiva | PARCIAL | E2E web 33/33; no evidencia de Playwright/axe oficial, despliegue, IdP, observabilidad operativa ni CI remoto. |

## Pruebas ejecutadas

Reauditoría ejecutada con `npm run ci`, BD propia `prospecting_audit2_test`: migraciones desde cero, `check`, integración, build, E2E, respaldo y restauración. Integración: **489/489, 32 archivos, 6m10s**; el valor anterior 453 quedó superado por 36 pruebas nuevas. E2E: **33/33**. Respaldo/restauración: **57 tablas, 9.846 filas**, hash, conteos y última migración coincidentes; la BD temporal y la BD auditada se eliminaron. La CI evita el timeout artificial mediante latidos y registros por etapa. Dos CI concurrentes comparten `ci-logs`, por lo que esos logs deben aislarse por ejecución antes de producción. No se hallaron `TODO`, `FIXME` ni `.skip(`; `.env` continúa ignorado y no versionado.

## Top 10 hallazgos/riesgos

1. **Crítico:** no hay proveedores reales de datos, IA ni canales; elegir, contratar y probarlos con términos/consentimiento.
2. **Crítico:** no hay nube, IdP, despliegue, CI remoto ni operación de incidentes; decidir región, responsable y SLO.
3. **Alto:** CI remoto sigue sin ejecutarse; hacer push autorizado, proteger rama y revisar artefactos/resultado remoto.
4. **Medio:** 18 tablas tenant dependen de excepciones `SECURITY DEFINER`; mantener la lista mínima y someterla a revisión externa de seguridad.
5. **Alto:** worker/cola está probado sólo localmente; desplegarlo, supervisarlo y alertar DLQ antes de automatizar operación.
6. **Alto:** privacidad carece de jurisdicción, aviso, plazos y proceso legal aprobado.
7. **Medio:** sin webhooks firmados de entrega/rebote ni outbox real; no se puede medir entrega/respuesta.
8. **Medio:** respaldo local sin cifrado ni copia externa; definir RPO/RTO, cifrado y restauración fuera del equipo.
9. **Medio:** accesibilidad sólo auditada internamente; ejecutar Playwright/axe y revisión manual con lector de pantalla.
10. **Medio:** `saas_admin` sigue sin alcance ni controles de soporte; decidir modelo de grants temporales y auditoría visible.

## Estimación propia

Fórmula: pesos del roadmap (98 puntos) × evidencia reproducida; mock/sandbox aporta como máximo 25 % al avance interno y 0 % al operable real; producción/proveedor/decisión legal ausente aporta 0 %. Resultado: **interno 68–72 %** (declarado 64–75 %, compatible como máximo local) y **operable real 22–27 %** (declarado 28–35 %, sobreestimado: F4/F6/F7/F12 esenciales aportan casi cero real).

Decisiones humanas que más desbloquean: (1) canal, fuente de datos e IA autorizados con presupuesto y términos; (2) nube/IdP/región/SLO y responsable operativo; (3) jurisdicción, aviso y retención; (4) política `saas_admin`; (5) almacenamiento, antivirus, firma/pagos. Orden recomendado: 1 → 2 → 3, pues sin ellos no puede probarse ningún flujo comercial real ni cumplimiento.
