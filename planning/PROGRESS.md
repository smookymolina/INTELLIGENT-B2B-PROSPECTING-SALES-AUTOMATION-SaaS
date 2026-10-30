# Progreso hacia "software operable" (100 %)

Fecha: 2026-10-30 (recalculado tras P4-01 + W-03/W-04/W-F4). **Estimación ponderada, no medida**: los pesos son esfuerzo relativo estimado por el Tech Lead (no historial de velocidad). "Operable" = un cliente real puede registrarse, cargar catálogo, prospectar, contactar por canales oficiales, gestionar leads/cotizaciones y operar en producción con la interfaz web.

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
| F5 Enriquecimiento y scoring | 6 | 0 % | 0 | |
| F6 IA | 6 | 0 % | 0 | requiere proveedor de modelos |
| F7 Campañas y canales | 10 | 0 % | 0 | requiere proveedores/credenciales/consentimiento |
| F8 Intención y leads | 5 | 0 % | 0 | |
| F9 CRM y routing | 6 | 0 % | 0 | |
| F10 Cotización y ventas | 6 | 0 % | 0 | |
| F11 Analítica | 4 | 0 % | 0 | |
| F12 SaaS, hardening y producción | 10 | 0 % | 0 | |
| Interfaz web (transversal) | 20 | 47,5 % | 9,5 | W-01, W-02, W-03 (precios), W-04 (importación) y prospectos; faltan empresa, miembros/org, endurecimiento y los módulos nuevos |
| **Total** | **98** | | **30,1** | **≈ 31 %** |

## Qué puede frenar el avance (decisiones humanas, no técnicas)

Proveedor cloud/IdP/pagos, vertical e ICP inicial, jurisdicciones y retención, aviso de privacidad, cuentas de proveedores de datos/IA/canales, almacenamiento y antivirus de adjuntos, política de `saas_admin`. Sin ellas F7, F12 y partes de F4–F6 no pueden cerrarse.
