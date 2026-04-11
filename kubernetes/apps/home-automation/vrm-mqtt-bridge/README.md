# VRM MQTT Bridge

Victron VRM MQTT bridge in the `home-automation` namespace.
Streams telemetry from VRM Cloud MQTT to CNPG Postgres and local Mosquitto.

## What is in git

- Flux Kustomization (`ks.yaml`) — depends on external-secrets-stores, cloudnative-pg, mosquitto
- HelmRelease using bjw-s `app-template` with `postgres-init` sidecar
- ExternalSecrets wired to 1Password item `lakemates victron integration - tranquility`
- Real Victron Venus CA certificate (`venus-ca.crt`) in ConfigMap
- Grafana datasource + dashboard wired in `selfhosted/grafana/`

## What must be provided before deploy

1. 1Password item `lakemates victron integration - tranquility` with fields:
   - `VRM_EMAIL`, `VRM_TOKEN`, `VRM_PORTAL_ID`, `VRM_MQTT_HOST`
   - `DATABASE_NAME`, `DATABASE_USER`, `DATABASE_PASS`
2. Container image at `ghcr.io/scottking2/vrm-mqtt-bridge:0.1.0` (or update the HelmRelease)

## Notes

- CNPG Postgres is the source of truth (not D1/Cloudflare Worker).
- Production Lakemates is out of scope.
- Secrets belong in 1Password + ExternalSecrets, not plain YAML.
- See `docs/VICTRON_VRM_STAGE_ROLLOUT.md` for full architecture and deployment steps.
