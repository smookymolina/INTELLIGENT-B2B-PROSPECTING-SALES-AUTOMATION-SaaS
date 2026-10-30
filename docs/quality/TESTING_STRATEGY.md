# Estrategia de pruebas

Pirámide: unitarias de reglas/mappers; integración PostgreSQL/RLS/colas; contrato de adaptadores/webhooks; E2E de flujos críticos; seguridad y carga focalizadas. Fixtures sintéticos, nunca PII real. Gates: lint, tipos, pruebas relevantes, migraciones y revisión. Casos obligatorios: fuga tenant, baja antes de envío, webhook duplicado, idempotencia, fallo proveedor y salida IA inválida.

Evidencia actual Fase 1: `npm run check` ejecuta lint, typecheck, tests y builds; CI repite el mismo gate en push/PR.
