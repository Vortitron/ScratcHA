// HTTPS mode with a self-signed certificate. Needs openssl, no Home Assistant.
import assert from "node:assert/strict";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test, before, after, describe } from "node:test";
import { BridgeProcess } from "./bridge-process.mjs";
import { makeTempDir } from "./start-ha.mjs";

let hasOpenssl = true;
try {
	execFileSync("openssl", ["version"], { stdio: "ignore" });
} catch {
	hasOpenssl = false;
}

function get(url, headers = {}) {
	return new Promise((resolve, reject) => {
		const req = https.get(url, { rejectUnauthorized: false, headers }, (res) => {
			let body = "";
			res.on("data", (c) => {
				body += c;
			});
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
		});
		req.on("error", reject);
	});
}

describe("HTTPS mode", { skip: hasOpenssl ? false : "no openssl" }, () => {
	let sslDir;
	let bridge;

	before(async () => {
		sslDir = makeTempDir("ssl-");
		execFileSync("openssl", [
			"req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
			"-subj", "/CN=ha.test.lan",
			"-addext", "subjectAltName=DNS:ha.test.lan,IP:127.0.0.1",
			"-keyout", path.join(sslDir, "privkey.pem"),
			"-out", path.join(sslDir, "fullchain.pem")
		], { stdio: "ignore" });
		bridge = new BridgeProcess({
			options: { ssl: true, allowed_hosts: ["ha.test.lan"], cors_allow_origins: ["null", "https://turbowarp.org"] },
			env: { SCRATCHA_SSL_DIR: sslDir }
		});
		await bridge.startTls();
	});

	after(async () => {
		await bridge?.stop();
		fs.rmSync(sslDir, { recursive: true, force: true });
	});

	test("serves HTTPS and writes an https bridge URL into the extension", async () => {
		const health = JSON.parse((await get(`https://127.0.0.1:${bridge.port}/bridge/health`)).body);
		assert.equal(health.status, "ok");
		const ext = await get(`https://127.0.0.1:${bridge.port}/extension/scratcha.js`, { host: `ha.test.lan:${bridge.port}`, origin: "https://turbowarp.org" });
		assert.equal(ext.status, 200);
		assert.equal(ext.body.split("\n")[0], `(function (Scratch, bridgeSetting = "https://ha.test.lan:${bridge.port}", knownSetting = "__SCRATCHA_KNOWN_ENTITIES__") {`);
		assert.equal(ext.headers["access-control-allow-origin"], "https://turbowarp.org");
		assert.match(bridge.output, /LAN \(HTTPS\)/);
	});
});
