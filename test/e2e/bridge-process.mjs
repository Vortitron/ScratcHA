// Runs the real bridge (src/server.js) as a child process for tests.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freePort, makeTempDir } from "./start-ha.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const bridgeDir = path.resolve(here, "..", "..", "addons", "scratcha", "rootfs", "opt", "scratcha");

export class BridgeProcess {
	constructor({ options, env = {}, port }) {
		this.options = options;
		this.env = env;
		this.port = port;
		this.dir = makeTempDir("bridge-");
		this.output = "";
	}

	get url() {
		return `http://127.0.0.1:${this.port}`;
	}

	async start({ waitFor = "connected" } = {}) {
		this.port ??= await freePort();
		const optionsPath = path.join(this.dir, "options.json");
		fs.writeFileSync(optionsPath, JSON.stringify(this.options));
		this.proc = spawn(process.execPath, ["src/server.js"], {
			cwd: bridgeDir,
			env: {
				PATH: process.env.PATH,
				OPTIONS_PATH: optionsPath,
				SCRATCHA_LAN_PORT: String(this.port),
				SCRATCHA_INGRESS_PORT: "0",
				SCRATCHA_BIND: "127.0.0.1",
				SCRATCHA_DATA_DIR: path.join(this.dir, "data"),
				...this.env
			},
			stdio: ["ignore", "pipe", "pipe"]
		});
		this.proc.stdout.on("data", (d) => {
			this.output += d;
		});
		this.proc.stderr.on("data", (d) => {
			this.output += d;
		});
		this.exited = new Promise((resolve) => this.proc.once("exit", resolve));
		const end = Date.now() + 30000;
		while (Date.now() < end) {
			try {
				const health = await (await fetch(`${this.url}/bridge/health`)).json();
				if (!waitFor || health.ha === waitFor) {
					return health;
				}
			} catch {
				// Not up yet.
			}
			await new Promise((r) => setTimeout(r, 100));
		}
		throw new Error(`Bridge did not reach ${waitFor}. Output:\n${this.output}`);
	}

	async stop() {
		if (!this.proc) {
			return;
		}
		this.proc.kill("SIGTERM");
		await this.exited;
		this.proc = null;
		fs.rmSync(this.dir, { recursive: true, force: true });
	}

	get(pathname, headers = {}) {
		return fetch(`${this.url}${pathname}`, { headers });
	}

	post(pathname, body, headers = {}) {
		return fetch(`${this.url}${pathname}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify(body)
		});
	}
}
