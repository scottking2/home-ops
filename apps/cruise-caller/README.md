# Cruise Caller

Cheap browser-voice MVP for family Disney Treasure cruise countdown calls.

## What it does

- Token-protected scheduler UI
- Browser voice calls over OpenAI Realtime WebRTC
- Ring animation + ringtone, then Answer to connect
- Original kid-friendly voice personas (not Disney character impersonations)
- Optional scheduled join links
- No Twilio phone number required

## Flow

1. Unlock the admin UI
2. Pick a persona + kids + topic
3. Click **Call now**
4. Phone UI rings
5. Tap **Answer**
6. Live speech-to-speech conversation starts

## Required secrets

- `cruise-caller-admin-secret` (SOPS): `ADMIN_TOKEN`
- ExternalSecret from 1Password `openai-key`: `OPENAI_API_KEY`

Twilio is **not** required for browser mode.

## Cost notes

- ChatGPT Plus/Pro does **not** cover this API usage
- Uses OpenAI API Realtime billing on your existing API key
- No monthly phone number fee

## Safety

Parent-supervised family calls only. No call recording. No personal-data collection. Original personas only.
