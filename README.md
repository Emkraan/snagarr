<p align="center">
  <img src=".github/snagarr.png" width="120" alt="Snagarr" />
</p>

<h1 align="center">Snagarr</h1>

<p align="center">
  <strong>Keep your *arr back-catalog hunted, on your schedule.</strong><br/>
  Snagarr continuously searches Sonarr, Radarr, Lidarr, Readarr and Whisparr for missing media and quality upgrades, then fires the searches for you.
</p>

<p align="center">
  <a href="https://github.com/Emkraan/snagarr/releases"><img src="https://img.shields.io/github/v/release/Emkraan/snagarr?style=for-the-badge&color=2486B9" alt="Latest release" /></a>
  <a href="https://github.com/Emkraan/snagarr/pkgs/container/snagarr"><img src="https://img.shields.io/badge/ghcr.io-emkraan%2Fsnagarr-2486B9?style=for-the-badge&logo=github" alt="GHCR image" /></a>
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
- [Roles and Permissions](#roles-and-permissions)
- [Audit Log](#audit-log)
- [Programmatic API](#programmatic-api)
- [Local Development](#local-development)
- [Troubleshooting](#troubleshooting)
- [License](#license)
- [Credits and Attribution](#credits-and-attribution)

---

## Features

- **Continuous missing and upgrade hunting** - A background loop asks Sonarr, Radarr, Lidarr, Readarr, Whisparr and Eros (Whisparr v3) to search for content you are missing and for files that qualify for a quality upgrade, so your back-catalog fills in on its own. One worker thread per configured app.
- **Per-app hunt counts and multi-instance** - Set how many missing items and how many upgrades each app searches per cycle, independently per app. Point one app type at more than one server (for example two Sonarr instances) and hunt each one on its own.
- **Stateful reset that fires on schedule** - Processed items are tracked so the same title is not re-searched every cycle. When the tracking window (`stateful_management_hours`, default 7 days) expires the hunt reliably picks missing and upgrade items back up, and you can reset it by hand from the UI at any time.
- **Swaparr stalled-download culling** - An optional module strikes downloads that stall or exceed a maximum download time, then removes them from your client after a configurable number of strikes and blocklists them. A 30-day removal ledger re-culls items that reappear. Off by default.
- **Scheduling** - Define time windows, per app or globally, that pause or resume hunting or change the hourly API cap, gated by day of week and time of day.
- **Indexer-friendly rate limiting** - A per-app sleep between cycles, an hourly API-hit cap, and a maximum download-queue guard keep Snagarr from hammering your indexers and clients.
- **Provider-agnostic single sign-on** - Configure any number of identity providers entirely in the UI: Microsoft Entra ID, Google, GitHub, Okta, Keycloak, Authentik, a generic OIDC issuer, or a custom OAuth2 endpoint. The login page shows one button per provider alongside the local login. Alongside SSO you get a local username and password account with optional TOTP two-factor, a local-network bypass, and a trusted reverse-proxy mode.
- **Role-based access control** - Two roles, `admin` (full control) and `member` (read-only). Grant admin to an identity-provider group; everyone else who signs in gets a read-only view. Writes from a member are rejected server-side, not just hidden.
- **Identity from your provider** - The signed-in user's full name and profile photo come straight from the identity provider (the standard `picture` claim, or a Microsoft Graph photo fetch for Entra), shown in the sidebar and account page.
- **Programmatic config API with an interactive reference** - A versioned, scope-authenticated `/api/v1` surface reads and writes every setting, resets apps, and reports fleet status, backed by an OpenAPI 3 spec and a browsable API console for minting keys and trying calls.
- **Premium dark web UI, mobile-ready** - A single-page dark interface with live dashboard data-visualization (connection rings, KPI counters, per-app search bars), and a mobile layout that collapses the sidebar into an off-canvas drawer.
- **Hunt history and connection status** - Browse a searchable, per-instance history of every search Snagarr triggered, and check per-app connection health at a glance.

---

## Support

snagarr is free and open source, and always will be. If it is useful to you and
you would like to support development:

<p>
  <a href="https://www.buymeacoffee.com/emkraan"><img src="https://img.buymeacoffee.com/button-api/?text=Buy%20me%20a%20drink&emoji=%F0%9F%8D%B9&slug=emkraan&button_colour=FF5F5F&font_colour=ffffff&font_family=Comic&outline_colour=000000&coffee_colour=FFDD00" alt="Buy Me a Coffee" height="44" /></a>
  &nbsp;
  <a href="https://www.paypal.com/ncp/payment/Z5LS6SWMFQGU4"><img src="https://img.shields.io/badge/PayPal-Donate-00457C?style=for-the-badge&logo=paypal&logoColor=white" alt="Donate via PayPal" height="44" /></a>
</p>

Entirely optional, and every feature stays free either way.

## Requirements

| Requirement | Details |
| :--- | :--- |
| Docker host | Docker Engine with Compose v2. Linux amd64 or arm64. The image runs as a non-root user (uid/gid 1000), so the host `/config` directory must be writable by uid 1000. |
| At least one *arr instance | A reachable Sonarr, Radarr, Lidarr, Readarr, Whisparr or Eros server. Provide its base URL and API key (found under `Settings > General` in each *arr app, see the [Servarr wiki](https://wiki.servarr.com/)). |
| Persistent volume | A directory or named volume mounted at `/config` for settings, state, credentials, and logs. |
| Reverse proxy (optional) | Recommended for TLS termination. Required if you use the trusted-proxy auth mode or want single sign-on over HTTPS. |
| Identity provider (optional) | Only if you enable single sign-on. Any OIDC or OAuth2 provider works; for Microsoft Entra ID see [Register an application](https://learn.microsoft.com/entra/identity-platform/quickstart-register-app). |

---

## Deployment

Snagarr ships as a single container that listens on port `9705` and keeps all state under one `/config` volume. Images are published to GitHub Container Registry (GHCR) under four tags:

```
ghcr.io/emkraan/snagarr:latest          <- latest commit on main
ghcr.io/emkraan/snagarr:edge            <- same as latest
ghcr.io/emkraan/snagarr:X.Y.Z           <- pinned stable release (semver)
ghcr.io/emkraan/snagarr:sha-<commit>    <- immutable per-commit build
```

Pin to a `X.Y.Z` release (or an immutable `sha-<commit>`) in production. Do not run `:latest`.

### Docker Compose (recommended)

Create a `docker-compose.yml`:

```yaml
services:
  snagarr:
    image: ghcr.io/emkraan/snagarr:0.1.0   # pin a release; avoid :latest in production
    container_name: snagarr
    restart: unless-stopped
    ports:
      - "9705:9705"                        # web UI + API
    volumes:
      - ./config:/config                   # all settings, state, credentials, and logs
    environment:
      - TZ=UTC                             # container timezone; affects schedules and log timestamps
      # - SECRET_KEY=change-me             # optional: a random key is generated and persisted if unset
      # - PORT=9705                        # optional: override the listen port
      # - DEBUG=false                      # optional: never enable in production
```

The container runs as uid/gid 1000, so make the host config directory writable by it before the first start:

```bash
mkdir -p ./config
sudo chown -R 1000:1000 ./config
docker compose up -d
```

### First run

Browse to `http://<your-host>:9705`. On first launch you are redirected to `/setup` to create the admin username and password. After that, open **Connections** and add each *arr instance (base URL + API key), then tune hunt counts and schedules under **Settings** and **Scheduling**.

> **Verify the deploy.** `curl http://<your-host>:9705/ping` returns `{"status":"OK"}`. `curl http://<your-host>:9705/api/v1/health` returns the running version. The build number also shows in the sidebar footer.

### Pin to a version

Replace the image tag with a semver release or an immutable commit build:

```yaml
    image: ghcr.io/emkraan/snagarr:0.1.0
    # or
    image: ghcr.io/emkraan/snagarr:sha-<commit>
```

### How the maintainer runs it (optional, GitOps + Portainer)

This is how the maintainer runs their own instance, not a requirement for self-hosting. GitHub Actions builds the image and pushes it to GHCR; a Portainer stack pulls `portainer-stack.yml` directly from a private ops repository and is pinned to an immutable `sha-<commit>` tag, so the running image always matches git. A GitOps webhook redeploys the stack when the pinned tag changes. If you go this route, keep the image tag in git and redeploy from there; never edit tags in the Portainer UI.

---

## Data Volume

All persistent state lives under `/config`. Each app has its own JSON file, so settings are isolated and independently editable. Secret material (credentials, the session key, SSO client secrets, API keys) is written with `0600` permissions.

```
/config
├── sonarr.json            # per-app settings: instances, hunt counts, sleep, hourly cap
├── radarr.json            # per-app settings (movie hunt counts)
├── lidarr.json            # per-app settings (artist-mode hunting)
├── readarr.json           # per-app settings (book hunt counts)
├── whisparr.json          # per-app settings (Whisparr v2)
├── eros.json              # per-app settings (Whisparr v3 / Eros)
├── general.json           # global + advanced settings, auth-bypass flags, stateful hours
├── swaparr.json           # stalled-download culling settings
├── user/                  # 0600 secret directory
│   ├── credentials.json   #   username hash, bcrypt password hash, TOTP 2FA secret
│   ├── secret_key         #   persisted Flask session key (survives restarts)
│   └── oidc.json          #   configured SSO providers (client secrets live here, never in general.json)
├── api/
│   └── keys.json          # hashed API keys (scoped read < write < admin)
├── stateful/              # processed-item tracking + the reset window (lock.json + per-instance files)
├── history/<app>/         # searchable per-instance record of triggered searches
├── scheduler/
│   └── schedule.json      # scheduled pause/resume and API-cap windows
├── swaparr/<app>/         # per-app strike tracking + a 30-day removal ledger
├── state/<app>/           # processed-ID working files for the hunt loop
├── reset/<app>.reset      # cycle-reset trigger files (force a fresh hunt cycle)
└── logs/                  # application logs
```

**Key behaviors.** On read, Snagarr back-fills any missing default keys into each on-disk file, so config self-heals as new settings are added. A corrupt settings file is restored from the shipped defaults rather than crashing the app. Reads are served from a short in-memory cache. Per-app files are independent, so resetting or editing one app never touches another. Login sessions are held in memory (see Troubleshooting).

---

## Environment Variables

Every value has a working default; a bare `docker run` with only a `/config` mount starts cleanly. See [`.env.example`](.env.example) for a copy-paste starting point.

#### Server

| Variable | Default | Required? | Purpose |
| :--- | :--- | :--- | :--- |
| `PORT` | `9705` | No | HTTP port the web UI and API listen on. |
| `FLASK_HOST` | `0.0.0.0` | No | Bind interface (honored by the production entrypoint). |
| `SECRET_KEY` | generated | No | Flask session-signing key. If unset, a random key is generated and persisted to `/config/user/secret_key` on first run. Set it explicitly to share one key across replicas. |
| `DEBUG` | `false` | No | When `true`, runs the Flask development server with debug logging. Never enable in production. |
| `SNAGARR_BUILD` | `dev` | No | Build label reported by `/api/version` and the sidebar footer. Set by CI at image build. |
| `TRUST_PROXY_HOPS` | `0` | No | Number of reverse-proxy hops to trust for `X-Forwarded-For`/`-Proto`/`-Host`. Leave at `0` if this container's port is reachable directly (the default docker-compose setup) - those headers are otherwise attacker-controlled and could be used to spoof a "local" IP or HTTPS. Set to `1` only when a reverse proxy (Traefik, nginx, etc.) sits directly in front of Snagarr; this is required for OIDC's HTTPS callback URL and for the local-network auth bypass to see the real client IP. |

> `TZ` is not read by the application, but the container's libc and Docker honor it, and it sets the timezone used for schedule windows and log timestamps. Set `TZ` in the environment (for example `TZ=America/New_York`).

#### Storage paths (all default under `/config`)

| Variable | Default | Required? | Purpose |
| :--- | :--- | :--- | :--- |
| `SNAGARR_CONFIG_DIR` | `/config` | No | Root config directory. Base for settings, history, keys, stateful, user, and logs. |
| `SNAGARR_USER_DIR` | `<config>/user` | No | Secret directory: credentials, session key, and the SSO provider store. |
| `SNAGARR_API_DIR` | `<config>/api` | No | Storage directory for hashed API keys. |
| `STATEFUL_DIR` | `<config>/stateful` | No | Processed-item tracking directory. |
| `SNAGARR_RESET_DIR` | `/config/reset` | No | Cycle-reset trigger directory used by the API reset endpoint. |
| `CONFIG_DIR` | `/config` | No | Legacy variable read only by the Swaparr and hunt-state modules. Defaults to the same path, so leave it unless you also override `SNAGARR_CONFIG_DIR`. |

#### Migration

| Variable | Default | Required? | Purpose |
| :--- | :--- | :--- | :--- |
| `HUNTARR_RUN_MIGRATION` | `false` | No | When `true`, runs a one-time import of legacy `huntarr.json` settings at startup. Only needed when migrating an existing Huntarr install. |

#### Single sign-on bootstrap (optional, legacy env seed)

SSO is normally configured in the UI (see [Authentication](#authentication)). These variables exist only to bootstrap a single Microsoft Entra provider from the environment on a fresh install; they are read once, when no providers exist yet, then the on-disk store is authoritative. Each accepts a `_FILE` pointer (read the value from a mounted secret file) where noted.

| Variable | `_FILE` variant | Default | Required? | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| `OIDC_TENANT_ID` | `OIDC_TENANT_ID_FILE` | - | No | Entra directory (tenant) ID for the seeded provider. |
| `OIDC_CLIENT_ID` | `OIDC_CLIENT_ID_FILE` | - | No | Application (client) ID. |
| `OIDC_CLIENT_SECRET` | `OIDC_CLIENT_SECRET_FILE` | - | No | Client secret. Seeding fires only if tenant, client ID, and secret are all present. |
| `OIDC_ALLOWED_GROUPS` | - | - | No | Comma-separated group values allowed to sign in. |
| `OIDC_ADMIN_GROUPS` | - | - | No | Comma-separated group values granted the admin role. |
| `OIDC_REDIRECT_URI` | - | derived | No | Hard override for the OAuth callback URL. If unset, the callback is derived from the request and forced to HTTPS for non-localhost hosts. |

---

## Authentication

Snagarr's auth mode is chosen in **Settings > General** and persisted to `general.json`. It is a preset over two flags (`local_access_bypass`, `proxy_auth_bypass`):

- **Login (local account).** The default. On first run, `/setup` creates a username and password (hashed with bcrypt), with optional TOTP two-factor from the account page. Recommended for a directly reachable instance.
- **Local access bypass.** Requests from private (RFC1918) or loopback addresses skip the login prompt; remote requests still authenticate. Useful on a trusted LAN. The first `X-Forwarded-For` address is honored behind a proxy.
- **Trusted proxy / no-login.** Snagarr performs no authentication of its own and trusts an upstream reverse proxy or SSO gateway to gate every request.

Single sign-on runs alongside login mode. The login page always renders the local username and password form plus one button per enabled provider, so a misconfigured provider can never lock you out of local login.

### Single sign-on (configured in the UI)

Open **Settings > Single sign-on** and add one or more providers. Supported types:

`microsoft` (Entra ID), `google`, `github`, `okta`, `keycloak`, `authentik`, `oidc` (any generic OIDC issuer), and `oauth2` (a fully custom authorize/token/userinfo endpoint).

Every provider shares one callback path, `/auth/callback`. Register that as the provider's redirect URI. Client secrets are stored in `/config/user/oidc.json` with `0600` permissions and are never returned to the browser (a sentinel is shown instead, and secrets are preserved unless you change them). Editing a provider re-registers it live, with no restart.

**Microsoft Entra ID example**

1. In the Entra admin center, [register an application](https://learn.microsoft.com/entra/identity-platform/quickstart-register-app) (single tenant).
2. Add a **Web** redirect URI of `https://<your-domain>/auth/callback`.
3. Create a client secret and note the **Application (client) ID**, the **client secret**, and your **Directory (tenant) ID**.
4. In Snagarr: **Settings > Single sign-on > Add provider > Microsoft Entra ID**, paste the tenant ID, client ID, and secret, and save. Sign out and use the Microsoft button on the login page.

For the flow background, see [OpenID Connect on the Microsoft identity platform](https://learn.microsoft.com/entra/identity-platform/v2-protocols-oidc).

> **No-login implication.** In trusted-proxy / no-login mode Snagarr does no authentication of its own. Anyone who can reach the port has full control of your *arr connections and API keys. Only use this mode behind a reverse proxy or SSO gateway that authenticates every request, and never expose a no-login instance directly to the internet.

---

## Roles and Permissions

Snagarr has two roles:

| Role | Can do |
| :--- | :--- |
| **Admin** | Everything: change any setting, add and edit connections, manage schedules, trigger resets, manage SSO providers, and mint or revoke API keys. |
| **Member** | Read-only. View the dashboard, logs, history, and connection status. Every write is rejected, and any API key / client secret returned by a settings read is masked to a last-4 hint. |

**How the role is assigned.** Local login and both bypass modes are always `admin`. For SSO users, the role comes from the provider's **Admin groups**: if a signed-in user's groups intersect that list they are `admin`, otherwise `member`. If **Admin groups** is empty, nobody gets admin via SSO (fails closed) until you configure it - the local username/password account is unaffected. A separate **Allowed groups** list, when set, gates who may sign in at all.

**Enforcement is server-side.** A central `before_request` check rejects every mutating request (`POST`, `PUT`, `PATCH`, `DELETE`) from a member session with `403`, so members are read-only even if they craft requests directly; the UI additionally hides admin navigation and controls for them. API keys inherit the caller's authority: an admin session maps to the `admin` scope, a member session to `read`.

**Claim mapping.** The SSO editor exposes the claim names used for the display name, email, profile photo, and groups, plus the OAuth scopes, so you can adapt Snagarr to any provider's token shape without code changes.

---

## Audit Log

Snagarr does not ship a cryptographic, tamper-evident audit log (no HMAC hash chain or append-only security store). Its activity records are:

- **Hunt History** (**History** page, `GET /api/history`) - a persistent, per-app and per-instance, timestamped record of every item Snagarr searched for, with the operation type (missing or upgrade). Searchable and paginated. This is an activity record for what the hunter did, not an integrity-protected security trail.
- **Scheduler execution history** - the last 50 schedule actions (enable, disable, cap change), held in memory and cleared on restart.
- **Application logs** under `/config/logs`.

If you need a tamper-evident audit trail, place Snagarr behind a reverse proxy or SIEM that records and seals access itself.

---

## Programmatic API

Snagarr exposes a stable, versioned `/api/v1` surface for automation. Browse and try it at **`/api/docs`** (an interactive OpenAPI reference plus an API-key console), and fetch the machine-readable spec from **`/api/v1/openapi.json`** (public). The interactive explorer loads its renderer from a public CDN, so it is not available fully offline; the API itself and the key console are entirely local.

**Envelope.** Every response is `{ "ok": bool, "data": ..., "error": { "code", "message" } | null }`.

**Authentication and scopes.** Send a scoped Bearer key (`Authorization: Bearer snag_...`) or call from a logged-in session. Scopes are ordered `read < write < admin`; a member session maps to `read`. Mint keys on the API page or with `POST /api/v1/keys`; the plaintext is shown once and only a hash is stored.

Representative endpoints (see the spec for the full list):

| Method | Path | Scope |
| :--- | :--- | :--- |
| `GET` | `/api/v1/health` | public |
| `GET` | `/api/v1/config` | read |
| `PUT` / `PATCH` | `/api/v1/config/<app>` | write |
| `GET` | `/api/v1/status` | read |
| `POST` | `/api/v1/stateful/reset` | admin |
| `GET` / `POST` / `DELETE` | `/api/v1/keys` | admin |

---

## Local Development

```bash
git clone https://github.com/Emkraan/snagarr.git
cd snagarr

python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Run against a local config directory
export SNAGARR_CONFIG_DIR="$(pwd)/config"
export SECRET_KEY="dev-only-not-for-production"
python3 main.py
```

The app starts on `http://127.0.0.1:9705`. Set `DEBUG=true` to use the Flask development server with debug logging. In production the same entrypoint serves through the Waitress WSGI server (8 threads). Run the tests with `python3 -m pytest -q`.

---

## Troubleshooting

**Login sessions drop after every container restart.** Sessions are held in memory, so restarting the container logs everyone out. This is expected. The Flask session key is persisted, so once you log back in the cookie stays valid for its one-week sliding lifetime. To avoid re-login on a trusted LAN, enable local-access or trusted-proxy bypass.

**The stateful reset does not clear at the hour I set.** The effective reset window is roughly double `stateful_management_hours`: the hunt path only clears processed IDs once about twice the configured interval has passed. If you want an immediate reset, use **Reset stateful management** in the UI or trigger a fresh cycle for the app.

**Nothing is being searched even though an app is connected, but Swaparr still runs.** If both `hunt_missing_*` and `hunt_upgrade_*` are `0`, the app is idle by design and logs "No items processed." Swaparr culling runs independently of the hunt counts whenever it is enabled. Set a hunt count above `0` to resume searching.

**Connection test fails or the *arr API returns 401.** Re-enter the API key (it must match `Settings > General` in the *arr app), and re-save the instance URL. Trailing slashes are trimmed on save, and the base URL must not include an `/api` suffix (Snagarr appends `api/vN/...` itself). For a self-signed or private-CA certificate, turn off the `ssl_verify` advanced setting.

**Swaparr removes downloads before the stateful window, or too slowly.** Swaparr runs on its own clock, one strike per hunt cycle, and removes an item after `max_strikes` cycles once it stalls or exceeds `max_download_time`. That is entirely separate from the stateful reset interval. Lower `sleep_duration`, `max_strikes`, or `max_download_time` to cull faster.

---

## License

This project is licensed under the GNU General Public License v3.0 - see [LICENSE](LICENSE).

---

## Credits and Attribution

Snagarr is a maintained fork of [Huntarr](https://github.com/plexguide/Huntarr.io) (v6.6.3), the *arr missing-media hunter created by the PlexGuide project, by way of the [elfhosted/newtarr](https://github.com/elfhosted/newtarr) fork. All upstream copyright notices and the GPL-3.0 license are preserved; see [NOTICE](NOTICE) for the full lineage. Snagarr keeps the original "hunt the missing and upgradable media" scope and builds on it under the same copyleft terms.
