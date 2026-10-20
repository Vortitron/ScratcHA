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
		if (config.editor) {
			const extension = new URL("extension/scratcha.js", location.href).href;
			$("make").href = `editor/editor.html?extension=${encodeURIComponent(extension)}`;
			$("make").hidden = false;
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

start();
