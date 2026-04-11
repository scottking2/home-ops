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

## Runtime behavior

- VRM API is polled every ~30s by default
- current values are written to `victron_latest`
- numeric values are appended to `victron_history`
- current values are also republished to `victron/<metric>` on local Mosquitto

## Notes

- CNPG Postgres is the source of truth.
- Production Lakemates remains out of scope until explicitly wired in.
- Secrets belong in 1Password + ExternalSecrets, not plain YAML.
- See `docs/VICTRON_VRM_STAGE_ROLLOUT.md` for rollout history and `vrm-mqtt-bridge` repo for bridge source.
