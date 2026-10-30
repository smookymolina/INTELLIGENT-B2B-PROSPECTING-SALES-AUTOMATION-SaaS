# Progreso hacia "software operable" (100 %)

Fecha: 2026-10-30. **Estimación ponderada, no medida**: los pesos son esfuerzo relativo estimado por el Tech Lead (no historial de velocidad). Se recalcula al cerrar cada bloque. "Operable" = un cliente real puede registrarse, cargar catálogo, prospectar, contactar por canales oficiales, gestionar leads/cotizaciones y operar en producción con la interfaz web.

| Fase | Peso | Avance | Aporte | Comentario |
|---|---:|---:|---:|---|
| F0 Documentación | 2 | 95 % | 1,9 | falta auditoría independiente |
| F1 Infraestructura | 3 | 100 % | 3,0 | monorepo, Compose, CI definido |
| F2 Identidad/tenancy/RBAC/RLS | 6 | 92 % | 5,5 | falta CI remoto, `saas_admin` (bloqueado), revisión |
| F3 Empresa y catálogo | 6 | 40 % | 2,4 | P3-01 (15 %) + P3-02 (25 %); faltan precios, importación, adjuntos, evidencia IA |
| F4 Prospección | 8 | 0 % | 0 | |
| F5 Enriquecimiento y scoring | 6 | 0 % | 0 | |
| F6 IA | 6 | 0 % | 0 | |
| F7 Campañas y canales | 10 | 0 % | 0 | requiere proveedores/credenciales/consentimiento |
| F8 Intención y leads | 5 | 0 % | 0 | |
| F9 CRM y routing | 6 | 0 % | 0 | |
| F10 Cotización y ventas | 6 | 0 % | 0 | |
| F11 Analítica | 4 | 0 % | 0 | |
| F12 SaaS, hardening y producción | 10 | 0 % | 0 | |
| Interfaz web (transversal) | 20 | 0 % | 0 | `apps/web` es sólo una página base |
| **Total** | **98** | | **12,8** | **≈ 13 %** (≈ 16 % contando sólo backend/plataforma) |

## Qué puede frenar el avance (decisiones humanas, no técnicas)

Proveedor cloud/IdP/pagos, vertical e ICP inicial, jurisdicciones y retención, aviso de privacidad, cuentas de proveedores de datos/IA/canales, almacenamiento y antivirus de adjuntos, política de `saas_admin`. Sin ellas F7, F12 y partes de F4–F6 no pueden cerrarse.
