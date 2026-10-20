import { EventEmitter } from "node:events";
import { bridgeError, BridgeError } from "./errors.js";

const defaultBackoffMs = [1000, 2000, 5000, 10000, 30000];

// Works out how to reach Core. Supervisor mode is the default inside the
// add-on. An access_token switches to token mode.
export function resolveCoreTarget(options, env = process.env) {
	if (options.access_token) {
		return {
			mode: "token",
			token: options.access_token,
			restBase: `${options.homeassistant_url}/api`,
			wsUrl: `${toWs(options.homeassistant_url)}/api/websocket`
		};
	}
	const token = (env.SUPERVISOR_TOKEN ?? "").trim();
	const override = (env.SCRATCHA_CORE_URL ?? "").trim().replace(/\/+$/, "");
	if (override) {
		return { mode: "supervisor", token, restBase: `${override}/api`, wsUrl: `${toWs(override)}/api/websocket` };
	}
	return {
		mode: "supervisor",
		token,
		restBase: "http://supervisor/core/api",
		wsUrl: "ws://supervisor/core/websocket"
	};
}

function toWs(url) {
	return url.replace(/^http/, "ws");
}

export function slimState(state) {
	return {
		entity_id: state.entity_id,
		state: state.state,
		attributes: state.attributes ?? {},
		last_changed: state.last_changed,
		last_updated: state.last_updated
	};
}

// Talks to Core over REST and keeps a mirror of allowed entities using one
// WebSocket. Emits "state" (one slim state, or { entity_id, state: null } when
// removed), "entities" (the allowed entity list changed) and "status".
export class CoreClient extends EventEmitter {
	constructor({ target, timeoutMs, isAllowed, logger, fetchImpl, WebSocketImpl, backoffMs, connectTimeoutMs = 15000, heartbeatMs = 30000 }) {
		super();
		this.target = target;
		this.timeoutMs = timeoutMs;
		this.isAllowed = isAllowed;
		this.logger = logger;
		this.fetch = fetchImpl ?? globalThis.fetch;
		this.WebSocket = WebSocketImpl ?? globalThis.WebSocket;
		this.backoffMs = backoffMs ?? defaultBackoffMs;
		this.mirror = new Map();
		this.status = target.token ? "connecting" : "not_configured";
		this.attempt = 0;
		this.ws = null;
		this.timer = null;
		this.stopped = false;
		this.nextId = 1;
		this.connectTimeoutMs = connectTimeoutMs;
		this.heartbeatMs = heartbeatMs;
		this.heartbeat = null;
	}

	get configured() {
		return Boolean(this.target.token);
	}

	get connected() {
		return this.status === "connected";
	}

	start() {
		if (!this.configured) {
			this.logger.warn("No Supervisor token and no access_token, so Home Assistant is not configured.");
			return;
		}
		this.connect();
	}

	stop() {
		this.stopped = true;
		clearTimeout(this.timer);
		clearInterval(this.heartbeat);
		if (this.ws) {
			try {
				this.ws.close();
			} catch {
				// Already closed.
			}
		}
	}

	setStatus(status) {
		if (this.status !== status) {
			this.status = status;
			this.emit("status", status);
		}
	}

	connect() {
		if (this.stopped) {
			return;
		}
		let ws;
		try {
			ws = new this.WebSocket(this.target.wsUrl);
		} catch (error) {
			this.logger.warn(`WebSocket could not start: ${error.message}`);
			this.scheduleReconnect();
			return;
		}
		this.ws = ws;
		const ids = {};
		let awaitingPong = null;
		// A socket can hang half open, for example while Core shuts down.
		// Give up on it if it does not finish connecting in time.
		const watchdog = setTimeout(() => {
			if (this.ws === ws && this.status !== "connected") {
				this.logger.warn("Home Assistant WebSocket did not finish connecting. Retrying.");
				this.abandon(ws);
			}
		}, this.connectTimeoutMs);
		watchdog.unref?.();
		ws.addEventListener("message", (event) => {
			let msg;
			try {
				msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
			} catch {
				return;
			}
			if (msg.type === "auth_required") {
				ws.send(JSON.stringify({ type: "auth", access_token: this.target.token }));
			} else if (msg.type === "auth_invalid") {
				this.logger.error("Home Assistant refused the bridge login. Check the token.");
				this.setStatus("auth_failed");
				ws.close();
			} else if (msg.type === "auth_ok") {
				ids.states = this.nextId++;
				ids.events = this.nextId++;
				ws.send(JSON.stringify({ id: ids.states, type: "get_states" }));
				ws.send(JSON.stringify({ id: ids.events, type: "subscribe_events", event_type: "state_changed" }));
			} else if (msg.type === "result" && msg.id === ids.states) {
				if (msg.success && Array.isArray(msg.result)) {
					clearTimeout(watchdog);
					this.replaceMirror(msg.result);
					this.attempt = 0;
					this.setStatus("connected");
					clearInterval(this.heartbeat);
					this.heartbeat = setInterval(() => {
						if (awaitingPong !== null) {
							this.logger.warn("Home Assistant stopped answering pings. Reconnecting.");
							this.abandon(ws);
							return;
						}
						awaitingPong = this.nextId++;
						try {
							ws.send(JSON.stringify({ id: awaitingPong, type: "ping" }));
						} catch {
							this.abandon(ws);
						}
					}, this.heartbeatMs);
					this.heartbeat.unref?.();
				}
			} else if (msg.type === "event" && msg.id === ids.events) {
				this.applyChange(msg.event?.data);
			} else if (msg.type === "pong" && msg.id === awaitingPong) {
				awaitingPong = null;
			}
		});
		ws.addEventListener("close", () => {
			clearTimeout(watchdog);
			if (this.ws === ws) {
				this.ws = null;
				clearInterval(this.heartbeat);
				this.scheduleReconnect();
			}
		});
		ws.addEventListener("error", () => {
			// Node 22 fires "error" but no "close" when the connection is
			// refused, so retry from here too. abandon() ignores repeats.
			clearTimeout(watchdog);
			this.abandon(ws);
		});
	}

	abandon(ws) {
		if (this.ws !== ws) {
			return;
		}
		this.ws = null;
		clearInterval(this.heartbeat);
		try {
			ws.close();
		} catch {
			// Ignore.
		}
		this.scheduleReconnect();
	}

	scheduleReconnect() {
		if (this.stopped) {
			return;
		}
		if (this.status !== "auth_failed") {
			this.setStatus("reconnecting");
		}
		const delay = this.backoffMs[Math.min(this.attempt, this.backoffMs.length - 1)];
		this.attempt += 1;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.connect(), delay);
		this.timer.unref?.();
	}

	replaceMirror(states) {
		const before = new Set(this.mirror.keys());
		this.mirror.clear();
		for (const state of states) {
			if (state && this.isAllowed(state.entity_id)) {
				this.mirror.set(state.entity_id, slimState(state));
			}
		}
		for (const state of this.mirror.values()) {
			this.emit("state", state);
		}
		const after = new Set(this.mirror.keys());
		if (before.size !== after.size || [...after].some((id) => !before.has(id))) {
			this.emit("entities");
		}
	}

	applyChange(data) {
		const entityId = data?.entity_id;
		if (!entityId || !this.isAllowed(entityId)) {
			return;
		}
		const isNew = !this.mirror.has(entityId);
		if (!data.new_state) {
			this.mirror.delete(entityId);
			this.emit("state", { entity_id: entityId, state: null });
			this.emit("entities");
			return;
		}
		const state = slimState(data.new_state);
		this.mirror.set(entityId, state);
		this.emit("state", state);
		if (isNew) {
			this.emit("entities");
		}
	}

	async getStates() {
		if (this.connected) {
			return [...this.mirror.values()];
		}
		const states = await this.rest("GET", "/states");
		return Array.isArray(states) ? states.filter((s) => s && this.isAllowed(s.entity_id)).map(slimState) : [];
	}

	async getState(entityId) {
		if (this.connected) {
			const state = this.mirror.get(entityId);
			if (!state) {
				throw bridgeError("not_found", 404, "That entity does not exist.");
			}
			return state;
		}
		return slimState(await this.rest("GET", `/states/${encodeURIComponent(entityId)}`));
	}

	async callService(domain, service, data) {
		const changed = await this.rest("POST", `/services/${domain}/${service}`, data);
		return Array.isArray(changed) ? changed.filter((s) => s && this.isAllowed(s.entity_id)).map(slimState) : [];
	}

	async rest(method, path, body) {
		if (!this.configured) {
			throw bridgeError("ha_unavailable", 503, "Home Assistant is not configured for ScratcHA.");
		}
		// The timer covers the whole exchange, body included. A Core that
		// sends headers and then stalls must not hang the request.
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			return await this.exchange(method, path, body, controller.signal);
		} catch (error) {
			if (controller.signal.aborted && !(error instanceof BridgeError)) {
				throw bridgeError("timeout", 504, `Home Assistant did not answer within ${this.timeoutMs} ms.`);
			}
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	async exchange(method, path, body, signal) {
		let response;
		try {
			response = await this.fetch(`${this.target.restBase}${path}`, {
				method,
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.target.token}`
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal
			});
		} catch (error) {
			if (signal.aborted) {
				throw error;
			}
			this.logger.warn(`Core ${method} ${path} failed: ${error.message}`);
			throw bridgeError("ha_unavailable", 502);
		}
		if (!response.ok) {
			// The Core body may hold details we do not want to pass on. Log it only.
			let text = "";
			try {
				text = (await response.text()).slice(0, 300);
			} catch (error) {
				if (signal.aborted) {
					throw error;
				}
			}
			this.logger.warn(`Core ${method} ${path} returned ${response.status}: ${text}`);
			if (response.status === 404) {
				throw bridgeError("not_found", 404, "Home Assistant does not know that.");
			}
			if (response.status === 401 || response.status === 403) {
				throw bridgeError("ha_error", 502, "Home Assistant refused the bridge login.");
			}
			if (response.status === 400) {
				throw bridgeError("ha_error", 400, "Home Assistant could not do that. Check the service data.");
			}
			throw bridgeError("ha_error", 502);
		}
		let text;
		try {
			text = await response.text();
		} catch (error) {
			if (signal.aborted) {
				throw error;
			}
			throw bridgeError("ha_error", 502, "Home Assistant sent an answer the bridge could not read.");
		}
		try {
			return JSON.parse(text);
		} catch {
			throw bridgeError("ha_error", 502, "Home Assistant sent an answer the bridge could not read.");
		}
	}
}

export { BridgeError };
