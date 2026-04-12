# Mosquitto

The broker mounts `/mosquitto/config/passwd` from the `mosquitto-auth` Secret key `passwd`.
That value must be a full Mosquitto password-file line, not a raw password.

Current contract:
- username: `telemetry`
- secret source field: `MQTT_PASSWD`
- rendered secret data: `telemetry:<hash>`

If clients get `not authorised`, first verify the mounted passwd file contains a `username:hash` entry rather than only a plain password string.
