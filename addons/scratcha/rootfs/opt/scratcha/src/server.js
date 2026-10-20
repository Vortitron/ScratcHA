import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { createBridge, version } from "./app.js";
import { loadOptions } from "./options.js";
import { createLogger } from "./logger.js";

const { options, warnings } = loadOptions();
const logger = createLogger(options.log_level);
for (const warning of warnings) {
	logger.warn(warning);
}

const bridge = createBridge(options, { logger, warnings });
bridge.start();

const bind = process.env.SCRATCHA_BIND ?? "0.0.0.0";
const lanPort = Number(process.env.SCRATCHA_LAN_PORT ?? 8099);
const ingressPort = Number(process.env.SCRATCHA_INGRESS_PORT ?? 8098);
const sslDir = process.env.SCRATCHA_SSL_DIR ?? "/ssl";
const servers = [];

function listen(server, port, label) {
	server.listen(port, bind, () => {
		logger.info(`ScratcHA ${version} ${label} on ${bind}:${port}`);
	});
	server.on("error", (error) => {
		logger.error(`${label} could not listen on ${port}: ${error.message}`);
		process.exitCode = 1;
	});
	servers.push(server);
}

let lan;
if (options.ssl) {
	try {
		const cert = fs.readFileSync(path.resolve(sslDir, options.certfile));
		const key = fs.readFileSync(path.resolve(sslDir, options.keyfile));
		lan = https.createServer({ cert, key }, bridge.handler({ kind: "lan", tls: true }));
	} catch (error) {
		logger.error(`HTTPS mode is on but the certificate could not be read (${error.code ?? error.message}). Serving plain HTTP instead.`);
	}
}
if (!lan) {
	lan = http.createServer(bridge.handler({ kind: "lan", tls: false }));
}
listen(lan, lanPort, options.ssl && lan instanceof https.Server ? "LAN (HTTPS)" : "LAN (HTTP)");

if (ingressPort > 0) {
	listen(http.createServer(bridge.handler({ kind: "ingress", tls: false })), ingressPort, "ingress");
}

function shutdown() {
	logger.info("Stopping");
	bridge.close();
	for (const server of servers) {
		server.close();
		server.closeAllConnections?.();
	}
	setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
