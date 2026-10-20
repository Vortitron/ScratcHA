// End-to-end: the real bridge against a real, throwaway Home Assistant.
import assert from "node:assert/strict";
import { test, before, after, describe } from "node:test";
import { TestHa, findHass } from "./start-ha.mjs";
import { BridgeProcess } from "./bridge-process.mjs";

const hass = findHass();
const skip = hass ? false : "no hass binary (set SCRATCHA_HASS)";

const safeOptions = {
	allowed_entities: ["input_boolean.*", "light.kids_lamp", "sensor.room_temperature", "input_number.temp", "scene.party"],
	denied_entities: ["input_boolean.house_main_power"],
	protected_entities: ["scene.party"],
	pin_code: "2468",
	min_interval_ms: 500,
	rate_limit_calls: 50,
	timeout_ms: 5000
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(check, timeoutMs = 10000, what = "condition") {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (await check()) {
			return;
		}
		await sleep(100);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

// Reads SSE text from the bridge until check(text) passes.
async function sseUntil(url, check, trigger, timeoutMs = 10000) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const res = await fetch(url, { signal: controller.signal });
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let triggered = false;
	try {
		while (!check(text)) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			text += decoder.decode(value);
			if (!triggered && text.includes("event: config")) {
				triggered = true;
				await trigger();
			}
		}
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
	return text;
}

let ha;

before(async () => {
	if (skip) {
		return;
	}
	ha = new TestHa({ hass });
	await ha.start();
}, { timeout: 300000 });

after(async () => {
	await ha?.cleanup();
});

for (const mode of ["token", "supervisor"]) {
	describe(`${mode} mode`, { skip }, () => {
		let bridge;

		before(async () => {
			const options = mode === "token"
				? { ...safeOptions, access_token: ha.token, homeassistant_url: ha.url }
				: { ...safeOptions };
			const env = mode === "supervisor" ? { SUPERVISOR_TOKEN: ha.token, SCRATCHA_CORE_URL: ha.url } : {};
			bridge = new BridgeProcess({ options, env });
			const health = await bridge.start();
			assert.equal(health.mode, mode);
		});

		after(async () => {
			await bridge?.stop();
		});

		test("reads an allowed state", async () => {
			const res = await bridge.get("/bridge/states/sensor.room_temperature");
			assert.equal(res.status, 200);
			const body = await res.json();
			assert.equal(body.state, await ha.state("sensor.room_temperature"));
			assert.ok(Number.isFinite(Number(body.state)));
			assert.equal(body.attributes.unit_of_measurement, "°C");
		});

		test("denied and unlisted entities are 403", async () => {
			for (const id of ["input_boolean.house_main_power", "zone.home", "person.test_owner"]) {
				const res = await bridge.get(`/bridge/states/${id}`);
				assert.equal(res.status, 403, id);
				assert.equal((await res.json()).error, "not_allowed");
			}
			const list = await (await bridge.get("/bridge/states")).json();
			const ids = list.map((s) => s.entity_id).sort();
			assert.deepEqual(ids, ["input_boolean.kids_lamp_power", "input_boolean.kids_room_power", "input_boolean.lamp", "input_number.temp", "light.kids_lamp", "scene.party", "sensor.room_temperature"]);
		});

		test("turns on the lamp in Home Assistant", async () => {
			await ha.call("input_boolean", "turn_off", { entity_id: "input_boolean.lamp" });
			await sleep(600);
			const res = await bridge.post("/bridge/services/homeassistant/turn_on", { entity_id: "input_boolean.lamp" });
			assert.equal(res.status, 200, await res.clone().text());
			const body = await res.json();
			assert.equal(body.ok, true);
			await waitUntil(async () => (await ha.state("input_boolean.lamp")) === "on", 5000, "lamp on");
		});

		test("house main power is never touched", async () => {
			assert.equal(await ha.state("input_boolean.house_main_power"), "on");
			for (const [service, body] of [
				["homeassistant/turn_off", { entity_id: "input_boolean.house_main_power" }],
				["homeassistant/toggle", { entity_id: ["input_boolean.lamp", "input_boolean.house_main_power"] }],
				["homeassistant/turn_off", { entity_id: "all" }],
				["input_boolean/turn_off", { entity_id: "input_boolean.house_main_power" }]
			]) {
				const res = await bridge.post(`/bridge/services/${service}`, body);
				assert.equal(res.status, 403, `${service} ${JSON.stringify(body)}`);
			}
			await sleep(300);
			assert.equal(await ha.state("input_boolean.house_main_power"), "on");
		});

		test("area, device, floor and label targets are rejected", async () => {
			for (const target of [{ area_id: "living_room" }, { device_id: "x" }, { floor_id: "ground" }, { label_id: "kids" }]) {
				const res = await bridge.post("/bridge/services/homeassistant/turn_off", { target });
				assert.equal(res.status, 403);
				assert.equal((await res.json()).error, "not_allowed");
			}
		});

		test("the PIN protects the party scene", async () => {
			await ha.call("input_boolean", "turn_off", { entity_id: "input_boolean.lamp" });
			const without = await bridge.post("/bridge/services/scene/turn_on", { entity_id: "scene.party" });
			assert.equal((await without.json()).error, "pin_required");
			const wrong = await bridge.post("/bridge/services/scene/turn_on", { entity_id: "scene.party" }, { "X-ScratcHA-PIN": "0000" });
			assert.equal((await wrong.json()).error, "pin_wrong");
			const right = await bridge.post("/bridge/services/scene/turn_on", { entity_id: "scene.party" }, { "X-ScratcHA-PIN": "2468" });
			assert.equal(right.status, 200);
			await waitUntil(async () => (await ha.state("input_boolean.lamp")) === "on", 5000, "scene to turn lamp on");
		});

		test("brightness reaches the template light", async () => {
			await sleep(600);
			const res = await bridge.post("/bridge/services/light/turn_on", { entity_id: "light.kids_lamp", brightness_pct: 50 });
			assert.equal(res.status, 200, await res.clone().text());
			await waitUntil(async () => (await ha.state("light.kids_lamp")) === "on", 5000, "kids lamp on");
			const level = Number(await ha.state("input_number.kids_lamp_level"));
			assert.ok(level >= 126 && level <= 129, `level ${level}`);
		});

		test("toggle loops hit the rate limit", async () => {
			await sleep(600);
			const first = await bridge.post("/bridge/services/homeassistant/toggle", { entity_id: "input_boolean.kids_lamp_power" });
			const second = await bridge.post("/bridge/services/homeassistant/toggle", { entity_id: "input_boolean.kids_lamp_power" });
			assert.equal(first.status, 200);
			assert.equal(second.status, 429);
			assert.equal((await second.json()).error, "rate_limited");
		});

		test("SSE sees a change made directly in Home Assistant", async () => {
			const target = Number(await ha.state("input_number.temp")) === 25 ? 19 : 25;
			const text = await sseUntil(
				`${bridge.url}/bridge/events?entities=input_number.temp`,
				(t) => t.includes(`"entity_id":"input_number.temp","state":"${target}.0"`),
				() => ha.call("input_number", "set_value", { entity_id: "input_number.temp", value: target })
			);
			assert.ok(text.includes("event: state"));
			assert.ok(!text.includes("house_main_power\",\"state"));
			await ha.call("input_number", "set_value", { entity_id: "input_number.temp", value: 21.5 });
		});

		test("nothing in the output leaks the token", async () => {
			for (const p of ["/bridge/health", "/bridge/config", "/bridge/entities", "/bridge/states", "/extension/scratcha.js"]) {
				const text = await (await bridge.get(p)).text();
				assert.ok(!text.includes(ha.token), p);
				assert.ok(!text.includes(ha.url), p);
			}
			assert.ok(!bridge.output.includes(ha.token), "log leaked the token");
		});
	});
}

describe("read-only mode", { skip }, () => {
	let bridge;
	before(async () => {
		bridge = new BridgeProcess({ options: { ...safeOptions, read_only: true, access_token: ha.token, homeassistant_url: ha.url } });
		await bridge.start();
	});
	after(async () => {
		await bridge?.stop();
	});

	test("refuses calls, still reads", async () => {
		const before = await ha.state("input_boolean.lamp");
		const res = await bridge.post("/bridge/services/homeassistant/toggle", { entity_id: "input_boolean.lamp" });
		assert.equal(res.status, 403);
		assert.equal((await res.json()).error, "read_only");
		assert.equal(await ha.state("input_boolean.lamp"), before);
		assert.equal((await bridge.get("/bridge/states/input_boolean.lamp")).status, 200);
	});
});

describe("Home Assistant restart", { skip }, () => {
	let bridge;
	before(async () => {
		bridge = new BridgeProcess({ options: { ...safeOptions }, env: { SUPERVISOR_TOKEN: ha.token, SCRATCHA_CORE_URL: ha.url } });
		await bridge.start();
	});
	after(async () => {
		await bridge?.stop();
	});

	test("the bridge reconnects and keeps working", { timeout: 300000 }, async () => {
		await ha.stop();
		await waitUntil(async () => (await (await bridge.get("/bridge/health")).json()).ha === "reconnecting", 15000, "reconnecting");
		const down = await bridge.get("/bridge/states/input_boolean.lamp");
		assert.equal(down.status, 502);
		assert.equal((await down.json()).error, "ha_unavailable");
		await ha.start();
		try {
			await waitUntil(async () => (await (await bridge.get("/bridge/health")).json()).ha === "connected", 60000, "connected again");
		} catch (error) {
			error.message += `\nBridge output:\n${bridge.output}`;
			throw error;
		}
		await sleep(600);
		const res = await bridge.post("/bridge/services/homeassistant/turn_off", { entity_id: "input_boolean.lamp" });
		assert.equal(res.status, 200);
		await waitUntil(async () => (await ha.state("input_boolean.lamp")) === "off", 5000, "lamp off after restart");
	});
});
