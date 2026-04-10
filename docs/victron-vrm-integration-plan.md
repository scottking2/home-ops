# Victron VRM Integration Plan

> Real-time Victron energy data on the houseboat website via home-ops MQTT bridge + Cloudflare Workers

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Prerequisites & Secrets](#2-prerequisites--secrets)
3. [Component 1: VRM MQTT Bridge (Kubernetes Pod)](#3-component-1-vrm-mqtt-bridge-kubernetes-pod)
4. [Component 2: PostgreSQL Schema](#4-component-2-postgresql-schema)
5. [Component 3: Cloudflare Worker + D1](#5-component-3-cloudflare-worker--d1)
6. [Component 4: Grafana Dashboards](#6-component-4-grafana-dashboards)
7. [Cloudflare Free Tier Budget](#7-cloudflare-free-tier-budget)
8. [Deployment Order](#8-deployment-order)
9. [Testing & Validation](#9-testing--validation)
10. [Rollback Plan](#10-rollback-plan)
11. [Future Enhancements](#11-future-enhancements)

---

## 1. Architecture Overview

```
                          Victron VRM Cloud
                          mqtt{N}.victronenergy.com:8883
                                    |
                                    | TLS MQTT (persistent connection)
                                    | ~2 second updates
                                    |
                    +---------------v-----------------+
                    |   vrm-mqtt-bridge (Python pod)  |
                    |   home-automation namespace      |
                    |                                  |
                    |  - Connects to VRM cloud MQTT    |
                    |  - Sends keepalive every 30s     |
                    |  - Republishes to local Mosquitto|
                    |  - Writes to PostgreSQL          |
                    |  - Pushes snapshots to CF Worker |
                    +------+----------+----------+----+
                           |          |          |
              +------------+    +-----+-----+    +-------------+
              |                 |           |                   |
              v                 v           v                   v
        Mosquitto          PostgreSQL    Cloudflare         Grafana
     (10.0.0.236:1883)    (CNPG)        Worker + D1        Dashboards
     home-automation ns    db ns         (edge)             selfhosted ns
              |                                |
              v                                v
        Home Assistant                   Houseboat Website
        (optional consumer)              (reads from D1)
```

### Data Flow Summary

| Step | Source | Destination | Protocol | Frequency |
|------|--------|-------------|----------|-----------|
| 1 | VRM Cloud MQTT | vrm-mqtt-bridge pod | MQTTS (port 8883) | ~2s (streaming) |
| 2 | vrm-mqtt-bridge | Local Mosquitto | MQTT (port 1883) | ~2s (republish) |
| 3 | vrm-mqtt-bridge | PostgreSQL (CNPG) | TCP (port 5432) | Every 30s (batch insert) |
| 4 | vrm-mqtt-bridge | Cloudflare Worker | HTTPS POST | Every 10-30s (configurable) |
| 5 | Cloudflare Worker | D1 (SQLite) | Internal binding | On each POST |
| 6 | Website | Cloudflare Worker | HTTPS GET | On page load / polling |

---

## 2. Prerequisites & Secrets

### 2.1 Victron VRM Access Token

Create a never-expiring access token for the MQTT bridge:

1. Log into [vrm.victronenergy.com](https://vrm.victronenergy.com)
2. Go to **Preferences > Integrations > Access Tokens** (or visit [vrm.victronenergy.com/access-tokens](https://vrm.victronenergy.com/access-tokens))
3. Create a new token with a descriptive name (e.g., `home-ops-mqtt-bridge`)
4. **Copy the token immediately** -- it is only shown once
5. Note your **VRM Portal ID** -- found on your GX device at Settings > VRM online portal > VRM Portal ID, or on the VRM website under your installation settings. It's typically the lowercase MAC address without colons (e.g., `d41243b50dfc`)

### 2.2 VRM MQTT Broker Calculation

The broker hostname is deterministic based on your Portal ID:

```python
def get_vrm_broker_url(portal_id: str) -> str:
    """Sum ASCII values of portal ID, mod 128 = broker index."""
    total = sum(ord(c) for c in portal_id.lower().strip())
    broker_index = total % 128
    return f"mqtt{broker_index}.victronenergy.com"
```

Example: Portal ID `d41243b50dfc` -> `mqtt86.victronenergy.com`

Alternatively, query the VRM API:
```
GET https://vrmapi.victronenergy.com/v2/users/{userId}/installations?extended=1
```
Each installation object contains `mqtt_host` and `mqtt_webhost` fields.

### 2.3 1Password Items to Create

Create two items in the `taxhawk-personal` vault:

**Item: `victron-vrm`**

| Field | Value | Description |
|-------|-------|-------------|
| `VRM_EMAIL` | your VRM login email | MQTT username |
| `VRM_TOKEN` | access token from step 2.1 | MQTT password (prefixed with `Token ` in code) |
| `VRM_PORTAL_ID` | your portal ID | e.g., `d41243b50dfc` |
| `VRM_MQTT_HOST` | calculated broker hostname | e.g., `mqtt86.victronenergy.com` |
| `CF_WORKER_URL` | Cloudflare Worker push endpoint | e.g., `https://victron-api.your-subdomain.workers.dev/api/push` |
| `CF_PUSH_SECRET` | random 64-char string | Shared secret for authenticating pushes to CF Worker |
| `DATABASE_NAME` | `victron` | PostgreSQL database name |
| `DATABASE_USER` | `victron` | PostgreSQL username |
| `DATABASE_PASS` | generate a strong password | PostgreSQL password |

**Item: `cloudnative-pg`** (already exists -- no changes needed, referenced for `POSTGRES_SERVER` and `POSTGRES_SUPER_PASS`)

### 2.4 Cloudflare Worker Secret

The `CF_PUSH_SECRET` value must also be set as a Wrangler secret on the Worker side:

```bash
cd cloudflare-worker-directory
npx wrangler secret put API_SECRET
# paste the same CF_PUSH_SECRET value
```

### 2.5 VRM TLS Certificate

The VRM MQTT brokers require TLS. The CA certificate is available from Victron's GitHub:

```
https://raw.githubusercontent.com/victronenergy/dbus-flashmq/master/venus-ca.crt
```

This cert will be mounted into the bridge pod via a ConfigMap (see Section 3).

---

## 3. Component 1: VRM MQTT Bridge (Kubernetes Pod)

### 3.1 Overview

A Python application deployed as a single pod in the `home-automation` namespace. It:

1. Connects to VRM's cloud MQTT broker over TLS
2. Subscribes to all topics for the configured portal ID
3. Maintains a keepalive every 30 seconds
4. Republishes all messages to local Mosquitto under `victron/` topic prefix
5. Buffers data and writes batches to PostgreSQL every 30 seconds
6. Pushes a JSON snapshot to the Cloudflare Worker every 10-30 seconds

### 3.2 Directory Structure

```
kubernetes/apps/home-automation/vrm-mqtt-bridge/
├── ks.yaml
└── app/
    ├── kustomization.yaml
    ├── helmrelease.yaml
    ├── externalsecret.yaml
    └── configs/
        └── venus-ca.crt
```

### 3.3 Docker Image

Build a custom Python image. The Dockerfile and application code will live in a separate repository (e.g., `git.taxhawk.com/sking/vrm-mqtt-bridge` or a public GitHub repo).

**Dockerfile:**

```dockerfile
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

USER 1000:1000

CMD ["python", "-u", "main.py"]
```

**requirements.txt:**

```
paho-mqtt==2.1.0
psycopg2-binary==2.9.10
requests==2.32.3
```

### 3.4 Application Code (`main.py`)

```python
#!/usr/bin/env python3
"""
VRM MQTT Bridge
- Connects to Victron VRM cloud MQTT
- Republishes to local Mosquitto
- Writes time-series data to PostgreSQL
- Pushes snapshots to Cloudflare Worker
"""

import json
import logging
import os
import signal
import ssl
import sys
import threading
import time
from datetime import datetime, timezone

import paho.mqtt.client as mqtt
import psycopg2
import psycopg2.extras
import requests

# ─── Configuration (from environment) ───────────────────────────────────────

VRM_EMAIL = os.environ["VRM_EMAIL"]
VRM_TOKEN = os.environ["VRM_TOKEN"]
VRM_PORTAL_ID = os.environ["VRM_PORTAL_ID"]
VRM_MQTT_HOST = os.environ["VRM_MQTT_HOST"]
VRM_MQTT_PORT = int(os.environ.get("VRM_MQTT_PORT", "8883"))
VRM_CA_CERT = os.environ.get("VRM_CA_CERT", "/certs/venus-ca.crt")

LOCAL_MQTT_HOST = os.environ.get("LOCAL_MQTT_HOST", "mosquitto.home-automation.svc.cluster.local")
LOCAL_MQTT_PORT = int(os.environ.get("LOCAL_MQTT_PORT", "1883"))
LOCAL_MQTT_PREFIX = os.environ.get("LOCAL_MQTT_PREFIX", "victron")

DB_HOST = os.environ.get("DATABASE_HOST", "postgres-rw.db.svc.cluster.local")
DB_PORT = int(os.environ.get("DATABASE_PORT", "5432"))
DB_NAME = os.environ["DATABASE_NAME"]
DB_USER = os.environ["DATABASE_USER"]
DB_PASS = os.environ["DATABASE_PASS"]

CF_WORKER_URL = os.environ.get("CF_WORKER_URL", "")
CF_PUSH_SECRET = os.environ.get("CF_PUSH_SECRET", "")
CF_PUSH_INTERVAL = int(os.environ.get("CF_PUSH_INTERVAL", "15"))  # seconds

DB_WRITE_INTERVAL = int(os.environ.get("DB_WRITE_INTERVAL", "30"))  # seconds

KEEPALIVE_INTERVAL = 30  # seconds (VRM timeout is 60s)

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO")

# ─── Logging ─────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL.upper()),
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("vrm-bridge")

# ─── Global State ────────────────────────────────────────────────────────────

# Thread-safe dict holding latest values from VRM
# Key: topic suffix (e.g., "system/0/Dc/Battery/Soc"), Value: {"value": ..., "ts": ...}
latest_data: dict[str, dict] = {}
data_lock = threading.Lock()

shutdown_event = threading.Event()

# ─── Topic Mapping ───────────────────────────────────────────────────────────

# Topics we care about for PostgreSQL and Cloudflare push
# Maps friendly name -> topic suffix (after N/{portal_id}/)
TRACKED_TOPICS = {
    # Battery
    "battery_soc": "system/0/Dc/Battery/Soc",
    "battery_voltage": "system/0/Dc/Battery/Voltage",
    "battery_current": "system/0/Dc/Battery/Current",
    "battery_power": "system/0/Dc/Battery/Power",
    "battery_temperature": "system/0/Dc/Battery/Temperature",
    "battery_time_to_go": "system/0/Dc/Battery/TimeToGo",
    # Solar
    "solar_power": "system/0/Dc/Pv/Power",
    "solar_current": "system/0/Dc/Pv/Current",
    # AC Consumption
    "ac_consumption_l1": "system/0/Ac/Consumption/L1/Power",
    "ac_consumption_l2": "system/0/Ac/Consumption/L2/Power",
    "ac_consumption_l3": "system/0/Ac/Consumption/L3/Power",
    # AC Grid
    "ac_grid_l1": "system/0/Ac/Grid/L1/Power",
    "ac_grid_l2": "system/0/Ac/Grid/L2/Power",
    "ac_grid_l3": "system/0/Ac/Grid/L3/Power",
    # Inverter/Charger DC
    "vebus_dc_current": "system/0/Dc/Vebus/Current",
    "vebus_dc_power": "system/0/Dc/Vebus/Power",
    # DC System loads
    "dc_system_power": "system/0/Dc/System/Power",
    # System state
    "system_state": "system/0/SystemState/State",
    "ac_input_source": "system/0/Ac/ActiveIn/Source",
    # GPS
    "gps_latitude": "gps/0/Position/Latitude",
    "gps_longitude": "gps/0/Position/Longitude",
    "gps_speed": "gps/0/Speed",
    "gps_course": "gps/0/Course",
}

# Reverse lookup: topic suffix -> friendly name
TOPIC_TO_NAME = {v: k for k, v in TRACKED_TOPICS.items()}

# ─── Per-device topics (discovered at runtime) ──────────────────────────────
# These are populated when we discover solarcharger, tank, and temperature
# device instances from the MQTT feed

# Tank fluid type mapping
TANK_FLUID_TYPES = {
    0: "fuel", 1: "fresh_water", 2: "waste_water", 3: "live_well",
    4: "oil", 5: "black_water", 6: "gasoline", 7: "diesel",
    8: "lpg", 9: "lng", 10: "hydraulic_oil", 11: "raw_water",
}


# ─── VRM MQTT Client ────────────────────────────────────────────────────────

def on_vrm_connect(client, userdata, flags, reason_code, properties=None):
    """Called when connected to VRM cloud MQTT."""
    if reason_code == 0:
        log.info("Connected to VRM MQTT broker: %s", VRM_MQTT_HOST)
        # Subscribe to all topics for our portal
        topic = f"N/{VRM_PORTAL_ID}/#"
        client.subscribe(topic, qos=0)
        log.info("Subscribed to: %s", topic)
        # Trigger initial full publish
        client.publish(f"R/{VRM_PORTAL_ID}/keepalive", "")
        log.info("Sent initial keepalive (full publish)")
    else:
        log.error("VRM connection failed: reason_code=%s", reason_code)


def on_vrm_message(client, userdata, msg):
    """Called for each message from VRM MQTT."""
    prefix = f"N/{VRM_PORTAL_ID}/"
    if not msg.topic.startswith(prefix):
        return

    topic_suffix = msg.topic[len(prefix):]

    # Parse payload
    value = None
    if msg.payload:
        try:
            payload = json.loads(msg.payload)
            value = payload.get("value")
        except (json.JSONDecodeError, AttributeError):
            value = msg.payload.decode("utf-8", errors="replace")
    # else: empty payload = device offline, value stays None

    # Store in latest_data
    now = datetime.now(timezone.utc).isoformat()
    with data_lock:
        latest_data[topic_suffix] = {"value": value, "ts": now}

    # Republish to local Mosquitto
    local_topic = f"{LOCAL_MQTT_PREFIX}/{topic_suffix}"
    try:
        local_client.publish(local_topic, msg.payload, qos=0)
    except Exception as e:
        log.warning("Failed to republish to local MQTT: %s", e)


def on_vrm_disconnect(client, userdata, flags, reason_code, properties=None):
    """Called when disconnected from VRM MQTT."""
    log.warning("Disconnected from VRM MQTT (rc=%s), will auto-reconnect", reason_code)


# ─── Local MQTT Client ──────────────────────────────────────────────────────

def on_local_connect(client, userdata, flags, reason_code, properties=None):
    if reason_code == 0:
        log.info("Connected to local Mosquitto: %s:%d", LOCAL_MQTT_HOST, LOCAL_MQTT_PORT)
    else:
        log.error("Local MQTT connection failed: reason_code=%s", reason_code)


# ─── PostgreSQL Writer ───────────────────────────────────────────────────────

def get_db_connection():
    """Create a new database connection."""
    return psycopg2.connect(
        host=DB_HOST,
        port=DB_PORT,
        dbname=DB_NAME,
        user=DB_USER,
        password=DB_PASS,
    )


def db_writer_loop():
    """Periodically write buffered data to PostgreSQL."""
    log.info("PostgreSQL writer started (interval=%ds)", DB_WRITE_INTERVAL)

    conn = None
    while not shutdown_event.is_set():
        shutdown_event.wait(DB_WRITE_INTERVAL)
        if shutdown_event.is_set():
            break

        # Snapshot current data
        with data_lock:
            snapshot = {k: v.copy() for k, v in latest_data.items()}

        if not snapshot:
            continue

        # Filter to tracked topics only
        rows = []
        for topic_suffix, data in snapshot.items():
            friendly_name = TOPIC_TO_NAME.get(topic_suffix)
            if friendly_name and data["value"] is not None:
                rows.append((
                    friendly_name,
                    topic_suffix,
                    json.dumps(data["value"]) if not isinstance(data["value"], (int, float)) else data["value"],
                    data["ts"],
                ))

        if not rows:
            continue

        try:
            if conn is None or conn.closed:
                conn = get_db_connection()

            with conn.cursor() as cur:
                # Upsert latest values
                psycopg2.extras.execute_values(
                    cur,
                    """
                    INSERT INTO victron_latest (metric, topic, value, updated_at)
                    VALUES %s
                    ON CONFLICT (metric) DO UPDATE SET
                        value = EXCLUDED.value,
                        updated_at = EXCLUDED.updated_at
                    """,
                    rows,
                    template="(%s, %s, %s, %s::timestamptz)",
                )

                # Append to history
                psycopg2.extras.execute_values(
                    cur,
                    """
                    INSERT INTO victron_history (metric, topic, value, recorded_at)
                    VALUES %s
                    """,
                    rows,
                    template="(%s, %s, %s, %s::timestamptz)",
                )

            conn.commit()
            log.debug("Wrote %d metrics to PostgreSQL", len(rows))

        except Exception as e:
            log.error("PostgreSQL write failed: %s", e)
            if conn and not conn.closed:
                conn.rollback()
            conn = None  # Force reconnect

    if conn and not conn.closed:
        conn.close()
    log.info("PostgreSQL writer stopped")


# ─── Cloudflare Worker Pusher ────────────────────────────────────────────────

def cf_pusher_loop():
    """Periodically push snapshot to Cloudflare Worker."""
    if not CF_WORKER_URL or not CF_PUSH_SECRET:
        log.info("Cloudflare push disabled (CF_WORKER_URL or CF_PUSH_SECRET not set)")
        return

    log.info("Cloudflare pusher started (interval=%ds, url=%s)", CF_PUSH_INTERVAL, CF_WORKER_URL)

    while not shutdown_event.is_set():
        shutdown_event.wait(CF_PUSH_INTERVAL)
        if shutdown_event.is_set():
            break

        # Build snapshot of tracked metrics
        with data_lock:
            snapshot = {}
            for friendly_name, topic_suffix in TRACKED_TOPICS.items():
                data = latest_data.get(topic_suffix)
                if data and data["value"] is not None:
                    snapshot[friendly_name] = {
                        "value": data["value"],
                        "ts": data["ts"],
                    }

            # Also grab any discovered tank/solar charger data
            for topic_suffix, data in latest_data.items():
                if data["value"] is not None:
                    # Include tank levels
                    if "/tank/" in topic_suffix.lower() or topic_suffix.startswith("tank/"):
                        key = f"raw/{topic_suffix}"
                        snapshot[key] = {"value": data["value"], "ts": data["ts"]}
                    # Include per-charger solar data
                    if topic_suffix.startswith("solarcharger/"):
                        key = f"raw/{topic_suffix}"
                        snapshot[key] = {"value": data["value"], "ts": data["ts"]}

        if not snapshot:
            continue

        # Push to Cloudflare Worker
        payload = [
            {"key": k, "data": v}
            for k, v in snapshot.items()
        ]

        try:
            resp = requests.post(
                CF_WORKER_URL,
                json=payload,
                headers={
                    "Authorization": f"Bearer {CF_PUSH_SECRET}",
                    "Content-Type": "application/json",
                },
                timeout=10,
            )
            if resp.status_code == 200:
                log.debug("Pushed %d metrics to Cloudflare", len(payload))
            else:
                log.warning("CF push returned %d: %s", resp.status_code, resp.text[:200])
        except requests.RequestException as e:
            log.warning("CF push failed: %s", e)

    log.info("Cloudflare pusher stopped")


# ─── VRM Keepalive ───────────────────────────────────────────────────────────

def keepalive_loop(vrm_client):
    """Send periodic keepalive to VRM MQTT."""
    log.info("Keepalive loop started (interval=%ds)", KEEPALIVE_INTERVAL)

    # First keepalive already sent on connect (full publish)
    # Subsequent keepalives suppress republish to reduce bandwidth
    shutdown_event.wait(KEEPALIVE_INTERVAL)

    while not shutdown_event.is_set():
        try:
            vrm_client.publish(
                f"R/{VRM_PORTAL_ID}/keepalive",
                json.dumps({"keepalive-options": ["suppress-republish"]}),
            )
            log.debug("Sent keepalive (suppress-republish)")
        except Exception as e:
            log.warning("Keepalive publish failed: %s", e)

        shutdown_event.wait(KEEPALIVE_INTERVAL)

    log.info("Keepalive loop stopped")


# ─── Main ────────────────────────────────────────────────────────────────────

def shutdown_handler(signum, frame):
    log.info("Shutdown signal received (%s)", signal.Signals(signum).name)
    shutdown_event.set()


def main():
    global local_client

    signal.signal(signal.SIGTERM, shutdown_handler)
    signal.signal(signal.SIGINT, shutdown_handler)

    log.info("Starting VRM MQTT Bridge")
    log.info("  Portal ID: %s", VRM_PORTAL_ID)
    log.info("  VRM Broker: %s:%d", VRM_MQTT_HOST, VRM_MQTT_PORT)
    log.info("  Local MQTT: %s:%d (prefix: %s)", LOCAL_MQTT_HOST, LOCAL_MQTT_PORT, LOCAL_MQTT_PREFIX)
    log.info("  PostgreSQL: %s:%d/%s", DB_HOST, DB_PORT, DB_NAME)
    log.info("  CF Push: %s (every %ds)", "enabled" if CF_WORKER_URL else "disabled", CF_PUSH_INTERVAL)

    # ── Local MQTT client ──
    local_client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id="vrm-bridge-local",
    )
    local_client.on_connect = on_local_connect
    local_client.reconnect_delay_set(min_delay=1, max_delay=30)

    try:
        local_client.connect(LOCAL_MQTT_HOST, LOCAL_MQTT_PORT, keepalive=60)
    except Exception as e:
        log.error("Failed to connect to local MQTT: %s", e)
        sys.exit(1)

    local_client.loop_start()

    # ── VRM MQTT client ──
    vrm_client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id=f"vrm-bridge-{VRM_PORTAL_ID}-{int(time.time())}",
    )
    vrm_client.username_pw_set(VRM_EMAIL, password=f"Token {VRM_TOKEN}")

    # TLS setup
    vrm_client.tls_set(
        ca_certs=VRM_CA_CERT,
        tls_version=ssl.PROTOCOL_TLS_CLIENT,
    )

    vrm_client.on_connect = on_vrm_connect
    vrm_client.on_message = on_vrm_message
    vrm_client.on_disconnect = on_vrm_disconnect
    vrm_client.reconnect_delay_set(min_delay=1, max_delay=60)

    try:
        vrm_client.connect(VRM_MQTT_HOST, VRM_MQTT_PORT, keepalive=60)
    except Exception as e:
        log.error("Failed to connect to VRM MQTT: %s", e)
        sys.exit(1)

    vrm_client.loop_start()

    # ── Background threads ──
    threads = [
        threading.Thread(target=keepalive_loop, args=(vrm_client,), daemon=True, name="keepalive"),
        threading.Thread(target=db_writer_loop, daemon=True, name="db-writer"),
        threading.Thread(target=cf_pusher_loop, daemon=True, name="cf-pusher"),
    ]
    for t in threads:
        t.start()

    # ── Wait for shutdown ──
    log.info("VRM MQTT Bridge running. Press Ctrl+C to stop.")
    shutdown_event.wait()

    log.info("Shutting down...")
    vrm_client.disconnect()
    vrm_client.loop_stop()
    local_client.disconnect()
    local_client.loop_stop()

    for t in threads:
        t.join(timeout=5)

    log.info("VRM MQTT Bridge stopped")


if __name__ == "__main__":
    main()
```

### 3.5 Tracked MQTT Topics Reference

These are the VRM MQTT topics subscribed to via `N/{portal_id}/#`. The bridge tracks these specific paths for storage and push:

#### System Aggregated (`system/0/...`)

| Metric | Topic Suffix | Unit |
|--------|-------------|------|
| Battery SOC | `system/0/Dc/Battery/Soc` | % |
| Battery Voltage | `system/0/Dc/Battery/Voltage` | V |
| Battery Current | `system/0/Dc/Battery/Current` | A |
| Battery Power | `system/0/Dc/Battery/Power` | W |
| Battery Temp | `system/0/Dc/Battery/Temperature` | C |
| Time to Go | `system/0/Dc/Battery/TimeToGo` | seconds |
| Solar Power (total) | `system/0/Dc/Pv/Power` | W |
| Solar Current (total) | `system/0/Dc/Pv/Current` | A |
| AC Consumption L1 | `system/0/Ac/Consumption/L1/Power` | W |
| AC Consumption L2 | `system/0/Ac/Consumption/L2/Power` | W |
| AC Consumption L3 | `system/0/Ac/Consumption/L3/Power` | W |
| Grid Power L1 | `system/0/Ac/Grid/L1/Power` | W |
| Grid Power L2 | `system/0/Ac/Grid/L2/Power` | W |
| Grid Power L3 | `system/0/Ac/Grid/L3/Power` | W |
| Inverter DC Current | `system/0/Dc/Vebus/Current` | A |
| Inverter DC Power | `system/0/Dc/Vebus/Power` | W |
| DC System Loads | `system/0/Dc/System/Power` | W |
| System State | `system/0/SystemState/State` | enum |
| AC Input Source | `system/0/Ac/ActiveIn/Source` | enum |

#### Per-Device (discovered at runtime)

| Device | Topic Pattern | Key Values |
|--------|--------------|------------|
| Solar Charger | `solarcharger/{instance}/Yield/Power` | Current W |
| Solar Charger | `solarcharger/{instance}/History/Daily/0/Yield` | Today kWh |
| Solar Charger | `solarcharger/{instance}/Pv/0/V` | Panel voltage |
| Tank | `tank/{instance}/Level` | 0-100% |
| Tank | `tank/{instance}/FluidType` | See fluid enum |
| Tank | `tank/{instance}/Remaining` | m3 |
| GPS | `gps/0/Position/Latitude` | degrees |
| GPS | `gps/0/Position/Longitude` | degrees |
| GPS | `gps/0/Speed` | m/s |
| Temperature | `temperature/{instance}/Temperature` | C |

#### VRM MQTT Payload Format

All payloads are JSON:
```json
{"value": 52.41}          // Battery voltage
{"value": -12.5}          // Discharging current (negative)
{"value": 85}             // SOC percentage
{"value": null}           // Temporarily unavailable
```
Empty payload (zero bytes) = device offline/disconnected.

### 3.6 Kubernetes Manifests

#### `kubernetes/apps/home-automation/vrm-mqtt-bridge/ks.yaml`

```yaml
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: &app vrm-mqtt-bridge
  namespace: flux-system
spec:
  targetNamespace: home-automation
  commonMetadata:
    labels:
      app.kubernetes.io/name: *app
  dependsOn:
    - name: external-secrets-stores
    - name: cloudnative-pg-cluster
    - name: mosquitto
  path: ./kubernetes/apps/home-automation/vrm-mqtt-bridge/app
  prune: true
  sourceRef:
    kind: GitRepository
    name: home-kubernetes
  wait: false
  interval: 30m
  retryInterval: 1m
  timeout: 5m
```

#### `kubernetes/apps/home-automation/vrm-mqtt-bridge/app/kustomization.yaml`

```yaml
---
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: home-automation
resources:
  - ./externalsecret.yaml
  - ./helmrelease.yaml
configMapGenerator:
  - name: vrm-mqtt-bridge-certs
    files:
      - ./configs/venus-ca.crt
generatorOptions:
  disableNameSuffixHash: true
```

#### `kubernetes/apps/home-automation/vrm-mqtt-bridge/app/externalsecret.yaml`

```yaml
---
# Database initialization secret
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: vrm-mqtt-bridge-init-db
spec:
  secretStoreRef:
    kind: ClusterSecretStore
    name: onepassword-connect
  target:
    name: vrm-mqtt-bridge-init-db
    creationPolicy: Owner
    template:
      engineVersion: v2
      metadata:
        labels:
          cnpg.io/reload: "true"
  data:
    - secretKey: INIT_POSTGRES_HOST
      remoteRef:
        key: cloudnative-pg
        property: POSTGRES_SERVER
    - secretKey: INIT_POSTGRES_DBNAME
      remoteRef:
        key: victron-vrm
        property: DATABASE_NAME
    - secretKey: INIT_POSTGRES_SUPER_PASS
      remoteRef:
        key: cloudnative-pg
        property: POSTGRES_SUPER_PASS
    - secretKey: INIT_POSTGRES_USER
      remoteRef:
        key: victron-vrm
        property: DATABASE_USER
    - secretKey: INIT_POSTGRES_PASS
      remoteRef:
        key: victron-vrm
        property: DATABASE_PASS
---
# Runtime secret for the bridge application
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: vrm-mqtt-bridge
spec:
  secretStoreRef:
    kind: ClusterSecretStore
    name: onepassword-connect
  target:
    name: vrm-mqtt-bridge-secret
    creationPolicy: Owner
    template:
      engineVersion: v2
  data:
    # VRM MQTT credentials
    - secretKey: VRM_EMAIL
      remoteRef:
        key: victron-vrm
        property: VRM_EMAIL
    - secretKey: VRM_TOKEN
      remoteRef:
        key: victron-vrm
        property: VRM_TOKEN
    - secretKey: VRM_PORTAL_ID
      remoteRef:
        key: victron-vrm
        property: VRM_PORTAL_ID
    - secretKey: VRM_MQTT_HOST
      remoteRef:
        key: victron-vrm
        property: VRM_MQTT_HOST
    # PostgreSQL credentials
    - secretKey: DATABASE_HOST
      remoteRef:
        key: cloudnative-pg
        property: POSTGRES_SERVER
    - secretKey: DATABASE_NAME
      remoteRef:
        key: victron-vrm
        property: DATABASE_NAME
    - secretKey: DATABASE_USER
      remoteRef:
        key: victron-vrm
        property: DATABASE_USER
    - secretKey: DATABASE_PASS
      remoteRef:
        key: victron-vrm
        property: DATABASE_PASS
    # Cloudflare Worker push
    - secretKey: CF_WORKER_URL
      remoteRef:
        key: victron-vrm
        property: CF_WORKER_URL
    - secretKey: CF_PUSH_SECRET
      remoteRef:
        key: victron-vrm
        property: CF_PUSH_SECRET
```

#### `kubernetes/apps/home-automation/vrm-mqtt-bridge/app/helmrelease.yaml`

```yaml
---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: vrm-mqtt-bridge
spec:
  interval: 30m
  chart:
    spec:
      chart: app-template
      version: 4.6.2
      sourceRef:
        kind: HelmRepository
        name: bjw-s
        namespace: flux-system
  install:
    remediation:
      retries: 3
  upgrade:
    cleanupOnFail: true
    remediation:
      strategy: rollback
      retries: 3
  uninstall:
    keepHistory: false

  values:
    controllers:
      vrm-mqtt-bridge:
        strategy: Recreate
        annotations:
          reloader.stakater.com/auto: "true"

        pod:
          enableServiceLinks: false

        initContainers:
          init-db:
            image:
              repository: ghcr.io/home-operations/postgres-init
              tag: "18.3"
              pullPolicy: IfNotPresent
            envFrom:
              - secretRef:
                  name: vrm-mqtt-bridge-init-db

        containers:
          app:
            image:
              repository: ghcr.io/YOURUSER/vrm-mqtt-bridge  # TODO: replace with actual image
              tag: "0.1.0"
              pullPolicy: IfNotPresent

            env:
              TZ: America/Denver
              LOG_LEVEL: INFO
              VRM_MQTT_PORT: "8883"
              LOCAL_MQTT_HOST: mosquitto.home-automation.svc.cluster.local
              LOCAL_MQTT_PORT: "1883"
              LOCAL_MQTT_PREFIX: victron
              CF_PUSH_INTERVAL: "15"
              DB_WRITE_INTERVAL: "30"

            envFrom:
              - secretRef:
                  name: vrm-mqtt-bridge-secret

            resources:
              requests:
                cpu: 25m
                memory: 64Mi
              limits:
                memory: 256Mi

            probes:
              # No HTTP server, so use exec probes
              liveness:
                enabled: true
                custom: true
                spec:
                  exec:
                    command:
                      - python
                      - -c
                      - "import os; os.path.exists('/tmp/healthy') or exit(1)"
                  initialDelaySeconds: 30
                  periodSeconds: 30
                  failureThreshold: 3
              readiness:
                enabled: false
              startup:
                enabled: false

    # No service needed -- this pod doesn't serve HTTP traffic
    service:
      app:
        enabled: false

    persistence:
      certs:
        type: configMap
        name: vrm-mqtt-bridge-certs
        globalMounts:
          - path: /certs/venus-ca.crt
            subPath: venus-ca.crt
            readOnly: true
```

#### `kubernetes/apps/home-automation/vrm-mqtt-bridge/app/configs/venus-ca.crt`

Download from Victron's GitHub before deploying:
```bash
curl -o kubernetes/apps/home-automation/vrm-mqtt-bridge/app/configs/venus-ca.crt \
  https://raw.githubusercontent.com/victronenergy/dbus-flashmq/master/venus-ca.crt
```

### 3.7 Register in Namespace Kustomization

Add to `kubernetes/apps/home-automation/kustomization.yaml`:

```yaml
---
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ./namespace.yaml
  - ./mosquitto/ks.yaml
  - ./home-assistant/ks.yaml
  - ./vrm-mqtt-bridge/ks.yaml       # <-- ADD THIS
  # - ./frigate/ks.yaml
```

### 3.8 Health Check

The application should write a `/tmp/healthy` file on successful VRM connection. Add this to the `on_vrm_connect` callback:

```python
def on_vrm_connect(client, userdata, flags, reason_code, properties=None):
    if reason_code == 0:
        # ... existing code ...
        # Write health file for Kubernetes liveness probe
        with open("/tmp/healthy", "w") as f:
            f.write(str(time.time()))
```

---

## 4. Component 2: PostgreSQL Schema

### 4.1 Overview

The `postgres-init` container creates the database and user automatically. The schema needs to be applied once after the database is created. Two approaches:

**Option A (recommended):** Add schema creation to the bridge's startup code
**Option B:** Run manually via `kubectl exec`

### 4.2 Schema

```sql
-- Latest snapshot: one row per metric, always the most recent value
CREATE TABLE IF NOT EXISTS victron_latest (
    metric      TEXT PRIMARY KEY,
    topic       TEXT NOT NULL,
    value       DOUBLE PRECISION,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Time-series history: append-only, for Grafana graphs
CREATE TABLE IF NOT EXISTS victron_history (
    id          BIGSERIAL PRIMARY KEY,
    metric      TEXT NOT NULL,
    topic       TEXT NOT NULL,
    value       DOUBLE PRECISION,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_history_metric_time
    ON victron_history (metric, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_history_time
    ON victron_history (recorded_at DESC);

-- Retention: auto-delete history older than 90 days
-- Run daily via pg_cron or a Kubernetes CronJob:
-- DELETE FROM victron_history WHERE recorded_at < NOW() - INTERVAL '90 days';
```

### 4.3 Add Schema Init to Bridge Startup

Add this to `main.py` before starting the MQTT clients:

```python
def init_database():
    """Create tables if they don't exist."""
    log.info("Initializing database schema...")
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS victron_latest (
                    metric      TEXT PRIMARY KEY,
                    topic       TEXT NOT NULL,
                    value       DOUBLE PRECISION,
                    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );

                CREATE TABLE IF NOT EXISTS victron_history (
                    id          BIGSERIAL PRIMARY KEY,
                    metric      TEXT NOT NULL,
                    topic       TEXT NOT NULL,
                    value       DOUBLE PRECISION,
                    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );

                CREATE INDEX IF NOT EXISTS idx_history_metric_time
                    ON victron_history (metric, recorded_at DESC);

                CREATE INDEX IF NOT EXISTS idx_history_time
                    ON victron_history (recorded_at DESC);
            """)
        conn.commit()
        log.info("Database schema ready")
    finally:
        conn.close()
```

### 4.4 History Retention CronJob

Deploy a Kubernetes CronJob to prune old data (or add it to the bridge's db_writer_loop):

```yaml
# Optional: kubernetes/apps/home-automation/vrm-mqtt-bridge/app/cronjob.yaml
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: victron-history-prune
spec:
  schedule: "0 3 * * *"  # Daily at 3 AM
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: prune
              image: ghcr.io/cloudnative-pg/postgresql:17.5
              command:
                - psql
                - -c
                - "DELETE FROM victron_history WHERE recorded_at < NOW() - INTERVAL '90 days';"
              env:
                - name: PGHOST
                  value: postgres-rw.db.svc.cluster.local
                - name: PGDATABASE
                  value: victron
              envFrom:
                - secretRef:
                    name: vrm-mqtt-bridge-secret  # provides DATABASE_USER, DATABASE_PASS
          restartPolicy: OnFailure
```

---

## 5. Component 3: Cloudflare Worker + D1

### 5.1 Overview

A Cloudflare Worker that:
- **POST `/api/push`** -- receives data pushed from the home-ops cluster (authenticated)
- **GET `/api/latest`** -- returns all latest metrics (public, CORS-enabled)
- **GET `/api/latest?key=battery_soc`** -- returns a single metric
- **GET `/api/history?key=battery_soc&limit=100`** -- returns recent history for a metric

### 5.2 Project Setup

```bash
npm create cloudflare@latest victron-api -- --type=worker-typescript
cd victron-api
npx wrangler d1 create victron-data
# Copy the database_id from output into wrangler.toml
```

### 5.3 `wrangler.toml`

```toml
name = "victron-api"
main = "src/index.ts"
compatibility_date = "2026-04-09"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "victron-data"
database_id = "<paste-from-d1-create-output>"

[vars]
ALLOWED_ORIGIN = "https://your-houseboat-website.com"
```

### 5.4 D1 Schema (`schema.sql`)

```sql
CREATE TABLE IF NOT EXISTS latest (
    key        TEXT PRIMARY KEY,
    value      REAL,
    ts         TEXT NOT NULL,
    data_json  TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    key        TEXT NOT NULL,
    value      REAL,
    ts         TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_history_key_created ON history(key, created_at);
CREATE INDEX IF NOT EXISTS idx_history_created ON history(created_at);
```

Apply:
```bash
npx wrangler d1 execute victron-data --remote --file=./schema.sql
```

### 5.5 Worker Code (`src/index.ts`)

```typescript
export interface Env {
  DB: D1Database;
  API_SECRET: string;         // wrangler secret put API_SECRET
  ALLOWED_ORIGIN: string;     // from [vars] in wrangler.toml
}

// ─── CORS ───────────────────────────────────────────────────────────────────

function corsHeaders(origin: string | null, allowed: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": allowed === "*" ? "*" : (origin ?? ""),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data: unknown, status: number, req: Request, env: Env): Response {
  const origin = req.headers.get("Origin");
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin, env.ALLOWED_ORIGIN ?? "*"),
    },
  });
}

// ─── Auth ───────────────────────────────────────────────────────────────────

function authenticate(req: Request, env: Env): boolean {
  const header = req.headers.get("Authorization");
  if (!header) return false;
  const token = header.replace("Bearer ", "");
  return token === env.API_SECRET;
}

// ─── POST /api/push ─────────────────────────────────────────────────────────

interface PushItem {
  key: string;
  data: { value: number | string | null; ts: string };
}

async function handlePush(req: Request, env: Env): Promise<Response> {
  if (!authenticate(req, env)) {
    return json({ error: "Unauthorized" }, 401, req, env);
  }

  let items: PushItem[];
  try {
    const raw = await req.json();
    items = Array.isArray(raw) ? raw : [raw];
  } catch {
    return json({ error: "Invalid JSON" }, 400, req, env);
  }

  const stmts: D1PreparedStatement[] = [];

  for (const item of items) {
    if (!item.key || !item.data) continue;

    const numericValue = typeof item.data.value === "number" ? item.data.value : null;
    const dataJson = JSON.stringify(item.data);

    // Upsert into latest
    stmts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO latest (key, value, ts, data_json, updated_at)
         VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
      ).bind(item.key, numericValue, item.data.ts, dataJson)
    );

    // Append to history (only for numeric values)
    if (numericValue !== null) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO history (key, value, ts, created_at)
           VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
        ).bind(item.key, numericValue, item.data.ts)
      );
    }
  }

  // Prune history older than 24 hours (keep D1 lean)
  stmts.push(
    env.DB.prepare(
      `DELETE FROM history WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')`
    )
  );

  if (stmts.length === 0) {
    return json({ error: "No valid items" }, 400, req, env);
  }

  try {
    await env.DB.batch(stmts);
    return json({ ok: true, items: items.length }, 200, req, env);
  } catch (err: any) {
    return json({ error: err.message }, 500, req, env);
  }
}

// ─── GET /api/latest ────────────────────────────────────────────────────────

async function handleLatest(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");

  try {
    if (key) {
      const row = await env.DB.prepare(
        "SELECT key, value, ts, data_json, updated_at FROM latest WHERE key = ?1"
      ).bind(key).first();

      if (!row) return json({ error: "Not found" }, 404, req, env);

      return json({
        key: row.key,
        value: row.value,
        ts: row.ts,
        data: row.data_json ? JSON.parse(row.data_json as string) : null,
        updated_at: row.updated_at,
      }, 200, req, env);
    }

    // Return all latest
    const { results } = await env.DB.prepare(
      "SELECT key, value, ts, data_json, updated_at FROM latest ORDER BY key"
    ).run();

    const parsed = results.map((r: any) => ({
      key: r.key,
      value: r.value,
      ts: r.ts,
      data: r.data_json ? JSON.parse(r.data_json) : null,
      updated_at: r.updated_at,
    }));

    return json({ metrics: parsed, count: parsed.length }, 200, req, env);
  } catch (err: any) {
    return json({ error: err.message }, 500, req, env);
  }
}

// ─── GET /api/history ───────────────────────────────────────────────────────

async function handleHistory(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100"), 1000);

  if (!key) return json({ error: "'key' query param required" }, 400, req, env);

  try {
    const { results } = await env.DB.prepare(
      "SELECT key, value, ts, created_at FROM history WHERE key = ?1 ORDER BY created_at DESC LIMIT ?2"
    ).bind(key, limit).run();

    return json({ key, points: results, count: results.length }, 200, req, env);
  } catch (err: any) {
    return json({ error: err.message }, 500, req, env);
  }
}

// ─── Router ─────────────────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      const origin = req.headers.get("Origin");
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, env.ALLOWED_ORIGIN ?? "*"),
      });
    }

    // Routes
    switch (url.pathname) {
      case "/api/push":
        if (req.method === "POST") return handlePush(req, env);
        break;
      case "/api/latest":
        if (req.method === "GET") return handleLatest(req, env);
        break;
      case "/api/history":
        if (req.method === "GET") return handleHistory(req, env);
        break;
      case "/health":
        return json({ ok: true }, 200, req, env);
    }

    return json({ error: "Not found" }, 404, req, env);
  },
} satisfies ExportedHandler<Env>;
```

### 5.6 Deploy

```bash
# Apply D1 schema
npx wrangler d1 execute victron-data --remote --file=./schema.sql

# Set the push secret
npx wrangler secret put API_SECRET
# paste the same value as CF_PUSH_SECRET in 1Password

# Deploy
npx wrangler deploy

# Verify
curl https://victron-api.YOUR-SUBDOMAIN.workers.dev/health
```

### 5.7 Website Integration Example

```javascript
// Fetch all latest metrics
async function fetchVictronData() {
  const resp = await fetch("https://victron-api.YOUR-SUBDOMAIN.workers.dev/api/latest");
  const data = await resp.json();
  return data.metrics;
}

// Fetch specific metric
async function fetchBatterySOC() {
  const resp = await fetch("https://victron-api.YOUR-SUBDOMAIN.workers.dev/api/latest?key=battery_soc");
  return await resp.json();
}

// Fetch history for charts
async function fetchSolarHistory() {
  const resp = await fetch("https://victron-api.YOUR-SUBDOMAIN.workers.dev/api/history?key=solar_power&limit=500");
  return await resp.json();
}
```

---

## 6. Component 4: Grafana Dashboards

### 6.1 Add PostgreSQL Datasource

Add a new datasource to the existing Grafana deployment. Update the Grafana HelmRelease or ExternalSecret to include the Victron database connection:

```yaml
# In Grafana's datasources configuration
datasources:
  - name: Victron
    type: postgres
    url: postgres-rw.db.svc.cluster.local:5432
    database: victron
    user: victron
    secureJsonData:
      password: <from secret>
    jsonData:
      sslmode: disable
      postgresVersion: 1700
      timescaledb: false
```

### 6.2 Dashboard Queries

**Battery SOC over time:**
```sql
SELECT
  recorded_at AS "time",
  value AS "Battery SOC (%)"
FROM victron_history
WHERE metric = 'battery_soc'
  AND $__timeFilter(recorded_at)
ORDER BY recorded_at
```

**Solar power vs consumption:**
```sql
SELECT
  recorded_at AS "time",
  metric,
  value
FROM victron_history
WHERE metric IN ('solar_power', 'ac_consumption_l1')
  AND $__timeFilter(recorded_at)
ORDER BY recorded_at
```

**Current system status (single stat panels):**
```sql
SELECT value FROM victron_latest WHERE metric = 'battery_soc';
SELECT value FROM victron_latest WHERE metric = 'solar_power';
SELECT value FROM victron_latest WHERE metric = 'battery_power';
```

---

## 7. Cloudflare Free Tier Budget

### 7.1 Worker Request Budget (100,000/day)

| Source | Calculation | Requests/Day |
|--------|-------------|-------------|
| Push from cluster (every 15s) | 86,400 / 15 = 5,760 | 5,760 |
| Website page views | ~500 views × 3 API calls | 1,500 |
| **Total** | | **~7,260** |
| **Headroom** | 100,000 - 7,260 | **92,740 (92.7% free)** |

### 7.2 D1 Write Budget (100,000/day)

| Source | Calculation | Writes/Day |
|--------|-------------|-----------|
| Upsert latest (20 metrics × 5,760 pushes) | Batch = 1 transaction per push | ~5,760 |
| Append history (20 metrics × 5,760) | Same batch | ~5,760 |
| Prune (1 per push) | 5,760 | ~5,760 |
| **Total** | | **~17,280** |
| **Headroom** | 100,000 - 17,280 | **82,720 (82.7% free)** |

Note: Each statement in a `db.batch()` counts individually toward the 50-per-invocation limit. With 20 metrics that's 20 upserts + 20 history inserts + 1 prune = 41 statements. Under the 50 limit.

### 7.3 D1 Read Budget (5,000,000/day)

| Source | Calculation | Reads/Day |
|--------|-------------|----------|
| Website latest (500 views) | 500 | 500 |
| Website history (100 views) | 100 | 100 |
| **Total** | | **~600** |
| **Headroom** | 5,000,000 - 600 | **4,999,400 (99.99% free)** |

### 7.4 Summary

**You are well within the free tier on all dimensions.** You could push every 5 seconds and 10x your website traffic and still have budget to spare.

---

## 8. Deployment Order

### Phase 1: Infrastructure (no risk)

1. **Create 1Password item** `victron-vrm` with all fields from Section 2.3
2. **Download venus-ca.crt** to `configs/` directory
3. **Build and push Docker image** for vrm-mqtt-bridge

### Phase 2: Cloudflare Worker (independent, no cluster impact)

4. **Scaffold Worker project** (`npm create cloudflare`)
5. **Create D1 database** and apply schema
6. **Deploy Worker** and set `API_SECRET` secret
7. **Test Worker** with curl:
   ```bash
   # Test push
   curl -X POST https://victron-api.YOUR-SUBDOMAIN.workers.dev/api/push \
     -H "Authorization: Bearer YOUR_SECRET" \
     -H "Content-Type: application/json" \
     -d '[{"key":"test_metric","data":{"value":42,"ts":"2026-04-09T00:00:00Z"}}]'

   # Test read
   curl https://victron-api.YOUR-SUBDOMAIN.workers.dev/api/latest

   # Test health
   curl https://victron-api.YOUR-SUBDOMAIN.workers.dev/health
   ```

### Phase 3: Kubernetes Deployment

8. **Add vrm-mqtt-bridge** directory structure to home-ops repo
9. **Update** `kubernetes/apps/home-automation/kustomization.yaml` to include the new app
10. **Commit and push** -- Flux will reconcile
11. **Monitor pod startup:**
    ```bash
    export KUBECONFIG=~/.kube/config.home-ops
    kubectl -n home-automation get pods -l app.kubernetes.io/name=vrm-mqtt-bridge -w
    kubectl -n home-automation logs -f deploy/vrm-mqtt-bridge
    ```

### Phase 4: Verify End-to-End

12. **Check local Mosquitto** for Victron topics:
    ```bash
    kubectl -n home-automation exec -it deploy/mosquitto -- \
      mosquitto_sub -h localhost -t "victron/#" -v -C 10
    ```
13. **Check PostgreSQL** for data:
    ```bash
    kubectl -n db exec -it postgres-1 -- psql -U victron -d victron -c \
      "SELECT * FROM victron_latest ORDER BY metric;"
    ```
14. **Check Cloudflare Worker** for pushed data:
    ```bash
    curl https://victron-api.YOUR-SUBDOMAIN.workers.dev/api/latest
    ```

### Phase 5: Grafana (optional, low risk)

15. **Add Victron datasource** to Grafana
16. **Create dashboards** for battery, solar, consumption

---

## 9. Testing & Validation

### 9.1 Pre-Deployment Checklist

- [ ] 1Password `victron-vrm` item created with all fields
- [ ] VRM access token created and tested (can query VRM API)
- [ ] Portal ID confirmed correct
- [ ] MQTT broker hostname calculated/verified
- [ ] `venus-ca.crt` downloaded and added to configs/
- [ ] Docker image built and pushed to registry
- [ ] Cloudflare Worker deployed and `/health` returns `{"ok": true}`
- [ ] Worker `API_SECRET` set via `wrangler secret`
- [ ] Worker push tested with curl (returns `{"ok": true}`)

### 9.2 Runtime Validation

| Check | Command | Expected |
|-------|---------|----------|
| Pod running | `kubectl -n home-automation get pods -l app.kubernetes.io/name=vrm-mqtt-bridge` | 1/1 Running |
| VRM connected | `kubectl -n home-automation logs deploy/vrm-mqtt-bridge \| grep "Connected to VRM"` | Connection message |
| Local MQTT flowing | `mosquitto_sub -h 10.0.0.236 -t "victron/#" -v -C 5` | Victron topics with values |
| PostgreSQL populated | `psql -c "SELECT count(*) FROM victron_latest"` | > 0 rows |
| CF Worker receiving | `curl .../api/latest` | JSON with metrics |
| Website displaying | Load website, check energy section | Real-time values |

### 9.3 Failure Scenarios

| Failure | Impact | Auto-Recovery |
|---------|--------|---------------|
| VRM MQTT disconnects | No new data; stale values served | paho-mqtt auto-reconnects (1-60s backoff) |
| Local Mosquitto down | VRM data still flows to PG + CF | Reconnects when Mosquitto returns |
| PostgreSQL down | History stops; latest/CF still work | Reconnects on next write cycle |
| CF Worker down | Website shows stale data | Worker is stateless; redeploy fixes |
| Bridge pod crashes | All data stops | Kubernetes restarts pod automatically |
| VRM token expires | MQTT auth fails | Create new token, update 1Password |

---

## 10. Rollback Plan

### Remove the Bridge

1. Comment out `./vrm-mqtt-bridge/ks.yaml` in `kubernetes/apps/home-automation/kustomization.yaml`
2. Commit and push -- Flux prunes the resources
3. Alternatively, immediate: `kubectl -n home-automation delete helmrelease vrm-mqtt-bridge`

### Remove Cloudflare Worker

```bash
npx wrangler delete victron-api
npx wrangler d1 delete victron-data
```

### Remove PostgreSQL Data

```bash
kubectl -n db exec -it postgres-1 -- psql -U postgres -c "DROP DATABASE victron;"
```

### No Impact on Existing Systems

- Mosquitto: bridge publishes to it but Mosquitto doesn't depend on the bridge
- PostgreSQL: new database, no impact on existing databases (teslamate, etc.)
- Cloudflare tunnel: not modified
- Home Assistant: can optionally subscribe to `victron/#` topics but is not required

---

## 11. Future Enhancements

### 11.1 Tank Level Discovery

The bridge currently tracks system-level aggregated data. To add per-tank tracking:

1. Subscribe to `N/{portal_id}/tank/+/Level` and `N/{portal_id}/tank/+/FluidType`
2. Build a device registry as tank instances are discovered
3. Map `FluidType` enum to friendly names (fresh_water, black_water, etc.)
4. Add these to the tracked metrics pushed to CF and written to PostgreSQL

### 11.2 Per-Charger Solar Tracking

If you have multiple MPPT solar chargers:

1. Discover instances via `solarcharger/+/ProductId`
2. Track individual tracker power: `solarcharger/{instance}/Pv/0/P`
3. Add per-charger yield tracking

### 11.3 Write Commands

The VRM MQTT bridge can also write values back to the system:

```python
# Example: set inverter mode
vrm_client.publish(
    f"W/{VRM_PORTAL_ID}/vebus/257/Mode",
    json.dumps({"value": 3})  # 3 = On
)
```

This enables remote control from the website (with proper authentication).

### 11.4 Alerting

- Add Prometheus metrics export to the bridge (via `/metrics` endpoint)
- Alert on low battery SOC, high consumption, solar charger errors
- Push alerts to Slack via the existing Slack integration

### 11.5 Home Assistant Integration

Home Assistant can subscribe to the local Mosquitto `victron/#` topics for automations:

```yaml
# Home Assistant configuration.yaml
mqtt:
  sensor:
    - name: "Houseboat Battery SOC"
      state_topic: "victron/system/0/Dc/Battery/Soc"
      value_template: "{{ value_json.value }}"
      unit_of_measurement: "%"
      device_class: battery

    - name: "Houseboat Solar Power"
      state_topic: "victron/system/0/Dc/Pv/Power"
      value_template: "{{ value_json.value }}"
      unit_of_measurement: "W"
      device_class: power
```
