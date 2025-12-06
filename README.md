# ScratcHA – Home Assistant + TurboWarp Bridge

Goal
- Build a client-first bridge so Scratch/TurboWarp projects can call Home Assistant (HA) safely, with minimal setup for kids and hobbyists.
- First target: HA Add-on (or HACS integration) to avoid CORS pain by serving assets and providing a trusted API proxy. Later: static build for GitHub Pages or similar.

Principles
- Keep everything sandboxed to HA’s network; no need for external servers.
- Use long-lived tokens but encourage least-privilege accounts for the bridge.
- Prefer plain HTTP/JSON blocks and extensions already available in TurboWarp; avoid bespoke runtimes if possible.
- ES modules and modern JS where relevant; no dynamic imports.

High-level approach
- HA side: lightweight proxy endpoint that fronts /api (configurable allowlist of entities/services) and serves the packaged TurboWarp project. Runs as an Add-on or HACS resource to sidestep CORS.
- Client side: TurboWarp project using HTTP/JSON/TTS extensions to query and control HA entities, plus a small JS helper for headers and error handling.
- Packaging: TurboWarp Packager to emit a self-contained HTML/JS bundle that the HA add-on hosts; later versions can be deployed as static web assets elsewhere.

Setup sketch (HA add-on path)
- Install add-on (or HACS resource) that exposes a local URL, e.g. /local/scratcha/.
- Configure bridge: HA base URL, scoped token, allowed entities/services, polling interval.
- Open the hosted page; the TurboWarp project reads config from a served JSON file and calls the proxy for GET/POST to HA.

Planned capabilities
- Read-only: announce temperatures, door/motion status, energy usage, etc.
- Control: toggle lights/switches/scenes with debounced calls and basic error toasts.
- Friendly UX: cartoon assistant (cat/dog/Bob throwback) with speech bubbles or TTS.
- Offline-friendly LAN use; no cloud dependency beyond HA itself.

Repository layout
- `addons/scratcha/config.json` – HA add-on manifest (ports, schema, options, host networking).
- `addons/scratcha/Dockerfile` – builds a Node-based proxy/host container.
- `addons/scratcha/rootfs/etc/services.d/scratcha/run` – s6 launch script that runs the bridge.
- `addons/scratcha/rootfs/opt/scratcha/src/server.js` – express server: static hosting + HA proxy with allowlists and optional caching.

Add-on usage (dev path)
- Build: `docker build -t scratcha:addon addons/scratcha`.
- Run locally (example): `docker run --net=host -v $PWD/dev-options.json:/data/options.json scratcha:addon`.
- Required option: `access_token` (HA long-lived, ideally scoped user). Optional: `homeassistant_url`, `allowed_entities`, `allowed_services`, `cache_seconds`, `cors_allow_origin`, `host`, `port`, `static_dir`, `timeout_ms`, `protected_services`, `pin_code`.
- Static assets: place packaged TurboWarp bundle under `/share/scratcha/www` (or set `static_dir`). The bridge serves that folder if present.
- Proxy endpoints exposed on `:8099` by default: `/bridge/health`, `/bridge/config`, `/bridge/states`, `/bridge/states/:entityId`, `/bridge/services/:domain/:service`.

Demo bundle
- Simple demos live under `examples/`:
  - `demo-www` — basic bridge tester for config/states/services.
  - `turbowarp-demo` — sensor read + speech and light toggle (with optional PIN header) to mirror what a TurboWarp project would do. Copy either folder to `/share/scratcha/www` (or your configured `static_dir`).

Security and safety
- Keep tokens browser-side but limit scope; recommend a dedicated HA user with minimal permissions.
- Optional PIN/confirmation for risky actions (e.g. unlocking doors).
- CORS handled by serving from HA; no public exposure by default.

Next steps
- Build TurboWarp demo project that fetches a sensor state and speaks it, then package to `/share/scratcha/www`.
- Add tests (Node) with mocked HA responses for the proxy and allowlists. (`npm test` in `addons/scratcha/rootfs/opt/scratcha`.) -> now includes PIN/timeout coverage.
- Publish add-on repository metadata so HA can install it directly.
- Document deployment for add-on and static-hosted variants.