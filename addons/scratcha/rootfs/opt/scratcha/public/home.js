// Kid landing page. Same origin as the bridge, so relative URLs work on the
// LAN port and under ingress.
const $ = (id) => document.getElementById(id);
const states = new Map();
let entities = [];

async function getJson(path) {
	const res = await fetch(path);
	if (!res.ok) {
		throw new Error(`${path}: ${res.status}`);
	}
	return res.json();
}

function render() {
	const body = $("things-body");
	body.textContent = "";
	if (entities.length === 0) {
		const row = body.insertRow();
		const cell = row.insertCell();
		cell.colSpan = 3;
		cell.textContent = "Nothing yet.";
		return;
	}
	for (const e of entities) {
		const row = body.insertRow();
		row.insertCell().textContent = e.name;
		const code = document.createElement("code");
		code.textContent = e.entity_id;
		row.insertCell().append(code);
		const s = states.get(e.entity_id);
		row.insertCell().textContent = s ? `${s.state}${s.attributes?.unit_of_measurement ? ` ${s.attributes.unit_of_measurement}` : ""}` : "";
	}
}

async function start() {
	try {
		const config = await getJson("bridge/config");
		$("nothing-allowed").hidden = !config.allow_list_empty;
		$("offline").hidden = config.ha === "connected";
		$("upload").hidden = !config.can_upload;
		if (config.editor) {
			const extension = new URL("extension/scratcha.js", location.href).href;
			$("make").href = `editor/editor.html?extension=${encodeURIComponent(extension)}`;
			$("make").hidden = false;
			const source = config.editor_source;
			if (source?.source) {
				const link = document.createElement("a");
				link.href = source.source;
				link.textContent = "editor source";
				const patch = document.createElement("a");
				patch.href = source.patches ?? source.source;
				patch.textContent = "patch";
				$("editor-source").append(" · The editor is TurboWarp, GPL-3.0: ", link, " and ", patch, ".");
			}
		} else {
			$("no-editor").hidden = false;
		}
	} catch {
		$("offline").hidden = false;
	}
}

$("show-things").addEventListener("click", async () => {
	const section = $("things");
	section.hidden = !section.hidden;
	$("show-things").setAttribute("aria-expanded", String(!section.hidden));
	if (section.hidden) {
		return;
	}
	try {
		entities = await getJson("bridge/entities");
		for (const s of await getJson("bridge/states")) {
			states.set(s.entity_id, s);
		}
	} catch {
		entities = [];
	}
	render();
	if (!window.scratchaEvents) {
		const events = new EventSource("bridge/events");
		window.scratchaEvents = events;
		events.addEventListener("state", (event) => {
			const s = JSON.parse(event.data);
			states.set(s.entity_id, s);
			render();
		});
	}
});

// Uploads only work from the Home Assistant panel (ingress), where the
// user is logged in.
$("upload-file").addEventListener("change", async () => {
	const file = $("upload-file").files[0];
	if (!file) {
		return;
	}
	const base = file.name.replace(/\.sb3$/i, "").replace(/[^A-Za-z0-9 _-]/g, "_").slice(0, 60);
	const name = `${base || "project"}.sb3`;
	$("upload-result").textContent = "Saving...";
	try {
		const res = await fetch(`projects?name=${encodeURIComponent(name)}`, {
			method: "POST",
			headers: { "Content-Type": "application/octet-stream" },
			body: file
		});
		const body = await res.json();
		$("upload-result").textContent = res.ok ? `Saved as ${body.name}.` : body.message;
	} catch (error) {
		$("upload-result").textContent = `Could not save: ${error.message}`;
	}
});

start();
