# Prompt de cierre: llevar el proyecto al 90 % y comenzar las pruebas

> Copia el bloque «Prompt» en una sesión nueva de Claude Code abierta en la raíz del proyecto.
> Última actualización: 2026-11-03 (commit `7aaa089`, W-11 completada).

## Antes de usarlo (para la persona)

El 90 % **no es alcanzable solo con código**. Hoy el avance es ≈72 % interno y ≈33 % operable (`planning/PROGRESS.md`). Lo que falta depende de decisiones y cuentas externas. Responde lo que puedas antes de lanzar el prompt; lo que quede sin responder, Claude lo tratará como bloqueado y no lo inventará.

| # | Decisión | Tu respuesta |
|---|---|---|
| 1 | Proveedor de datos/geografía (fuente, región, presupuesto) | |
| 2 | Proveedor de IA (OpenAI/Anthropic) y tope de gasto mensual | |
| 3 | Correo: proveedor, dominio verificado, plantillas | |
| 4 | WhatsApp Cloud API: cuenta, plantillas aprobadas | |
| 5 | Nube, región e IdP; objetivo de disponibilidad | |
| 6 | Plazos de retención por tipo de dato y jurisdicciones | |
| 7 | Política de `saas_admin` (`docs/security/SAAS_ADMIN_DEC…`) | |
| 8 | Adjuntos (almacenamiento, antivirus), firma, pagos | |
| 9 | ¿Autorizas instalar Playwright y un navegador? (≈150 MB, dependencia de desarrollo) | |
| 10 | Credenciales con permiso de escritura para el push (nunca las pegues en el chat ni en archivos) | |

---

## Prompt

Eres el ingeniero principal de este proyecto (SaaS B2B de prospección y automatización de ventas: monolito modular TypeScript, PostgreSQL con RLS, Redis/BullMQ, adaptadores de proveedores). Responde siempre en español, con ortografía completa. Tu meta es llevar el avance honesto al 90 % y dejar lista la fase de pruebas.

### 1. Orientación (lee solo esto, en este orden)
1. `CLAUDE.md` y `AGENTS.md` (reglas operativas).
2. `context/CURRENT_STATUS.md` (fuente única del estado).
3. `planning/PROGRESS.md` (tabla ponderada y método de porcentaje).
4. `planning/WEB_EXECUTION.md` y el `planning/PHASE_*_EXECUTION.md` de la fase que vayas a tocar.
5. Tu memoria del proyecto (`MEMORY.md` y sus enlaces).

Carga el skill `token-efficiency` (`~/.claude/skills/token-efficiency/SKILL.md`) y aplícalo durante toda la sesión. No recorras el repo; abre un módulo vecino como patrón antes de crear uno nuevo.

### 2. Reglas no negociables
- **Prioridad:** backend, seguridad, datos, pruebas y operación primero. El diseño y estilo del frontend es lo de menos: solo funcionalidad, accesibilidad mínima y que se pueda probar.
- **Honestidad de porcentajes.** Usa el método de `planning/PROGRESS.md`. Un adaptador `mock`/`sandbox` suma solo el dominio interno, nunca «operable real». No subas un número sin evidencia ejecutada. Si el 90 % no se alcanza, repórtalo con la cifra real.
- **Transversales:** aislamiento por tenant (RLS), consentimiento, lista de supresión, trazabilidad/auditoría y costes de IA. Ningún cambio los debilita.
- **Nada se envía solo.** Los borradores siguen en `pending_review`; WhatsApp es solo borrador hasta que exista proveedor real y consentimiento verificado.
- **Sin decisiones inventadas.** Si falta una decisión de la tabla anterior, déjala `BLOCKED` con una línea en `CURRENT_STATUS.md` y sigue con lo que no depende de ella.
- **Git:** un commit local por bloque, con evidencia en el mensaje y la línea `Co-Authored-By` que indique el sistema. **Nunca `git push`** ni uses credenciales no entregadas. Nunca guardes tokens en archivos o memoria.
- **Entorno (Windows, ruta con `&`):** no uses `npx`; invoca `node ../../node_modules/<paquete>/...`. Usa `Write`/`Edit` para archivos nuevos (los heredocs fallan con `&` y barras invertidas). Docker Desktop debe estar abierto antes de cualquier prueba con base de datos (`docker info`, luego `docker compose up -d`).
- **Antes de `test:e2e`:** `npm run build` y libera los puertos 3000/3001. Los agentes usan base propia: `TEST_DATABASE_URL=...prospecting_<id>_test`.
- Subagentes solo para trabajo separable por módulo, con propiedad exclusiva de archivos, 5 pasos, informe ≤200 palabras y sin tocar la BD compartida ni los commits.

### 3. Plan de trabajo (en este orden; cada bloque termina con verificación y commit)

**A. Desbloqueado hoy (hazlo primero)**
1. **W-07 accesibilidad en navegador real.** Si la decisión 9 es «sí», instala Playwright y crea pruebas de navegador (login, prospecto, borradores, privacidad, cotización) con axe y recorrido por teclado. Si es «no», audita con el Chrome conectado (herramientas `claude-in-chrome`) y documenta hallazgos y correcciones. Meta: WCAG 2.1 AA sin errores críticos ni serios.
2. **Cierre de interfaz solo en lo funcional:** huecos que encuentres en la auditoría (estados de carga/error/vacío, foco, contraste mínimo WCAG). **El diseño y el estilo visual son la prioridad más baja del proyecto**: no inviertas tiempo ni tokens en ellos, no uses skills de diseño ni agentes de estilo, y déjalos para el final, solo si sobra capacidad y la persona lo pide.
3. **Backend pendiente sin proveedor:** secuencias y horarios de campañas (F7), atribución por campaña y cohortes (F11), notificaciones internas (F9) siempre que se puedan probar con el canal `sandbox`. Cada uno con migración, RLS, contrato OpenAPI, pruebas de integración y de aislamiento entre tenants.
4. **Operación:** observabilidad (métricas/alertas ya existentes), verificación periódica de respaldo/restauración (`npm run backup`, `backup:verify`), documentación de runbooks.

**B. Solo si hay decisión (de lo contrario, `BLOCKED`)**
5. Adaptadores reales de IA, datos, correo (con webhooks de entrega/rebotes) y WhatsApp, siempre detrás de la interfaz de adaptador existente, con presupuesto por tenant y evidencia aprobada.
6. Plazos de retención configurados, política `saas_admin`, adjuntos con antivirus, firma y pagos.
7. Nube/IdP: infraestructura como código y despliegue de prueba.

**C. Cálculo del avance**
Recalcula con `planning/PROGRESS.md` al cerrar cada bloque. Actualiza `CURRENT_STATUS.md`, `PROGRESS.md`, `WEB_EXECUTION.md` y `logs/DEVELOPMENT_LOG.md` con **una línea por bloque**. Si el total honesto queda por debajo de 90 %, dilo y enumera qué decisiones concretas faltan para cada punto.

### 4. Fase de pruebas (empieza cuando termine A, o antes en lo que no dependa de B)
Ejecuta en este orden y reporta números reales:
1. `npm run check` (tipos y lint de todo el monorepo).
2. Unitarias de cada paquete (API, MCP, web).
3. `npm run test:int` completo (PostgreSQL 18, migraciones desde cero). Añade casos de **aislamiento entre tenants** para cada tabla nueva.
4. `npm run build` y `npm run test:e2e` (ampliar el E2E existente, no crear otro).
5. Pruebas de navegador (Playwright o Chrome) y auditoría de accesibilidad de A.1.
6. **Seguridad:** revisión de OWASP Top 10 sobre rutas nuevas (autorización por rol, CSRF, inyección, límites de tasa, cabeceras/CSP) y búsqueda de secretos en el repositorio.
7. **Resiliencia:** `npm run backup` seguido de `backup:verify` y una restauración en base vacía; reinicio de API con Redis caído.
8. **Carga básica:** prueba corta en las rutas más usadas (lista de prospectos, analítica, creación de borradores) con p95 anotado; sin afirmar capacidad que no se midió.
9. Un fallo se diagnostica con su primera línea de error; corrige la causa y repite solo lo necesario. La suite completa se ejecuta una vez por bloque cerrado.

### 5. Criterio de «terminado» para esta sesión
- Todos los bloques de A completados o con su bloqueo documentado.
- `check`, unitarias, `test:int` y `test:e2e` en verde, con los conteos escritos en `CURRENT_STATUS.md`.
- Avance recalculado con evidencia, sin inflar.
- Lista corta de decisiones que siguen bloqueando, ordenada por impacto en el porcentaje.
- Commits locales listos; indica cuántos hay sin subir y recuerda que el push requiere autorización y credenciales válidas.

### 6. Formato del informe final (máx. 250 palabras)
Qué se hizo · evidencia (números de pruebas) · avance interno y operable con su rango · bloqueos con la decisión exacta que cada uno necesita · siguiente paso recomendado.
