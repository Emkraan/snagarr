# Changelog

All notable changes to Snagarr are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

Initial Snagarr release. This is the fork baseline: Snagarr is forked from
Huntarr v6.6.3 by way of the elfhosted/newtarr fork, and this entry covers the
foundation work plus build modernization carried out to stand the project up as
Snagarr. It intentionally does not carry any upstream changelog history.

### Added

- Snagarr project foundation forked from Huntarr v6.6.3 (via elfhosted/newtarr),
  distributed under GPL-3.0 with upstream attribution.
- Microsoft Entra OIDC as a sign-in option.
- Versioned configuration API.
- NOTICE file documenting attribution, the fork modifications, and bundled
  third-party components.

### Changed

- Rebranded the user interface and application identity to Snagarr.
- Modernized the container image to a Python 3.12 base and refreshed the pinned
  Python dependency set.
- Hardened on-disk state persistence against corruption and loss across
  restarts.

### Fixed

- Corrected the stateful auto-reset behavior so scheduled hunting no longer
  resets its processed-item tracking prematurely.

[0.1.0]: https://github.com/Emkraan/snagarr/releases/tag/v0.1.0
