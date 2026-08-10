# Changelog

All notable changes to Snagarr are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-08-10

Five-pillar compliance pass, full Cobalt Elevated v3 UI rebuild, and GitOps hardening.

### Added

- **P4 - OIDC provider seeding:** Snagarr now seeds its Authentik OIDC provider from
  `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET` environment variables at
  startup. A deployment with correct env vars is pre-configured out of the box; manual
  provider setup in the UI is only needed for non-Authentik IdPs.
- **P2 - Admin hub:** Dedicated admin UI (`/admin`) with read-only operator view for all
  settings, RBAC enforcement (admin-only routes), and an audit-oriented summary page.
  Admin routes reject non-admin sessions before rendering any content.
- **P3 - API spec identity:** `/api/v1/openapi.json` now carries contact, license, and
  x-logo fields, satisfying the Emkraan Scalar spec-identity standard. An invariant test
  verifies the schema is stable across runs.
- **Login screen standard:** Full-screen entrance with mascot animation, entry animation,
  and sidebar token display. Consistent with the Emkraan login-screen standard across apps.
- **GitOps compliance:** Every push to main dispatches a sha-bump event to homelab-stacks
  so the fleet's Portainer GitOps stack always tracks the canonical image on main.
- **Interactive API docs console:** `/api/v1/docs` (via Scalar) now embeds an interactive
  console with per-view animated heroes. API key auth is pre-wired.
- **Entra profile photo:** OIDC sign-in now fetches and displays the user's Entra profile
  photo in the sidebar and session header. The `profile` scope is added automatically.

### Changed

- **Full UI rebuild - Cobalt Elevated v3:** All views rebuilt on `cobalt.css` v3. The
  design system is de-meshed (no more mixed inline styles + class overrides); every color,
  spacing, and typography value flows through the single CSS token layer.
- **Shell overhaul:** Topbar retired; account info, version, and build now live in the
  sidebar footer. Off-canvas drawer replaces the broken mobile shell; full responsive pass.
- **Cobalt v3 token alignment:** `cobalt.css` updated to v3.1 data-viz primitives across
  all tabs. Toast z-index corrected so toasts are never clipped by the sidebar.
- **P1 - Inline hex removal:** All remaining hardcoded hex color values replaced with
  Cobalt CSS token references, completing P1 compliance.
- **RBAC hardening:** Animated-background standard introduced; admin/member role separation
  enforced at the route level with fail-closed defaults. IdP identity is carried through
  the session and displayed in the UI.

### Fixed

- `/api/v1` health and meta endpoints now report the real running version (was reporting
  the module-level default instead of reading `VERSION`).
- OIDC `redirect_uri` scheme is now derived from the proxy `X-Forwarded-Proto` header
  rather than the Flask request object, so callbacks are built correctly behind a
  TLS-terminating reverse proxy.
- RBAC / proxy-trust hardened for fail-closed behavior on missing or untrusted headers.

## [0.1.0] - 2026-07-18

Fork baseline. Snagarr is forked from Huntarr v6.6.3 by way of the
elfhosted/newtarr fork. This entry covers the foundation, build modernization,
and the state-engine fixes that motivated the fork. It intentionally does not
carry any upstream changelog history. Later entries will add the UI rebrand,
Entra OIDC sign-in, and the versioned configuration API.

### Added

- Snagarr project foundation forked from Huntarr v6.6.3 (via elfhosted/newtarr),
  distributed under GPL-3.0 with upstream attribution (LICENSE + NOTICE).
- Microsoft Entra ID sign-in via in-app OIDC (Authlib), as an alternative to the
  local login. Client credentials are read from mounted secret files, and access
  can be restricted to configured Entra groups.
- A versioned programmatic configuration API at `/api/v1` for reading and writing
  every setting, resetting state, and checking status. It is authenticated with
  scoped bearer API keys (read/write/admin) or an operator session, returns a
  consistent response envelope, and masks secret values in responses.
- Unit tests covering the state engine, password hashing/migration, OIDC
  configuration, the API-key store, and the `/api/v1` surface.

### Fixed

- Scheduled hunting no longer goes idle: the stateful auto-reset that clears the
  processed-item tracker when the retention window passes was never invoked, so
  once the backlog drained, still-missing items were never searched again. It is
  now run on every hunt cycle, so `stateful_management_hours` takes effect.
- Lowering the retention interval no longer places the expiry in the past (the
  window is now anchored to the moment of the change), and a process restart
  preserves the running window instead of re-anchoring it.

### Changed

- Modernized the container image to a Python 3.12 base, dropped Windows-only
  packaging, and refreshed the pinned Python dependency set for current security
  fixes.
- Hardened on-disk state persistence: atomic writes (so a crash mid-write cannot
  wipe the tracker), collision-resistant per-instance filenames, and a lock that
  prevents a reset from racing a concurrent write.
- Hardened authentication: passwords are now hashed with bcrypt (existing
  SHA-256 hashes verify and are upgraded transparently on next login), the
  session signing key is generated once and persisted instead of a weak default,
  and reverse-proxy headers are trusted for one hop so HTTPS callbacks are built
  correctly.
- Secure by default: a fresh install now requires setup and login rather than
  shipping with authentication bypassed.

[0.2.0]: https://github.com/Emkraan/snagarr/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Emkraan/snagarr/releases/tag/v0.1.0
