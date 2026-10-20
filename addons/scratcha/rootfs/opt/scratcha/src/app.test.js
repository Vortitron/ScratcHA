import assert from "node:assert/strict";
import http from "node:http";
import { test, before, after } from "node:test";
import { makeState, postJson, startBridge, startFakeCore, testToken, waitFor } from "./test-helpers.js";

const states = [
	makeState("input_boolean.lamp", "off", { friendly_name: "Lamp" }),
	makeState("input_boolean.house_main_power", "on", { friendly_name: "Main power" }),
	makeState("light.kids_lamp", "off", { friendly_name: "Kids lamp", brightness: 0 }),
	makeState("sensor.room_temperature", "21.5", { friendly_name: "Room temperature", unit_of_measurement: "°C" }),
	makeState("scene.party", "unknown", { friendly_name: "Party" }),
	makeState("switch.secret", "on")
];

const safeOptions = {
	allowed_entities: ["input_boolean.*", "light.kids_lamp", "sensor.room_*", "scene.party"],
	denied_entities: ["input_boolean.house_main_power"],
	protected_entities: ["scene.party"],
	pin_code: "2468",
	min_interval_ms: 0,
	rate_limit_calls: 100
};

let fake;
const opened = [];

before(async () => {
	fake = await startFakeCore({ states });
});

after(async () => {
	while (opened.length) {
		await opened.pop().close();
	}
	await fake.close();
});

async function bridgeWith(raw = safeOptions, extra = {}) {
	const b = await startBridge(raw, { core: fake, ...extra });
	opened.push(b);
	return b;
}

function rawGet(base, path, headers = {}) {
	const url = new URL(path, base);
	return new Promise((resolve, reject) => {
		const req = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, headers }, (res) => {
			let body = "";
			res.on("data", (c) => {
				body += c;
			});
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
		});
		req.on("error", reject);
		req.end();
	});
}

// Reads an SSE stream until check(text) is true, then closes it.
async function readEvents(url, check, timeoutMs = 2000) {
	const controller = new AbortController();
	const res = await fetch(url, { signal: controller.signal });
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		while (!check(text)) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			text += decoder.decode(value);
		}
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
	return { res, text };
}

test("health and config never show the token or Core URL", async () => {
	const b = await bridgeWith();
	const health = await (await fetch(`${b.base}/bridge/health`)).json();
	assert.deepEqual(health, { status: "ok", ha: "connected", mode: "token", version: "0.1.0" });
	const configText = await (await fetch(`${b.base}/bridge/config`)).text();
	assert.ok(!configText.includes(testToken));
	assert.ok(!configText.includes(fake.url));
	assert.ok(!configText.includes("2468"));
	const config = JSON.parse(configText);
	assert.equal(config.pin_enabled, true);
	assert.equal(config.read_only, false);
	assert.deepEqual(config.denied_entities, ["input_boolean.house_main_power"]);
});

test("entities and states only list allowed entities", async () => {
	const b = await bridgeWith();
	const entities = await (await fetch(`${b.base}/bridge/entities`)).json();
	assert.deepEqual(entities.map((e) => e.entity_id).sort(), ["input_boolean.lamp", "light.kids_lamp", "scene.party", "sensor.room_temperature"]);
	assert.deepEqual(entities.find((e) => e.entity_id === "input_boolean.lamp"), { entity_id: "input_boolean.lamp", name: "Lamp", domain: "input_boolean" });
	const list = await (await fetch(`${b.base}/bridge/states`)).json();
	assert.equal(list.length, 4);
	const one = await (await fetch(`${b.base}/bridge/states/sensor.room_temperature`)).json();
	assert.equal(one.state, "21.5");
});

test("denied and unknown entities both give 403 not_allowed", async () => {
	const b = await bridgeWith();
	for (const id of ["input_boolean.house_main_power", "switch.secret", "switch.does_not_exist"]) {
		const res = await fetch(`${b.base}/bridge/states/${id}`);
		assert.equal(res.status, 403, id);
		assert.deepEqual(await res.json(), { error: "not_allowed", message: "That is not on the allowed list." });
	}
	const bad = await fetch(`${b.base}/bridge/states/not%20valid`);
	assert.equal(bad.status, 400);
	assert.equal((await bad.json()).error, "bad_request");
});

test("allowed but missing entity is 404", async () => {
	const b = await bridgeWith();
	const res = await fetch(`${b.base}/bridge/states/input_boolean.nope`);
	assert.equal(res.status, 404);
	assert.equal((await res.json()).error, "not_found");
});

test("empty allowlist allows nothing", async () => {
	const b = await bridgeWith({});
	assert.deepEqual(await (await fetch(`${b.base}/bridge/states`)).json(), []);
	assert.deepEqual(await (await fetch(`${b.base}/bridge/entities`)).json(), []);
	const res = await postJson(`${b.base}/bridge/services/homeassistant/turn_on`, { entity_id: "input_boolean.lamp" });
	assert.equal(res.status, 403);
	const config = await (await fetch(`${b.base}/bridge/config`)).json();
	assert.equal(config.allow_list_empty, true);
});

test("service call works and returns only allowed changed states", async () => {
	const b = await bridgeWith();
	fake.calls.length = 0;
	const res = await postJson(`${b.base}/bridge/services/homeassistant/turn_on`, { entity_id: "input_boolean.lamp" });
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.ok, true);
	assert.deepEqual(body.changed.map((s) => [s.entity_id, s.state]), [["input_boolean.lamp", "on"]]);
	assert.deepEqual(fake.calls, [{ domain: "homeassistant", service: "turn_on", data: { entity_id: "input_boolean.lamp" } }]);
	assert.ok(b.lines.some((l) => /Called homeassistant.turn_on on input_boolean.lamp/.test(l)));
});

test("main power stays off limits even with input_boolean.* allowed", async () => {
	const b = await bridgeWith();
	fake.calls.length = 0;
	for (const body of [
		{ entity_id: "input_boolean.house_main_power" },
		{ entity_id: ["input_boolean.lamp", "input_boolean.house_main_power"] },
		{ target: { entity_id: "input_boolean.house_main_power" } },
		{ entity_id: "all" },
		{ area_id: "house" }
	]) {
		const res = await postJson(`${b.base}/bridge/services/homeassistant/turn_off`, body);
		assert.equal(res.status, 403, JSON.stringify(body));
		assert.equal((await res.json()).error, "not_allowed");
	}
	assert.equal(fake.calls.length, 0);
});

test("service calls need JSON, a small body and a plain object", async () => {
	const b = await bridgeWith();
	const plain = await fetch(`${b.base}/bridge/services/homeassistant/turn_on`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{\"entity_id\":\"input_boolean.lamp\"}" });
	assert.equal(plain.status, 415);
	assert.equal((await plain.json()).error, "bad_request");
	const big = await postJson(`${b.base}/bridge/services/homeassistant/turn_on`, { entity_id: "input_boolean.lamp", pad: "x".repeat(9000) });
	assert.equal(big.status, 413);
	const notObject = await postJson(`${b.base}/bridge/services/homeassistant/turn_on`, "[1,2]");
	assert.equal(notObject.status, 400);
	const broken = await postJson(`${b.base}/bridge/services/homeassistant/turn_on`, "{oops");
	assert.equal(broken.status, 400);
	assert.equal((await broken.json()).message, "That is not valid JSON.");
	const badDomain = await postJson(`${b.base}/bridge/services/Bad-Domain/turn_on`, { entity_id: "input_boolean.lamp" });
	assert.equal(badDomain.status, 400);
});

test("PIN header protects the party scene", async () => {
	const b = await bridgeWith();
	const missing = await postJson(`${b.base}/bridge/services/scene/turn_on`, { entity_id: "scene.party" });
	assert.equal(missing.status, 403);
	assert.equal((await missing.json()).error, "pin_required");
	const wrong = await postJson(`${b.base}/bridge/services/scene/turn_on`, { entity_id: "scene.party" }, { "X-ScratcHA-PIN": "1111" });
	assert.equal((await wrong.json()).error, "pin_wrong");
	const right = await postJson(`${b.base}/bridge/services/scene/turn_on`, { entity_id: "scene.party" }, { "X-ScratcHA-PIN": "2468" });
	assert.equal(right.status, 200);
});

test("read-only refuses calls but reads still work", async () => {
	const b = await bridgeWith({ ...safeOptions, read_only: true });
	const res = await postJson(`${b.base}/bridge/services/homeassistant/turn_on`, { entity_id: "input_boolean.lamp" });
	assert.equal(res.status, 403);
	assert.equal((await res.json()).error, "read_only");
	assert.equal((await fetch(`${b.base}/bridge/states/input_boolean.lamp`)).status, 200);
});

test("rate limits give 429 rate_limited", async () => {
	const b = await bridgeWith({ ...safeOptions, min_interval_ms: 500, rate_limit_calls: 100 });
	const first = await postJson(`${b.base}/bridge/services/homeassistant/toggle`, { entity_id: "input_boolean.lamp" });
	assert.equal(first.status, 200);
	const second = await postJson(`${b.base}/bridge/services/homeassistant/toggle`, { entity_id: "input_boolean.lamp" });
	assert.equal(second.status, 429);
	const body = await second.json();
	assert.equal(body.error, "rate_limited");
	assert.equal(typeof body.message, "string");
});

test("Core timeout becomes 504 timeout", async () => {
	const b = await bridgeWith({ ...safeOptions, timeout_ms: 1000 });
	fake.restDelayMs = 1500;
	try {
		const res = await postJson(`${b.base}/bridge/services/homeassistant/turn_on`, { entity_id: "input_boolean.lamp" });
		assert.equal(res.status, 504);
		assert.equal((await res.json()).error, "timeout");
	} finally {
		fake.restDelayMs = 0;
	}
});

test("Core errors do not leak the Core body, and the token is never in output or logs", async () => {
	const b = await bridgeWith();
	fake.failNext = 500;
	const res = await postJson(`${b.base}/bridge/services/homeassistant/turn_on`, { entity_id: "input_boolean.lamp" });
	const text = await res.text();
	assert.equal(res.status, 502);
	assert.ok(!text.includes("secret core detail"));
	const outputs = [text];
	for (const path of ["/bridge/health", "/bridge/config", "/bridge/entities", "/bridge/states", "/extension/scratcha.js", "/", "/status"]) {
		outputs.push(await (await fetch(`${b.base}${path}`)).text());
	}
	for (const out of [...outputs, ...b.lines]) {
		assert.ok(!out.includes(testToken), "token leaked");
		assert.ok(!out.includes("Bearer"), "auth header leaked");
	}
});

test("bridge without any token starts and says not_configured", async () => {
	const b = await startBridge({ access_token: "" }, { core: null, deps: { env: {} } });
	opened.push(b);
	assert.equal((await (await fetch(`${b.base}/bridge/health`)).json()).ha, "not_configured");
	const res = await fetch(`${b.base}/bridge/states`);
	assert.equal(res.status, 503);
	assert.equal((await res.json()).error, "ha_unavailable");
	assert.equal((await fetch(`${b.base}/status`)).status, 200);
});

test("Host check blocks rebinding names on the LAN port", async () => {
	const b = await bridgeWith({ ...safeOptions, allowed_hosts: ["ha.example.lan"] });
	for (const host of ["127.0.0.1:1", "homeassistant.local:8099", "homeassistant", "192.168.1.5", "[::1]:8099", "localhost:8000", "ha.example.lan"]) {
		assert.equal((await rawGet(b.base, "/bridge/health", { host })).status, 200, host);
	}
	for (const host of ["evil.example.com", "homeassistant.local.evil.com", "999.1.1.1", "a b", "[::1]x"]) {
		assert.equal((await rawGet(b.base, "/bridge/health", { host })).status, 421, host);
	}
});

test("CORS: null by default, listed origins reflected, others not", async () => {
	const b = await bridgeWith();
	const nullOrigin = await rawGet(b.base, "/bridge/health", { origin: "null" });
	assert.equal(nullOrigin.headers["access-control-allow-origin"], "null");
	const other = await rawGet(b.base, "/bridge/health", { origin: "https://evil.example.com" });
	assert.equal(other.headers["access-control-allow-origin"], undefined);
	const pre = await fetch(`${b.base}/bridge/services/homeassistant/turn_on`, {
		method: "OPTIONS",
		headers: { Origin: "null", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-scratcha-pin" }
	});
	assert.equal(pre.status, 204);
	assert.match(pre.headers.get("access-control-allow-headers").toLowerCase(), /x-scratcha-pin/);
	assert.equal(pre.headers.get("access-control-allow-credentials"), null);
	const page = await rawGet(b.base, "/status", { origin: "null" });
	assert.equal(page.headers["access-control-allow-origin"], undefined);
});

test("CORS: turbowarp.org when listed, and star when the parent types it", async () => {
	const b = await bridgeWith({ ...safeOptions, cors_allow_origins: ["null", "https://turbowarp.org"] });
	const tw = await rawGet(b.base, "/extension/scratcha.js", { origin: "https://turbowarp.org" });
	assert.equal(tw.headers["access-control-allow-origin"], "https://turbowarp.org");
	const star = await bridgeWith({ ...safeOptions, cors_allow_origins: ["*"] });
	const any = await rawGet(star.base, "/bridge/health", { origin: "https://x.example" });
	assert.equal(any.headers["access-control-allow-origin"], "*");
	assert.equal((await (await fetch(`${star.base}/bridge/config`)).json()).cors_allow_any, true);
});

test("extension URL is written in: plain, ingress and HTTPS", async () => {
	const b = await bridgeWith();
	const plain = await rawGet(b.base, "/extension/scratcha.js", { host: "homeassistant.local:8099" });
	assert.equal(plain.headers["content-type"], "text/javascript; charset=utf-8");
	assert.equal(plain.headers["cache-control"], "no-cache");
	assert.equal(plain.body.split("\n")[0], "(function (Scratch, bridgeSetting = \"http://homeassistant.local:8099\") {");
	const ingress = await rawGet(b.ingressBase, "/extension/scratcha.js", { "x-ingress-path": "/api/hassio_ingress/AbC_123-x" });
	assert.equal(ingress.body.split("\n")[0], "(function (Scratch, bridgeSetting = \"/api/hassio_ingress/AbC_123-x\") {");
	const oddPath = await rawGet(b.ingressBase, "/extension/scratcha.js", { "x-ingress-path": "/api/hassio_ingress/x\"y" });
	assert.equal(oddPath.body.split("\n")[0], "(function (Scratch, bridgeSetting = \"\") {");
	const tls = http.createServer(b.bridge.handler({ kind: "lan", tls: true }));
	await new Promise((r) => tls.listen(0, "127.0.0.1", r));
	try {
		const res = await rawGet(`http://127.0.0.1:${tls.address().port}`, "/extension/scratcha.js", { host: "ha.local.example:8099" });
		assert.equal(res.status, 421);
		const ok = await rawGet(`http://127.0.0.1:${tls.address().port}`, "/extension/scratcha.js", { host: "192.168.1.2:8099" });
		assert.equal(ok.body.split("\n")[0], "(function (Scratch, bridgeSetting = \"https://192.168.1.2:8099\") {");
	} finally {
		tls.closeAllConnections();
		await new Promise((r) => tls.close(r));
	}
});

test("ingress port answers only the Supervisor address and only trusted ingress can upload", async () => {
	const b = await startBridge(safeOptions, { core: fake, deps: { ingressAddresses: ["172.30.32.2"] } });
	opened.push(b);
	assert.equal((await rawGet(b.ingressBase, "/bridge/health")).status, 403);
	const c = await bridgeWith();
	const lanUpload = await fetch(`${c.base}/projects?name=x.sb3`, { method: "POST", body: "x" });
	assert.equal(lanUpload.status, 403);
	const untrusted = await fetch(`${c.ingressBase}/projects?name=x.sb3`, { method: "POST", body: "x" });
	assert.equal(untrusted.status, 403);
	const trustedBad = await fetch(`${c.ingressBase}/projects?name=x.sb3`, { method: "POST", body: "not a zip", headers: { "X-Ingress-Path": "/api/hassio_ingress/abc" } });
	assert.equal(trustedBad.status, 400);
	const badName = await fetch(`${c.ingressBase}/projects?name=../x.sb3`, { method: "POST", body: "x", headers: { "X-Ingress-Path": "/api/hassio_ingress/abc" } });
	assert.equal(badName.status, 400);
});

test("ingress rate limits use the forwarded client address", async () => {
	const b = await bridgeWith({ ...safeOptions, rate_limit_calls: 1, rate_limit_window_s: 600, min_interval_ms: 0 });
	const headers = { "X-Ingress-Path": "/api/hassio_ingress/abc" };
	const a1 = await postJson(`${b.ingressBase}/bridge/services/homeassistant/turn_on`, { entity_id: "input_boolean.lamp" }, { ...headers, "X-Forwarded-For": "10.0.0.5" });
	const a2 = await postJson(`${b.ingressBase}/bridge/services/homeassistant/turn_on`, { entity_id: "input_boolean.lamp" }, { ...headers, "X-Forwarded-For": "10.0.0.5" });
	const other = await postJson(`${b.ingressBase}/bridge/services/homeassistant/turn_on`, { entity_id: "input_boolean.lamp" }, { ...headers, "X-Forwarded-For": "10.0.0.6" });
	assert.deepEqual([a1.status, a2.status, other.status], [200, 429, 200]);
});

test("SSE: headers, config and snapshot, live changes, filter", async () => {
	const b = await bridgeWith();
	const { res, text } = await readEvents(`${b.base}/bridge/events`, (t) => t.includes("sensor.room_temperature"));
	assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
	assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");
	assert.ok(text.startsWith("retry: 3000\n\n"));
	assert.ok(text.includes("event: config\n"));
	assert.ok(!text.includes("house_main_power\",\"state"));
	assert.ok(!text.includes("switch.secret"));

	const filtered = readEvents(`${b.base}/bridge/events?entities=light.kids_lamp`, (t) => t.includes("\"state\":\"on\""));
	await waitFor(() => b.bridge.hub.size >= 1);
	fake.setState("input_boolean.lamp", "on");
	fake.setState("switch.secret", "off");
	fake.setState("light.kids_lamp", "on");
	const live = (await filtered).text;
	assert.ok(live.includes("event: state\ndata: {\"entity_id\":\"light.kids_lamp\",\"state\":\"on\""));
	const stateLines = live.split("\n").filter((l) => l.startsWith("data: {\"entity_id\""));
	assert.ok(stateLines.every((l) => l.includes("light.kids_lamp")));
	fake.setState("light.kids_lamp", "off");
});

test("SSE: ping and the stream limit", async () => {
	const b = await bridgeWith(safeOptions, { deps: { maxStreams: 1, pingMs: 50 } });
	const first = readEvents(`${b.base}/bridge/events`, (t) => t.includes(": ping"));
	await waitFor(() => b.bridge.hub.size === 1);
	const second = await fetch(`${b.base}/bridge/events`);
	assert.equal(second.status, 503);
	assert.equal((await second.json()).error, "busy");
	assert.ok((await first).text.includes(": ping\n\n"));
	await waitFor(() => b.bridge.hub.size === 0);
});

test("pages and fallbacks", async () => {
	const b = await bridgeWith();
	const home = await fetch(`${b.base}/`);
	assert.equal(home.status, 200);
	assert.match(await home.text(), /Make a project/);
	assert.match(await (await fetch(`${b.base}/status`)).text(), /ScratcHA status/);
	assert.equal((await fetch(`${b.base}/assets/app.css`)).status, 200);
	assert.equal((await fetch(`${b.base}/editor/editor.html`)).status, 404);
	assert.match(await (await fetch(`${b.base}/play/`)).text(), /No projects yet/);
	assert.equal((await fetch(`${b.base}/play/..%2Fsecret.html`)).status, 400);
	const unknown = await fetch(`${b.base}/bridge/nope`);
	assert.equal(unknown.status, 404);
	assert.equal((await unknown.json()).error, "not_found");
});

test("editor: served when present, with its GPL source in the config", async () => {
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scratcha-editor-"));
	try {
		fs.writeFileSync(path.join(dir, "editor.html"), "<!doctype html><title>TurboWarp</title>");
		fs.writeFileSync(path.join(dir, "scratcha-source.json"), JSON.stringify({ commit: "abc123", source: "https://github.com/TurboWarp/scratch-gui/tree/abc123", patches: "javascript:alert(1)" }));
		const b = await bridgeWith(safeOptions, { deps: { editorDir: dir } });
		const config = await (await fetch(`${b.base}/bridge/config`)).json();
		assert.equal(config.editor, true);
		assert.deepEqual(config.editor_source, { commit: "abc123", source: "https://github.com/TurboWarp/scratch-gui/tree/abc123", patches: null });
		assert.match(await (await fetch(`${b.base}/editor/editor.html`)).text(), /TurboWarp/);
		assert.match(await (await fetch(`${b.base}/editor/`)).text(), /TurboWarp/);
		const redirect = await fetch(`${b.base}/editor`, { redirect: "manual" });
		assert.equal(redirect.status, 302);
		assert.equal(redirect.headers.get("location"), "editor/");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("player route packages a project from projects_dir", async () => {
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const JSZip = (await import("@turbowarp/jszip")).default;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scratcha-play-"));
	try {
		const zip = new JSZip();
		const project = { targets: [{ isStage: true, name: "Stage", variables: {}, lists: {}, broadcasts: {}, blocks: {}, comments: {}, currentCostume: 0, costumes: [], sounds: [], volume: 100, layerOrder: 0 }], monitors: [], extensions: ["scratcha"], extensionURLs: { scratcha: "http://elsewhere.example/scratcha.js" }, meta: { semver: "3.0.0" } };
		zip.file("project.json", JSON.stringify(project));
		fs.writeFileSync(path.join(dir, "My game.sb3"), await zip.generateAsync({ type: "nodebuffer" }));
		fs.writeFileSync(path.join(dir, "bad name!.sb3"), "x");
		const b = await bridgeWith({ ...safeOptions, projects_dir: dir }, { deps: { dataDir: path.join(dir, "data") } });
		const list = await (await fetch(`${b.base}/play/list.json`)).json();
		assert.deepEqual(list.map((p) => p.file), ["My game.sb3"]);
		const res = await fetch(`${b.base}/play/My%20game.html`);
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.ok(html.includes("data:text/javascript;base64,"));
		assert.ok(!html.includes("elsewhere.example"));
		assert.equal((await fetch(`${b.base}/play/missing.html`)).status, 404);
		assert.ok(fs.readdirSync(path.join(dir, "data", "cache")).length === 1, "cached");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("trusted ingress can upload a project, and config says so", async () => {
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const JSZip = (await import("@turbowarp/jszip")).default;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scratcha-upload-"));
	try {
		const b = await bridgeWith({ ...safeOptions, projects_dir: path.join(dir, "projects") });
		const ingress = { "X-Ingress-Path": "/api/hassio_ingress/abc" };
		assert.equal((await (await fetch(`${b.base}/bridge/config`)).json()).can_upload, false);
		assert.equal((await (await fetch(`${b.ingressBase}/bridge/config`, { headers: ingress })).json()).can_upload, true);
		const zip = new JSZip();
		zip.file("project.json", "{}");
		const res = await fetch(`${b.ingressBase}/projects?name=${encodeURIComponent("My game.sb3")}`, {
			method: "POST",
			headers: { ...ingress, "Content-Type": "application/octet-stream" },
			body: await zip.generateAsync({ type: "nodebuffer" })
		});
		assert.equal(res.status, 200);
		assert.ok(fs.existsSync(path.join(dir, "projects", "My game.sb3")));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
