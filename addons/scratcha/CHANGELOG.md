# Changelog

All notable changes to this add-on are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-10-20

### Added

- TurboWarp extension with Home blocks: reporters, booleans, commands, two hats, PIN and error blocks.
- Kids' landing page, status and test page, and a player for `.sb3` files using the TurboWarp Packager.
- Optional self-hosted TurboWarp editor, built in CI from a pinned TurboWarp/scratch-gui commit with one patch.
- Ingress panel, open to non-admin users.
- Supervisor mode: no token needed inside Home Assistant. A WebSocket mirror keeps states live.
- Live updates over Server-Sent Events, with polling as a fallback.
- Safety: deny by default, glob allow and deny lists, named targets only, read-only mode, PIN with lockout, rate limits per device and per entity, Host check, CORS by list.
- HTTPS mode using the Home Assistant certificate.
- AppArmor profile. It is broad on files for now, because it could not be checked on a real Supervisor yet.
- Demo project, unit tests, end-to-end tests against a real Home Assistant, and browser tests.

### Changed

- `config.json` is now `config.yaml`. Only `aarch64` and `amd64` are supported.
- No host networking.
- An empty allowed list now means nothing is allowed. Before, it meant everything.

### Removed

- Options `cache_seconds`, `host`, `port` and `cors_allow_origin`. They are ignored with a warning.
- The old HTML examples. The status page and the demo project replace them.

### Fixed

- The code lived in `rootfs/opt/scratha` while the Dockerfile used `scratcha`, so the image did not build.

## [0.0.1]

- First skeleton.
