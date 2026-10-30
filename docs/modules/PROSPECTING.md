# Prospección (P4-01)

Contrato ejecutable: `docs/api/openapi.v1.json` (tag *Prospecting*). Tenant siempre de la sesión.

- **Prospecto:** empresa candidata (`name`, `domain` normalizado, país ISO-2, región, ciudad, giro, notas). `contactPermission` es siempre `"none"`. Estados: `candidate` → `qualified`/`disqualified` (con motivo opcional).
- **Normalización:** `https://www.Ejemplo.com:8080/x` → `ejemplo.com`; se rechazan correos, IP, userinfo y no-ASCII (punycode). Identidad = dominio, o `nombre|país` si no hay dominio; duplicado → 409 con `details.existingId`.
- **Procedencia (append-only):** `manual` o `csv_import` (con referencia al trabajo de importación) por cada alta/actualización.
- **Lista de no contactar:** entradas `domain` o `name`. Alta: `suppressions:manage` (descalifica de inmediato a los calificados coincidentes y audita cuántos); baja: sólo `org_admin`, auditada. Los prospectos se devuelven con `suppressed`; un suprimido no puede calificarse (API y trigger). Los módulos de campañas deben consultar esta lista antes de cualquier envío.
- **Importación CSV** `POST /prospects/imports` (`mode`: `dry_run`|`apply`): columnas `name` (obligatoria), `domain`, `country`, `region`, `city`, `industry`; todo-o-nada, idempotente por contenido y por `Idempotency-Key`, nunca cambia estados, errores por fila sin eco de valores, máx. 1000 filas. Historial: `GET /prospects/imports[/{id}]`.
- **Conectores:** `GET /prospects/connectors` devuelve la lista (hoy vacía). Un conector se habilitará sólo con proveedor aprobado, términos, cuotas y credenciales; los resultados serán candidatos con procedencia, nunca permisos de contacto.
- **Interfaz:** `/prospects` (filtros, búsqueda, cursor), `/prospects/new`, `/prospects/{id}` (procedencia, estado, edición), `/prospects/suppressions`, `/prospects/import`.
