# Victron VRM Stage Rollout — CNPG-First

This documents the implementation state for the Victron proof of concept.
CNPG Postgres on home-ops is the source of truth. Production Lakemates is untouched.

## Architecture

```
VRM Cloud MQTT ──TLS──▶ vrm-mqtt-bridge pod (home-automation)
                              │
                              ├──▶ CNPG Postgres (victron_latest / victron_history)
                              │         ▲
                              │         │ Grafana datasource
                              │         └──── Grafana (selfhosted)
                              │
                              └──▶ Mosquitto (local MQTT, victron/# topics)
```

## What is implemented

### Bridge app (`/Users/sking/skgit/vrm-mqtt-bridge`)
- Python 3.12 app using paho-mqtt + psycopg
- Connects to VRM MQTT with TLS (venus-ca.crt from Victron GitHub)
- Parses dbus topic paths → friendly metric names (16 metrics)
- Buffers metrics in-memory, flushes to Postgres every DB_WRITE_INTERVAL seconds
- Auto-creates `victron_latest` and `victron_history` tables on startup
- Republishes all metrics to local Mosquitto under `victron/` prefix
- VRM keepalive loop to maintain session
- Health check via `/tmp/healthy` for Kubernetes liveness probe
- Dockerfile, CI workflow, pytest suite

### Kubernetes manifests (`home-ops`)
- `kubernetes/apps/home-automation/vrm-mqtt-bridge/` — full Flux Kustomization
- HelmRelease using bjw-s app-template with postgres-init sidecar
- ExternalSecrets wired to 1Password item `lakemates victron integration - tranquility`
  - DB bootstrap: INIT_POSTGRES_HOST/DBNAME/USER/PASS/SUPER_PASS
  - Runtime: VRM_EMAIL/TOKEN/PORTAL_ID/MQTT_HOST + DATABASE_HOST/NAME/USER/PASS
- Real Victron Venus CA cert in ConfigMap (replaced placeholder)
- Flux depends on: `external-secrets-stores`, `cloudnative-pg`, `mosquitto`

### Grafana integration
- Victron Postgres datasource using CNPG credentials
- ExternalSecret pulls VICTRON_DB_NAME/USER/PASS from `lakemates victron integration - tranquility`
- Dashboard ConfigMap: Battery SOC, Solar vs Consumption, Current Battery/Solar/State panels
- Dashboard queries match bridge schema (victron_latest, victron_history tables)

## CNPG-first pivot (what changed from original plan)

- Removed CF_WORKER_URL / CF_PUSH_SECRET from bridge ExternalSecrets and HelmRelease
- Removed CF_PUSH_INTERVAL env var — bridge no longer pushes to Cloudflare Worker
- Aligned all 1Password references to `lakemates victron integration - tranquility` (was `victron-vrm` in Grafana)
- CNPG Postgres is the single source of truth; CF Worker (victron-api-stage) is parked
- No changes to production Lakemates D1 or Cloudflare Worker deployments

## 1Password item: `lakemates victron integration - tranquility`

Required fields:
| Field | Example | Notes |
|-------|---------|-------|
| VRM_EMAIL | user@example.com | Victron VRM account email |
| VRM_TOKEN | abcdef123456 | VRM access token (API key) |
| VRM_PORTAL_ID | c0619ab12345 | Portal/installation ID from VRM |
| VRM_MQTT_HOST | mqtt20.victronenergy.com | VRM MQTT broker hostname |
| DATABASE_NAME | victron | CNPG database name |
| DATABASE_USER | victron | CNPG database user |
| DATABASE_PASS | (generated) | CNPG database password |

## Deployment steps

1. Create 1Password item `lakemates victron integration - tranquility` with fields above
2. Build and push container image:
   ```
   cd /Users/sking/skgit/vrm-mqtt-bridge
   docker build -t ghcr.io/scottking2/vrm-mqtt-bridge:0.1.0 .
   docker push ghcr.io/scottking2/vrm-mqtt-bridge:0.1.0
   ```
   Or push to GitHub and let CI build it.
3. Commit home-ops changes and let Flux reconcile
4. Verify: `kubectl logs -n home-automation deploy/vrm-mqtt-bridge`
5. Verify Grafana Victron dashboard shows live data

## Current live status (2026-04-11)

### Confirmed working
- Flux applied `vrm-mqtt-bridge` successfully on `home-ops`
- GHCR pull secret is present and image pull is no longer blocked
- ExternalSecret is syncing and the runtime secret exists in-cluster
- Bridge pod is running in `home-automation`
- CNPG Postgres is healthy and the `victron` schema objects exist:
  - `victron_history`
  - `victron_latest`

### Confirmed blocked
- The bridge is **not** ingesting live Victron data yet
- Current pod logs show repeated VRM auth failures:
  - `VRM MQTT connect failed: rc=Bad user name or password`
- Row counts are still zero in Postgres for both telemetry tables

### What was tested live
- Verified pod, Helm/Flux state, ExternalSecret sync, and DB schema
- Confirmed runtime env vars are populated in the bridge pod
- Tested multiple likely MQTT auth combinations from inside the running pod:
  - empty username + token password → `Bad user name or password`
  - VRM email + token → `Not authorized`
  - `Token` / `token` / `any` + token → `Not authorized`

### Current conclusion
This is no longer a Kubernetes/bootstrap problem. The remaining blocker is **Victron VRM MQTT authentication**. Most likely one of:
- `VRM_TOKEN` in 1Password is invalid/stale/wrong for MQTT
- MQTT access is not enabled for this VRM installation/account
- the account/token pair does not have MQTT authorization
- the bridge auth contract needs to be adjusted once the correct Victron MQTT login format is confirmed

### Next actions
1. Verify Victron-side MQTT access is enabled for the installation/account
2. Regenerate or replace the VRM token in 1Password item `lakemates victron integration - tranquility`
3. Let ExternalSecret refresh (or force restart/reconcile bridge)
4. Re-check logs for successful VRM connection
5. Confirm rows begin landing in `victron_history` / `victron_latest`

## What is NOT deployed / out of scope

- Production Lakemates (no changes)
- Cloudflare Worker push path (parked, can re-enable later)
- Lakemates stage migration 0028 (not needed for CNPG-first path)
- Fleet/multi-tenant support (single-portal bridge for now)
