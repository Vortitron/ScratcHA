import http from "node:http";
import { once } from "node:events";
import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { createApp } from "./app.js";

const servers = [];

afterEach(async () => {
	while (servers.length) {
		const server = servers.pop();
		server.close();
	}
});

test("states route filters by allowlist and caches responses", async () => {
	let calls = 0;
	const fetchImpl = async (url, init = {}) => {
		if (!url.endsWith("/api/states")) {
			throw new Error(`Unexpected URL ${url}`);
		}
		calls += 1;
		return jsonResponse([
			{ entity_id: "sensor.allowed", state: "21.0" },
			{ entity_id: "sensor.blocked", state: "999" }
		]);
	};

	const { base } = await startApp({
		homeassistant_url: "http://ha.local:8123",
		access_token: "abc",
		allowed_entities: ["sensor.allowed"],
		allowed_services: [],
		cache_seconds: 2
	}, { fetch: fetchImpl, now: () => Date.now() });

	const first = await (await fetch(`${base}/bridge/states`)).json();
	assert.deepEqual(first.map((x) => x.entity_id), ["sensor.allowed"]);

	const second = await (await fetch(`${base}/bridge/states`)).json();
	assert.deepEqual(second.map((x) => x.entity_id), ["sensor.allowed"]);
	assert.equal(calls, 1, "cache should avoid duplicate HA calls");
});

test("states route denies disallowed entity", async () => {
	const fetchImpl = async () => jsonResponse({ entity_id: "sensor.allowed", state: "1" });

	const { base } = await startApp({
		homeassistant_url: "http://ha.local:8123",
		access_token: "abc",
		allowed_entities: ["sensor.allowed"],
		allowed_services: []
	}, { fetch: fetchImpl });

	const res = await fetch(`${base}/bridge/states/sensor.blocked`);
	assert.equal(res.status, 403);
	const body = await res.json();
	assert.match(body.error, /not allowed/);
});

test("service route enforces allowlist", async () => {
	const fetchImpl = async (url, init = {}) => {
		if (url.endsWith("/api/services/light/turn_on")) {
			return jsonResponse({ ok: true, body: JSON.parse(init.body ?? "{}") });
		}
		throw new Error(`Unexpected URL ${url}`);
	};

	const { base } = await startApp({
		homeassistant_url: "http://ha.local:8123",
		access_token: "abc",
		allowed_entities: [],
		allowed_services: ["light.turn_on"]
	}, { fetch: fetchImpl });

	const allowed = await fetch(`${base}/bridge/services/light/turn_on`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ entity_id: "light.kitchen" })
	});
	assert.equal(allowed.status, 200);
	const allowedBody = await allowed.json();
	assert.equal(allowedBody.body.entity_id, "light.kitchen");

	const blocked = await fetch(`${base}/bridge/services/light/turn_off`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({})
	});
	assert.equal(blocked.status, 403);
});

test("protected service requires PIN header", async () => {
	const fetchImpl = async (url) => jsonResponse({ ok: url });

	const { base } = await startApp({
		homeassistant_url: "http://ha.local:8123",
		access_token: "abc",
		allowed_entities: [],
		allowed_services: ["lock.unlock"],
		protected_services: ["lock.unlock"],
		pin_code: "1234"
	}, { fetch: fetchImpl });

	const denied = await fetch(`${base}/bridge/services/lock/unlock`, { method: "POST" });
	assert.equal(denied.status, 403);

	const allowed = await fetch(`${base}/bridge/services/lock/unlock`, {
		method: "POST",
		headers: { "x-scratha-pin": "1234" }
	});
	assert.equal(allowed.status, 200);
});

test("timeout aborts HA request", async () => {
	const fetchImpl = (url, init = {}) => {
		const signal = init.signal;
		return new Promise((_, reject) => {
			signal.addEventListener("abort", () => {
				const err = new Error("Aborted");
				err.name = "AbortError";
				reject(err);
			});
		});
	};

	const { base } = await startApp({
		homeassistant_url: "http://ha.local:8123",
		access_token: "abc",
		allowed_entities: [],
		allowed_services: [],
		timeout_ms: 10
	}, { fetch: fetchImpl });

	const res = await fetch(`${base}/bridge/states`);
	assert.equal(res.status, 504);
	const body = await res.json();
	assert.match(body.error, /timed out/);
});

function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" }
	});
}

async function startApp(config, deps) {
	const app = createApp({
		...config,
		cache_seconds: config.cache_seconds ?? 0,
		host: "127.0.0.1",
		port: 0,
		static_dir: "/tmp",
		timeout_ms: config.timeout_ms ?? 8000
	}, deps);
	const server = http.createServer(app);
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	return { base: `http://127.0.0.1:${address.port}` };
}

