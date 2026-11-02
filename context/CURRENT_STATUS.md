# Estado actual

Fecha: 2026-10-30. **Fuente única del estado vigente**; el historial por bloque está en `logs/DEVELOPMENT_LOG.md` y el detalle por fase en `planning/PHASE_*_EXECUTION.md`. Git local en `main` (último commit `a827792`); **sin push, sin CI remoto, sin proveedores externos, sin despliegue**.

## Avance (estimación ponderada, no medición; método en `planning/PROGRESS.md`)

| Métrica | Valor | Qué significa |
|---|---|---|
| Interno (dominio implementado y probado en local) | ≈ 70 % (revisión independiente: ≈ 60 %; usar rango 60–70 %) | incluye lo que depende de proveedores sólo por su dominio interno |
| Operable real (cliente real en producción) | ≈ 30 % (rango 25–35 %) | exige proveedores reales, nube, cumplimiento y revisión independiente, que no existen |

## Evidencia local vigente

`npm run check` exit 0 · `docker compose config --quiet` exit 0 · `npm run test:int` 394/394 (24 archivos, PostgreSQL 18, migraciones desde cero) · unitarias 45 API + 16 web · `npm run test:e2e` 30 pasos sobre API compilada + Next real. Esto es **local**: el CI remoto nunca se ejecutó.

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
Revisión por módulos con agentes y pruebas en vivo (≈154 rutas): sin 500 residuales, aislamiento y permisos correctos, aritmética de cotizaciones exacta. **Sin verificar en vivo** por falta de proveedor: `POST /ai/analyze` (mock) y `dispatch` de campañas (sandbox); sólo cubiertos por pruebas automáticas. **Observaciones abiertas** (decisión de negocio): `quotes.service.ts` permite enviar una cotización cuya oportunidad no puede pasar a `quote_sent` (luego `accept` da 409); el CSV de catálogo acepta nombres que empiezan por `=` (no hay export de catálogo). Esta auditoría no cambia los porcentajes: el avance interno se confirma en la parte alta del rango (≈ 70 %); operable real sigue ≈ 30 %.
