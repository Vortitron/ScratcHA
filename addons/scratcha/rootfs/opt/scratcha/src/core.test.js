import assert from "node:assert/strict";
import { test } from "node:test";
import { CoreClient, resolveCoreTarget } from "./core.js";
import { compileList } from "./glob.js";
import { makeState, startFakeCore, testToken, waitFor } from "./test-helpers.js";

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function clientFor(fake, extra = {}) {
	const allow = compileList(["light.*", "input_boolean.lamp"]);
	return new CoreClient({
		target: { mode: "token", token: testToken, restBase: `${fake.url}/api`, wsUrl: `${fake.url.replace("http", "ws")}/api/websocket` },
		timeoutMs: 500,
		isAllowed: allow,
		logger: quiet,
		backoffMs: [30, 60],
		...extra
	});
}

test("target: token mode, Supervisor mode and the test override", () => {
	assert.deepEqual(resolveCoreTarget({ access_token: "t", homeassistant_url: "http://ha:8123" }, {}), {
		mode: "token", token: "t", restBase: "http://ha:8123/api", wsUrl: "ws://ha:8123/api/websocket"
	});
	assert.deepEqual(resolveCoreTarget({ access_token: "", homeassistant_url: "x" }, { SUPERVISOR_TOKEN: "s" }), {
		mode: "supervisor", token: "s", restBase: "http://supervisor/core/api", wsUrl: "ws://supervisor/core/websocket"
	});
	const local = resolveCoreTarget({ access_token: "" }, { SUPERVISOR_TOKEN: "s", SCRATCHA_CORE_URL: "http://127.0.0.1:8123/" });
	assert.equal(local.restBase, "http://127.0.0.1:8123/api");
	assert.equal(local.wsUrl, "ws://127.0.0.1:8123/api/websocket");
	assert.equal(resolveCoreTarget({ access_token: "" }, {}).token, "");
});

test("not configured without a token, and REST refuses", async () => {
	const core = new CoreClient({ target: { mode: "supervisor", token: "", restBase: "http://x/api", wsUrl: "ws://x" }, timeoutMs: 100, isAllowed: () => true, logger: quiet });
	core.start();
	assert.equal(core.status, "not_configured");
	await assert.rejects(core.getStates(), (e) => e.code === "ha_unavailable");
});

test("mirror: auth, get_states, filtering, state_changed and removal", async () => {
	const fake = await startFakeCore({ states: [makeState("light.a", "off"), makeState("switch.secret", "on"), makeState("input_boolean.lamp", "off")] });
	const core = clientFor(fake);
	const seen = [];
	core.on("state", (s) => seen.push(`${s.entity_id}=${s.state}`));
	try {
		core.start();
		await waitFor(() => core.connected);
		assert.deepEqual([...core.mirror.keys()].sort(), ["input_boolean.lamp", "light.a"]);
		fake.setState("switch.secret", "off");
		fake.setState("light.a", "on");
		await waitFor(() => core.mirror.get("light.a").state === "on");
		assert.ok(!seen.some((s) => s.startsWith("switch.")));
		const entities = [];
		core.on("entities", () => entities.push(1));
		fake.setState("light.b", "on");
		await waitFor(() => core.mirror.has("light.b"));
		assert.equal(entities.length, 1);
		const states = await core.getStates();
		assert.equal(states.length, 3);
		assert.deepEqual(Object.keys(states[0]).sort(), ["attributes", "entity_id", "last_changed", "last_updated", "state"]);
	} finally {
		core.stop();
		await fake.close();
	}
});

test("mirror reconnects after the socket drops and falls back to REST meanwhile", async () => {
	const fake = await startFakeCore({ states: [makeState("light.a", "off")] });
	const core = clientFor(fake);
	try {
		core.start();
		await waitFor(() => core.connected);
		fake.refuseWs = true;
		fake.dropSockets();
		await waitFor(() => core.status === "reconnecting");
		fake.store.set("light.a", makeState("light.a", "on"));
		const viaRest = await core.getState("light.a");
		assert.equal(viaRest.state, "on");
		fake.refuseWs = false;
		await waitFor(() => core.connected, 3000);
		assert.equal(core.mirror.get("light.a").state, "on");
	} finally {
		core.stop();
		await fake.close();
	}
});

test("bad token gives auth_failed", async () => {
	const fake = await startFakeCore();
	const core = clientFor(fake);
	core.target = { ...core.target, token: "wrong" };
	try {
		core.start();
		await waitFor(() => core.status === "auth_failed");
	} finally {
		core.stop();
		await fake.close();
	}
});

test("REST: timeout, 401 and 500 give short messages without the Core body", async () => {
	const fake = await startFakeCore({ states: [makeState("light.a", "off")] });
	const core = clientFor(fake);
	try {
		fake.restDelayMs = 800;
		await assert.rejects(core.rest("GET", "/states"), (e) => e.code === "timeout" && e.status === 504);
		fake.restDelayMs = 0;
		fake.failNext = 500;
		await assert.rejects(core.rest("GET", "/states"), (e) => e.code === "ha_error" && !e.message.includes("secret"));
		core.target = { ...core.target, token: "wrong" };
		await assert.rejects(core.rest("GET", "/states"), (e) => e.code === "ha_error" && /refused/.test(e.message) && !e.message.includes("secret"));
	} finally {
		core.stop();
		await fake.close();
	}
});

test("REST: unreachable Core is ha_unavailable", async () => {
	const core = new CoreClient({ target: { mode: "token", token: "t", restBase: "http://127.0.0.1:9/api", wsUrl: "ws://127.0.0.1:9" }, timeoutMs: 1000, isAllowed: () => true, logger: quiet });
	await assert.rejects(core.rest("GET", "/states"), (e) => e.code === "ha_unavailable");
});

test("REST: a Core that stalls after the headers times out", async () => {
	const http = await import("node:http");
	const server = http.createServer((req, res) => {
		res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "1000" });
		res.write("[");
		// Never send the rest of the body.
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	const core = new CoreClient({ target: { mode: "token", token: "t", restBase: `http://127.0.0.1:${port}/api`, wsUrl: "ws://127.0.0.1:9" }, timeoutMs: 1000, isAllowed: () => true, logger: quiet });
	const started = Date.now();
	try {
		await assert.rejects(core.rest("GET", "/states"), (e) => e.code === "timeout" && e.status === 504);
		assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test("reconnects when Core was down at start (refused, not just closed)", async () => {
	const fake = await startFakeCore({ states: [makeState("light.a", "off")] });
	const port = new URL(fake.url).port;
	await fake.close();
	const core = new CoreClient({
		target: { mode: "token", token: testToken, restBase: `http://127.0.0.1:${port}/api`, wsUrl: `ws://127.0.0.1:${port}/api/websocket` },
		timeoutMs: 500,
		isAllowed: () => true,
		logger: quiet,
		backoffMs: [30, 60]
	});
	try {
		core.start();
		await waitFor(() => core.status === "reconnecting");
		await waitFor(() => core.attempt >= 3, 2000);
	} finally {
		core.stop();
	}
});

test("a half-open socket is dropped by the connect watchdog", async () => {
	const http = await import("node:http");
	const server = http.createServer();
	server.on("upgrade", () => {
		// Never answer the upgrade.
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	const warnings = [];
	const core = new CoreClient({
		target: { mode: "token", token: testToken, restBase: `http://127.0.0.1:${port}/api`, wsUrl: `ws://127.0.0.1:${port}/api/websocket` },
		timeoutMs: 500,
		isAllowed: () => true,
		logger: { ...quiet, warn: (m) => warnings.push(m) },
		backoffMs: [30],
		connectTimeoutMs: 100
	});
	try {
		core.start();
		await waitFor(() => warnings.some((w) => /did not finish connecting/.test(w)), 2000);
		assert.equal(core.status, "reconnecting");
	} finally {
		core.stop();
		server.closeAllConnections();
		server.close();
	}
});

test("heartbeat drops a Core that stops answering pings", async () => {
	const fake = await startFakeCore({ states: [makeState("light.a", "off")] });
	const warnings = [];
	const core = clientFor(fake, { heartbeatMs: 50, logger: { ...quiet, warn: (m) => warnings.push(m) } });
	try {
		core.start();
		await waitFor(() => core.connected);
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(warnings.length, 0, "pings are answered");
		fake.ignorePings = true;
		await waitFor(() => warnings.some((w) => /stopped answering pings/.test(w)), 2000);
		fake.ignorePings = false;
		await waitFor(() => core.connected, 2000);
	} finally {
		core.stop();
		await fake.close();
	}
});
