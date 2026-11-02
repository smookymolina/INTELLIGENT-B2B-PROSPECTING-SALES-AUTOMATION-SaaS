# Estado actual

Fecha: 2026-10-30. **Fuente única del estado vigente**; el historial por bloque está en `logs/DEVELOPMENT_LOG.md` y el detalle por fase en `planning/PHASE_*_EXECUTION.md`. Git local en `main` (último commit `a827792`); **sin push, sin CI remoto, sin proveedores externos, sin despliegue**.

## Avance (estimación ponderada, no medición; método en `planning/PROGRESS.md`)

| Métrica | Valor | Qué significa |
|---|---|---|
| Interno (dominio implementado y probado en local) | ≈ 70 % (revisión independiente: ≈ 60 %; usar rango 60–70 %) | incluye lo que depende de proveedores sólo por su dominio interno |
| Operable real (cliente real en producción) | ≈ 30 % (rango 25–35 %) | exige proveedores reales, nube, cumplimiento y revisión independiente, que no existen |

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
