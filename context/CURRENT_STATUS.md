# Estado actual

Fecha: 2026-11-11 (check 95/95, test:int 550/550, e2e 33 pasos; último `npm run ci` completo en la Ola 3; interno ≈71 %, operable ≈35 % — ver la sección «Olas 3 y 4»). **Fuente única del estado vigente**; el historial por bloque está en `logs/DEVELOPMENT_LOG.md` y el detalle por fase en `planning/PHASE_*_EXECUTION.md`. Git en `main`, con push a `origin/main` desde el 2026-11-11 (código de la Ola 4: `46192bf`); **resultado del CI remoto sin comprobar, sin despliegue**; único proveedor real verificado: SMTP.

## Avance (estimación ponderada, no medición; método en `planning/PROGRESS.md`)

| Métrica | Valor | Qué significa |
|---|---|---|
| Interno (dominio implementado y probado en local) | ≈ 71 % (rango 66–74 %) | incluye lo que depende de proveedores sólo por su dominio interno |
| Operable real (cliente real en producción) | ≈ 35 % (rango 30–40 %) | exige proveedores reales, nube, cumplimiento y revisión independiente; hoy sólo el correo SMTP está verificado en real |

Par vigente fijado por el dueño el 2026-11-11: **71 / 35**. Los porcentajes de secciones anteriores de este documento y de `planning/PROGRESS.md` son históricos.

## Evidencia local vigente

`npm run check` exit 0 · `docker compose config --quiet` exit 0 · `npm run test:int` 426/426 (27 archivos, PostgreSQL 18, migraciones desde cero) · unitarias 48 API + 12 MCP + 16 web · `npm run test:e2e` 30 pasos sobre API compilada + Next real. Esto es **local**: el CI remoto nunca se ejecutó.

## Por fase

- **Completo en local** (con sus límites): F1 infraestructura; F2 identidad/RLS (IN_REVIEW: falta CI remoto, `saas_admin`, revisión independiente); F3 empresa/catálogo (adjuntos BLOCKED); F9 CRM + tareas; F10 cotizaciones (PDF de descarga sí; sin firma/pagos/envío del PDF); F11 analítica + exportación CSV.
- **Dominio interno sin proveedor real**: F4 prospección (sin búsqueda externa), F5 scoring (sin enriquecimiento externo), F6 IA (sólo adaptador `mock`, tarifas sintéticas), F7 campañas (sólo canal `sandbox`), F8 leads por reglas (sin recepción por canal).
- **Parcial**: F12 (sesiones/contraseña, readiness, métricas; faltan nube, respaldo, retención, derechos del titular); web (W-07 parcial: CSP con nonces hecha; auditoría a11y en navegador real y Playwright pendientes).

## Bloqueos (decisión humana concreta)

1. Proveedor de datos/geografía → fuente, región, presupuesto, términos.
2. Correo y WhatsApp oficiales → cuentas, dominio verificado, plantillas, política de consentimiento.
3. Producción → nube, región, IdP, objetivos de disponibilidad, responsable operativo.
4. Privacidad → jurisdicciones, aviso, retención, proceso de derechos.
5. Adjuntos/cotizaciones → almacenamiento, antivirus, PDF, firma, pagos.
6. Autorizar push (CI remoto), política `saas_admin` (`docs/security/SAAS_ADMIN_DECISION.md`), revisión independiente (`planning/CODEX_AUDIT_TASK.md`), instalar Playwright (W-07).

## Riesgos conocidos

`app_runtime` depende de que todo acceso pase por `PrismaService` (no usar credenciales privilegiadas en producción) · `mock` y `sandbox` no validan calidad, coste ni entrega reales (se activan sólo con `AI_PROVIDER` / `EMAIL_PROVIDER`; sin ellos responden 503) · sin revisión legal ni de seguridad independiente.

## Auditoría backend (2026-11-02)
Revisión por módulos con agentes y pruebas en vivo (≈154 rutas): sin 500 residuales, aislamiento y permisos correctos, aritmética de cotizaciones exacta. **Sin verificar en vivo** por falta de proveedor: `POST /ai/analyze` (mock) y `dispatch` de campañas (sandbox); sólo cubiertos por pruebas automáticas. **Observaciones abiertas** (decisión de negocio): (resuelta 2026-11-02: `send` responde 409 si la oportunidad no puede pasar a `quote_sent`); el CSV de catálogo acepta nombres que empiezan por `=` (no hay export de catálogo). Esta auditoría no cambia los porcentajes: el avance interno se confirma en la parte alta del rango (≈ 70 %); operable real sigue ≈ 30 %.

Fusión de duplicados de prospectos (P5-02): enlace reversible y no destructivo (`prospect_merges`, triggers contra cadenas/dobles fusiones; listas y exportación ocultan el duplicado; nada se mueve ni se borra). Endpoints `POST /prospects/{id}/merge`, `GET /prospects/{id}/merges`, `POST /prospects/{id}/merges/{mergeId}/revert`.

## Ola de agentes (2026-11-02)
Nuevo: borradores de mensajes (`/message-drafts`, `/contacts/{id}/outreach-context`; correo y WhatsApp E.164, siempre `pending_review`, sin envío), servidor MCP `apps/mcp` (3 herramientas, contenido de terceros marcado `untrustedData`; 20 pruebas con la API real), privacidad (`/privacy/*`: retención sin plazos por defecto, acceso/restricción/borrado del titular con huella HMAC y borradores redactados), respaldo/restauración (`npm run backup`, `npm run backup:verify`; sin cifrar, sin copia externa, sin Redis). Auditorías Q1 (seguridad) y Q2 (15/15 rutas nuevas en vivo): 4 hallazgos medios corregidos. **Aceptado/pendiente:** el aprobador de un borrador puede ser quien lo creó (usar para el MCP un usuario `campaign_manager`, que no tiene `campaigns:approve`); `x-client-kind` es solo etiqueta; el chequeo de re-alta tras borrado usa una marca de transacción (protege contra descuidos, no contra un `app_runtime` malicioso). WhatsApp no tiene proveedor ni plantillas aprobadas: solo borradores. Porcentajes: interno ≈ 72 % (66–72), operable ≈ 33 % (28–35).

## Cierre 90 % (2026-11-04)
Hecho (sólo local, canal `sandbox`/in-app): P7-05 secuencias y horarios (4 tablas, RLS, `run-due` sin cron), P11-03 atribución último toque + cohortes (sólo lectura), P9-03 notificaciones in-app con preferencias, runbooks (`docs/infrastructure/RUNBOOKS.md`), W-07 auditoría de accesibilidad propia en Chrome headless (28 páginas, 0 críticos/serios/moderados; `docs/quality/A11Y_AUDIT.md`; NO sustituye axe ni lector de pantalla). Auditoría OWASP de lo nuevo: sin altos; el medio (tope de frecuencia ignoraba envíos de secuencia) corregido; bajo abierto: política `notifications_insert` permisiva a nivel de BD.
**Evidencia:** `check` exit 0 · `test:int` 453/453 (30 archivos) · unitarias 48 API + 12 MCP + 20 web · `test:e2e` 33 pasos · backup + `backup:verify` OK (56 tablas, 31 298 filas) · API reinicia y `/health/ready`=200 con Redis detenido (la API aún no usa Redis ni BullMQ).
**Carga local (1 equipo, 300 prospectos, sin extrapolar):** p95 GET /prospects 112 ms · analytics/overview 165 ms · attribution 111 ms · notifications 48 ms · POST /prospects 52 ms. Creación de borradores NO medida.
**Avance:** interno ≈ 74 % (rango 64–75; el 90 % NO se alcanza) · operable ≈ 33 % (28–35; nada nuevo depende de proveedores reales).
**BLOCKED por decisión (por impacto):** 1 proveedores de correo/WhatsApp/datos/IA (F4–F8) · 2 nube/IdP/disponibilidad (F12) · 3 plazos de retención y jurisdicciones · 4 política `saas_admin` · 5 adjuntos/antivirus/firma/pagos · 6 credenciales de push (CI remoto nunca ejecutado) · 7 Playwright/axe oficial. Sin worker/cron: `run-due` y `scanDue` no se disparan solos.

## Fases A y B del plan MVP (2026-11-04) — sin commit (pendiente de autorización)
**A. Evidencia y seguridad base.** `test:int` NO estaba colgado: tarda 5–6 min (el auditor excedió su límite de ejecución). Nuevo `npm run ci` (`scripts/ci.mjs`, `docs/infrastructure/CI.md`, workflow actualizado): BD limpia → migraciones → check → test:int → build → e2e → backup → restore-verify; última corrida **PASSED en 9m05s**: check 80/80 (48 API + 12 MCP + 20 web), test:int **489/489** (32 archivos), e2e OK, backup+verify OK. RLS: `FORCE` en 27 tablas más (33 de 56; 17 excepciones justificadas en ADR-030), `app_login` no es dueño ni superusuario, spec `tenant-bypass` (body/query/cabeceras/IDOR/membresía) sin fugas. Incidente de la corrida: las specs de `sequences`/`worker` fallaron en suite completa por mis cambios (excepción 404 no atrapada) y por un planificador global que se saturaba con cientos de organizaciones de otras specs; corregido en las pruebas, no en producción.
**B. Operación asíncrona.** Worker con cola en PostgreSQL (`jobs`, lease, backoff, DLQ, idempotencia por ventana; ADR-031, `docs/infrastructure/WORKER.md`, runbook R8), `npm run worker`. Se **eliminó** `POST /campaigns/{id}/sequence/run-due`: ningún envío ocurre en una petición HTTP. Límites: sin cron externo ni Redis; el worker corre cada job como el `org_admin` más antiguo de la organización; `jobs` sin purga (retención sin decidir); métricas del worker salen a archivo, no por HTTP; el envío sigue siendo SOLO `sandbox`.
**Avance honesto (método de la auditoría independiente):** interno probado ≈ 66 % (rango 62–70) · operable real ≈ 22 % (rango 20–25). El 74/33 anterior queda reemplazado: era optimista. Nada de A/B suma a «operable» porque no hay proveedor real.
**Fase C: BLOQUEADA** hasta recibir las decisiones humanas listadas abajo. **D (cifrado de respaldos, alertas, IaC) y E (Playwright/axe) no iniciadas.**

## Proveedores reales (2026-11-11) — decisiones del dueño recibidas
**Decidido:** correo = SMTP propio de cada organización · IA = Anthropic · datos = OpenStreetMap · retención = 30/30/90/30 días.
**Hecho:** (1) SMTP por organización (`/organization/email-settings`, pantalla Empresa → Correo saliente): contraseña cifrada AES-256-GCM, nunca devuelta; RLS FORCE; bloqueo de hosts internos (SSRF); TLS obligatorio; prueba de conexión. **Verificado con proveedor real** (GoDaddy, puerto 465): conexión, inicio de sesión y un mensaje entregado al propio buzón. (2) Envío solo por el worker: jobs `campaign.dispatch` y `draft.send_queued`; el `dispatch` HTTP responde 409 si la organización usa correo real; borrador aprobado → «Enviar» lo encola (`/message-drafts/{id}/send`, tabla `draft_deliveries`) y el worker revalida consentimiento/supresión antes de enviar; cabecera `List-Unsubscribe` y enlace de baja. (3) IA: adaptador `anthropic` (fetch, sin SDK), tarifas de lista, rechaza modelos sin tarifa; **inactivo hasta poner `ANTHROPIC_API_KEY` y `AI_PROVIDER=anthropic` en `.env`**. (4) Descubrimiento OpenStreetMap (`/prospects/discovery/search|import`, página Prospectos → Descubrir): procedencia `openstreetmap`, dedupe, omite suprimidos; probado contra servidor simulado, **sin consulta real verificada**. (5) Purga de retención diaria por el worker con simulación previa.
**Evidencia:** `npm run ci`: check 90/90, test:int 514/514 (35 archivos); el E2E falló por una aserción obsoleta («no existe enviar»), corregida y repetido aparte: 33 pasos OK; backup + restore-verify OK (59 tablas). Pila Docker reconstruida y sana. `test:browser` NO se repitió.
**Avance:** interno ≈ 71 % (66–74) · operable ≈ 35 % (30–40). Sube por correo real verificado, envío por worker y retención; IA y OSM no suman a operable hasta probarse en vivo.
**Límites:** SMTP es al-menos-una-vez (sin idempotencia del proveedor); rebotes asíncronos llegan al buzón, no al sistema (sin webhooks); sin límite de envíos por hora por organización; el envío ocurre dentro de la transacción del intento; el botón «Procesar envíos» de campañas muestra conflicto genérico con correo real (el worker lo hace solo, ciclo ≈1 min).
**BLOCKED (por impacto):** 1 `ANTHROPIC_API_KEY` y tope de gasto · 2 nube/región/IdP/dominio público (`PUBLIC_BASE_URL`, TLS) · 3 SPF/DKIM/DMARC del dominio remitente (lo configura cada cliente) · 4 credenciales de push (CI remoto nunca ejecutado) · 5 `saas_admin`, adjuntos, firma, pagos, WhatsApp · 6 destino de alertas y KMS.

## Olas 3 y 4 (2026-11-11)
**Ola 3 (`a30dac8`):** ciclo de vida de prospectos por cohorte mensual con cupo de leads; notificaciones por correo desde una cuenta SMTP separada con destinos configurables (worker); uso de Claude/MCP (llamadas por herramienta, % de límite interno, gasto de API); superadmin de solo lectura auditado; 3 pantallas web y aviso «en desarrollo» para pagos/adjuntos; OpenAPI al día. Evidencia: `npm run ci` PASSED 8m22s (check 95/95, test:int 541/541, e2e, backup/restore).
**Ola 4 (`46192bf`):** roles Gerente/Usuario/Superadmin con visibilidad por propietario (RLS FORCE en `prospects` y `leads`); WhatsApp manual con enlace `wa.me` (no se automatiza WhatsApp Web); pantallas de superadmin; tokens CSS para el diseño futuro. Evidencia: check 95/95, test:int 550/550, e2e 33 pasos; no se repitió el `ci` completo ni el backup.
**Avance vigente:** interno ≈ 71 % (66–74) · operable ≈ 35 % (30–40). Las Olas 3 y 4 no suben «operable»: nada nuevo se probó contra proveedores reales.
**Sin verificar:** IA Anthropic (inactiva sin `ANTHROPIC_API_KEY` y `AI_PROVIDER=anthropic`); consulta real a OpenStreetMap; Playwright/axe en las pantallas nuevas; resultado del CI remoto tras el push.
**BLOCKED (por impacto):** 1 clave de Anthropic y tope de gasto · 2 nube/región/IdP/dominio público (despliegue en Hostinger previsto al final) · 3 WhatsApp por QR (riesgo de términos), pagos, adjuntos, firma · 4 destino de alertas y KMS · 5 SPF/DKIM/DMARC del dominio remitente (cada cliente).

## Ola 5 (2026-11-12) — MVP para el primer negocio
**Hecho:** un usuario crea más negocios sin registrarse de nuevo (`POST /auth/organizations`, /company/new; máx. 20 como administrador); menú reducido al MVP (resto en «Avanzado»); cada lead nuevo genera `lead_assigned` (in-app y correo a los destinos configurados); el descubrimiento OSM crea contactos de correo y WhatsApp (E.164 con `+`) sin consentimiento; tope de envíos por organización 50/h y 200/día (`EMAIL_MAX_PER_HOUR`, `EMAIL_MAX_PER_DAY`); transacciones de envío de 60 s y límite global SMTP de 45 s; la web permite contactos de WhatsApp.
**Evidencia:** `npm run check` exit 0 · `test:int` 559/559 (42 archivos, base limpia). **Sin verificar:** e2e, navegador, envío real tras estos cambios, consulta real a OSM.
**Decisión pendiente del dueño:** el envío exige consentimiento `granted` por contacto; los prospectos descubiertos nacen sin él (hoy se registra a mano, uno por uno, con evidencia).
**Límites:** el aviso de lead va al `org_admin` más antiguo (el lead nace sin propietario) y el correo no incluye los datos del lead; las respuestas se registran a mano; sin cobro/facturación en la app.
