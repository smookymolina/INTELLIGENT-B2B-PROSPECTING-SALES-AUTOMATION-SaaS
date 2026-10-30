# Aplicación web (apps/web)

Next.js 16 (App Router) actuando como **BFF**: el navegador sólo habla con el servidor de Next; éste habla con la API (`API_URL`, nunca expuesta al cliente).

## Seguridad (ADR-022)

- **Token fuera del alcance de JavaScript:** el token de sesión de la API vive sólo en la cookie `httpOnly` `__Host-session` (`Secure`, `SameSite=Lax`, `Path=/`, sin `Domain`) en producción; `session` en desarrollo sobre http. Lo lee únicamente el servidor.
- **CSRF:** todo POST (login, registro, salida) exige `Origin` igual al host (`X-Forwarded-Host` si hay proxy); sin Origin o con uno ajeno → 403. Los formularios son HTML puro (sin JS de cliente).
- **Idempotencia del registro:** la clave se genera al renderizar el formulario, así un doble envío repite el mismo registro.
- **Sin enumeración:** los errores de login/registro son genéricos; la limitación de intentos de la API se refleja como "demasiados intentos".
- **Contenido hostil:** React escapa todo; las pruebas E2E confirman que HTML en nombres/características del catálogo se muestra como texto. Los filtros de URL se validan contra listas permitidas antes de reenviarse.
- **Cabeceras:** CSP (`base-uri`, `form-action`, `frame-ancestors 'none'`, `object-src 'none'`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: same-origin`, `Permissions-Policy`, `Cache-Control: no-store`, sin `X-Powered-By`. Pendiente: `script-src` con nonces.
- **Datos por usuario sin caché:** todas las llamadas a la API usan `cache: "no-store"`.

## Requisito de despliegue (IP del cliente)

La API limita intentos por IP (ADR-013). Como el BFF llama a la API, debe reenviar la IP real en `X-Forwarded-For` (lo hace a partir de la cabecera que reciba) y la API debe arrancar con `TRUST_PROXY=1` **sólo** si únicamente el BFF/proxy puede alcanzarla. El servidor web debe ir detrás de un proxy que fije `X-Forwarded-For` (sobrescribiéndolo); si recibiera tráfico directo, un cliente podría falsear su IP y eludir el límite por IP (el límite por cuenta sigue vigente).

## Pantallas (W-01, sólo lectura salvo autenticación)

`/login`, `/register`, `/` (inicio y permisos), `/catalog` (filtros estado/tipo, paginación por cursor), `/catalog/{id}` (contenido aprobado, borrador e historial), `/company` (perfil y sedes). Accesibilidad base: enlace "saltar al contenido", etiquetas visibles, foco visible, tablas con `caption`/`scope`, diseño responsive.

## Pruebas

- Unitarias (`apps/web/lib/web.spec.ts`, 9): CSRF, IP, cookie, configuración, cliente de API.
- **E2E real** (`npm run test:e2e`, 10 pasos): API compilada + `next start` contra la base de pruebas; cabeceras, redirecciones, CSRF, registro e idempotencia, cookie endurecida, token ausente del HTML, escape de contenido hostil, filtros, 404, límite de intentos y cierre de sesión con revocación.
