# VRM Bridge

Victron VRM REST bridge in the `home-automation` namespace.
Polls the VRM API, writes telemetry to CNPG Postgres, and republishes current values to local Mosquitto.

## What is in git

- Flux Kustomization (`ks.yaml`) — depends on external-secrets-stores, cloudnative-pg, mosquitto
- HelmRelease using bjw-s `app-template` with `postgres-init` sidecar
- ExternalSecrets wired to a shared stage item plus one 1Password item per boat
- Bridge pod also accepts an optional V2 shared-trust secret for the future Lakemates fetch/decrypt runtime
- CNPG-backed tables: `victron_latest`, `victron_history`
- Grafana datasource + dashboard wired in `selfhosted/grafana/`

## Required secret fields

Shared 1Password item `lakemates victron stage shared` should provide:
- `DATABASE_NAME`
- `DATABASE_USER`
- `DATABASE_PASS`
- `LAKEMATES_PUSH_URL` (stage ingest endpoint, e.g. `https://stage.lakemates.com/api/victron/ingest`)
- `LAKEMATES_INGEST_SECRET` (shared secret sent as `X-Ingest-Secret`)

Per-boat 1Password item `lakemates victron boat - <boat-slug>` should provide:
- `VRM_EMAIL`
- `VRM_TOKEN`
- `VRM_PORTAL_ID` (gateway identifier is OK; bridge resolves numeric site id automatically)
- `LAKEMATES_SITE_KEY` (matches the stage tenant's `worker_site_key` / ingest site key)

Current V2 trust item is `lakemates victron v2 shared` and should provide:
- `VICTRON_ENCRYPTION_KEY`
- `VICTRON_BRIDGE_MACHINE_TOKEN`
- `VICTRON_INTERNAL_API_BASE_URL`

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
- `VRM_BOATS_JSON` is now rendered into the runtime secret as the stage multi-boat contract; the current bridge image still receives legacy single-boat vars from the primary stage boat for compatibility
- The pod now also looks for `VICTRON_ENCRYPTION_KEY`, `VICTRON_BRIDGE_MACHINE_TOKEN`, and `VICTRON_INTERNAL_API_BASE_URL` from an optional `vrm-mqtt-bridge-v2-shared` Secret; if that Secret is absent, stage continues to run on the current V1/stage foundation contract

## V2 enablement

- The V2 trust wiring is staged in `app/externalsecret-v2-shared.disabled.yaml`.
- It currently points at the Tranquility-specific trust item because `VICTRON_INTERNAL_API_BASE_URL` is still boat-specific.
- Keep that file out of `app/kustomization.yaml` until the production trust item exists and the bridge runtime is ready to consume the V2 env vars in production.
- When enabling it, add it to `app/kustomization.yaml`, reconcile Flux, and verify the new env vars render into `vrm-mqtt-bridge-v2-shared`.
- Roll back by removing that resource from `app/kustomization.yaml` again; the pod still has the legacy env contract from `vrm-mqtt-bridge-secret`.

## Notes

- CNPG Postgres is the source of truth.
- Production Lakemates remains out of scope until explicitly wired in.
- Secrets belong in 1Password + ExternalSecrets, not plain YAML.
- Bridge egress is restricted by NetworkPolicy and MQTT is intended to stay cluster-internal.
- See `docs/VICTRON_VRM_STAGE_ROLLOUT.md` for rollout history and `vrm-mqtt-bridge` repo for bridge source.
