#!/bin/sh
# Installs Home Assistant, plus the frontend it pins, into a new venv.
# Usage: install-ha.sh <venv dir> <Home Assistant version>
#
# The tests start hass with --skip-pip, and the frontend is not a pip
# dependency of homeassistant. Without it Home Assistant starts in recovery
# mode on port 8123 and the tests time out.
set -eu
venv="$1"
version="$2"
python -m venv "$venv"
"$venv/bin/pip" install "homeassistant==$version"
frontend=$("$venv/bin/python" -I - <<'PY'
import importlib.util
import json
import pathlib

root = pathlib.Path(importlib.util.find_spec("homeassistant").origin).parent
manifest = json.loads((root / "components" / "frontend" / "manifest.json").read_text())
print(next(r for r in manifest["requirements"] if r.startswith("home-assistant-frontend==")))
PY
)
echo "Installing $frontend"
"$venv/bin/pip" install "$frontend"
