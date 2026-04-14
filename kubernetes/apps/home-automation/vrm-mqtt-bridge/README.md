# VRM Bridge

Victron VRM REST bridge in the `home-automation` namespace.
Polls the VRM API, writes telemetry to CNPG Postgres, and republishes current values to local Mosquitto.

## What is in git

- Flux Kustomization (`ks.yaml`) — depends on external-secrets-stores, cloudnative-pg, mosquitto
- HelmRelease using bjw-s `app-template` with `postgres-init` sidecar
- ExternalSecrets wired to shared runtime secrets only
- Bridge pod accepts the shared Lakemates fetch/decrypt trust secret used for dynamic multi-boat discovery
- CNPG-backed tables: `victron_latest`, `victron_history`
- Grafana datasource + dashboard wired in `selfhosted/grafana/`

## Required secret fields

Shared 1Password item `lakemates victron stage shared` should provide:
- `DATABASE_NAME`
- `DATABASE_USER`
- `DATABASE_PASS`

Current shared trust item is `lakemates victron v2 shared` and should provide:
- `VICTRON_ENCRYPTION_KEY`
- `VICTRON_BRIDGE_MACHINE_TOKEN`
- `VICTRON_INTERNAL_API_BASE_URL`

Mosquitto currently authorizes the bridge with user `telemetry` on topic `victron/#`.
The password file is sourced via the `mosquitto-auth` ExternalSecret, and the bridge needs matching `LOCAL_MQTT_USERNAME` / `LOCAL_MQTT_PASSWORD` at runtime.

## Runtime behavior

- VRM API is polled every ~30s by default
- current values are written to `victron_latest`
- numeric values are appended to `victron_history`
- current values are also republished to `victron/<metric>` on local Mosquitto
- the bridge fetches enabled integrations from Lakemates and decrypts per-boat credentials in memory
- each poll pushes snapshots into Lakemates through the internal machine-auth ingest API
- the pod looks for `VICTRON_ENCRYPTION_KEY`, `VICTRON_BRIDGE_MACHINE_TOKEN`, and `VICTRON_INTERNAL_API_BASE_URL` from the shared `vrm-mqtt-bridge-v2-shared` Secret

## Runtime contract

- Home-ops should provide shared runtime trust and database/MQTT config only.
- Per-boat VRM credentials live in Lakemates and are served to the bridge through the internal machine-auth config API.
- Telemetry returns to Lakemates through the internal machine-auth ingest API keyed by `boatKey`.
- New boats should not require manifest edits or new per-boat ExternalSecret entries.

## Notes

- CNPG Postgres is the source of truth.
- Production Lakemates remains out of scope until explicitly wired in.
- Secrets belong in 1Password + ExternalSecrets, not plain YAML.
- Bridge egress is restricted by NetworkPolicy and MQTT is intended to stay cluster-internal.
- See `docs/VICTRON_VRM_STAGE_ROLLOUT.md` for rollout history and `vrm-mqtt-bridge` repo for bridge source.
