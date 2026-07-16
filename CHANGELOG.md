# Changelog

All notable changes to Snagarr are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

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
- Unit tests covering the state engine, password hashing/migration, and OIDC
  configuration.

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

[0.1.0]: https://github.com/Emkraan/snagarr/releases/tag/v0.1.0
