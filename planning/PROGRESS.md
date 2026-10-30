# Progreso hacia "software operable" (100 %)

Fecha: 2026-10-30 (recalculado tras P11-01). **Estimación ponderada, no medida**: los pesos son esfuerzo relativo estimado por el Tech Lead (no historial de velocidad). "Operable" = un cliente real puede registrarse, cargar catálogo, prospectar, contactar por canales oficiales, gestionar leads/cotizaciones y operar en producción con la interfaz web.

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
| F5 Enriquecimiento y scoring | 6 | 65 % | 3,9 | P5-01: atributos verificables, modelo versionado, puntuación explicable. Falta (bloqueado): enriquecimiento con proveedores y merge reversible |
| F6 IA | 6 | 40 % | 2,4 | P6-01 puerta de entrada neutral (sin proveedor real): presupuesto por tenant, evidencia aprobada, minimización de PII, esquema y verificación de cifras, libro de uso. Falta (bloqueado): adaptadores reales (OpenAI/Anthropic), evaluación con datos reales, clasificación de intención con modelo |
| F7 Campañas y canales | 10 | 0 % | 0 | requiere proveedores/credenciales/consentimiento |
| F8 Intención y leads | 5 | 80 % | 4,0 | P8-01: leads por regla/intención con revisión humana, clasificador por reglas. Falta (bloqueado): clasificación con IA y recepción por canales |
| F9 CRM y routing | 6 | 95 % | 5,7 | P9-01 oportunidades/etapas/SLA/visibilidad; P9-02 tareas de seguimiento con RLS y máquina de estados en la base. Faltan (bloqueado): notificaciones por canales |
| F10 Cotización y ventas | 6 | 75 % | 4,5 | P10-01: cotizaciones desde evidencia, totales exactos, descuentos, snapshot, venta. Faltan (bloqueado): PDF, fiscalidad, firma, pagos |
| F11 Analítica | 4 | 92 % | 3,7 | P11-01 (API y pantalla) y P11-02 exportación CSV segura y auditada. Falta (F7/otros): atribución por campaña, cohortes, paneles configurables |
| F12 SaaS, hardening y producción | 10 | 18 % | 1,8 | P12-01 sesiones/contraseña, P12-02 readiness y métricas. Falta: retención/derechos del titular, respaldo, Dockerfiles verificados; BLOCKED: nube, IdP, jurisdicciones |
| Interfaz web (transversal) | 20 | 90 % | 18,0 | W-01…W-06 y la CSP con nonces de W-07 (0,5 de 2,5); falta auditoría a11y en navegador real y pruebas Playwright |
| **Total** | **98** | | **64,6** | **≈ 66 %** (hitos de commit alcanzados: 20, 30, 40, 50 y 60 %; siguiente: 70 %) |

## Qué puede frenar el avance (decisiones humanas, no técnicas)

Proveedor cloud/IdP/pagos, vertical e ICP inicial, jurisdicciones y retención, aviso de privacidad, cuentas de proveedores de datos/IA/canales, almacenamiento y antivirus de adjuntos, política de `saas_admin`. Sin ellas F7, F12 y partes de F4–F6 no pueden cerrarse.
