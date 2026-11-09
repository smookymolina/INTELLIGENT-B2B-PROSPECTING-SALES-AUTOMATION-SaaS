# Monitoreo y alertas (local)

- Reglas: `infra/monitoring/alerts.yml` (7 reglas, validadas con `promtool check rules`): API caida, 5xx > 5 %, rutas lentas, worker detenido, DLQ no vacia, cola acumulada, leases perdidos.
- Levantar: `docker compose --profile app --profile monitoring up -d`. Prometheus en http://127.0.0.1:9090 (solo loopback).
- La API exige `METRICS_TOKEN` (>= 32 caracteres): copiarlo a `infra/monitoring/metrics_token` y montarlo en `/etc/prometheus/metrics_token` (el archivo no se versiona).
- El worker no abre puerto: escribe `/metrics/worker.prom` en el volumen `worker_metrics` y `node-exporter` (textfile collector) lo expone.
- Alertmanager (perfil `monitoring`, http://127.0.0.1:9093): `infra/monitoring/alertmanager.yml`. Destino por variable: `ALERT_WEBHOOK_URL=https://...` en el entorno/.env antes de `docker compose up` (por defecto un receptor nulo en localhost: las alertas no salen). Sin secretos en el YAML.
- Prueba de disparo (worker detenido, DLQ, cola acumulada): `docker run --rm -v "$PWD/infra/monitoring:/etc/prometheus:ro" --entrypoint promtool prom/prometheus:v3.5.0 test rules /etc/prometheus/alerts.test.yml`. Validar config: `amtool check-config` (imagen prom/alertmanager).
- Pendiente (decision humana): elegir el destino real (Slack/correo/webhook) y probar una entrega extremo a extremo.
- Validacion en esta sesion: `promtool` SUCCESS 7 reglas; worker en Docker escribe `worker.prom`. Alertas no disparadas en vivo.
