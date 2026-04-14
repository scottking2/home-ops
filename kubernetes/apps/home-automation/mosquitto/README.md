# Mosquitto

The broker mounts `/mosquitto/config/passwd` from the `mosquitto-auth` Secret key `passwd`.
That value must be a full Mosquitto password-file line, not a raw password.

Current contract:
- secret source fields: `MQTT_USERNAME`, `MQTT_PASSWD`
- rendered secret data: `<MQTT_USERNAME>:<MQTT_PASSWD>`
- `MQTT_PASSWD` must be the Mosquitto hash derived from the plaintext `MQTT_PASSWORD` stored in 1Password for clients

If clients get `not authorised`, first verify the mounted passwd file contains a `username:hash` entry rather than only a plain password string.
