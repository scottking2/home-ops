# Cruise Caller

Small MVP for scheduled family cruise countdown phone calls.

## What it does

- Hosts a token-protected scheduler UI.
- Stores schedules and recent calls in `/data/state.json`.
- Places outbound calls through Twilio Programmable Voice.
- Bridges Twilio bidirectional Media Streams to the OpenAI Realtime API.
- Uses original kid-friendly voice personas. It must not impersonate Mickey, Minnie, Donald, Goofy, or any other protected character.

## Required secrets

The admin token is stored as a SOPS-encrypted Kubernetes secret:

- `cruise-caller-admin-secret`

External Secrets expects a 1Password item named `cruise-caller` with these fields:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`
- `DEFAULT_TO_NUMBER`

The OpenAI key comes from the existing `openai-key` 1Password item:

- `OPENAI_API_KEY`

## Twilio

The app creates outbound calls with a per-call webhook URL, so the Twilio phone number does not need a fixed voice webhook for scheduled calls. The public app URL must stay reachable by Twilio:

`https://cruise-caller.scottjking.com`

## Safety notes

This is designed for parent-supervised family calls only. It does not record calls, does not ask children for personal information, and keeps the assistant focused on cruise countdown conversation.
