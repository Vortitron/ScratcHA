(function (Scratch, bridgeSetting = "__SCRATCHA_BRIDGE_URL__", knownSetting = "__SCRATCHA_KNOWN_ENTITIES__") {
	// ScratcHA: Home Assistant blocks for TurboWarp.
	// The bridge writes its own address into the line above when it serves
	// this file. A downloaded copy also gets the allowed list, so the menus
	// work in an editor that cannot reach home. Works sandboxed and
	// unsandboxed. Blocks never throw: a failure sets "last home error" and
	// the block finishes.

	const EXTENSION_ID = "scratcha";
	const FRESH_MS = 5000;
	const POLL_MS = 2000;
	const SSE_RETRY_MS = 60000;
	const SSE_MAX_FAILS = 3;
	const HAT_WINDOW_MS = 150;
	const NEGATIVE_CACHE_MS = 2000;

	const SWITCHABLE_DOMAINS = ["light", "switch", "fan", "input_boolean", "cover", "media_player", "climate", "siren"];
	const RUNNABLE_DOMAINS = ["scene", "script", "button", "input_button"];
	// Things that can only be read. Turning them on or off does nothing.
	const READ_ONLY_DOMAINS = ["sensor", "binary_sensor", "weather", "sun", "person", "device_tracker", "zone", "event"];
	const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;
	const ON_STATES = ["on", "open", "opening", "home", "playing", "heat", "cool", "heat_cool", "auto", "dry", "fan_only", "unlocked", "active", "true"];
	const RUN_SERVICES = {
		scene: "scene.turn_on",
		script: "script.turn_on",
		button: "button.press",
		input_button: "input_button.press"
	};

	const FRIENDLY = {
		not_allowed: "That is not on your list.",
		read_only: "Look, don't touch: ScratcHA is read-only.",
		pin_required: "That needs a grown-up's PIN.",
		pin_wrong: "That PIN is not right.",
		pin_locked: "Too many wrong PINs. Wait a few minutes.",
		rate_limited: "Slow down a bit.",
		bad_request: "Use the ID from \"What can I control?\", like light.kids_room.",
		not_found: "Home does not know that thing.",
		no_entity: "Pick a thing from the menu first.",
		cannot_switch: "That can only be read, not switched.",
		bad_address: "Start the address with http:// or https://",
		ha_unavailable: "Can't reach home.",
		network: "Can't reach home.",
		timeout: "Can't reach home.",
		bad_json: "That JSON is not quite right.",
		other: "Home said no."
	};

	const icon = "data:image/svg+xml;base64," + base64(
		"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'>" +
		"<path d='M20 5 3 19h5v15h9V25h6v9h9V19h5z' fill='#fff' stroke='#0b87b3' stroke-width='2' stroke-linejoin='round'/>" +
		"</svg>"
	);

	const unsandboxed = Boolean(Scratch.extensions && Scratch.extensions.unsandboxed);

	const state = {
		bridge: resolveBridge(bridgeSetting),
		config: null,
		entities: knownEntities(knownSetting),
		entitiesLoaded: false,
		mirror: new Map(),
		misses: new Map(),
		changedAt: new Map(),
		lastError: "",
		pin: "",
		events: null,
		eventsOpen: false,
		eventsFails: 0,
		pollTimer: null,
		retryTimer: null,
		health: { at: 0, ok: false }
	};

	function base64(text) {
		if (typeof btoa === "function") {
			return btoa(text);
		}
		return Buffer.from(text, "utf8").toString("base64");
	}

	function resolveBridge(raw) {
		const fallback = "http://homeassistant.local:8099";
		if (typeof raw !== "string" || !raw || raw.indexOf("__SCRATCHA") === 0) {
			return fallback;
		}
		if (raw.indexOf("relative:") === 0) {
			try {
				return new URL(raw.slice("relative:".length), location.href).href.replace(/\/+$/, "");
			} catch (error) {
				return fallback;
			}
		}
		return raw.replace(/\/+$/, "");
	}

	// The allowed list a downloaded copy was made with, if any.
	function knownEntities(raw) {
		if (!Array.isArray(raw)) {
			return [];
		}
		return raw.filter((e) => e && typeof e.entity_id === "string" && ENTITY_ID.test(e.entity_id))
			.map((e) => ({ entity_id: e.entity_id, name: String(e.name || e.entity_id), domain: domainOf(e.entity_id) }));
	}

	function timeoutMs() {
		const base = state.config && Number(state.config.timeout_ms);
		return (Number.isFinite(base) && base > 0 ? base : 8000) + 1000;
	}

	function grownUpLog(what, detail) {
		try {
			console.warn("[ScratcHA] " + what, detail);
		} catch (error) {
			// No console. Nothing to do.
		}
	}

	function fail(error) {
		const code = error && error.code;
		state.lastError = FRIENDLY[code] || FRIENDLY.other;
		grownUpLog(state.lastError, error);
	}

	async function request(method, path, body) {
		const controller = typeof AbortController === "function" ? new AbortController() : null;
		const timer = controller ? setTimeout(() => controller.abort(), timeoutMs()) : null;
		const headers = {};
		if (body !== undefined) {
			headers["Content-Type"] = "application/json";
		}
		// Only calls need the PIN. Leaving it off reads avoids a CORS preflight.
		if (state.pin && method === "POST") {
			headers["X-ScratcHA-PIN"] = state.pin;
		}
		let response;
		try {
			response = await fetch(state.bridge + path, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: controller ? controller.signal : undefined
			});
		} catch (error) {
			const err = new Error("Network request failed: " + (error && error.message));
			err.code = error && error.name === "AbortError" ? "timeout" : "network";
			throw err;
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
		}
		let data = null;
		try {
			data = await response.json();
		} catch (error) {
			data = null;
		}
		if (!response.ok) {
			const err = new Error((data && data.message) || "HTTP " + response.status);
			err.code = (data && data.error) || "other";
			err.status = response.status;
			throw err;
		}
		return data;
	}

	// Mirror of allowed states, fed by events, polling and direct reads.

	function applyState(item) {
		if (!item || typeof item.entity_id !== "string") {
			return;
		}
		const id = item.entity_id;
		const previous = state.mirror.get(id);
		if (item.state === null || item.state === undefined) {
			state.mirror.delete(id);
			return;
		}
		state.mirror.set(id, { value: item, at: Date.now() });
		state.misses.delete(id);
		if (previous && previous.value.state !== item.state) {
			changed(id, item.state);
		}
	}

	function changed(id, newState) {
		state.changedAt.set(id, Date.now());
		if (unsandboxed && Scratch.vm && Scratch.vm.runtime) {
			try {
				Scratch.vm.runtime.startHats(EXTENSION_ID + "_whenChanges", { ENTITY_FIELD: id });
				Scratch.vm.runtime.startHats(EXTENSION_ID + "_whenBecomes", { ENTITY_FIELD: id });
			} catch (error) {
				grownUpLog("Could not start hats", error);
			}
		}
	}

	function startEvents() {
		clearTimeout(state.retryTimer);
		if (typeof EventSource !== "function") {
			startPolling();
			return;
		}
		let source;
		try {
			source = new EventSource(state.bridge + "/bridge/events");
		} catch (error) {
			startPolling();
			return;
		}
		state.events = source;
		source.addEventListener("open", () => {
			state.eventsOpen = true;
			state.eventsFails = 0;
			stopPolling();
		});
		source.addEventListener("state", (event) => {
			try {
				applyState(JSON.parse(event.data));
			} catch (error) {
				grownUpLog("Bad state event", error);
			}
		});
		source.addEventListener("config", () => {
			refreshEntities();
		});
		source.addEventListener("error", () => {
			state.eventsOpen = false;
			state.eventsFails += 1;
			if (state.eventsFails >= SSE_MAX_FAILS) {
				source.close();
				state.events = null;
				state.eventsFails = 0;
				startPolling();
				state.retryTimer = setTimeout(startEvents, SSE_RETRY_MS);
			}
		});
	}

	function startPolling() {
		if (state.pollTimer) {
			return;
		}
		const tick = async () => {
			try {
				const list = await request("GET", "/bridge/states");
				if (Array.isArray(list)) {
					list.forEach(applyState);
				}
			} catch (error) {
				// Polling quietly retries. Blocks report their own errors.
			}
		};
		tick();
		state.pollTimer = setInterval(tick, POLL_MS);
	}

	function stopPolling() {
		if (state.pollTimer) {
			clearInterval(state.pollTimer);
			state.pollTimer = null;
		}
	}

	async function loadConfig() {
		try {
			state.config = await request("GET", "/bridge/config");
		} catch (error) {
			grownUpLog("Could not load the bridge config", error);
		}
		await refreshEntities();
	}

	async function refreshEntities() {
		let list;
		try {
			list = await request("GET", "/bridge/entities");
		} catch (error) {
			grownUpLog("Could not load the entity list", error);
			return;
		}
		if (!Array.isArray(list)) {
			return;
		}
		const before = JSON.stringify(state.entities);
		state.entities = list.filter((e) => e && typeof e.entity_id === "string");
		state.entitiesLoaded = true;
		if (before !== JSON.stringify(state.entities) && unsandboxed && Scratch.vm && Scratch.vm.extensionManager) {
			try {
				Scratch.vm.extensionManager.refreshBlocks();
			} catch (error) {
				grownUpLog("Could not refresh blocks", error);
			}
		}
	}

	async function readState(entityId) {
		const id = entityArg(entityId);
		if (!id) {
			fail({ code: "no_entity", message: "No entity picked" });
			return null;
		}
		const hit = state.mirror.get(id);
		if (hit && (state.eventsOpen || state.pollTimer || Date.now() - hit.at < FRESH_MS)) {
			return hit.value;
		}
		const miss = state.misses.get(id);
		if (!hit && miss && Date.now() - miss.at < NEGATIVE_CACHE_MS) {
			return null;
		}
		try {
			const value = await request("GET", "/bridge/states/" + encodeURIComponent(id));
			applyState(value);
			state.lastError = "";
			return value;
		} catch (error) {
			state.misses.set(id, { at: Date.now() });
			fail(error);
			return hit ? hit.value : null;
		}
	}

	async function callService(service, data) {
		const parts = String(service).split(".");
		if (parts.length !== 2) {
			fail({ code: "other", message: "Service must look like domain.service" });
			return;
		}
		try {
			const result = await request("POST", "/bridge/services/" + encodeURIComponent(parts[0]) + "/" + encodeURIComponent(parts[1]), data);
			state.lastError = "";
			if (result && Array.isArray(result.changed)) {
				result.changed.forEach(applyState);
			}
		} catch (error) {
			fail(error);
		}
	}

	// An entity ID, or a friendly name from the allowed list, which is
	// turned into its ID. Kids often type the name they can see.
	function entityArg(value) {
		const text = String(value === undefined || value === null ? "" : value).trim();
		if (!text || ENTITY_ID.test(text)) {
			return text;
		}
		const lower = text.toLowerCase();
		const known = state.entities.find((e) => String(e.name).toLowerCase() === lower || e.entity_id === lower);
		return known ? known.entity_id : text;
	}

	// Checks an entity for the on, off and toggle blocks. Returns the ID, or
	// "" after setting the error.
	function switchableArg(value) {
		const id = entityArg(value);
		if (!id) {
			fail({ code: "no_entity", message: "No entity picked" });
			return "";
		}
		if (READ_ONLY_DOMAINS.indexOf(domainOf(id)) !== -1) {
			fail({ code: "cannot_switch", message: id + " can only be read" });
			return "";
		}
		return id;
	}

	function targetArg(value) {
		const id = entityArg(value);
		if (!id) {
			fail({ code: "no_entity", message: "No entity picked" });
		}
		return id;
	}

	function domainOf(entityId) {
		return entityId.split(".")[0];
	}

	function hexToRgb(value) {
		if (typeof value === "string") {
			const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
			if (m) {
				const n = parseInt(m[1], 16);
				return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
			}
		}
		if (Scratch.Cast && typeof Scratch.Cast.toRgbColorList === "function") {
			return Scratch.Cast.toRgbColorList(value).slice(0, 3);
		}
		return [255, 255, 255];
	}

	function clampPercent(value) {
		const n = Number(value);
		if (!Number.isFinite(n)) {
			return 0;
		}
		return Math.round(Math.min(100, Math.max(0, n)));
	}

	function menuFrom(list) {
		if (list.length === 0) {
			// Without the list from home, an empty menu says nothing about
			// what is allowed. Do not send a grown-up to the wrong fix.
			const loaded = state.entitiesLoaded || Array.isArray(knownSetting);
			return [{ text: loaded ? "(nothing allowed yet)" : "(can't reach home)", value: "" }];
		}
		return list.map((e) => ({ text: e.name || e.entity_id, value: e.entity_id }));
	}

	function entitiesIn(domains) {
		return state.entities.filter((e) => domains.indexOf(e.domain || domainOf(e.entity_id)) !== -1);
	}

	function firstOf(list) {
		return list.length ? list[0].entity_id : "";
	}

	// Dynamic menus (a method name) only work unsandboxed. The VM cannot call
	// into a sandboxed worker to build a menu, so sandboxed menus are fixed
	// lists made when the extension registers.
	function menuItems(method) {
		return unsandboxed ? method : extension[method]();
	}

	class ScratcHA {
		getInfo() {
			const anyEntity = firstOf(state.entities);
			const switchable = firstOf(entitiesIn(SWITCHABLE_DOMAINS));
			const light = firstOf(entitiesIn(["light"]));
			const runnable = firstOf(entitiesIn(RUNNABLE_DOMAINS));
			const hatType = unsandboxed ? { isEdgeActivated: false } : { isEdgeActivated: true };
			return {
				id: EXTENSION_ID,
				name: "Home",
				color1: "#18BCF2",
				color2: "#0FA3D6",
				color3: "#0B87B3",
				menuIconURI: icon,
				blockIconURI: icon,
				blocks: [
					{ opcode: "stateOf", blockType: Scratch.BlockType.REPORTER, text: "state of [ENTITY]", arguments: { ENTITY: { type: Scratch.ArgumentType.STRING, menu: "entities", defaultValue: anyEntity } } },
					{ opcode: "numberOf", blockType: Scratch.BlockType.REPORTER, text: "number from [ENTITY]", arguments: { ENTITY: { type: Scratch.ArgumentType.STRING, menu: "entities", defaultValue: anyEntity } } },
					{ opcode: "attributeOf", blockType: Scratch.BlockType.REPORTER, text: "[ATTRIBUTE] of [ENTITY]", arguments: { ATTRIBUTE: { type: Scratch.ArgumentType.STRING, defaultValue: "friendly_name" }, ENTITY: { type: Scratch.ArgumentType.STRING, menu: "entities", defaultValue: anyEntity } } },
					{ opcode: "nameOf", blockType: Scratch.BlockType.REPORTER, text: "name of [ENTITY]", arguments: { ENTITY: { type: Scratch.ArgumentType.STRING, menu: "entities", defaultValue: anyEntity } } },
					{ opcode: "isOn", blockType: Scratch.BlockType.BOOLEAN, text: "[ENTITY] is on?", arguments: { ENTITY: { type: Scratch.ArgumentType.STRING, menu: "entities", defaultValue: anyEntity } } },
					{ opcode: "isState", blockType: Scratch.BlockType.BOOLEAN, text: "[ENTITY] is [STATE]?", arguments: { ENTITY: { type: Scratch.ArgumentType.STRING, menu: "entities", defaultValue: anyEntity }, STATE: { type: Scratch.ArgumentType.STRING, defaultValue: "on" } } },
					"---",
					{ opcode: "turnOnOff", blockType: Scratch.BlockType.COMMAND, text: "turn [SWITCHABLE] [ONOFF]", arguments: { SWITCHABLE: { type: Scratch.ArgumentType.STRING, menu: "switchables", defaultValue: switchable }, ONOFF: { type: Scratch.ArgumentType.STRING, menu: "onoff", defaultValue: "on" } } },
					{ opcode: "toggle", blockType: Scratch.BlockType.COMMAND, text: "toggle [SWITCHABLE]", arguments: { SWITCHABLE: { type: Scratch.ArgumentType.STRING, menu: "switchables", defaultValue: switchable } } },
					{ opcode: "setBrightness", blockType: Scratch.BlockType.COMMAND, text: "set [LIGHT] brightness to [PERCENT] %", arguments: { LIGHT: { type: Scratch.ArgumentType.STRING, menu: "lights", defaultValue: light }, PERCENT: { type: Scratch.ArgumentType.NUMBER, defaultValue: 50 } } },
					{ opcode: "setColour", blockType: Scratch.BlockType.COMMAND, text: "set [LIGHT] colour to [COLOUR]", arguments: { LIGHT: { type: Scratch.ArgumentType.STRING, menu: "lights", defaultValue: light }, COLOUR: { type: Scratch.ArgumentType.COLOR, defaultValue: "#ff8800" } } },
					{ opcode: "run", blockType: Scratch.BlockType.COMMAND, text: "run [RUNNABLE]", arguments: { RUNNABLE: { type: Scratch.ArgumentType.STRING, menu: "runnables", defaultValue: runnable } } },
					{ opcode: "callService", blockType: Scratch.BlockType.COMMAND, text: "call service [SERVICE] with [JSON]", arguments: { SERVICE: { type: Scratch.ArgumentType.STRING, defaultValue: "light.turn_on" }, JSON: { type: Scratch.ArgumentType.STRING, defaultValue: "{\"entity_id\": \"light.example\"}" } } },
					"---",
					Object.assign({ opcode: "whenChanges", blockType: Scratch.BlockType.HAT, text: "when [ENTITY_FIELD] changes", arguments: { ENTITY_FIELD: { type: Scratch.ArgumentType.STRING, menu: "entityFields", defaultValue: anyEntity } } }, hatType),
					Object.assign({ opcode: "whenBecomes", blockType: Scratch.BlockType.HAT, text: "when [ENTITY_FIELD] becomes [STATE]", arguments: { ENTITY_FIELD: { type: Scratch.ArgumentType.STRING, menu: "entityFields", defaultValue: anyEntity }, STATE: { type: Scratch.ArgumentType.STRING, defaultValue: "on" } } }, hatType),
					"---",
					{ opcode: "connected", blockType: Scratch.BlockType.BOOLEAN, text: "connected to home?" },
					{ opcode: "lastError", blockType: Scratch.BlockType.REPORTER, text: "last home error" },
					{ opcode: "enterPin", blockType: Scratch.BlockType.COMMAND, text: "use PIN [PIN]", arguments: { PIN: { type: Scratch.ArgumentType.STRING, defaultValue: "" } } },
					{ opcode: "allEntities", blockType: Scratch.BlockType.REPORTER, text: "list of things I can use" },
					{ opcode: "setBridge", blockType: Scratch.BlockType.COMMAND, text: "set home address to [URL]", arguments: { URL: { type: Scratch.ArgumentType.STRING, defaultValue: state.bridge } } }
				],
				menus: {
					entities: { acceptReporters: true, items: menuItems("entitiesMenu") },
					entityFields: { acceptReporters: false, items: menuItems("entitiesMenu") },
					switchables: { acceptReporters: true, items: menuItems("switchablesMenu") },
					lights: { acceptReporters: true, items: menuItems("lightsMenu") },
					runnables: { acceptReporters: true, items: menuItems("runnablesMenu") },
					onoff: { acceptReporters: true, items: ["on", "off"] }
				}
			};
		}

		entitiesMenu() {
			return menuFrom(state.entities);
		}

		switchablesMenu() {
			return menuFrom(entitiesIn(SWITCHABLE_DOMAINS));
		}

		lightsMenu() {
			return menuFrom(entitiesIn(["light"]));
		}

		runnablesMenu() {
			return menuFrom(entitiesIn(RUNNABLE_DOMAINS));
		}

		async stateOf(args) {
			const value = await readState(args.ENTITY);
			return value ? String(value.state) : "";
		}

		async numberOf(args) {
			const value = await readState(args.ENTITY);
			const n = value ? Number(value.state) : NaN;
			return Number.isFinite(n) ? n : 0;
		}

		async attributeOf(args) {
			const value = await readState(args.ENTITY);
			if (!value || !value.attributes) {
				return "";
			}
			const attr = value.attributes[String(args.ATTRIBUTE).trim()];
			if (attr === undefined || attr === null) {
				return "";
			}
			return typeof attr === "object" ? JSON.stringify(attr) : attr;
		}

		async nameOf(args) {
			const id = entityArg(args.ENTITY);
			const value = await readState(id);
			if (value && value.attributes && value.attributes.friendly_name) {
				return String(value.attributes.friendly_name);
			}
			const known = state.entities.find((e) => e.entity_id === id);
			return known ? known.name : "";
		}

		async isOn(args) {
			const value = await readState(args.ENTITY);
			return value ? ON_STATES.indexOf(String(value.state).toLowerCase()) !== -1 : false;
		}

		async isState(args) {
			const value = await readState(args.ENTITY);
			return value ? String(value.state).toLowerCase() === String(args.STATE).trim().toLowerCase() : false;
		}

		async turnOnOff(args) {
			const id = switchableArg(args.SWITCHABLE);
			if (!id) {
				return;
			}
			const service = String(args.ONOFF).trim().toLowerCase() === "off" ? "homeassistant.turn_off" : "homeassistant.turn_on";
			await callService(service, { entity_id: id });
		}

		async toggle(args) {
			const id = switchableArg(args.SWITCHABLE);
			if (id) {
				await callService("homeassistant.toggle", { entity_id: id });
			}
		}

		async setBrightness(args) {
			const id = targetArg(args.LIGHT);
			if (id) {
				await callService("light.turn_on", { entity_id: id, brightness_pct: clampPercent(args.PERCENT) });
			}
		}

		async setColour(args) {
			const id = targetArg(args.LIGHT);
			if (id) {
				await callService("light.turn_on", { entity_id: id, rgb_color: hexToRgb(args.COLOUR) });
			}
		}

		async run(args) {
			const id = targetArg(args.RUNNABLE);
			if (!id) {
				return;
			}
			const service = RUN_SERVICES[domainOf(id)];
			if (!service) {
				fail({ code: "not_allowed", message: id + " is not a scene, script or button" });
				return;
			}
			await callService(service, { entity_id: id });
		}

		async callService(args) {
			let data;
			try {
				data = JSON.parse(String(args.JSON || "{}"));
			} catch (error) {
				fail({ code: "bad_json", message: error.message });
				return;
			}
			if (!data || typeof data !== "object" || Array.isArray(data)) {
				fail({ code: "bad_json", message: "Service data must be an object" });
				return;
			}
			await callService(String(args.SERVICE).trim(), data);
		}

		whenChanges(args) {
			if (unsandboxed) {
				return true;
			}
			const at = state.changedAt.get(entityArg(args.ENTITY_FIELD));
			return at !== undefined && Date.now() - at < HAT_WINDOW_MS;
		}

		whenBecomes(args) {
			const hit = state.mirror.get(entityArg(args.ENTITY_FIELD));
			if (!hit) {
				return false;
			}
			return String(hit.value.state).toLowerCase() === String(args.STATE).trim().toLowerCase();
		}

		async connected() {
			if (Date.now() - state.health.at < 1000) {
				return state.health.ok;
			}
			let ok = false;
			try {
				const health = await request("GET", "/bridge/health");
				ok = Boolean(health && health.status === "ok" && health.ha === "connected");
			} catch (error) {
				ok = false;
			}
			state.health = { at: Date.now(), ok };
			return ok;
		}

		lastError() {
			return state.lastError;
		}

		enterPin(args) {
			state.pin = String(args.PIN === undefined || args.PIN === null ? "" : args.PIN).trim();
		}

		allEntities() {
			return state.entities.map((e) => e.entity_id).join(",");
		}

		async setBridge(args) {
			const url = String(args.URL).trim();
			if (!/^https?:\/\/[^\s]+$/.test(url)) {
				fail({ code: "bad_address", message: "Home address must start with http:// or https://" });
				return;
			}
			state.bridge = url.replace(/\/+$/, "");
			state.mirror.clear();
			if (state.events) {
				state.events.close();
				state.events = null;
			}
			stopPolling();
			await loadConfig();
			startEvents();
		}
	}

	// Test hook: lets the unit tests reach the internals in Node.
	if (Scratch.__scratchaTest) {
		Scratch.__scratchaTest.state = state;
		Scratch.__scratchaTest.applyState = applyState;
	}

	const extension = new ScratcHA();
	let registered = false;
	const register = () => {
		if (!registered) {
			registered = true;
			Scratch.extensions.register(extension);
		}
	};
	// Register even if the bridge is slow or missing, so projects still open.
	const giveUp = setTimeout(register, 3000);
	loadConfig().then(() => {
		clearTimeout(giveUp);
		register();
		startEvents();
	});
})(Scratch);
