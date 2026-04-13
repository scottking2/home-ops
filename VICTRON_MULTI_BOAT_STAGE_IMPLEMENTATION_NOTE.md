# Victron Multi-Boat Stage Foundation

## Secret Contract

Stage is split into shared infra secrets and one secret item per boat.

Shared stage item: `lakemates victron stage shared`

- `DATABASE_NAME`
- `DATABASE_USER`
- `DATABASE_PASS`
- `LAKEMATES_PUSH_URL`
- `LAKEMATES_INGEST_SECRET`

Per-boat item: `lakemates victron boat - <boat-slug>`

- `VRM_EMAIL`
- `VRM_TOKEN`
- `VRM_PORTAL_ID`
- `LAKEMATES_SITE_KEY`
- Optional operator-only notes can stay in the item, but manifests only depend on the four fields above.

This keeps boat-scoped credentials isolated while avoiding duplicated shared DB and ingest credentials in every boat item.

## Multi-Boat Representation

`kubernetes/apps/home-automation/vrm-mqtt-bridge/app/externalsecret.yaml` now renders a deterministic `VRM_BOATS_JSON` secret value for the bridge. The current stage representation is:

```json
[
  {
    "slug": "tranquility",
    "vrm_email": "...",
    "vrm_token": "...",
    "vrm_portal_id": "...",
    "lakemates_site_key": "..."
  }
]
```

Shared DB, ingest, and local MQTT credentials remain separate top-level env vars. For rollout safety, the same secret template also keeps populating legacy single-boat env vars from the primary stage boat. That means stage can deploy deterministically now, and the bridge runtime can switch to `VRM_BOATS_JSON` without another secret-contract migration.

## Exact Stage Deploy Steps

1. Create or update 1Password item `lakemates victron stage shared` with the shared fields above.
2. Create or update 1Password item `lakemates victron boat - tranquility` with the per-boat fields above.
3. If adding another stage boat, duplicate the `tranquility_*` stanza in `kubernetes/apps/home-automation/vrm-mqtt-bridge/app/externalsecret.yaml`, point it at `lakemates victron boat - <new-slug>`, and append a new object to `VRM_BOATS_JSON`.
4. Commit and push the manifest change.
5. Reconcile Flux:
   ```bash
   flux reconcile kustomization vrm-mqtt-bridge -n flux-system --with-source
   flux reconcile kustomization grafana -n flux-system --with-source
   ```
6. Verify secrets and rollout:
   ```bash
   kubectl -n home-automation get externalsecret vrm-mqtt-bridge
   kubectl -n home-automation get secret vrm-mqtt-bridge-secret -o jsonpath='{.data.VRM_BOATS_JSON}' | base64 -d
   kubectl -n home-automation get pods -l app.kubernetes.io/name=vrm-mqtt-bridge
   kubectl -n selfhosted get externalsecret grafana
   ```

## Production Rollout Considerations

- Reuse the same split contract in production: one shared environment item plus one 1Password item per boat.
- Do not reuse stage ingest secrets or site keys in production.
- Switch production only after the bridge runtime reads `VRM_BOATS_JSON` natively and tags writes by boat/tenant in a way downstream consumers can query safely.
- Grafana is now wired to shared Victron DB credentials, but the current dashboard still assumes a single telemetry stream.
- The bridge deployment is also prepped for a future optional `vrm-mqtt-bridge-v2-shared` Secret carrying `VICTRON_ENCRYPTION_KEY`, `VICTRON_BRIDGE_MACHINE_TOKEN`, and `VICTRON_INTERNAL_API_BASE_URL`, but that path should remain disabled until the V2 bridge runtime is proven.

## Onboarding A New Boat

1. Pick a stable boat slug.
2. Create `lakemates victron boat - <boat-slug>` in 1Password.
3. Fill `VRM_EMAIL`, `VRM_TOKEN`, `VRM_PORTAL_ID`, and the Lakemates `LAKEMATES_SITE_KEY`.
4. Add the new boat block and JSON object in `kubernetes/apps/home-automation/vrm-mqtt-bridge/app/externalsecret.yaml`.
5. Commit, push, reconcile Flux, and verify the rendered `VRM_BOATS_JSON`.

## Risks And Open Questions

- The current bridge image may still be single-boat internally; this change preserves compatibility, but true multi-boat behavior still depends on runtime support.
- The current CNPG schema and Grafana dashboard appear single-stream. Before enabling more than one active boat, confirm telemetry is partitioned by boat and queries filter on that partition key.
- If Lakemates wants some identifiers treated as non-secret later, `LAKEMATES_SITE_KEY` and `VRM_PORTAL_ID` may move out of 1Password, but this foundation keeps stage deterministic today.
- Do not add the future V2 ExternalSecret to `app/kustomization.yaml` until the `lakemates victron v2 shared` item exists. A missing 1Password item would otherwise create avoidable reconcile noise during stage validation.
