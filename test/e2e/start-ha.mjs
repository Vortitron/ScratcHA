// Starts a throwaway Home Assistant for the end-to-end tests.
// Copies ha-config to a temp dir, runs hass on a free 127.0.0.1 port, does
// onboarding through the API and makes a long-lived token. Never touches any
// other Home Assistant.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const clientId = "http://127.0.0.1/scratcha-e2e/";
// Temp files go in test/.tmp (git ignored) unless SCRATCHA_TEST_TMP is set.
export const tmpRoot = process.env.SCRATCHA_TEST_TMP ?? path.resolve(here, "..", ".tmp");

export function makeTempDir(prefix) {
	fs.mkdirSync(tmpRoot, { recursive: true });
	return fs.mkdtempSync(path.join(tmpRoot, prefix));
}

export function findHass() {
	const candidates = [
		process.env.SCRATCHA_HASS,
		process.env.VIRTUAL_ENV && path.join(process.env.VIRTUAL_ENV, "bin", "hass"),
		path.resolve(here, "..", "..", "..", "sm-venv", "bin", "hass")
	].filter(Boolean);
	return candidates.find((p) => fs.existsSync(p)) ?? null;
}

export function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

async function waitFor(check, timeoutMs, what) {
	const end = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < end) {
		try {
			if (await check()) {
				return;
			}
		} catch (error) {
			lastError = error;
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`Timed out waiting for ${what}${lastError ? `: ${lastError.message}` : ""}`);
}

export class TestHa {
	constructor({ hass = findHass(), keepDir = Boolean(process.env.SCRATCHA_KEEP_TMP) } = {}) {
		if (!hass) {
			throw new Error("No hass binary found. Set SCRATCHA_HASS to a venv's bin/hass.");
		}
		this.hass = hass;
		this.keepDir = keepDir;
		this.dir = makeTempDir("ha-");
		fs.copyFileSync(path.join(here, "ha-config", "configuration.yaml"), path.join(this.dir, "configuration.yaml"));
		this.proc = null;
		this.port = null;
		this.token = null;
	}

	get url() {
		return `http://127.0.0.1:${this.port}`;
	}

	async start() {
		this.port ??= await freePort();
		this.log = fs.openSync(path.join(this.dir, "hass-run.log"), "a");
		this.proc = spawn(this.hass, ["-c", this.dir, "--skip-pip"], {
			env: { ...process.env, SCRATCHA_TEST_HA_PORT: String(this.port) },
			stdio: ["ignore", this.log, this.log]
		});
		this.exited = new Promise((resolve) => this.proc.once("exit", resolve));
		await waitFor(async () => (await fetch(`${this.url}/api/onboarding`)).ok, 180000, "Home Assistant to start");
		if (!this.token) {
			await this.onboard();
		}
		await waitFor(async () => {
			const res = await this.api("GET", "/api/states/light.kids_lamp");
			return res.ok;
		}, 60000, "template entities");
	}

	async stop() {
		if (!this.proc) {
			return;
		}
		this.proc.kill("SIGTERM");
		const timer = setTimeout(() => this.proc?.kill("SIGKILL"), 20000);
		await this.exited;
		clearTimeout(timer);
		this.proc = null;
		fs.closeSync(this.log);
	}

	async restart() {
		await this.stop();
		await this.start();
	}

	async cleanup() {
		await this.stop();
		if (!this.keepDir) {
			fs.rmSync(this.dir, { recursive: true, force: true });
		}
	}

	async onboard() {
		const user = await fetch(`${this.url}/api/onboarding/users`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ client_id: clientId, name: "Test Owner", username: "owner", password: "scratcha-test-password", language: "en" })
		});
		if (!user.ok) {
			throw new Error(`Onboarding user failed: ${user.status} ${await user.text()}`);
		}
		const { auth_code: code } = await user.json();
		const tokenRes = await fetch(`${this.url}/auth/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId })
		});
		if (!tokenRes.ok) {
			throw new Error(`Token exchange failed: ${tokenRes.status}`);
		}
		const shortToken = (await tokenRes.json()).access_token;
		const headers = { "Content-Type": "application/json", Authorization: `Bearer ${shortToken}` };
		// The core_config step is left out on purpose: it adds default
		// integrations (weather, radio, translate) that need the internet.
		for (const [step, body] of [
			["analytics", {}],
			["integration", { client_id: clientId, redirect_uri: `${clientId}callback` }]
		]) {
			const res = await fetch(`${this.url}/api/onboarding/${step}`, { method: "POST", headers, body: JSON.stringify(body) });
			if (!res.ok && res.status !== 403) {
				throw new Error(`Onboarding step ${step} failed: ${res.status}`);
			}
		}
		this.token = await this.longLivedToken(shortToken);
	}

	longLivedToken(shortToken) {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(`ws://127.0.0.1:${this.port}/api/websocket`);
			const timer = setTimeout(() => {
				ws.close();
				reject(new Error("Timed out making a long-lived token"));
			}, 15000);
			ws.addEventListener("message", (event) => {
				const msg = JSON.parse(event.data);
				if (msg.type === "auth_required") {
					ws.send(JSON.stringify({ type: "auth", access_token: shortToken }));
				} else if (msg.type === "auth_ok") {
					ws.send(JSON.stringify({ id: 1, type: "auth/long_lived_access_token", client_name: "ScratcHA e2e", lifespan: 1 }));
				} else if (msg.type === "result" && msg.id === 1) {
					clearTimeout(timer);
					ws.close();
					if (msg.success) {
						resolve(msg.result);
					} else {
						reject(new Error(`Long-lived token failed: ${JSON.stringify(msg.error)}`));
					}
				} else if (msg.type === "auth_invalid") {
					clearTimeout(timer);
					reject(new Error("Short token refused"));
				}
			});
			ws.addEventListener("error", () => {
				clearTimeout(timer);
				reject(new Error("WebSocket error while making a token"));
			});
		});
	}

	api(method, pathname, body) {
		return fetch(`${this.url}${pathname}`, {
			method,
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
	}

	async state(entityId) {
		const res = await this.api("GET", `/api/states/${entityId}`);
		return res.ok ? (await res.json()).state : null;
	}

	async call(domain, service, data) {
		const res = await this.api("POST", `/api/services/${domain}/${service}`, data);
		if (!res.ok) {
			throw new Error(`HA call ${domain}.${service} failed: ${res.status}`);
		}
		return res.json();
	}
}

// Run directly to start one and print its URL and token, for manual poking.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const ha = new TestHa({ keepDir: true });
	await ha.start();
	console.log(JSON.stringify({ url: ha.url, token: ha.token, dir: ha.dir }));
	process.on("SIGINT", async () => {
		await ha.cleanup();
		process.exit(0);
	});
}
