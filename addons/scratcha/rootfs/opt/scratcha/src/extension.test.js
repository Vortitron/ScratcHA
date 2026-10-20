import assert from "node:assert/strict";
import vm from "node:vm";
import { test, before, after } from "node:test";
import { loadExtensionSource, renderExtension } from "./extension.js";
import { makeState, startBridge, startFakeCore, waitFor } from "./test-helpers.js";

const source = loadExtensionSource();
// Values made inside the vm context have other prototypes, so compare as JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));

const states = [
	makeState("input_boolean.lamp", "off", { friendly_name: "Lamp" }),
	makeState("input_boolean.house_main_power", "on", { friendly_name: "Main power" }),
	makeState("light.kids_lamp", "on", { friendly_name: "Kids lamp", rgb_color: [255, 0, 0], brightness: 128 }),
	makeState("sensor.room_temperature", "21.5", { friendly_name: "Room temperature" }),
	makeState("sensor.words", "hello", { friendly_name: "Words" }),
	makeState("scene.party", "unknown", { friendly_name: "Party" })
];

const options = {
	allowed_entities: ["input_boolean.*", "light.kids_lamp", "sensor.*", "scene.party"],
	denied_entities: ["input_boolean.house_main_power"],
	protected_entities: ["scene.party"],
	pin_code: "2468",
	min_interval_ms: 0,
	rate_limit_calls: 100
};

let fake;
let bridge;
const loaded = [];

before(async () => {
	fake = await startFakeCore({ states });
	bridge = await startBridge(options, { core: fake });
});

after(async () => {
	for (const ext of loaded) {
		ext.stop();
	}
	await bridge.close();
	await fake.close();
});

// A small EventSource on top of fetch, enough for the extension.
class FakeEventSource {
	constructor(url) {
		this.listeners = {};
		this.controller = new AbortController();
		this.closed = false;
		this.run(url);
	}

	addEventListener(type, fn) {
		(this.listeners[type] ??= []).push(fn);
	}

	emit(type, data) {
		for (const fn of this.listeners[type] ?? []) {
			fn({ data });
		}
	}

	async run(url) {
		try {
			const res = await fetch(url, { signal: this.controller.signal });
			if (!res.ok) {
				throw new Error(`status ${res.status}`);
			}
			this.emit("open");
			const decoder = new TextDecoder();
			let buffer = "";
			for await (const chunk of res.body) {
				buffer += decoder.decode(chunk);
				let end;
				while ((end = buffer.indexOf("\n\n")) >= 0) {
					const block = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					const type = /^event: (.+)$/m.exec(block)?.[1];
					const data = /^data: (.+)$/m.exec(block)?.[1];
					if (type && data) {
						this.emit(type, data);
					}
				}
			}
		} catch {
			if (!this.closed) {
				this.emit("error");
			}
		}
	}

	close() {
		this.closed = true;
		this.controller.abort();
	}
}

// Loads the extension into a fresh context with a fake Scratch global.
async function loadExtension({ bridgeUrl = bridge.base, unsandboxed = true, eventSource = true, known = null } = {}) {
	const hats = [];
	const timers = new Set();
	const sources = [];
	let fetches = 0;
	let registered = null;
	let refreshes = 0;
	const Scratch = {
		extensions: { unsandboxed, register: (ext) => { registered = ext; } },
		BlockType: { COMMAND: "command", REPORTER: "reporter", BOOLEAN: "Boolean", HAT: "hat" },
		ArgumentType: { STRING: "string", NUMBER: "number", COLOR: "color" },
		vm: {
			runtime: { startHats: (opcode, fields) => hats.push([opcode, fields]) },
			extensionManager: { refreshBlocks: () => { refreshes += 1; } }
		},
		__scratchaTest: {}
	};
	const context = vm.createContext({
		Scratch,
		fetch: (...args) => {
			fetches += 1;
			return fetch(...args);
		},
		EventSource: eventSource ? class extends FakeEventSource {
			constructor(url) {
				super(url);
				sources.push(this);
			}
		} : undefined,
		AbortController,
		URL,
		TextDecoder,
		btoa,
		console: { warn() {}, log() {}, error() {} },
		location: { href: `${bridge.base}/play/x.html` },
		setTimeout: (fn, ms) => {
			const t = setTimeout(fn, ms);
			timers.add(t);
			return t;
		},
		clearTimeout: (t) => clearTimeout(t),
		setInterval: (fn, ms) => {
			const t = setInterval(fn, ms);
			timers.add(t);
			return t;
		},
		clearInterval: (t) => clearInterval(t)
	});
	vm.runInContext(renderExtension(source, bridgeUrl, known), context);
	await waitFor(() => registered !== null, 4000);
	const ext = {
		instance: registered,
		Scratch,
		hats,
		get fetches() {
			return fetches;
		},
		get refreshes() {
			return refreshes;
		},
		internals: Scratch.__scratchaTest,
		sources,
		stop() {
			for (const t of timers) {
				clearTimeout(t);
				clearInterval(t);
			}
			for (const s of sources) {
				s.close();
			}
		}
	};
	loaded.push(ext);
	return ext;
}

test("block definitions, colours, menus", async () => {
	const ext = await loadExtension();
	const info = ext.instance.getInfo();
	assert.equal(info.id, "scratcha");
	assert.equal(info.name, "Home");
	assert.equal(info.color1, "#18BCF2");
	assert.match(info.blockIconURI, /^data:image\/svg\+xml;base64,/);
	const opcodes = info.blocks.filter((b) => typeof b === "object").map((b) => b.opcode);
	for (const op of ["stateOf", "numberOf", "attributeOf", "nameOf", "isOn", "isState", "turnOnOff", "toggle", "setBrightness", "setColour", "run", "callService", "whenChanges", "whenBecomes", "connected", "lastError", "enterPin", "allEntities"]) {
		assert.ok(opcodes.includes(op), op);
	}
	assert.equal(info.menus.entityFields.acceptReporters, false);
	assert.equal(info.menus.entities.items, "entitiesMenu");
	assert.equal(info.menus.entities.acceptReporters, true);
	const hat = info.blocks.find((b) => b.opcode === "whenChanges");
	assert.equal(hat.isEdgeActivated, false);
	assert.deepEqual(Object.keys(hat.arguments), ["ENTITY_FIELD"]);
});

test("menus come from the bridge and only list allowed entities", async () => {
	const ext = await loadExtension();
	const all = ext.instance.entitiesMenu().map((m) => m.value).sort();
	assert.deepEqual(all, ["input_boolean.lamp", "light.kids_lamp", "scene.party", "sensor.room_temperature", "sensor.words"]);
	assert.deepEqual(plain(ext.instance.entitiesMenu().find((m) => m.value === "input_boolean.lamp")), { text: "Lamp", value: "input_boolean.lamp" });
	assert.deepEqual(ext.instance.switchablesMenu().map((m) => m.value).sort(), ["input_boolean.lamp", "light.kids_lamp"]);
	assert.deepEqual(ext.instance.lightsMenu().map((m) => m.value), ["light.kids_lamp"]);
	assert.deepEqual(ext.instance.runnablesMenu().map((m) => m.value), ["scene.party"]);
	assert.equal(ext.instance.allEntities().split(",").length, 5);
});

test("an unreachable bridge still registers, with empty menus and friendly errors", async () => {
	const ext = await loadExtension({ bridgeUrl: "http://127.0.0.1:9", eventSource: false });
	assert.deepEqual(plain(ext.instance.entitiesMenu()), [{ text: "(can't reach home)", value: "" }]);
	assert.equal(await ext.instance.stateOf({ ENTITY: "light.kids_lamp" }), "");
	assert.equal(ext.instance.lastError(), "Can't reach home.");
	assert.equal(await ext.instance.isOn({ ENTITY: "light.kids_lamp" }), false);
	await ext.instance.toggle({ SWITCHABLE: "input_boolean.lamp" });
	assert.equal(ext.instance.lastError(), "Can't reach home.");
	assert.equal(await ext.instance.connected(), false);
});

test("a downloaded copy keeps its menus when home cannot be reached", async () => {
	const known = [{ entity_id: "light.kids_lamp", name: "Kids lamp" }, { entity_id: "sensor.room_temperature", name: "Room temperature" }];
	const ext = await loadExtension({ bridgeUrl: "http://127.0.0.1:9", eventSource: false, unsandboxed: false, known });
	const info = ext.instance.getInfo();
	assert.deepEqual(plain(info.menus.entityFields.items), [{ text: "Kids lamp", value: "light.kids_lamp" }, { text: "Room temperature", value: "sensor.room_temperature" }]);
	assert.deepEqual(plain(info.menus.lights.items), [{ text: "Kids lamp", value: "light.kids_lamp" }]);
	assert.deepEqual(plain(info.menus.runnables.items), [{ text: "(nothing allowed yet)", value: "" }]);
	await ext.instance.toggle({ SWITCHABLE: "light.kids_lamp" });
	assert.equal(ext.instance.lastError(), "Can't reach home.");
	const empty = await loadExtension({ bridgeUrl: "http://127.0.0.1:9", eventSource: false, known: [] });
	assert.deepEqual(plain(empty.instance.entitiesMenu()), [{ text: "(nothing allowed yet)", value: "" }]);
});

test("common kid mistakes get a message that says what to do", async () => {
	const ext = await loadExtension();
	const i = ext.instance;
	fake.calls.length = 0;
	// The friendly name works as well as the ID.
	assert.equal(await i.stateOf({ ENTITY: "Room temperature" }), "21.5");
	await i.turnOnOff({ SWITCHABLE: "lamp", ONOFF: "on" });
	assert.equal(i.lastError(), "");
	assert.deepEqual(fake.calls.map((c) => c.data.entity_id), ["input_boolean.lamp"]);
	await i.turnOnOff({ SWITCHABLE: "Not a thing", ONOFF: "on" });
	assert.equal(i.lastError(), "Use the ID from \"What can I control?\", like light.kids_room.");
	await i.turnOnOff({ SWITCHABLE: "", ONOFF: "on" });
	assert.equal(i.lastError(), "Pick a thing from the menu first.");
	assert.equal(await i.stateOf({ ENTITY: "" }), "");
	assert.equal(i.lastError(), "Pick a thing from the menu first.");
	await i.toggle({ SWITCHABLE: "sensor.room_temperature" });
	assert.equal(i.lastError(), "That can only be read, not switched.");
	assert.equal(fake.calls.length, 1);
	await i.setBridge({ URL: "homeassistant.local" });
	assert.equal(i.lastError(), "Start the address with http:// or https://");
	fake.setState("input_boolean.lamp", "off", { friendly_name: "Lamp" });
});

test("reporters and booleans", async () => {
	const ext = await loadExtension();
	const i = ext.instance;
	assert.equal(await i.stateOf({ ENTITY: "sensor.room_temperature" }), "21.5");
	assert.equal(await i.numberOf({ ENTITY: "sensor.room_temperature" }), 21.5);
	assert.equal(await i.numberOf({ ENTITY: "sensor.words" }), 0);
	assert.equal(await i.attributeOf({ ATTRIBUTE: "brightness", ENTITY: "light.kids_lamp" }), 128);
	assert.equal(await i.attributeOf({ ATTRIBUTE: "rgb_color", ENTITY: "light.kids_lamp" }), "[255,0,0]");
	assert.equal(await i.attributeOf({ ATTRIBUTE: "missing", ENTITY: "light.kids_lamp" }), "");
	assert.equal(await i.nameOf({ ENTITY: "light.kids_lamp" }), "Kids lamp");
	assert.equal(await i.isOn({ ENTITY: "light.kids_lamp" }), true);
	assert.equal(await i.isOn({ ENTITY: "input_boolean.lamp" }), false);
	assert.equal(await i.isState({ ENTITY: "sensor.words", STATE: " HELLO " }), true);
	assert.equal(await i.connected(), true);
	assert.equal(i.lastError(), "");
});

test("not allowed entity gives the kid message and an empty value", async () => {
	const ext = await loadExtension();
	assert.equal(await ext.instance.stateOf({ ENTITY: "input_boolean.house_main_power" }), "");
	assert.equal(ext.instance.lastError(), "That is not on your list.");
	assert.equal(await ext.instance.isOn({ ENTITY: "input_boolean.house_main_power" }), false);
	await ext.instance.turnOnOff({ SWITCHABLE: "input_boolean.house_main_power", ONOFF: "off" });
	assert.equal(ext.instance.lastError(), "That is not on your list.");
	assert.equal(fake.store.get("input_boolean.house_main_power").state, "on");
});

test("commands call the right services", async () => {
	const ext = await loadExtension();
	const i = ext.instance;
	fake.calls.length = 0;
	await i.turnOnOff({ SWITCHABLE: "input_boolean.lamp", ONOFF: "on" });
	await i.turnOnOff({ SWITCHABLE: "input_boolean.lamp", ONOFF: "off" });
	await i.toggle({ SWITCHABLE: "input_boolean.lamp" });
	await i.setBrightness({ LIGHT: "light.kids_lamp", PERCENT: 150 });
	await i.setBrightness({ LIGHT: "light.kids_lamp", PERCENT: -3 });
	await i.setBrightness({ LIGHT: "light.kids_lamp", PERCENT: "abc" });
	await i.setColour({ LIGHT: "light.kids_lamp", COLOUR: "#ff8000" });
	await i.callService({ SERVICE: "homeassistant.turn_off", JSON: "{\"entity_id\": \"input_boolean.lamp\"}" });
	assert.equal(i.lastError(), "");
	assert.deepEqual(fake.calls.map((c) => [`${c.domain}.${c.service}`, c.data]), [
		["homeassistant.turn_on", { entity_id: "input_boolean.lamp" }],
		["homeassistant.turn_off", { entity_id: "input_boolean.lamp" }],
		["homeassistant.toggle", { entity_id: "input_boolean.lamp" }],
		["light.turn_on", { entity_id: "light.kids_lamp", brightness_pct: 100 }],
		["light.turn_on", { entity_id: "light.kids_lamp", brightness_pct: 0 }],
		["light.turn_on", { entity_id: "light.kids_lamp", brightness_pct: 0 }],
		["light.turn_on", { entity_id: "light.kids_lamp", rgb_color: [255, 128, 0] }],
		["homeassistant.turn_off", { entity_id: "input_boolean.lamp" }]
	]);
});

test("run picks the service by domain and the PIN block unlocks it", async () => {
	const ext = await loadExtension();
	const i = ext.instance;
	fake.calls.length = 0;
	await i.run({ RUNNABLE: "scene.party" });
	assert.equal(i.lastError(), "That needs a grown-up's PIN.");
	i.enterPin({ PIN: "1111" });
	await i.run({ RUNNABLE: "scene.party" });
	assert.equal(i.lastError(), "That PIN is not right.");
	i.enterPin({ PIN: "2468" });
	await i.run({ RUNNABLE: "scene.party" });
	assert.equal(i.lastError(), "");
	assert.deepEqual(fake.calls.map((c) => `${c.domain}.${c.service}`), ["scene.turn_on"]);
	await i.run({ RUNNABLE: "input_boolean.lamp" });
	assert.equal(i.lastError(), "That is not on your list.");
});

test("bad JSON and bad service names never throw", async () => {
	const ext = await loadExtension();
	await ext.instance.callService({ SERVICE: "light.turn_on", JSON: "{nope" });
	assert.equal(ext.instance.lastError(), "That JSON is not quite right.");
	await ext.instance.callService({ SERVICE: "light.turn_on", JSON: "[1]" });
	assert.equal(ext.instance.lastError(), "That JSON is not quite right.");
	await ext.instance.callService({ SERVICE: "nodot", JSON: "{}" });
	assert.equal(ext.instance.lastError(), "Home said no.");
	await ext.instance.callService({ SERVICE: "homeassistant.restart", JSON: "{}" });
	assert.equal(ext.instance.lastError(), "That is not on your list.");
});

test("read-only and rate limit messages", async () => {
	const ro = await startBridge({ ...options, read_only: true }, { core: fake });
	const slow = await startBridge({ ...options, min_interval_ms: 5000 }, { core: fake });
	try {
		const a = await loadExtension({ bridgeUrl: ro.base });
		await a.instance.toggle({ SWITCHABLE: "input_boolean.lamp" });
		assert.equal(a.instance.lastError(), "Look, don't touch: ScratcHA is read-only.");
		const b = await loadExtension({ bridgeUrl: slow.base });
		await b.instance.toggle({ SWITCHABLE: "input_boolean.lamp" });
		assert.equal(b.instance.lastError(), "");
		await b.instance.toggle({ SWITCHABLE: "input_boolean.lamp" });
		assert.equal(b.instance.lastError(), "Slow down a bit.");
	} finally {
		await ro.close();
		await slow.close();
	}
});

test("unsandboxed hats: startHats on a real state change only", async () => {
	const ext = await loadExtension();
	await waitFor(() => ext.internals.state.eventsOpen && ext.internals.state.mirror.has("input_boolean.lamp"));
	ext.hats.length = 0;
	const current = fake.store.get("input_boolean.lamp").state;
	const next = current === "on" ? "off" : "on";
	fake.setState("input_boolean.lamp", next);
	await waitFor(() => ext.hats.length >= 2);
	assert.deepEqual(plain(ext.hats), [
		["scratcha_whenChanges", { ENTITY_FIELD: "input_boolean.lamp" }],
		["scratcha_whenBecomes", { ENTITY_FIELD: "input_boolean.lamp" }]
	]);
	assert.equal(ext.instance.whenChanges({ ENTITY_FIELD: "input_boolean.lamp" }), true);
	assert.equal(ext.instance.whenBecomes({ ENTITY_FIELD: "input_boolean.lamp", STATE: next }), true);
	assert.equal(ext.instance.whenBecomes({ ENTITY_FIELD: "input_boolean.lamp", STATE: current }), false);
	ext.hats.length = 0;
	fake.setState("input_boolean.lamp", next, { friendly_name: "Lamp", extra: 1 });
	await new Promise((r) => setTimeout(r, 100));
	assert.deepEqual(ext.hats, [], "attribute-only change must not fire hats");
});

test("sandboxed hats: edge-activated with a 150 ms window", async () => {
	const ext = await loadExtension({ unsandboxed: false });
	const info = ext.instance.getInfo();
	const hat = info.blocks.find((b) => b.opcode === "whenChanges");
	assert.equal(hat.isEdgeActivated, true);
	// Sandboxed menus must be plain lists: the VM cannot call into a worker for them.
	assert.ok(Array.isArray(info.menus.entities.items));
	assert.ok(plain(info.menus.lights.items).some((m) => m.value === "light.kids_lamp"));
	await waitFor(() => ext.internals.state.eventsOpen && ext.internals.state.mirror.has("input_boolean.lamp"));
	assert.equal(ext.instance.whenChanges({ ENTITY_FIELD: "input_boolean.lamp" }), false);
	const next = fake.store.get("input_boolean.lamp").state === "on" ? "off" : "on";
	fake.setState("input_boolean.lamp", next);
	await waitFor(() => ext.instance.whenChanges({ ENTITY_FIELD: "input_boolean.lamp" }));
	assert.equal(ext.hats.length, 0, "sandboxed mode must not call startHats");
	await new Promise((r) => setTimeout(r, 170));
	assert.equal(ext.instance.whenChanges({ ENTITY_FIELD: "input_boolean.lamp" }), false);
	assert.equal(ext.instance.whenBecomes({ ENTITY_FIELD: "input_boolean.lamp", STATE: next }), true);
});

test("fresh mirror answers reporters without fetching", async () => {
	const ext = await loadExtension();
	await waitFor(() => ext.internals.state.eventsOpen && ext.internals.state.mirror.has("sensor.room_temperature"));
	const before = ext.fetches;
	for (let n = 0; n < 50; n += 1) {
		await ext.instance.stateOf({ ENTITY: "sensor.room_temperature" });
	}
	assert.equal(ext.fetches, before);
});

test("without EventSource it polls, and stale entries are fetched again", async () => {
	const ext = await loadExtension({ eventSource: false });
	assert.ok(ext.internals.state.pollTimer);
	await waitFor(() => ext.internals.state.mirror.has("sensor.room_temperature"));
	clearInterval(ext.internals.state.pollTimer);
	ext.internals.state.pollTimer = null;
	ext.internals.state.mirror.get("sensor.room_temperature").at = Date.now() - 6000;
	const before = ext.fetches;
	fake.setState("sensor.room_temperature", "19");
	await waitFor(() => bridge.bridge.core.mirror.get("sensor.room_temperature").state === "19");
	assert.equal(await ext.instance.stateOf({ ENTITY: "sensor.room_temperature" }), "19");
	assert.equal(ext.fetches, before + 1);
	assert.equal(await ext.instance.stateOf({ ENTITY: "sensor.room_temperature" }), "19");
	assert.equal(ext.fetches, before + 1);
	fake.setState("sensor.room_temperature", "21.5");
});

test("a config event with new entities refreshes the palette", async () => {
	const ext = await loadExtension();
	await waitFor(() => ext.internals.state.eventsOpen);
	const before = ext.refreshes;
	fake.setState("sensor.new_one", "1", { friendly_name: "New one" });
	await waitFor(() => ext.refreshes > before);
	assert.ok(ext.instance.entitiesMenu().some((m) => m.value === "sensor.new_one"));
});

test("relative bridge setting resolves against the page, placeholder falls back", async () => {
	const rel = await loadExtension({ bridgeUrl: "relative:../" });
	assert.equal(rel.internals.state.bridge, bridge.base);
	const raw = await loadExtension({ bridgeUrl: "__SCRATCHA_BRIDGE_URL__", eventSource: false });
	assert.equal(raw.internals.state.bridge, "http://homeassistant.local:8099");
});

test("rendered extension escapes odd bridge URLs", () => {
	const out = renderExtension(source, "http://x/</script>\"");
	assert.ok(out.startsWith("(function (Scratch, bridgeSetting = \"http://x/\\u003c/script>\\\"\", knownSetting"));
	const dollars = renderExtension(source, "http://x/$&$'", [{ entity_id: "light.a", name: "$& </script>" }]);
	assert.ok(dollars.startsWith("(function (Scratch, bridgeSetting = \"http://x/$&$'\", knownSetting = [{\"entity_id\":\"light.a\",\"name\":\"$& \\u003c/script>\"}]) {"), dollars.split("\n")[0]);
});
