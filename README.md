# ScratcHA

ScratcHA is a Home Assistant add-on that lets Scratch projects made in TurboWarp read and control a home, safely. It is aimed at kids and hobbyists.

A kid opens ScratcHA from the Home Assistant sidebar or on the home network, makes a project with the **Home** blocks, clicks the green flag and the lamp changes. A grown-up decides exactly what the blocks may touch. Nothing is allowed until it is listed.

Setup and every option are in [addons/scratcha/DOCS.md](addons/scratcha/DOCS.md). The design and its reasons are in [docs/SPEC.md](docs/SPEC.md).

## How it works

turbowarp.org is an HTTPS site and the add-on is plain HTTP on your network, so the browser blocks the two from talking (mixed content). ScratcHA avoids this by serving everything from the add-on itself:

- **Bridge**: a Node server inside the add-on. It talks to Home Assistant through the Supervisor and applies the safety rules.
- **Extension**: `scratcha.js`, the TurboWarp extension with the Home blocks. The bridge writes its own address into it.
- **Editor**: an optional TurboWarp editor build, served by the add-on.
- **Player**: `.sb3` files from `/share/scratcha/projects`, turned into full-screen players with the TurboWarp Packager.
- **Pages**: a kids' landing page and a status and test page for grown-ups.

## Safety

- Deny by default. Allow and deny lists take exact IDs or `*` patterns, and deny wins.
- Every call must name its entities. "All", areas, devices, floors and labels are refused.
- Read-only mode, a PIN with lockout for protected things (refused if no PIN is set), and rate limits per device and per entity.
- The token and Core error details never leave the bridge.
- The network port only answers to IP addresses, `homeassistant.local` and names you list, which blocks DNS rebinding.

## Repository layout

```
repository.yaml                  add-on repository metadata
addons/scratcha/                 the add-on
	config.yaml, Dockerfile, DOCS.md, CHANGELOG.md, apparmor.txt, translations/
	rootfs/etc/services.d/scratcha/   s6 run and finish scripts
	rootfs/opt/scratcha/              the bridge
		src/                          server, safety rules, Core client, SSE, player
		src/*.test.js                 unit tests
		extension/scratcha.js         the TurboWarp extension
		public/                       landing and status pages
editor/                          pinned TurboWarp/scratch-gui commit and our patch
examples/ScratcHA demo.sb3       demo project
art/                             icon and logo sources
test/                            end-to-end and browser tests, and tools
docs/SPEC.md                     the spec
.github/workflows/               CI and the editor build
```

The extension lives inside the add-on folder, not in a top-level `extension/` folder as the spec suggested. The Supervisor builds the image with the add-on folder as the Docker context, so files outside it cannot be copied in.

## Development

Needs Node 22.

```sh
cd addons/scratcha/rootfs/opt/scratcha
npm ci
npm test
```

Run the bridge outside Home Assistant with a long-lived token:

```sh
cat > /tmp/scratcha-options.json <<'JSON'
{
	"access_token": "YOUR_TOKEN",
	"homeassistant_url": "http://homeassistant.local:8123",
	"allowed_entities": ["light.kids_room"]
}
JSON
OPTIONS_PATH=/tmp/scratcha-options.json SCRATCHA_DATA_DIR=/tmp/scratcha-data \
	SCRATCHA_INGRESS_PORT=0 npm start
```

Then open `http://localhost:8099/`. Other environment variables: `SCRATCHA_LAN_PORT`, `SCRATCHA_BIND`, `SCRATCHA_SSL_DIR`, `SCRATCHA_EDITOR_DIR`, and `SCRATCHA_CORE_URL` (points Supervisor mode at another Core, for tests).

### End-to-end and browser tests

These start a throwaway Home Assistant from a Python venv on a free `127.0.0.1` port. They never contact any other Home Assistant. `test/tools/install-ha.sh` also installs the frontend that Home Assistant pins. The tests run hass with `--skip-pip`, so without it Home Assistant starts in recovery mode.

```sh
PATH="$(dirname "$(command -v python3.13)"):$PATH" sh test/tools/install-ha.sh ~/ha-venv 2026.2.3
cd test
npm ci
npx playwright-core install chromium
SCRATCHA_HASS=~/ha-venv/bin/hass npm run e2e
SCRATCHA_HASS=~/ha-venv/bin/hass npm run browser
```

The browser suite includes an optional test in the real turbowarp.org editor. It is skipped when turbowarp.org cannot be reached, or when `SCRATCHA_SKIP_ONLINE=1` is set. Temporary files go in `test/.tmp` and are removed afterwards. Set `SCRATCHA_KEEP_TMP=1` to keep the Home Assistant folder and its log.

### Tools

- `node test/tools/build-demo.mjs` rebuilds the demo project.
- `node test/tools/render-art.mjs` renders `icon.png` and `logo.png` from `art/`.

### Editor build

The `Editor build` workflow builds TurboWarp/scratch-gui at the commit in `editor/SCRATCH_GUI_COMMIT` with `editor/patches/*.patch`, and publishes `turbowarp-editor-<sha>.tar.gz` with a SHA-256 file. Build the add-on image with `EDITOR_URL` and `EDITOR_SHA256` to include it.

## Licences

ScratcHA is MIT licensed. The TurboWarp editor is GPL-3.0 and the TurboWarp Packager is MPL-2.0.
