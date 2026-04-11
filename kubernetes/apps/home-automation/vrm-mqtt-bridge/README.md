# VRM Bridge

Victron VRM REST bridge in the `home-automation` namespace.
Polls the VRM API, writes telemetry to CNPG Postgres, and republishes current values to local Mosquitto.

## What is in git

- Flux Kustomization (`ks.yaml`) — depends on external-secrets-stores, cloudnative-pg, mosquitto
- HelmRelease using bjw-s `app-template` with `postgres-init` sidecar
- ExternalSecrets wired to 1Password item `lakemates victron integration - tranquility`
- CNPG-backed tables: `victron_latest`, `victron_history`
- Grafana datasource + dashboard wired in `selfhosted/grafana/`

## Required secret fields

1Password item `lakemates victron integration - tranquility` should provide:
- `VRM_EMAIL`
- `VRM_TOKEN`
- `VRM_PORTAL_ID` (gateway identifier is OK; bridge resolves numeric site id automatically)
- `DATABASE_NAME`
- `DATABASE_USER`
- `DATABASE_PASS`
- `LAKEMATES_PUSH_URL` (stage ingest endpoint, e.g. `https://stage.lakemates.com/api/victron/ingest`)
- `LAKEMATES_SITE_KEY` (matches the stage tenant's `worker_site_key` / ingest site key)
- `LAKEMATES_INGEST_SECRET` (shared secret sent as `X-Ingest-Secret`)

1Password item `mosquitto home automation` should provide:
- `MQTT_USERNAME`
- `MQTT_PASSWORD`
- `MQTT_PASSWD` (mosquitto password file content)

## Runtime behavior

- VRM API is polled every ~30s by default
- current values are written to `victron_latest`
- numeric values are appended to `victron_history`
- current values are also republished to `victron/<metric>` on local Mosquitto
- when `LAKEMATES_PUSH_URL` + `LAKEMATES_SITE_KEY` + `LAKEMATES_INGEST_SECRET` are set, each poll also pushes a snapshot into Lakemates stage ingest for the Solar & Batteries page

## Notes

- CNPG Postgres is the source of truth.
- Production Lakemates remains out of scope until explicitly wired in.
- Secrets belong in 1Password + ExternalSecrets, not plain YAML.
- Bridge egress is restricted by NetworkPolicy and MQTT is intended to stay cluster-internal.
- See `docs/VICTRON_VRM_STAGE_ROLLOUT.md` for rollout history and `vrm-mqtt-bridge` repo for bridge source.
