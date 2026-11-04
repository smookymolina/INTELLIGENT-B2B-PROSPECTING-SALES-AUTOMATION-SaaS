# Progreso hacia "software operable" (100 %)

Fecha: 2026-10-30 (recalculado tras P11-01). **Estimación ponderada, no medida**: los pesos son esfuerzo relativo estimado por el Tech Lead (no historial de velocidad). "Operable" = un cliente real puede registrarse, cargar catálogo, prospectar, contactar por canales oficiales, gestionar leads/cotizaciones y operar en producción con la interfaz web.

## Dos métricas (revisión independiente, 2026-10-30)

- **Interno ≈ 70 %** (esta tabla). Una revisión independiente que aplicó más estrictamente el tope de «mock/sandbox cuenta máx. 50 %» obtuvo **≈ 60 %** (rango 55–65 %); la diferencia está en F4, F5, F8, F10, F11 y la web, donde ella puntuó más bajo por depender de reportes internos. Se informa el rango **60–70 %**.
- **Operable real ≈ 30 %** (rango 25–35 %): exige proveedores reales, nube, cumplimiento y revisión independiente, todavía inexistentes.
- Acción: cada porcentaje de fase debe citar su evidencia; «COMPLETED» sólo con prueba ejecutada; CI remoto y proveedor real se reportan aparte.

## Regla de conteo

Sólo suma lo entregado **con pruebas ejecutadas** (y documentado). Lo que dependa de un proveedor externo (datos, IA, canales, nube) no suma hasta que exista y se pruebe; las fases con proveedor se puntúan sólo por su dominio interno. Hitos de commit: 20 %, 30 %, 40 % y 50 %.

**Rebalanceo (honesto):** al planificar los módulos siguientes se vio que los pesos de la interfaz sumaban más de 20; se fijaron así: W-01 2,5 · W-02 2,5 · W-03 1,5 · W-04 1,5 · W-05 1 · W-06 2 · W-07 2,5 · prospectos 1,5 · leads/scoring 1,5 · CRM 2 · cotizaciones 1,5 = 20. Con ello el hito del 20 % (commit `5c62665`) equivalía a ≈ 21 %, no 22 %.

| Fase | Peso | Avance | Aporte | Comentario |
|---|---|---:|---:|---|
| F0 Documentación | 2 | 95 % | 1,9 | falta auditoría independiente |
| F1 Infraestructura | 3 | 100 % | 3,0 | monorepo, Compose, CI definido |
| F2 Identidad/tenancy/RBAC/RLS | 6 | 92 % | 5,5 | falta CI remoto, `saas_admin` (bloqueado), revisión |
| F3 Empresa y catálogo | 6 | 90 % | 5,4 | falta sólo adjuntos (bloqueado) |
| F4 Prospección | 8 | 60 % | 4,8 | P4-01: prospectos, procedencia, dedupe, lista de no contactar, importación CSV. Falta (bloqueado por proveedor): conectores de búsqueda geolocalizada |
| F5 Enriquecimiento y scoring | 6 | 70 % | 4,2 | P5-01: atributos verificables, modelo versionado, puntuación explicable. P5-02 fusión reversible de duplicados (enlace no destructivo, invariantes en la base). Falta (bloqueado): enriquecimiento con proveedores |
| F6 IA | 6 | 40 % | 2,4 | P6-01 puerta de entrada neutral (sin proveedor real): presupuesto por tenant, evidencia aprobada, minimización de PII, esquema y verificación de cifras, libro de uso. Falta (bloqueado): adaptadores reales (OpenAI/Anthropic), evaluación con datos reales, clasificación de intención con modelo |
| F7 Campañas y canales | 10 | 55 % | 5,5 | P7-01 contactos y libro de consentimiento; P7-02 campañas de un correo con aprobación, elegibilidad en vista previa/lanzamiento/cada envío, tope de frecuencia, baja pública firmada y canal **sandbox**. Falta (bloqueado): proveedores reales de correo/WhatsApp, webhooks de entrega/rebotes, secuencias, horarios, atribución |
| F8 Intención y leads | 5 | 80 % | 4,0 | P8-01: leads por regla/intención con revisión humana, clasificador por reglas. Falta (bloqueado): clasificación con IA y recepción por canales |
| F9 CRM y routing | 6 | 95 % | 5,7 | P9-01 oportunidades/etapas/SLA/visibilidad; P9-02 tareas de seguimiento con RLS y máquina de estados en la base. Faltan (bloqueado): notificaciones por canales |
| F10 Cotización y ventas | 6 | 80 % | 4,8 | P10-01: cotizaciones desde evidencia, totales exactos, descuentos, snapshot, venta. P10-03 PDF de descarga; el envío sólo se acepta si la oportunidad puede pasar a `quote_sent`. Faltan (bloqueado): fiscalidad, firma, pagos, envío del PDF |
| F11 Analítica | 4 | 92 % | 3,7 | P11-01 (API y pantalla) y P11-02 exportación CSV segura y auditada. Falta (F7/otros): atribución por campaña, cohortes, paneles configurables |
| F12 SaaS, hardening y producción | 10 | 40 % | 4,0 | P12-01 sesiones/contraseña, P12-02 readiness y métricas. Hecho: Dockerfiles verificados (perfil `app`, rol `app_login`) y logs estructurados. Falta: retención/derechos del titular, respaldo; BLOCKED: nube, IdP, jurisdicciones |
| Interfaz web (transversal) | 20 | 90 % | 18,0 | W-01…W-06 y la CSP con nonces de W-07 (0,5 de 2,5); falta auditoría a11y en navegador real y pruebas Playwright |
| **Total** | **98** | | **72,9** | **≈ 70 %** (hitos de commit alcanzados: 20, 30, 40, 50, 60 y 70 %; siguiente: 80 %, que ya no se puede alcanzar sin proveedores o decisiones humanas) |

## Qué puede frenar el avance (decisiones humanas, no técnicas)

Proveedor cloud/IdP/pagos, vertical e ICP inicial, jurisdicciones y retención, aviso de privacidad, cuentas de proveedores de datos/IA/canales, almacenamiento y antivirus de adjuntos, política de `saas_admin`. Sin ellas F7, F12 y partes de F4–F6 no pueden cerrarse.

## Orden de trabajo (2026-11-02)
Frontend al final: el avance siguiente se mide sobre backend/operación; la interfaz (peso 20) se completa en la última etapa.
Auditoría 2026-11-02: backend verificado en vivo (≈154 rutas, 0 pendientes graves); porcentajes sin cambio — interno ≈ 70 % (rango 60–70), operable ≈ 30 %. Detalle en `context/CURRENT_STATUS.md`.

### Ola de agentes 2026-11-02 (arquitectura en `docs/architecture/AGENT_ARCHITECTURE.md`)
P7-03 borradores personalizados de correo/WhatsApp con aprobación humana (F7 +10 pts); P7-04 servidor MCP acotado a 3 herramientas (sin envío ni aprobación); P12-04 retención configurable y derechos del titular sin plazos por defecto (mecanismo; los plazos son decisión del cliente); P12-05 respaldo y restauración verificados (F12 +16 pts). Total de la tabla 72,9 sobre pesos que suman 98; lectura honesta: **interno ≈ 72 % (rango 66–72)**, **operable ≈ 33 % (rango 28–35)**. No se llega a 100 % sin proveedores reales, nube, plazos legales, CI remoto, revisión independiente y la etapa final de interfaz.

W-11 2026-11-03: interfaz de privacidad completada (E2E 33 pasos OK, typecheck y lint web limpios). Sin cambio de porcentajes: W-11 no tenía peso propio en la tabla; el 90 % no es alcanzable sin proveedores, nube, plazos legales y revisión independiente (ver bloqueos).
