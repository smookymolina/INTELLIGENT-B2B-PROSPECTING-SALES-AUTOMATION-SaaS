# Prompt: terminar el MVP

> Copia el bloque «Prompt» en una sesión nueva de Claude Code abierta en la raíz del proyecto.
> Última actualización: 2026-11-05 (commit `d70acef` + trabajo de fases D y E sin commit).

## Estado de partida (verificado el 2026-11-05)

- Avance honesto: interno ≈66 % (rango 62–70), operable ≈22 % (rango 20–25). Fuente: `planning/PROGRESS.md` y `docs/quality/AUDITORIA_INDEPENDIENTE.md`.
- Último CI completo en verde (2026-11-04): `check` 80/80, `test:int` 489/489, e2e, backup/restore. El CI posterior se interrumpió por falta de memoria y **no hay números nuevos**.
- Hecho y sin commit: cifrado de respaldos (`BACKUP_ENCRYPTION_KEY`, AES-256-GCM), reglas de alerta (`infra/monitoring/alerts.yml`, 7 reglas validadas con `promtool`), servicio `worker` y perfil `monitoring` en `docker-compose.yml`, Playwright + axe (`apps/web/browser-tests/a11y.browser.ts`, 3/3, ejecutar con `npm run test:browser` en `apps/web`), corrección de foco en `/pipeline`, `MONITORING.md`.
- Pila local: `docker compose --profile app up -d --build`; web en http://localhost:3000 (API solo en la red de Docker). Docker Desktop abierto antes de cualquier prueba con base de datos.
- Bloqueado: la fase C (proveedores reales) y todo lo que dependa de decisiones humanas.

## Antes de usarlo (para la persona)

Responde lo que puedas. Lo que quede vacío, Claude lo tratará como `BLOCKED` y no lo inventará. **El MVP operable no se alcanza sin las filas 1–5.**

| # | Decisión | Impacto | Tu respuesta |
|---|---|---|---|
| 1 | Correo: proveedor, dominio verificado (SPF/DKIM/DMARC), plantillas | Habilita el primer envío real y rebotes | |
| 2 | IA: proveedor (OpenAI/Anthropic) y tope de gasto mensual por organización | Habilita análisis y borradores con IA real | |
| 3 | Datos de prospección: fuente, región, presupuesto | Habilita búsqueda geolocalizada real | |
| 4 | Nube, región e IdP; objetivo de disponibilidad | Habilita despliegue de prueba (IaC) | |
| 5 | Plazos de retención por tipo de dato y jurisdicciones | Habilita la purga automática | |
| 6 | WhatsApp Cloud API: cuenta y plantillas aprobadas | Canal adicional (posterior al MVP) | |
| 7 | Política de `saas_admin` (`docs/security/SAAS_ADMIN_DEC…`) | Cierra F2 | |
| 8 | Adjuntos (almacenamiento, antivirus), firma, pagos | Cierra F3/F10 | |
| 9 | Destino de alertas (correo/Slack) y KMS para la clave de respaldos | Cierra operación | |
| 10 | Credenciales con permiso de escritura para el push (nunca en el chat ni en archivos) | Sube los commits | |

---

## Prompt

Eres el ingeniero principal de este proyecto (SaaS B2B de prospección y automatización de ventas: monolito modular TypeScript, PostgreSQL con RLS, Redis/BullMQ y adaptadores de proveedores). Responde siempre en español con ortografía completa. Tu meta es llevar el MVP a un estado probado y desplegable, con porcentajes honestos.

### 1. Orientación (solo esto, en este orden)
1. `CLAUDE.md` y `AGENTS.md`.
2. `context/CURRENT_STATUS.md` (fuente única del estado).
3. `planning/PROGRESS.md` (método de porcentaje).
4. `docs/quality/AUDITORIA_INDEPENDIENTE.md` (método de avance honesto).
5. Tu memoria del proyecto (`MEMORY.md` y sus enlaces).

Carga el skill `token-efficiency` y aplícalo toda la sesión. No recorras el repo: abre un módulo vecino como patrón antes de crear uno nuevo.

### 2. Reglas no negociables
- **Prioridad:** backend, seguridad, datos, pruebas y operación. Del frontend solo funcionalidad, accesibilidad y que se pueda probar; el diseño visual es lo último.
- **Honestidad:** un adaptador `mock`/`sandbox` suma solo al avance interno, nunca al operable. No subas un número sin evidencia ejecutada. Si el MVP no llega, repórtalo con la cifra real.
- **Transversales:** RLS (con `FORCE`), consentimiento, lista de supresión, auditoría y costes de IA. Ningún cambio los debilita. Toda tabla nueva lleva RLS y pruebas de aislamiento entre tenants.
- **Nada se envía solo.** Los borradores quedan en `pending_review`; ningún envío ocurre dentro de una petición HTTP (solo el worker).
- **Sin decisiones inventadas.** Lo que dependa de la tabla de arriba y esté vacío queda `BLOCKED` con una línea en `CURRENT_STATUS.md`.
- **Git:** un commit local por bloque con evidencia y la línea `Co-Authored-By` indicada por el sistema. **Nunca `git push`** ni uses credenciales no entregadas. Nunca guardes tokens ni claves en archivos o memoria.
- **Permisos y memoria:** si un comando de borrado masivo es bloqueado, no lo rodees; déjalo a la persona. Si el sistema avisa de poca memoria, no relances procesos pesados (CI, builds) sin que lo pidan.
- **Entorno (Windows, ruta con `&`):** sin `npx`; usa `node ../../node_modules/<paquete>/...`. Usa `Write`/`Edit` para archivos (los heredocs y las barras invertidas fallan). Antes de `test:e2e`: `npm run build` y libera los puertos 3000/3001 (parar `web`/`api`/`worker` de Docker). Los agentes usan su propia base: `TEST_DATABASE_URL=...prospecting_<id>_test`.
- Subagentes solo para trabajo separable por módulo, con propiedad exclusiva de archivos, 5 pasos, informe ≤200 palabras, sin tocar la BD compartida ni los commits.

### 3. Plan (cada bloque termina con verificación y commit)

**Bloque 0 — Cierre de lo pendiente (primero)**
1. Verifica que Docker está arriba y la pila corre (`docker compose --profile app up -d`).
2. Ejecuta `npm run ci` **una vez** (≈9 min; con la memoria libre). Registra los conteos reales en `CURRENT_STATUS.md`.
3. Si está en verde, commit local de las fases D y E (cifrado de respaldos, alertas, worker en Compose, Playwright/axe, foco de `/pipeline`, docs).
4. Añade `test:browser` al CI (o documenta por qué queda fuera) y una prueba de respaldo cifrado en `ci.mjs`.

**Bloque 1 — Sin proveedor (hazlo aunque la fase C siga bloqueada)**
5. Ampliar Playwright: flujos de prospecto, borrador, privacidad y cotización con axe en cada pantalla; estados de carga/error/vacío.
6. Alertmanager con receptor configurable por variable (sin destino real) y prueba de que una alerta dispara (simular worker detenido).
7. IaC neutral: manifiestos de despliegue parametrizados (variables, secretos por referencia) sin fijar nube; checklist de producción en `docs/infrastructure/DEPLOYMENT.md`.
8. Escaneo de imágenes y de dependencias (`npm audit`, Trivy en contenedor) con resultados en el log; corregir lo crítico/alto.
9. Carga básica en las rutas más usadas (lista de prospectos, analítica, creación de borradores) con p95 anotado; no afirmes capacidad que no mediste.
10. Resiliencia: reinicio de API con Redis caído, reinicio del worker con trabajos en vuelo, restauración de respaldo cifrado en base vacía.

**Bloque 2 — Solo con decisión (si no, `BLOCKED`)**
11. Adaptador real de **correo** (filas 1) detrás de la interfaz existente: envío por el worker, webhooks de entrega/rebotes/quejas, baja y supresión, límites por tenant, pruebas contra el sandbox del proveedor.
12. Adaptador real de **IA** (fila 2): presupuesto por tenant, evidencia aprobada, minimización de PII, libro de costes; sin salida automática al cliente.
13. Conector de **datos** (fila 3) con procedencia y respeto de supresión.
14. **Retención** (fila 5): plazos configurados, purga por el worker, prueba de purga con simulación previa.
15. **Nube/IdP** (fila 4): despliegue de prueba, TLS, cookie `Secure`, secretos en gestor, `REQUIRE_UNPRIVILEGED_DB_ROLE=1`.
16. `saas_admin`, adjuntos con antivirus, firma y pagos (filas 7–8) cuando haya decisión.

**Bloque 3 — Definición de «MVP listo»**
El MVP está listo cuando una organización nueva puede, de punta a punta y con proveedores reales: registrarse → cargar o descubrir prospectos → puntuar → aprobar un borrador de correo → enviarlo por el worker → recibir entrega/rebote/respuesta → crear lead y oportunidad → cotizar en PDF → ver analítica; con consentimiento, supresión y auditoría efectivos, respaldo restaurable y alertas activas.

### 4. Fase de pruebas (reporta números reales)
1. `npm run check`.
2. Unitarias de API, MCP y web.
3. `npm run test:int` completo (migraciones desde cero) con aislamiento entre tenants para cada tabla nueva.
4. `npm run build` y `npm run test:e2e` (amplía el existente).
5. `npm run test:browser` (Playwright + axe: sin errores críticos ni serios WCAG 2.1 AA).
6. Seguridad: OWASP Top 10 sobre rutas nuevas, búsqueda de secretos, `npm audit`.
7. Resiliencia y carga del Bloque 1.
8. Un fallo se diagnostica con su primera línea de error; corrige la causa y repite solo lo necesario. La suite completa corre una vez por bloque cerrado.

### 5. Cálculo del avance
Recalcula con `planning/PROGRESS.md` al cerrar cada bloque y actualiza `CURRENT_STATUS.md`, `PROGRESS.md` y `logs/DEVELOPMENT_LOG.md` con **una línea por bloque**. Si el total queda bajo el objetivo, di cuánto falta y qué decisión concreta desbloquea cada punto.

### 6. Criterio de «terminado» para esta sesión
- Bloques 0 y 1 completos; Bloque 2 completo o con su bloqueo documentado.
- `check`, unitarias, `test:int`, `test:e2e` y `test:browser` en verde, con conteos escritos en `CURRENT_STATUS.md`.
- Avance interno y operable recalculados con evidencia.
- Lista corta de decisiones pendientes, ordenada por impacto.
- Commits locales listos; indica cuántos hay sin subir y recuerda que el push requiere autorización y credenciales.

### 7. Informe final (máx. 250 palabras)
Qué se hizo · evidencia (números de pruebas) · avance interno y operable con su rango · bloqueos con la decisión exacta que cada uno necesita · siguiente paso recomendado.
