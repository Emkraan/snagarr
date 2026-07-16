<p align="center">
  <img src=".github/snagarr.png" width="120" alt="Snagarr" />
</p>

<h1 align="center">Snagarr</h1>

<p align="center">
  <strong>Keep Sonarr and Radarr's back-catalog hunted.</strong><br/>
  Snagarr continuously searches your *arr apps for missing media and quality upgrades, then fires the searches for you on a schedule.
</p>

<p align="center">
  <a href="https://github.com/Emkraan/snagarr/releases"><img src="https://img.shields.io/github/v/release/Emkraan/snagarr?style=for-the-badge&color=6366F1" alt="Latest release" /></a>
  <a href="https://github.com/Emkraan/snagarr/pkgs/container/snagarr"><img src="https://img.shields.io/badge/ghcr.io-emkraan%2Fsnagarr-6366F1?style=for-the-badge&logo=github" alt="GHCR image" /></a>
  <a href="https://github.com/Emkraan/snagarr/actions/workflows/build-and-deploy.yml"><img src="https://img.shields.io/github/actions/workflow/status/Emkraan/snagarr/build-and-deploy.yml?style=for-the-badge" alt="Build status" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue?style=for-the-badge" alt="License GPL-3.0" /></a>
</p>

---

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Deployment](#deployment)
- [Data Volume](#data-volume)
- [Environment Variables](#environment-variables)
- [Authentication](#authentication)
- [Troubleshooting](#troubleshooting)
- [Local Development](#local-development)
- [License](#license)
- [Credits and Attribution](#credits-and-attribution)

---

## Features

- **Continuous missing and upgrade hunting** - A background loop keeps asking Sonarr, Radarr, Lidarr, Readarr, Whisparr and Eros to search for content you are missing and for files that qualify for a quality upgrade, so your back-catalog fills in on its own.
- **Per-app hunt counts** - Set how many missing items and how many upgrade items each app searches per cycle. Hunt aggressively on one app and gently on another, with independent counters per app type.
- **Stateful reset that actually works** - Processed items are tracked so the same title is not re-searched every cycle, and the stateful reset now fires on schedule. Once the tracking window expires, the hunt reliably picks missing and upgrade items back up instead of sitting idle for the rest of the week.
- **Swaparr stalled-download culling** - An optional module strikes downloads that stall or exceed a maximum download time, then removes them from your client after a configurable number of strikes. A persistent removal ledger re-culls items that reappear.
- **Scheduling** - Define time windows during which hunting runs, per app or globally, so searches only fire when you want them to.
- **Multi-instance support** - Point a single app type at more than one instance (for example two Sonarr servers) and hunt each one independently.
- **Indexer-friendly rate limiting** - Per-app sleep duration, an hourly API cap and a minimum-download-queue guard keep Snagarr from hammering your indexers.
- **In-app authentication including Microsoft Entra ID (available)** - Local username and password with optional TOTP two-factor, a local-network bypass, a trusted reverse-proxy mode, and Microsoft Entra ID (OIDC) single sign-on.
- **Programmatic config API (available)** - A versioned, auth-protected `/api/v1` surface reads and writes every setting, resets apps, and reports fleet status, so you can drive Snagarr from scripts and GitOps.
- **Hunt history and connection status** - Browse a searchable history of triggered searches and check per-instance connection health at a glance.
- **Single small container** - One Python 3.12 container listening on port 9705, all state under a single `/config` volume, dark web UI included.

## Requirements

| Requirement | Details |
| :--- | :--- |
| Docker host | Docker Engine with Compose v2, or a Portainer-managed environment. amd64 or arm64 Linux. |
| At least one *arr instance | A reachable Sonarr, Radarr, Lidarr, Readarr, Whisparr or Eros server. You provide its base URL and API key (found under `Settings > General` in each *arr app, see the [Servarr wiki](https://wiki.servarr.com/)). |
| Persistent volume | A directory or named volume mounted at `/config` for settings, state, credentials and logs. |
| Microsoft Entra ID tenant (optional) | Only if you enable Entra ID (OIDC) sign-on. See [Register an application with the Microsoft identity platform](https://learn.microsoft.com/entra/identity-platform/quickstart-register-app). |
| Reverse proxy (optional) | Recommended for TLS termination and, if you use proxy or OIDC auth, for putting Snagarr behind a trusted front end. |

## Deployment

Snagarr follows a GitOps deploy model. GitHub Actions builds the container, pushes it to GHCR, and pins the deployed compose to the exact commit. A Portainer stack pulls the compose file directly from this repository, so the running image always matches git. Never edit image tags in the Portainer UI: change them in the compose file in git and redeploy.

Images are published to GHCR under four tags:

```
ghcr.io/emkraan/snagarr:latest          <- latest commit on main
ghcr.io/emkraan/snagarr:edge            <- same as latest
ghcr.io/emkraan/snagarr:X.Y.Z           <- pinned stable release (semver)
ghcr.io/emkraan/snagarr:sha-<commit>    <- immutable build, the deploy target
```

Deploy by the immutable `sha-<commit>` tag. Do not run `:latest` in a production compose.

### Via Portainer

1. **Create the data directory** on the Docker host for the `/config` volume (for example `mkdir -p /srv/snagarr/config`), or plan to use a named volume.
2. **Add a new stack** in Portainer and choose **Repository** as the build method. Point it at this repository and the compose file path.
3. **Set environment variables** for the stack (see [Environment Variables](#environment-variables)). At minimum set a strong `SECRET_KEY` and your `TZ`.
4. **Enable GitOps updates** (automatic redeployment) if you want the stack to redeploy when the compose file changes in git.
5. **Add a repository webhook** so pushes trigger a redeploy, and store the Portainer webhook URL as a GitHub Actions secret named `PORTAINER_WEBHOOK_URL` so the build pipeline can fire it after publishing a new image.
6. **Deploy the stack.**

After deploying, browse to `http://<your-host>:9705` for the web UI. Confirm the service is healthy with `curl http://<your-host>:9705/ping` (returns `{"status":"OK"}`) and check the running build at `http://<your-host>:9705/version.txt`.

### Compose YAML

```yaml
services:
  snagarr:
    image: ghcr.io/emkraan/snagarr:sha-<commit>   # pin to an immutable build, not :latest
    container_name: snagarr
    restart: unless-stopped
    ports:
      - "9705:9705"                # web UI + API
    volumes:
      - ./config:/config           # all settings, state, credentials and logs
    environment:
      - TZ=UTC                     # container timezone; affects schedules and log timestamps
      - SECRET_KEY=change-me       # required in production: strong random Flask session key
      # - PORT=9705                # optional: override the listen port
      # - FLASK_HOST=0.0.0.0       # optional: override the bind address
      # - DEBUG=false              # optional: never enable in production
```

### Pin to a version

To pin to a tagged release instead of a commit, replace the image tag with the semver tag:

```yaml
    image: ghcr.io/emkraan/snagarr:0.1.0
```

## Data Volume

All persistent state lives under `/config`. Each app has its own JSON file, so settings are isolated and independently editable.

```
/config
├── sonarr.json            # per-app settings: instances, hunt counts, sleep, hourly cap
├── radarr.json            # per-app settings (movie hunt counts)
├── lidarr.json            # per-app settings (artist-mode hunting)
├── readarr.json           # per-app settings (book hunt counts)
├── whisparr.json          # per-app settings (Whisparr v2)
├── eros.json              # per-app settings (Whisparr v3 / Eros)
├── general.json           # global + advanced settings, auth bypass flags, stateful hours
├── swaparr.json           # stalled-download culling settings (global, applied to every app)
├── user/
│   └── credentials.json   # hashed username, salted password hash, TOTP 2FA secret
├── stateful/              # processed-item lock timestamps and expiry for stateful reset
├── swaparr/<app>/         # per-app strike tracking and a persistent removal ledger
├── scheduler/
│   └── schedule.json      # scheduled search windows, per app and global
├── reset/<app>.reset      # cycle-reset trigger files (force a fresh hunt cycle)
└── logs/                  # application logs
```

**Key behaviours.** On read, Snagarr back-fills any missing default keys into the on-disk file, so config self-heals as new settings are added. If a settings file is corrupt, it is restored from the shipped defaults rather than crashing the app. Reads are served from a short in-memory cache. Per-app files are independent, so resetting or editing one app does not touch the others.

## Environment Variables

| Variable | Default | Required? | Purpose |
| :--- | :--- | :--- | :--- |
| `PORT` | `9705` | No | Port the web UI and API listen on. |
| `FLASK_HOST` | `0.0.0.0` | No | Bind address for the server. |
| `TZ` | `UTC` | No | Container timezone. Affects schedule windows and log timestamps. |
| `SECRET_KEY` | `dev_key_for_sessions` | Recommended | Flask session signing key. Set a strong random value in production; the default is insecure. |
| `DEBUG` | `false` | No | When `true`, runs the Flask development server with debug logging. Never enable in production. |
| `OIDC_ISSUER_FILE` | (unset) | Optional | Path to a file containing the Entra ID / OIDC issuer URL. Used only when OIDC sign-on is enabled. |
| `OIDC_CLIENT_ID_FILE` | (unset) | Optional | Path to a file containing the OIDC client (application) ID. |
| `OIDC_CLIENT_SECRET_FILE` | (unset) | Optional | Path to a file containing the OIDC client secret. |

Secrets are supplied as file pointers (`*_FILE`) so the value is read from a mounted secret file rather than an inline environment string.

## Authentication

Snagarr's authentication mode is set from the **General** settings (persisted to `general.json`). The available modes are:

- **Login (local account).** On first run, open `/setup` to create a username and password. Passwords are hashed on disk, and you can enable TOTP two-factor from the user page. This is the recommended mode for a directly reachable instance.
- **Local access bypass.** Requests from private (RFC1918) or localhost addresses skip the login prompt while remote requests still must authenticate. Useful on a trusted LAN.
- **Proxy / no-login.** Snagarr trusts an upstream reverse proxy or SSO gateway to handle authentication and does not prompt for its own credentials.
- **Microsoft Entra ID (OIDC), available.** Sign in with your organization's Microsoft Entra ID tenant over OIDC.

### Entra ID example

1. In the Entra admin center, [register an application](https://learn.microsoft.com/entra/identity-platform/quickstart-register-app).
2. Add a **Web** redirect URI of `https://<your-domain>/oidc/callback`.
3. Create a client secret and note the **Application (client) ID**, the **client secret**, and your tenant's OIDC issuer URL (`https://login.microsoftonline.com/<tenant-id>/v2.0`).
4. Mount those three values as files and point `OIDC_ISSUER_FILE`, `OIDC_CLIENT_ID_FILE` and `OIDC_CLIENT_SECRET_FILE` at them, then enable OIDC sign-on in the General settings.

For background on the flow, see [OpenID Connect on the Microsoft identity platform](https://learn.microsoft.com/entra/identity-platform/v2-protocols-oidc).

**No-login implication.** In proxy / no-login mode, Snagarr performs no authentication of its own. Anyone who can reach the port has full control of your *arr connections and API keys. Only use this mode behind a reverse proxy or SSO gateway that authenticates every request, and never expose a no-login instance directly to the internet.

## Troubleshooting

**Hunts went idle and stopped re-searching missing items.** In earlier builds, once every eligible item had been marked processed the hunt could sit idle until the next stateful window, which by default is a week away. Snagarr's stateful reset now fires reliably on schedule, so when the processed-item window expires the hunt picks missing and upgrade items back up automatically. If you want to force it immediately, reset stateful management from the UI or trigger a fresh cycle for the app.

**Swaparr is not culling stalled downloads in time.** Swaparr does not run on its own timer: it piggybacks on each app's hunt loop and adds one strike per cycle, so an item needs `max_strikes` cycles (`max_strikes * sleep_duration`) plus its `max_download_time` before it is removed. Keep that total comfortably shorter than your stateful reset interval (`stateful_management_hours`), otherwise a stalled download can be re-queued by a state reset before Swaparr ever strikes it out. Lower `sleep_duration`, lower `max_strikes`, or shorten `max_download_time` to cull faster.

**Nothing is being searched even though an app is connected.** Check that the app's per-cycle hunt counts are not both zero. `hunt_missing_*` and `hunt_upgrade_*` default to `1` and `0`; if both are `0` the app is effectively idle. Also confirm `monitored_only` matches your library expectations, since unmonitored items are skipped.

**Connection test fails or the *arr API returns 401.** Verify the base URL includes the correct scheme and port, and that the API key matches the one under `Settings > General` in the *arr app. Trailing slashes on the URL are trimmed automatically. If your *arr uses a self-signed certificate, review the `ssl_verify` advanced setting.

**Sessions drop after a restart.** Login sessions are held in memory, so restarting the container logs everyone out. This is expected. Set a stable `SECRET_KEY` so session cookies remain valid across restarts once re-authenticated.

## Local Development

```bash
git clone https://github.com/Emkraan/snagarr.git
cd snagarr

python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Run against a local config directory
export CONFIG_DIR="$(pwd)/config"
export SECRET_KEY="dev-only-not-for-production"
python3 main.py
```

The app starts on `http://127.0.0.1:9705`. Set `DEBUG=true` to use the Flask development server with auto debug logging. In production the same entrypoint serves the app through the Waitress WSGI server.

## License

This project is licensed under the GNU General Public License v3.0 - see [LICENSE](LICENSE).

## Credits and Attribution

Snagarr is a maintained fork of [Huntarr](https://github.com/plexguide/Huntarr.io) (v6.6.3), the *arr missing-media hunter created by the PlexGuide project, by way of the [elfhosted/newtarr](https://github.com/elfhosted/newtarr) fork. All upstream copyright notices and the GPL-3.0 license are preserved. Snagarr keeps the original "hunt the missing and upgradable media" scope and continues to build on that lineage under the same copyleft terms.
