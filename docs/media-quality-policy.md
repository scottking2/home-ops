# Media quality and privacy policy

This stack is intentionally limited to organization and subtitle management for
lawfully obtained media. It does not deploy a downloader, torrent client, or
indexer aggregator.

## Required first-run settings

Configure Sonarr and Radarr through their internal-only UIs before importing
anything:

- Set the root folders to the existing Plex TV and Movies library paths.
- Use only authorized acquisition integrations.
- Prefer verified digital purchases, disc rips, and other licensed sources.
- Require the desired audio language and reject releases without an audio
  stream.
- Reject CAM/TS/TC/SCR releases, unknown codecs, and releases below the chosen
  resolution and bitrate floor.
- Enable completed-download import only after the source integration has passed
  a test import.
- In Bazarr, set the preferred subtitle language and enable forced subtitles
  only for foreign-language dialogue.
- In Plex, set subtitle mode to `Shown with foreign audio` and disable automatic
  subtitle selection for normal same-language playback.

## Network boundary

The manifests expose the three UIs only through the internal ingress. The media
namespace is deny-by-default for ingress and egress; the applications may use
cluster DNS and HTTPS, but no torrent/download service is included.

This is a defense-in-depth boundary, not a guarantee of anonymity. Review NAS
access logs, router/firewall logs, DNS logs, and any external service provider's
retention policy before treating the system as private.
