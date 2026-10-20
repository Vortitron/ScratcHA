# ScratcHA

ScratcHA lets kids make Scratch projects in TurboWarp that read and control your home. It adds a set of **Home** blocks, such as "turn the kids' lamp on" or "when the front door changes". A grown-up decides exactly what the blocks may touch.

Nothing is allowed until you add it to the allowed list.

## Install

1. In Home Assistant, go to **Settings > Add-ons > Add-on store**.
2. Open the menu (three dots), choose **Repositories** and add `https://github.com/Vortitron/ScratcHA`.
3. Install **ScratcHA**. Do not start it yet.
4. Fill in the **Configuration** tab (see below), then start it.

The add-on talks to Home Assistant through the Supervisor. You do not need a token.

## First setup

Start small. List only what a kid should be able to use.

```yaml
allowed_entities:
  - light.kids_room
  - sensor.kids_room_temperature
  - scene.disco
  - input_boolean.kids_*
denied_entities:
  - input_boolean.kids_room_heater
```

Rules:

- An entry is an exact entity ID or a pattern with `*`. `light.*` means every light. Be careful with patterns.
- `denied_entities` always wins. Put anything dangerous there, such as a main power switch, even if no pattern seems to match it.
- Every call must name its entities. Calls that target "all", an area, a device, a floor or a label are refused.
- The blocks use a small set of services: `homeassistant.turn_on`, `turn_off` and `toggle`, `light.turn_on`, `scene.turn_on`, `script.turn_on`, `button.press` and `input_button.press`. These work for allowed entities without listing them. Any other service must be in `allowed_services`.

Then open the **Status** page (see below) and check what is allowed.

## How kids open it

There are two ways in. Both serve everything from the add-on itself.

- **The ScratcHA panel** in the Home Assistant sidebar. The kid needs a Home Assistant login. Non-admin users can open it.
- **`http://homeassistant.local:8099/`** on your home network. No login. The allowed list is the guard. If you do not want this, clear the port in the add-on **Network** settings and use only the panel.

The kids' page has three big buttons:

- **Make a project** opens the TurboWarp editor with the Home blocks ready. This only shows when the add-on image includes the editor (see Limitations).
- **Play a project** lists the `.sb3` files in `/share/scratcha/projects` and plays them full screen.
- **What can I control?** shows the allowed things and their state.

To add a project to Play, save it from TurboWarp as an `.sb3` file. In the ScratcHA panel, use **Save to ScratcHA** on the kids' page to upload it. Or copy it to `/share/scratcha/projects` yourself, for example with the Samba or File editor add-ons. Names may use letters, numbers, spaces, `-` and `_`. Uploads only work from the panel, where the user is logged in to Home Assistant.

A demo project is in the repository at `examples/ScratcHA demo.sb3`. It uses `light.kids_room` and `sensor.room_temperature`. Change those in the editor to your own.

## The blocks

| Block | What it does |
| --- | --- |
| state of [thing] | The state, such as `on` or `21.5`. |
| number from [thing] | The state as a number. `0` if it is not a number. |
| [attribute] of [thing] | An attribute, such as `brightness`. |
| name of [thing] | The friendly name. |
| [thing] is on? | True for on, open, home, playing, heating and similar. |
| [thing] is [state]? | Compares the state, ignoring case. |
| turn [thing] [on/off] | Turns it on or off. |
| toggle [thing] | Flips it. |
| set [light] brightness to [n] % | 0 to 100. 0 turns it off. |
| set [light] colour to [colour] | Uses the colour picker. |
| run [scene, script or button] | Runs it. |
| call service [domain.service] with [JSON] | For experts. The service must be allowed. |
| when [thing] changes | Runs when the state changes. |
| when [thing] becomes [state] | Runs when the state turns into that value. |
| connected to home? | True when the bridge and Home Assistant answer. |
| last home error | A short, friendly message. Empty when the last call worked. |
| use PIN [PIN] | Unlocks protected things. Kept in memory only, never saved in the project. |
| list of things I can use | The allowed entity IDs. |
| set home address to [URL] | For HTTPS mode only. |

Blocks never crash a project. If something goes wrong, "last home error" says so, for example "That is not on your list." or "Slow down a bit.". Grown-ups can see more detail in the browser console.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `allowed_entities` | empty | What the blocks may read and control. Empty means nothing. |
| `denied_entities` | empty | Never allowed. Wins over the allowed list. |
| `allowed_services` | empty | Extra services, for example `input_boolean.turn_on`. Patterns work. They still only work on allowed entities. |
| `allowed_services_without_target` | empty | Services that may run without an entity, for example `notify.kids_tablet`. |
| `read_only` | `false` | Refuse every service call. Reading still works. |
| `protected_services` | empty | Services that need the PIN. |
| `protected_entities` | empty | Entities that need the PIN to control. |
| `pin_code` | empty | The PIN. If something is protected and this is empty, it is always refused. After 5 wrong tries a device is locked out for 5 minutes. |
| `rate_limit_calls` | `10` | Service calls allowed per device in each window. Short bursts of half that are allowed. |
| `rate_limit_window_s` | `10` | The window in seconds. |
| `min_interval_ms` | `500` | Shortest time between two changes to one entity, across all devices. Stops a `forever` loop chattering a relay. |
| `cors_allow_origins` | `["null"]` | Other web sites that may call the bridge. `null` covers sandboxed TurboWarp extensions. `*` allows any site and is not recommended. |
| `allowed_hosts` | empty | Extra host names for the network port, for example `ha.home.lan`. IP addresses, `homeassistant`, `homeassistant.local` and `localhost` always work. Other names are refused, which blocks DNS rebinding attacks. |
| `projects_dir` | `/share/scratcha/projects` | Where Play a project looks for `.sb3` files. |
| `static_dir` | `/share/scratcha/www` | Your own files, served under `/www/`. |
| `ssl` | `false` | HTTPS on the network port. See HTTPS mode. |
| `certfile` | `fullchain.pem` | Certificate file in `/ssl`. |
| `keyfile` | `privkey.pem` | Key file in `/ssl`. |
| `timeout_ms` | `8000` | How long to wait for Home Assistant. |
| `access_token` | empty | Advanced. Only for running the bridge outside Home Assistant. |
| `homeassistant_url` | `http://homeassistant:8123` | Advanced. Used only with `access_token`. |
| `log_level` | `info` | `debug`, `info`, `warning` or `error`. |

Old options from version 0.0.1 (`cache_seconds`, `host`, `port`, `cors_allow_origin`) are ignored with a warning in the log.

## Status page

Open `/status` from the kids' page ("Grown-ups: status and safety"). It shows:

- whether Home Assistant is connected, and how,
- the allowed and denied lists and the things they match right now,
- big warnings if the list is empty, uses `*`, or protects something with no PIN set,
- test buttons to turn allowed things on, off or toggle them, with a PIN box,
- the extension URL for HTTPS mode.

## HTTPS mode (advanced)

turbowarp.org is an HTTPS site, so it cannot call a plain HTTP address on your network. If your Home Assistant has a real certificate for a name that works at home, you can use turbowarp.org directly:

1. Set `ssl: true`. Check `certfile` and `keyfile` match the files in `/ssl`.
2. Add `https://turbowarp.org` to `cors_allow_origins`, and your host name to `allowed_hosts`.
3. Restart. Open the status page over `https://your-name:8099/status` and copy the extension URL.
4. In turbowarp.org, choose **Add extension > Custom extension** and paste the URL.

The panel inside Home Assistant keeps working as before.

## Limitations

- Browsers block HTTP requests from HTTPS pages, which is called mixed content. So turbowarp.org cannot reach the add-on on plain HTTP, and the add-on serves its own pages instead.
- The editor is built from TurboWarp's source and is not part of every image. Without it, "Make a project" is hidden. Make projects on turbowarp.org or TurboWarp Desktop, then put the `.sb3` file in the projects folder. The Home blocks load there but cannot reach your home, so they report "Can't reach home." until the project plays from the add-on.
- In a sandboxed TurboWarp extension the menus are fixed when the extension loads. Reload the page after changing the allowed list.
- The editor cannot save straight back to the add-on yet. Use File > Save to your computer, then Save to ScratcHA in the panel.

## Licences

- ScratcHA: MIT.
- TurboWarp editor (when included): GPL-3.0. Source: [TurboWarp/scratch-gui](https://github.com/TurboWarp/scratch-gui) at the commit in `editor/SCRATCH_GUI_COMMIT`, with the patch in `editor/patches`.
- TurboWarp Packager, used for players: MPL-2.0. Source: [TurboWarp/packager](https://github.com/TurboWarp/packager).
