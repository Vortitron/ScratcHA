// Shared helpers for the unit tests: a fake Home Assistant Core (REST and
// WebSocket) and a way to start the bridge on a random local port.
import http from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { createBridge } from "./app.js";
import { normalizeOptions } from "./options.js";

export const testToken = "test-token-SHOULD-NEVER-LEAK-1234567890";

export function makeState(entity_id, state, attributes = {}) {
	const t = new Date().toISOString();
	return { entity_id, state, attributes, last_changed: t, last_updated: t, context: { id: "x" } };
}

export async function startFakeCore({ states = [], token = testToken, restDelayMs = 0 } = {}) {
	const store = new Map(states.map((s) => [s.entity_id, s]));
	const calls = [];
	const sockets = new Set();
	const fake = { store, calls, sockets, restDelayMs, failNext: null, refuseWs: false };

	const server = http.createServer((req, res) => {
		handle(req, res).catch(() => res.destroy());
	});
	async function handle(req, res) {
		if (fake.restDelayMs) {
			await new Promise((r) => setTimeout(r, fake.restDelayMs));
		}
		if (req.headers.authorization !== `Bearer ${token}`) {
			res.writeHead(401, { "Content-Type": "text/plain" });
			res.end("401: Unauthorized secret core detail");
			return;
		}
		if (fake.failNext) {
			const status = fake.failNext;
			fake.failNext = null;
			res.writeHead(status, { "Content-Type": "text/plain" });
			res.end("Internal secret core detail");
			return;
		}
		const url = new URL(req.url, "http://x");
		let body = "";
		for await (const chunk of req) {
			body += chunk;
		}
		const send = (status, value) => {
			res.writeHead(status, { "Content-Type": "application/json" });
			res.end(JSON.stringify(value));
		};
		if (req.method === "GET" && url.pathname === "/api/states") {
			send(200, [...store.values()]);
			return;
		}
		const one = /^\/api\/states\/(.+)$/.exec(url.pathname);
		if (req.method === "GET" && one) {
			const s = store.get(decodeURIComponent(one[1]));
			if (s) {
				send(200, s);
			} else {
				send(404, { message: "Entity not found." });
			}
			return;
		}
		const svc = /^\/api\/services\/([^/]+)\/([^/]+)$/.exec(url.pathname);
		if (req.method === "POST" && svc) {
			const data = body ? JSON.parse(body) : {};
			calls.push({ domain: svc[1], service: svc[2], data });
			const ids = [].concat(data.entity_id ?? []);
			const changed = [];
			for (const id of ids) {
				const current = store.get(id);
				if (!current) {
					continue;
				}
				let next = current.state;
				if (svc[2] === "turn_on") {
					next = "on";
				} else if (svc[2] === "turn_off") {
					next = "off";
				} else if (svc[2] === "toggle") {
					next = current.state === "on" ? "off" : "on";
				}
				changed.push(fake.setState(id, next));
			}
			send(200, changed);
			return;
		}
		send(404, { message: "Not found" });
	}

	const wss = new WebSocketServer({ noServer: true });
	server.on("upgrade", (req, socket, head) => {
		if (fake.refuseWs || req.url !== "/api/websocket") {
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			const client = { ws, subscription: null, authed: false };
			sockets.add(client);
			ws.on("close", () => sockets.delete(client));
			ws.send(JSON.stringify({ type: "auth_required", ha_version: "2026.2.3" }));
			ws.on("message", (raw) => {
				const msg = JSON.parse(raw.toString());
				if (msg.type === "auth") {
					if (msg.access_token === token) {
						client.authed = true;
						ws.send(JSON.stringify({ type: "auth_ok", ha_version: "2026.2.3" }));
					} else {
						ws.send(JSON.stringify({ type: "auth_invalid", message: "Invalid access token" }));
						ws.close();
					}
				} else if (msg.type === "get_states") {
					ws.send(JSON.stringify({ id: msg.id, type: "result", success: true, result: [...store.values()] }));
				} else if (msg.type === "subscribe_events") {
					client.subscription = msg.id;
					ws.send(JSON.stringify({ id: msg.id, type: "result", success: true, result: null }));
				}
			});
		});
	});

	fake.setState = (entity_id, state, attributes) => {
		const old = store.get(entity_id) ?? null;
		const next = makeState(entity_id, state, attributes ?? old?.attributes ?? {});
		store.set(entity_id, next);
		for (const client of sockets) {
			if (client.subscription !== null) {
				client.ws.send(JSON.stringify({
					id: client.subscription,
					type: "event",
					event: { event_type: "state_changed", data: { entity_id, old_state: old, new_state: next } }
				}));
			}
		}
		return next;
	};
	fake.dropSockets = () => {
		for (const client of sockets) {
			client.ws.terminate();
		}
	};

	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	fake.url = `http://127.0.0.1:${server.address().port}`;
	fake.close = async () => {
		fake.dropSockets();
		wss.close();
		server.closeAllConnections();
		await new Promise((r) => server.close(r));
	};
	return fake;
}

// Starts a bridge against a fake core. Returns base URLs for the LAN and the
// ingress listener, the captured log lines and a close function.
export async function startBridge(rawOptions, { core, deps = {}, waitConnected = true } = {}) {
	const { options } = normalizeOptions({ access_token: testToken, homeassistant_url: core?.url ?? "http://127.0.0.1:9", ...rawOptions });
	const lines = [];
	const logger = {};
	for (const level of ["debug", "info", "warn", "error"]) {
		logger[level] = (...args) => lines.push(`${level}: ${args.map(String).join(" ")}`);
	}
	const bridge = createBridge(options, {
		logger,
		dataDir: deps.dataDir ?? "/nonexistent-scratcha-data",
		editorDir: deps.editorDir ?? "/nonexistent-scratcha-editor",
		ingressAddresses: ["127.0.0.1"],
		backoffMs: [50, 100],
		...deps
	});
	const lan = http.createServer(bridge.handler({ kind: "lan", tls: false }));
	const ingress = http.createServer(bridge.handler({ kind: "ingress", tls: false }));
	lan.listen(0, "127.0.0.1");
	ingress.listen(0, "127.0.0.1");
	await Promise.all([once(lan, "listening"), once(ingress, "listening")]);
	bridge.start();
	if (core && waitConnected) {
		await waitFor(() => bridge.core.connected, 3000);
	}
	return {
		bridge,
		lines,
		base: `http://127.0.0.1:${lan.address().port}`,
		ingressBase: `http://127.0.0.1:${ingress.address().port}`,
		async close() {
			bridge.close();
			for (const server of [lan, ingress]) {
				server.closeAllConnections();
				await new Promise((r) => server.close(r));
			}
		}
	};
}

export async function waitFor(check, timeoutMs = 2000, stepMs = 10) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (await check()) {
			return true;
		}
		await new Promise((r) => setTimeout(r, stepMs));
	}
	throw new Error("waitFor timed out");
}

export function postJson(url, body, headers = {}) {
	return fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body)
	});
}
