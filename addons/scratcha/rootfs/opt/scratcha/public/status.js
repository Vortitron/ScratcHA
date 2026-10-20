// Status and test page. Plain ES module, no build step.
const $ = (id) => document.getElementById(id);
const switchable = ["light", "switch", "fan", "input_boolean", "cover", "media_player", "climate", "siren"];
const states = new Map();
let entities = [];
let config = null;

async function getJson(path) {
	const res = await fetch(path);
	return res.json();
}

function alert(text, bad = false) {
	const p = document.createElement("p");
	p.className = bad ? "notice bad" : "notice";
	p.textContent = text;
	$("alerts").append(p);
}

function fact(list, name, value) {
	const dt = document.createElement("dt");
	dt.textContent = name;
	const dd = document.createElement("dd");
	if (value instanceof Node) {
		dd.append(value);
	} else {
		dd.textContent = value;
	}
	list.append(dt, dd);
}

function listText(items) {
	return items && items.length ? items.join(", ") : "(none)";
}

function pill(text, kind) {
	const span = document.createElement("span");
	span.className = `pill ${kind ?? ""}`;
	span.textContent = text;
	return span;
}

async function call(entityId, service) {
	const pin = $("pin").value.trim();
	const headers = { "Content-Type": "application/json" };
	if (pin) {
		headers["X-ScratcHA-PIN"] = pin;
	}
	$("result").textContent = `Calling ${service} on ${entityId}...`;
	try {
		const res = await fetch(`bridge/services/homeassistant/${service}`, {
			method: "POST",
			headers,
			body: JSON.stringify({ entity_id: entityId })
		});
		const body = await res.json();
		if (res.ok) {
			$("result").textContent = `Done: ${service} on ${entityId}.`;
			for (const s of body.changed ?? []) {
				states.set(s.entity_id, s);
			}
			renderEntities();
		} else {
			$("result").textContent = `Refused (${body.error}): ${body.message}`;
		}
	} catch (error) {
		$("result").textContent = `Could not reach the bridge: ${error.message}`;
	}
}

function renderEntities() {
	const body = $("entities");
	body.textContent = "";
	if (entities.length === 0) {
		const cell = body.insertRow().insertCell();
		cell.colSpan = 3;
		cell.textContent = "No allowed entities exist right now.";
		return;
	}
	for (const e of entities) {
		const row = body.insertRow();
		row.dataset.entity = e.entity_id;
		const name = row.insertCell();
		const code = document.createElement("code");
		code.textContent = e.entity_id;
		name.append(e.name, document.createElement("br"), code);
		const s = states.get(e.entity_id);
		row.insertCell().textContent = s ? s.state : "";
		const actions = row.insertCell();
		if (switchable.includes(e.domain) && !config?.read_only) {
			for (const [label, service] of [["On", "turn_on"], ["Off", "turn_off"], ["Toggle", "toggle"]]) {
				const button = document.createElement("button");
				button.type = "button";
				button.className = "small";
				button.textContent = label;
				button.dataset.service = service;
				button.addEventListener("click", () => call(e.entity_id, service));
				actions.append(button);
			}
		}
	}
}

function renderConfig(health) {
	$("ha").replaceChildren(pill(health.ha, health.ha === "connected" ? "ok" : "bad"));
	$("mode").textContent = health.mode === "supervisor" ? "Supervisor (no token needed)" : "Access token";
	$("version").textContent = health.version;

	$("alerts").textContent = "";
	if (config.allow_list_empty) {
		alert("The allowed list is empty, so nothing can be read or controlled. Add entities in the add-on options.", true);
	}
	if (config.allow_everything) {
		alert("allowed_entities contains \"*\". Every entity in the house can be controlled. Use a short list instead.", true);
	}
	if (config.cors_allow_any) {
		alert("cors_allow_origins contains \"*\". Any web page can call the bridge.", true);
	}
	if (config.pin_missing) {
		alert("Some things are protected but no PIN is set, so they are always refused.", true);
	}
	if (health.ha === "not_configured") {
		alert("No Home Assistant connection is set up. Inside Home Assistant this is automatic. Outside it, set access_token.", true);
	}
	for (const warning of config.warnings ?? []) {
		alert(warning);
	}

	const safety = $("safety");
	safety.textContent = "";
	fact(safety, "Read-only", config.read_only ? "Yes. Calls are refused." : "No");
	fact(safety, "Allowed entities", listText(config.allowed_entities));
	fact(safety, "Denied entities", listText(config.denied_entities));
	fact(safety, "Extra services", listText(config.allowed_services));
	fact(safety, "Services with no target", listText(config.allowed_services_without_target));
	fact(safety, "Block services", listText(config.block_services));
	fact(safety, "Protected services", listText(config.protected_services));
	fact(safety, "Protected entities", listText(config.protected_entities));
	fact(safety, "PIN", config.pin_enabled ? "Set" : "Not set");
	const r = config.rate_limits;
	fact(safety, "Rate limits", `${r.calls} calls per ${r.window_s} s (burst ${r.burst}), ${r.min_interval_ms} ms between changes to one entity, ${r.reads_per_s} reads per second`);
	fact(safety, "Allowed web origins", listText(config.cors_allow_origins));

	const extensionUrl = new URL("extension/scratcha.js", location.href).href;
	$("extension-url").textContent = extensionUrl;
	if (config.editor) {
		const link = document.createElement("a");
		link.href = `editor/editor.html?extension=${encodeURIComponent(extensionUrl)}`;
		link.textContent = "Open the editor";
		$("editor").replaceChildren(link);
	} else {
		$("editor").textContent = "Not in this build. Players still work.";
	}
}

async function refresh() {
	const [health, cfg] = await Promise.all([getJson("bridge/health"), getJson("bridge/config")]);
	config = cfg;
	renderConfig(health);
	try {
		entities = await getJson("bridge/entities");
		if (!Array.isArray(entities)) {
			entities = [];
		}
		const list = await getJson("bridge/states");
		for (const s of Array.isArray(list) ? list : []) {
			states.set(s.entity_id, s);
		}
	} catch {
		entities = [];
	}
	renderEntities();
}

function connectEvents() {
	const events = new EventSource("bridge/events");
	events.addEventListener("open", () => {
		$("live").replaceChildren(pill("connected", "ok"));
	});
	events.addEventListener("error", () => {
		$("live").replaceChildren(pill("reconnecting", "bad"));
	});
	events.addEventListener("state", (event) => {
		const s = JSON.parse(event.data);
		if (s.state === null) {
			states.delete(s.entity_id);
		} else {
			states.set(s.entity_id, s);
		}
		renderEntities();
	});
	events.addEventListener("config", () => {
		refresh();
	});
}

refresh().catch((error) => alert(`Could not load status: ${error.message}`, true));
connectEvents();
