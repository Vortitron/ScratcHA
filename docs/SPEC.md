# ScratcHA specification

Status: agreed plan for the "finish" build pass. Date: 2026-10-20.

ScratcHA is a Home Assistant app (add-on) that lets Scratch projects made in TurboWarp read and control a home, safely, for kids and hobbyists. This document says what "finished" means, why each choice was made, and how we prove it works.

Words used here:

- **Bridge**: the Node server inside the add-on.
- **Extension**: the TurboWarp custom extension file `scratcha.js` that adds the Home Assistant blocks.
- **Editor**: a TurboWarp editor build served by the add-on itself.
- **Player**: a packaged project (one HTML file) made by the TurboWarp Packager.
- **Core**: Home Assistant Core, reached through the Supervisor.

"Must" items are in scope for this pass. "Should" items are in scope if time allows. "Later" items are out of scope.

---

## 1. How a kid uses it

### 1.1 The real constraint

turbowarp.org is served over HTTPS. The bridge is plain HTTP on the LAN (for example `http://homeassistant.local:8099`). Browsers block HTTP requests from an HTTPS page (mixed content). That blocks both loading the extension from the bridge and every `fetch` the extension makes. CORS headers cannot fix this. So the obvious path, "open turbowarp.org and point it at the add-on", does not work.

### 1.2 Options evaluated

| Option | Works? | Notes |
| --- | --- | --- |
| turbowarp.org + extension by URL from the bridge (HTTP) | No | Mixed content. The extension script itself is blocked. |
| turbowarp.org + extension from an HTTPS host (for example GitHub Pages) calling the HTTP bridge | No | Script loads, but every bridge `fetch` is mixed content. |
| Same, in Chrome with Local Network Access | Partly | Chrome exempts requests to private IP literals and `.local` names from mixed content after a permission prompt. Chrome only. A sandboxed extension runs in an `allow-scripts` iframe whose permissions policy TurboWarp locks down, so it needs "Run without sandbox". Not reliable for kids. Experimental only. |
| TurboWarp Desktop | No (same as web) | The editor runs from the `tw-editor://` scheme, registered with `secure: true` (checked in `TurboWarp/desktop` `src-main/protocols.js`). HTTP LAN requests are mixed content there too. Only `http://localhost` works. |
| HA ingress, used from turbowarp.org | No | The ingress cookie is set by the HA frontend with `SameSite=Strict` and `path=/api/hassio_ingress/`, so cross-site requests from turbowarp.org never carry it. The ingress URL also contains a session token that changes. |
| HA ingress, page served by the add-on itself | Yes | Same origin as the bridge, HTTPS if HA is HTTPS, logged-in users only. Non-admin users can open the panel when `panel_admin: false` (HA allows `/ingress/session` for non-admins). |
| Editor self-hosted on the add-on origin | Yes | Same origin as the bridge, so no mixed content and no CORS. Works in every browser, on the LAN port and inside ingress. Cost: TurboWarp has no prebuilt web bundle to download, so we build `TurboWarp/scratch-gui` in CI. |
| Packaged projects (TurboWarp Packager) hosted on the add-on | Yes | The Packager Node API (`@turbowarp/packager`, MPL-2.0, about 6 MB) turns an `.sb3` into one HTML file with the extension inlined and unsandboxed. Served from the bridge origin. Play only, no editing. |
| Add-on serves HTTPS with HA's own certificate | Yes, if the house has a real certificate | With `map: ssl` the bridge can use `/ssl/fullchain.pem`. turbowarp.org can then load the extension and call the bridge directly. Needs a domain that resolves on the LAN and a valid certificate. Not every house has that. |
| scratch.mit.edu | No | Official Scratch does not load custom extensions at all. |

### 1.3 Decision

**Primary path: everything on the add-on origin.** The add-on serves the editor, the extension, the bridge API and the player. A kid never needs turbowarp.org, a token or a certificate.

**Fallback path: packaged projects on the add-on.** If the editor build is missing (CI not run yet, or a broken pinned build), the add-on still turns `.sb3` files into players. The kid edits anywhere (turbowarp.org, Desktop), saves an `.sb3`, and a parent drops it into the add-on. The blocks do not reach the house while editing elsewhere, but they load and fail gently (see 2.4).

**Advanced option: HTTPS mode** for houses with a real certificate, so turbowarp.org works directly. Documented, tested with a self-signed certificate, not the default.

Why: the primary and fallback both avoid mixed content by design rather than by browser luck. Both work in Chrome, Firefox and Safari, on the LAN port and through ingress. The fallback needs no heavy build, so the add-on is useful even before the editor pipeline exists.

### 1.4 The kid's journey (primary path)

1. A parent installs the add-on from the repository, sets the allowlist (nothing is allowed until they do) and starts it.
2. The kid opens either:
   - the **ScratcHA** sidebar panel in HA (ingress, needs an HA login, HTTPS if HA has it), or
   - `http://homeassistant.local:8099/` on the LAN (no login, the allowlist is the guard).
3. The landing page shows big buttons: **Make a project** (editor), **Play a project** (player list), **What can I control?** (allowed entities with live state).
4. **Make a project** opens `editor/editor.html?extension=<same-origin>/extension/scratcha.js`. The Home Assistant blocks are already in the palette. Entity dropdowns list only allowed entities.
5. The kid builds, clicks the green flag and sees the lamp change. Errors show as a friendly reporter value, never a crash.
6. The kid saves with File > Save to your computer (the File System Access API needs a secure context, so on plain HTTP TurboWarp falls back to a download, which is fine). **Should**: a "Save to ScratcHA" button on the landing page uploads the `.sb3` to the projects folder.
7. Saved projects in `/share/scratcha/projects/` appear under **Play a project** as full-screen players.

### 1.5 Editor build (primary path detail)

- A GitHub Actions workflow `editor.yml` (manual dispatch and on tag) checks out `TurboWarp/scratch-gui` at a pinned commit, applies `editor/patches/*.patch`, runs `npm ci` and `NODE_ENV=production npm run build` with `ROOT` unset. `ROOT` defaults to `''`, which gives relative public paths, so the build works under `/editor/` and under the ingress prefix. `ROUTING_STYLE` stays `filehash`.
- One small patch: `isTrustedExtension` in `src/containers/tw-security-manager.jsx` also trusts a URL whose origin equals `location.origin` and whose path ends in `/extension/scratcha.js`. That loads our extension unsandboxed with no prompt. Unsandboxed matters under ingress: a sandboxed extension runs in an opaque-origin iframe, so its requests are cross-site and the `SameSite=Strict` ingress cookie is not sent.
- The output is published as a release asset `turbowarp-editor-<sha>.tar.gz` with a SHA-256 file. The Dockerfile downloads it via `ARG EDITOR_URL` and `ARG EDITOR_SHA256` and checks the hash. If `EDITOR_URL` is empty the image builds without the editor and the landing page hides **Make a project**.
- The editor is GPL-3.0. The landing page and DOCS.md link to the exact source commit and the patch.
- When a project is loaded, TurboWarp skips extension URLs whose extension ID is already loaded, so projects saved elsewhere with a different `scratcha.js` URL still use the local one. This must be checked in the browser test.

### 1.6 Player (fallback path detail)

- `GET /play/` lists `.sb3` files in `projects_dir` (default `/share/scratcha/projects`).
- `GET /play/<name>.html` packages the file with `@turbowarp/packager` (pinned exact version, as its docs require) and caches the result in `/data/cache` keyed by file name, size and modification time.
- Before packaging, the bridge replaces the project's `extensionURLs.scratcha` with a `data:` URL of the current extension source, so packaging needs no network and always uses this bridge's extension.
- Packaged custom extensions run unsandboxed, in the page, same origin. This works on the LAN port and under ingress.
- File names are checked against `^[A-Za-z0-9 _-]{1,64}\.sb3$`. No paths. Maximum `.sb3` size 50 MB.

### 1.7 HTTPS mode (advanced)

- Options `ssl` (bool), `certfile`, `keyfile` (default `fullchain.pem` and `privkey.pem` under `/ssl`).
- When on, the LAN port serves HTTPS. Ingress traffic still arrives as HTTP from the Supervisor on the same port, so ingress uses its own internal port (`ingress_port: 8098`, always plain HTTP) and 8099 stays for the LAN.
- `cors_allow_origins` must then include `https://turbowarp.org` (and `null` for sandboxed loading). The extension URL to paste into TurboWarp is shown on the status page.

---

## 2. The blocks

### 2.1 Extension basics

- ID `scratcha`, name "Home", colour `#18BCF2` (HA blue), secondary colours derived. A simple house icon as a data URI.
- One file, `scratcha.js`, plain script, works sandboxed and unsandboxed. It uses `Scratch.extensions.unsandboxed` to pick features.
- The bridge serves it at `/extension/scratcha.js` and writes the bridge base URL into the first line, computed from the request (scheme, `Host`, and `X-Ingress-Path` when present). A block can override it (2.3).
- On load it fetches `/bridge/config` and `/bridge/entities`, then registers. If that fails it still registers, with empty menus, so a project never fails to open.
- It keeps a local mirror of allowed entity states, fed by SSE (`/bridge/events`). If `EventSource` fails three times in a row it polls `/bridge/states` every 2 seconds and keeps trying SSE every 60 seconds.
- Reporters read from the mirror when it is fresh (under 5 seconds old), otherwise fetch once. So a `forever` loop of reporters does not hammer the bridge.

### 2.2 Menus

- `entities`: allowed entity IDs, shown as friendly names. `acceptReporters: true` so a kid can drop in a variable.
- `switchables`: allowed entities in `light`, `switch`, `fan`, `input_boolean`, `cover`, `media_player`, `climate`, `siren`.
- `lights`: allowed `light.*` entities.
- `runnables`: allowed `scene`, `script`, `button`, `input_button` entities.
- `onoff`: `on`, `off`.
- Hat menus are fields (`acceptReporters: false`) so unsandboxed hats can use `startHats` field matching.
- Menus refresh when the bridge sends a `config` event. Unsandboxed: `Scratch.vm.extensionManager.refreshBlocks()`. Sandboxed: the new list is used next time the palette is built.

### 2.3 Block list (must)

| Opcode | Text | Type | Behaviour |
| --- | --- | --- | --- |
| `stateOf` | state of [ENTITY] | reporter | State string, for example `on`, `21.5`, `unavailable`. |
| `numberOf` | number from [ENTITY] | reporter | State as a number, `0` if not a number. Handy for temperatures. |
| `attributeOf` | [ATTRIBUTE] of [ENTITY] | reporter | Attribute value. Objects and arrays become JSON text. Missing gives `""`. |
| `nameOf` | name of [ENTITY] | reporter | Friendly name. |
| `isOn` | [ENTITY] is on? | boolean | True for `on`, `open`, `home`, `playing`, `heat`, `cool` and similar. |
| `isState` | [ENTITY] is [STATE]? | boolean | Case-insensitive compare. |
| `turnOnOff` | turn [SWITCHABLE] [ONOFF] | command | `homeassistant.turn_on` or `turn_off` with that entity. Waits for the call. |
| `toggle` | toggle [SWITCHABLE] | command | `homeassistant.toggle`. |
| `setBrightness` | set [LIGHT] brightness to [PERCENT] % | command | `light.turn_on` with `brightness_pct` clamped to 0..100. 0 turns it off. |
| `setColour` | set [LIGHT] colour to [COLOUR] | command | Scratch colour picker. Hex becomes `rgb_color`. |
| `run` | run [RUNNABLE] | command | `scene.turn_on`, `script.turn_on`, `button.press` or `input_button.press` by domain. |
| `callService` | call service [SERVICE] with [JSON] | command | Expert block. `SERVICE` is `domain.service`, `JSON` is the service data including `entity_id`. |
| `whenChanges` | when [ENTITY_FIELD] changes | hat | Fires once per state change. |
| `whenBecomes` | when [ENTITY_FIELD] becomes [STATE] | hat | Edge-triggered on the state becoming equal to STATE. |
| `connected` | connected to home? | boolean | True when the bridge answers and Core is connected. |
| `lastError` | last home error | reporter | Short kid-friendly message, `""` when the last call worked. |
| `enterPin` | use PIN [PIN] | command | Keeps the PIN in memory for protected services. Never saved in the project. A parent types it at runtime with an "ask" block. |
| `allEntities` | list of things I can use | reporter | Comma-separated allowed entity IDs. |

Should, if time allows: `setTemperature` (`climate.set_temperature`), `coverPosition` (`cover.set_cover_position`), `say on speaker` (`tts.speak` with an allowed `media_player`), `setBridge` (set home address to [URL]) for HTTPS mode users.

Hats:

- Unsandboxed: `isEdgeActivated: false`. On each SSE or poll change the extension calls `Scratch.vm.runtime.startHats('scratcha_whenChanges', { ENTITY: id })`, and for `whenBecomes` also matches `STATE`.
- Sandboxed: `isEdgeActivated: true`. `whenChanges` returns true for 150 ms after a change, so every hat sees one false-to-true edge. Two changes inside that window count as one. `whenBecomes` returns `state == STATE` from the mirror.

### 2.4 Errors

- Blocks never throw into the VM. A failure sets `lastError` and the block finishes.
- Reporters return the last known value if there is one, else `""`. Booleans return `false`.
- Commands wait at most `timeout_ms` plus 1 second, then give up.
- Messages are short and friendly, mapped from bridge error codes:
  - `not_allowed`: "That is not on your list."
  - `read_only`: "Look, don't touch: ScratcHA is read-only."
  - `pin_required` or `pin_wrong`: "That needs a grown-up's PIN."
  - `rate_limited`: "Slow down a bit."
  - `ha_unavailable`, network failure or mixed content: "Can't reach home."
  - anything else: "Home said no."
- Every failure is also logged to the browser console with full detail for grown-ups.

---

## 3. Bridge API

### 3.1 Connecting to Core

- Default mode: **Supervisor**. `config.yaml` sets `homeassistant_api: true`. The bridge reads `SUPERVISOR_TOKEN` and uses `http://supervisor/core/api/...` for REST and `ws://supervisor/core/websocket` for events. No long-lived token needed.
- Override mode: if `access_token` is set, use it with `homeassistant_url` (default `http://homeassistant:8123`). For running outside HA and for tests.
- Env `SCRATCHA_CORE_URL` overrides the Supervisor core URL, so tests can point Supervisor mode at a local HA.
- If neither a Supervisor token nor an access token exists, the bridge starts, serves the status page and reports `ha: "not_configured"`. It does not crash.
- The Supervisor token has full Core rights. The allowlist is the only guard, which is why it is deny by default.

### 3.2 State mirror and events

- One WebSocket to Core using Node 22's built-in `WebSocket` (no extra dependency). Auth, then `get_states`, then `subscribe_events` for `state_changed`.
- The mirror keeps only allowed entities, with `entity_id`, `state`, `attributes`, `last_changed`, `last_updated`.
- Reconnect with backoff (1, 2, 5, 10, 30 seconds). While disconnected, REST reads fall back to Core REST and `/bridge/health` reports `ha: "reconnecting"`.
- `cache_seconds` is removed. The mirror replaces it.

### 3.3 Endpoints

All JSON. Errors are `{ "error": "<code>", "message": "<text>" }` with codes from 2.4 plus `bad_request`, `not_found`, `timeout`, `ha_error`.

| Method and path | Purpose |
| --- | --- |
| `GET /bridge/health` | `{ status, ha, mode, version }`. `mode` is `supervisor` or `token`. |
| `GET /bridge/config` | Safe public config: `read_only`, allow patterns, protected services, PIN enabled (bool), rate limits, events transport, version. Never the token or Core URL. |
| `GET /bridge/entities` | `[{ entity_id, name, domain }]` for menus. |
| `GET /bridge/states` | Allowed states from the mirror. |
| `GET /bridge/states/:entityId` | One state. Returns 403 `not_allowed` for any entity not allowed, whether it exists or not. |
| `POST /bridge/services/:domain/:service` | Calls a service after the checks in section 4. Returns `{ ok: true, changed: [states] }`, filtered to allowed entities. |
| `GET /bridge/events` | SSE. `event: state` with one state as data, `event: config` when options change, `: ping` every 25 seconds, `retry: 3000`. Optional `?entities=a,b` filter. Maximum 20 concurrent streams. |
| `GET /extension/scratcha.js` | The extension with the bridge URL written in. `Content-Type: text/javascript`, `Cache-Control: no-cache`. |
| `GET /` | Landing page (1.4). |
| `GET /status` | Status and test page (5.3). |
| `GET /editor/...` | Editor build, if present. |
| `GET /play/`, `GET /play/:name.html` | Player list and players (1.6). |
| `POST /projects` (should) | Upload an `.sb3`. Same name rules as 1.6. |
| static `static_dir` | Kept for custom bundles, served under `/www/`. |

### 3.4 CORS

- Same-origin use (editor, player, status page) needs no CORS.
- For `/bridge/*` and `/extension/*` the bridge reflects the request `Origin` only if it is in `cors_allow_origins`. Default `["null"]`, which covers sandboxed extension iframes (they send `Origin: null`). HTTPS mode adds `https://turbowarp.org`.
- `*` is accepted only if the parent types it, and the status page warns.
- Allowed headers: `Content-Type`, `X-ScratcHA-PIN`. Methods: `GET`, `POST`, `OPTIONS`. No credentials.
- Service calls require `Content-Type: application/json`, which forces a preflight, so a random web page cannot fire a "simple" cross-origin POST.

---

## 4. Safety

Andy's house has switches that cut power to the house. The rules below assume a curious kid with a `forever` loop.

1. **Deny by default.** Empty `allowed_entities` means nothing is readable or controllable. The status page and the log say so clearly.
2. **Patterns.** Allow entries are exact IDs or globs on `domain.object_id` with `*` only, for example `light.*`, `sensor.kids_room_*`. `denied_entities` uses the same syntax and always wins.
3. **Services.** `allowed_services` uses the same glob syntax on `domain.service`. The block commands map to a fixed small set (`homeassistant.turn_on`, `turn_off`, `toggle`, `light.turn_on`, `scene.turn_on`, `script.turn_on`, `button.press`, `input_button.press`). These are allowed by default **only for allowed entities**. Anything else, including all of `callService`, must be listed.
4. **Targets.** Every service call must name its entities in `entity_id` (string or list, maximum 20). All of them must be allowed. `entity_id: all`, and any `area_id`, `device_id`, `floor_id` or `label_id` key in data or `target`, is rejected with `not_allowed`. Entities named inside `target` are rejected with `bad_request`, because the Core REST API ignores `target`. Calls with no entity are rejected unless the service is listed in `allowed_services_without_target` (default empty), for example `notify.kids_tablet`.
5. **Read-only mode.** `read_only: true` rejects every service call with `read_only`. Reads still work.
6. **PIN.** `protected_services` (globs) and `protected_entities` (globs) need `X-ScratcHA-PIN` matching `pin_code`. Compare in constant time. After 5 wrong PINs from one client address, lock PIN checks for that address for 5 minutes. If something is protected but no PIN is set, the call is refused (fail closed) and the status page warns.
7. **Rate limits.** Token bucket per client address: 10 service calls per 10 seconds, burst 5 (`rate_limit_calls`, `rate_limit_window_s`). Per entity: at most one call per `min_interval_ms` (default 500) across all clients, so a toggle loop cannot chatter a relay. Reads: 30 per second per address. Over the limit gives 429 `rate_limited`.
8. **Never expose the token.** No endpoint returns it or the Core URL. Core error bodies are not passed through. The bridge logs Core errors and returns a short message. Log lines never include `Authorization` headers.
9. **Input validation.** Entity ID `^[a-z0-9_]+\.[a-z0-9_]+$`. Domain and service `^[a-z0-9_]+$`. Body must be a JSON object, at most 8 KB, at most 5 levels deep. Brightness and colour are clamped. Unknown query parameters are ignored.
10. **Ingress trust.** Requests from the Supervisor ingress address (`172.30.32.2`) with `X-Ingress-Path` are treated as from a logged-in HA user. Only those requests may upload projects. The LAN port can be turned off (host port `null` in the add-on network settings) for ingress-only houses.
11. **Host check.** The LAN port only answers when `Host` is an IP literal, `homeassistant`, `homeassistant.local`, or listed in `allowed_hosts`. This blocks DNS rebinding from outside web pages.

---

## 5. Packaging

### 5.1 Repository layout (target)

```
repository.yaml
addons/scratcha/
	config.yaml
	Dockerfile
	DOCS.md
	CHANGELOG.md
	README.md          (short store blurb)
	icon.png           (128 x 128)
	logo.png           (about 250 x 100)
	apparmor.txt
	translations/en.yaml
	rootfs/etc/services.d/scratcha/run
	rootfs/etc/services.d/scratcha/finish
	rootfs/opt/scratcha/   (package.json, package-lock.json, src/, public/)
editor/patches/*.patch
extension/ (source of scratcha.js, copied into the image at build)
test/ (e2e and browser tests)
docs/SPEC.md
.github/workflows/ci.yml, editor.yml
```

Current breakage to fix first: code lives in `rootfs/opt/scratha` and `rootfs/etc/services.d/scratha` while the Dockerfile and docs use `scratcha`. Rename with `git mv`. Replace `config.json` with `config.yaml`.

### 5.2 Decisions from the current HA developer docs

The docs moved to contributors.home-assistant.io and now call add-ons "apps". Checked on 2026-10-20:

- **No `build.yaml`.** It is deprecated (still read, with a warning). Since Supervisor 2026.04 `BUILD_FROM` is no longer passed by default. The Dockerfile uses `ARG BUILD_FROM=ghcr.io/home-assistant/base:3.24` then `FROM ${BUILD_FROM}`. That base is multi-arch. Labels `io.hass.version`, `io.hass.arch`, `io.hass.type=addon` are set with `LABEL`.
- **Architectures:** `aarch64`, `amd64` only. `armv7`, `armhf` and `i386` are deprecated. TurboWarp in a browser is the heavy part, and that runs on the kid's device, so dropping 32-bit costs little.
- No `image:` key for now, so the Supervisor builds on the device. Pre-built images (home-assistant/builder actions to GHCR) are later.

`config.yaml` key points:

```yaml
name: ScratcHA
version: "0.1.0"
slug: scratcha
description: Control your home from Scratch projects, safely.
url: https://github.com/Vortitron/ScratcHA
arch: [aarch64, amd64]
init: false
startup: application
boot: auto
stage: experimental
homeassistant_api: true
ingress: true
ingress_port: 8098
panel_icon: mdi:puzzle
panel_title: ScratcHA
panel_admin: false
ports:
  8099/tcp: 8099
map:
  - type: share
    read_only: false
  - type: ssl
```

`host_network` is dropped: the bridge only talks to the Supervisor and serves one LAN port, and host networking lowers the security rating. `init: false` because the base image runs s6-overlay. The run script uses `#!/usr/bin/with-contenv bashio`. One process listens on 8098 (ingress, always HTTP, needed so HTTPS mode in 1.7 works) and 8099 (LAN, HTTP or HTTPS).

Options schema:

| Option | Schema | Default |
| --- | --- | --- |
| `allowed_entities` | `[str]` | `[]` |
| `denied_entities` | `[str]` | `[]` |
| `allowed_services` | `[str]` | `[]` |
| `allowed_services_without_target` | `[str]` | `[]` |
| `read_only` | `bool` | `false` |
| `protected_services` | `[str]` | `[]` |
| `protected_entities` | `[str]` | `[]` |
| `pin_code` | `password?` | |
| `rate_limit_calls` | `int(1,100)?` | 10 |
| `rate_limit_window_s` | `int(1,600)?` | 10 |
| `min_interval_ms` | `int(0,10000)?` | 500 |
| `cors_allow_origins` | `[str]` | `["null"]` |
| `allowed_hosts` | `[str]` | `[]` |
| `projects_dir` | `str?` | `/share/scratcha/projects` |
| `static_dir` | `str?` | `/share/scratcha/www` |
| `ssl` | `bool` | `false` |
| `certfile` | `str?` | `fullchain.pem` |
| `keyfile` | `str?` | `privkey.pem` |
| `timeout_ms` | `int(1000,60000)?` | 8000 |
| `access_token` | `password?` | |
| `homeassistant_url` | `url?` | |
| `log_level` | `list(debug\|info\|warning\|error)?` | `info` |

Removed: `cache_seconds`, `host`, `port`, `cors_allow_origin` (singular). Old values are ignored with a log warning.

Other files:

- `repository.yaml`: `name: ScratcHA`, `url`, `maintainer`.
- `translations/en.yaml`: a name and description for every option and a label for `8099/tcp`.
- `DOCS.md`: install, first setup (allowlist examples), every option, how kids open it, HTTPS mode, limitations (mixed content explained in two sentences), licences (MIT for ScratcHA, GPL-3.0 editor, MPL-2.0 Packager).
- `CHANGELOG.md`: Keep a Changelog, starting at 0.1.0.
- `icon.png`, `logo.png`: simple house plus Scratch-style block, made as SVG in the repo and exported to PNG.
- `apparmor.txt`: yes, it is sensible. Node only needs to read `/opt/scratcha`, read and write `/data`, `/share/scratcha`, read `/ssl`, and use the network. Start from the example profile in the developer docs. If it blocks something we cannot debug without a real Supervisor, ship it in the repo but leave it out of the add-on folder and note it in the changelog.

### 5.3 Status and test page

Served at `/status`, and as the ingress landing page for admins (the kid landing page links to it).

- Connection: mode, Core state, WebSocket state, version.
- Safety summary: allowed patterns and the entities they match right now, denied entities, read-only, protected items, PIN set or not. Big warning if the allowlist is empty or `*` is used.
- Live table of allowed entities via SSE.
- Test buttons: turn on, off, toggle for switchable allowed entities, with a PIN box.
- The extension URL for HTTPS mode and the editor link.
- Plain HTML, CSS and one ES module. No build step.

### 5.4 CI (`.github/workflows/ci.yml`)

- `test`: Node 22, `npm ci`, `npm test` in `addons/scratcha/rootfs/opt/scratcha`.
- `lint-addon`: `frenck/action-app-linter` (the repository formerly called `action-addon-linter`, latest v2.21.1) on `addons/scratcha`.
- `yaml`: yamllint on YAML files.
- `e2e`: Python 3.13, `pip install homeassistant==<pinned>`, run the e2e suite (6.2). Allowed to be slow. Cache pip.
- `browser`: Playwright Chromium, run the browser suite (6.3).
- `editor.yml`: the editor build (1.5). Manual dispatch, uploads an artifact; on tag, attaches it to the release.

---

## 6. Test plan

Runner: `node:test` (built in), no extra test framework. Tests live next to the code (`src/*.test.js`) for units and under `test/` for e2e and browser.

### 6.1 Unit tests (mocked Core)

- Options: defaults, validation, old keys ignored with warning.
- Glob matcher: exact, `light.*`, prefix globs, deny wins, empty means nothing.
- Service guard: allowed and denied services, `entity_id` string and list, `all`, area/device/label/floor targets, missing target, more than 20 entities, read-only, protected services and entities, PIN right, wrong, missing, lockout after 5, fail closed when PIN unset.
- Rate limits: per client bucket, per entity interval, 429 body.
- Validation: bad entity IDs, bad domain names, body too big, too deep, not an object.
- Token never appears in any response body or log line (scan output for the test token).
- Core client: REST timeout gives `timeout`, Core 401 or 500 gives a short message without the Core body.
- WebSocket mirror against a fake WS server in the test (Node 22 has a WS client, the fake server is a tiny handshake over `node:http`, or the `ws` package as a dev dependency only): auth, `get_states`, `state_changed` updates, filtering, reconnect.
- SSE endpoint: headers, events, ping, stream limit.
- Extension URL templating: plain, ingress path, HTTPS. Reject odd `Host` values.
- Host check and CORS: origin reflected only when listed, preflight, `null` default.
- Extension logic in Node with a fake `Scratch` global: block definitions, menus from config, error mapping, hat behaviour sandboxed and unsandboxed, colour hex to RGB, brightness clamp, mirror freshness.
- Keep and port the four existing tests.

### 6.2 End to end with a real throwaway HA

- Use the venv at `scratchpad/sm-venv` (Home Assistant 2026.2.3 with `bin/hass`).
- `test/e2e/ha-config/configuration.yaml` defines only safe fake entities: `input_boolean.lamp`, `input_boolean.house_main_power` (the "never touch" one), `input_number.temp`, a template `light.kids_lamp` backed by an `input_boolean` and `input_number`, a `scene.party`, and a template `sensor.room_temperature`. No `demo:` (it pulls extra dependencies).
- `test/e2e/start-ha.mjs`: copy config to a temp dir, start `hass -c <dir>` on a free port, wait for `/api/onboarding`, create the owner with `POST /api/onboarding/users`, swap the auth code at `/auth/token`, finish onboarding steps, then make a long-lived token over the WebSocket (`auth/long_lived_access_token`). Tear down and delete the temp dir after.
- Run the bridge twice: token mode, and Supervisor mode with `SUPERVISOR_TOKEN=<token>` and `SCRATCHA_CORE_URL=http://127.0.0.1:<port>`.
- Cases: read allowed state; denied entity 403; turn on `input_boolean.lamp` and see the state change in HA; `house_main_power` is denied even with `input_boolean.*` allowed plus a deny entry; area target rejected; read-only; PIN protected scene; rate limit; SSE receives a change made directly in HA; bridge survives HA restart and reconnects.
- Never contacts any real HA. Ports bind to `127.0.0.1` only.

### 6.3 Headless browser tests (Playwright Chromium)

1. **Player test (must).** Build a tiny `.sb3` in the test (project.json plus one costume) that uses ScratcHA blocks: on green flag turn on `input_boolean.lamp`, set a variable to `state of input_number.temp`, and a `when input_boolean.lamp changes` hat that sets another variable. Put it in a temp `projects_dir`, open `/play/test.html` from the bridge, start the project, then assert in HA (REST) that the lamp is on, and read variables from the VM (the packaged page exposes the VM on its scaffolding object) to check the reporter and the hat.
2. **Editor test (must when the editor is built, else skipped).** Open `/editor/editor.html?extension=...`, check the blocks appear without a sandbox prompt, load the same `.sb3`, run it, assert the same results.
3. **Real TurboWarp test (should, needs internet, skipped offline).** Run the bridge on `http://localhost:8000` (TurboWarp trusts that origin unsandboxed and Chromium treats localhost as secure, so there is no mixed content). Open `https://turbowarp.org/editor?extension=http://localhost:8000/extension/scratcha.js`. Proves the extension works in the real editor. Also run once with the extension loaded sandboxed (a different port, accept the prompt) to cover the sandboxed code path and `Origin: null` CORS.
4. **Status page.** Loads, shows the empty-allowlist warning, test button toggles the lamp.

### 6.4 Not tested in this pass

- A real Supervisor (no Docker here): ingress headers and `172.30.32.2` are simulated in unit tests. Docker build and the add-on linter run in CI only.
- AppArmor profile.
- Safari and Firefox (manual check later).

---

## 7. Build order for this pass

1. Rename `scratha` to `scratcha`, `config.json` to `config.yaml`, update Dockerfile and run script. Tests still pass.
2. Options, glob allowlists, deny by default, validation, read-only, PIN rules, rate limits. Unit tests.
3. Core client with Supervisor and token modes, WebSocket mirror, SSE. Unit tests.
4. Extension and its serving route. Unit tests with fake `Scratch`.
5. Landing and status pages.
6. Player via Packager. Browser test 1.
7. E2E suite against the venv HA.
8. Packaging files: repository.yaml, DOCS, CHANGELOG, translations, icons, apparmor. CI workflow.
9. Editor workflow and patch, Dockerfile editor stage. Browser test 2 runs only where the build exists.
10. README rewritten to match.

## 8. Later

- Pre-built multi-arch images on GHCR (`image:` key).
- Saving projects straight back to the add-on from the editor.
- More blocks (media, climate scheduling, notifications), translations beyond English.
- Per-kid profiles with separate allowlists.
- A HACS integration that exposes the bridge on HA's own HTTPS port, which would let turbowarp.org work in every house with remote access.

---

## 9. Notes from the build pass

Where the build differs from the plan above, and why.

- **Extension location.** `scratcha.js` lives in `addons/scratcha/rootfs/opt/scratcha/extension/`, not a top-level `extension/`. The Supervisor builds with the add-on folder as the Docker context, so nothing outside it can be copied in.
- **config.yaml defaults.** `startup`, `boot` and `panel_icon` are left out. The add-on linter fails on keys that repeat a default.
- **Burst.** The per-client burst is half of `rate_limit_calls`, rounded up. With the defaults that is 5, as planned.
- **Sandboxed menus.** The VM cannot call into a sandboxed worker to build a dynamic menu, and the palette breaks if it tries. Sandboxed, the menus are fixed lists made at register time. Unsandboxed, they stay dynamic.
- **Node 22 WebSocket.** A refused connection fires `error` but never `close`. The Core client retries on `error`, has a 15 second connect watchdog and a 30 second ping heartbeat.
- **Extra error codes.** `pin_locked` (lockout), `busy` (more than 20 SSE streams). A refused `Host` gets HTTP 421 with plain text. `localhost` is accepted as a host name too, since it cannot be rebound.
- **Config events.** Options only change on restart, so SSE sends `config` when a stream opens and when the set of allowed entities changes.
- **Editor source.** The editor build writes `scratcha-source.json` (commit, source and patch links). The landing page shows them for the GPL notice.
- **E2E onboarding.** The `core_config` step is skipped and `hass` runs with `--skip-pip`. That step adds integrations that need the internet, and they hung the restart test.
- **turbowarp.org test.** Port 8000 can be busy on a dev machine, so Playwright routes `localhost:8000` and `localhost:8001` to the bridge. SSE is aborted in the route because routed responses are buffered, which also covers the polling fallback.
- **AppArmor.** Shipped in the add-on folder, broad on files, limited on capabilities and network families. Not checked on a real Supervisor.
