# Despliegue a produccion: checklist

Manifiestos neutrales en `infra/deploy/base` (kustomize). Sin nube, region ni IdP fijados. Marcado BLOCKED = decision humana pendiente; no se inventa.

## Contenido de `infra/deploy`
- `base/`: Deployments `web`, `api`, `worker`; Services `web`/`api`; ConfigMap `app-config`; NetworkPolicy (la API solo acepta trafico de `web`).
- Secretos solo por `secretKeyRef` al Secret `app-secrets` (claves: DATABASE_URL, REDIS_URL, HMAC_SECRET, ENCRYPTION_KEY, METRICS_TOKEN), que se crea fuera del repo.
- `.env.example`: placeholders de produccion.
- Imagenes `app-api` (api y worker, target `api`) y `app-web`: fijar en un overlay con registro y tag por SHA.
- Probes: api `/v1/health` (liveness) y `/v1/health/ready` (readiness); web TCP; worker por fichero de metricas.
- Postgres y Redis no se incluyen: servicio gestionado o decision de nube.
- El job de migracion (target `migrate` del Dockerfile) debe ejecutarse antes de cada rollout (Job o hook de pipeline).

## Checklist
| # | Control | Estado |
|---|---------|--------|
| 1 | TLS extremo a extremo en el ingress y certificados gestionados | BLOCKED (nube/ingress) |
| 2 | Cookie de sesion Secure: `SESSION_COOKIE_SECURE=true` (ya en ConfigMap) detras de TLS | Listo en manifiesto; verificar con TLS real |
| 3 | `TRUST_PROXY=1` solo si hay un proxy de confianza delante | Listo en manifiesto |
| 4 | `REQUIRE_UNPRIVILEGED_DB_ROLE=1` y conexion con rol `app_login` (sin BYPASSRLS ni superusuario); RLS con FORCE | Listo en manifiesto; verificar en el entorno |
| 5 | Secretos en gestor (no en repo ni en ConfigMap); rotacion de HMAC_SECRET y ENCRYPTION_KEY | BLOCKED (gestor de secretos) |
| 6 | Respaldo cifrado de Postgres, restauracion verificada (`scripts/restore-verify.mjs`) | Scripts existentes; cifrado con KMS BLOCKED (KMS) |
| 7 | Custodia de ENCRYPTION_KEY en KMS con copia recuperable | BLOCKED (KMS) |
| 8 | Alertas (readiness, cola/DLQ, errores 5xx, espacio de BD); ver `MONITORING.md` | Parcial; destino de avisos BLOCKED |
| 9 | `/v1/health/metrics` protegido con METRICS_TOKEN y no expuesto en el ingress | Pendiente de verificar |
| 10 | Autenticacion/SSO de usuarios finales | BLOCKED (IdP) |
| 11 | Rollback: `kubectl rollout undo` por Deployment; migraciones aditivas y compatibles hacia atras; respaldo previo a migrar | Procedimiento definido; ensayo pendiente |
| 12 | NetworkPolicy: requiere CNI que la aplique; politica de egress hacia Postgres/Redis/proveedores | Ingress listo; egress BLOCKED (topologia) |
| 13 | Ingress publico solo hacia `web` (nunca `api`) | BLOCKED (ingress) |
| 14 | UID 1000 coincide con el usuario `node` de la imagen | Verificar al construir |

## Validacion realizada
Sintaxis YAML de los seis ficheros comprobada con PyYAML. No se ejecuto `kubectl kustomize` ni se aplico nada en un clúster.
