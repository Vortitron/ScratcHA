import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import JSZip from "@turbowarp/jszip";
import { createLogger } from "./logger.js";
import { createPolicy } from "./policy.js";
import { CoreClient, resolveCoreTarget } from "./core.js";
import { EventHub } from "./sse.js";
import { BridgeError, bridgeError } from "./errors.js";
import { entityIdShape, maxBodyBytes } from "./validate.js";
import { loadExtensionSource, renderExtension } from "./extension.js";
import { Players, projectNameShape, maxProjectBytes } from "./player.js";
import { bridgeUrlOf, clientIdOf, corsMiddleware, ingressPathOf, isHostAllowed } from "./http.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageInfo = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));
export const version = packageInfo.version;

const publicDir = path.join(here, "..", "public");
const defaultIngressAddresses = ["172.30.32.2"];
const htmlEscapes = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };

// Builds the bridge. Returns an Express app plus handler(listener), which
// tags each request with the listener it arrived on (LAN or ingress).
export function createBridge(options, deps = {}) {
	const env = deps.env ?? process.env;
	const logger = deps.logger ?? createLogger(options.log_level);
	const now = deps.now ?? Date.now;
	const warnings = deps.warnings ?? [];
	const policy = createPolicy(options, { now });
	const target = deps.target ?? resolveCoreTarget(options, env);
	const core = deps.core ?? new CoreClient({
		target,
		timeoutMs: options.timeout_ms,
		isAllowed: policy.isEntityAllowed,
		logger,
		fetchImpl: deps.fetch,
		WebSocketImpl: deps.WebSocket,
		backoffMs: deps.backoffMs
	});
	const hub = new EventHub({ maxStreams: deps.maxStreams ?? 20, pingMs: deps.pingMs ?? 25000 });
	const ingressAddresses = deps.ingressAddresses ?? defaultIngressAddresses;
	const dataDir = deps.dataDir ?? env.SCRATCHA_DATA_DIR ?? "/data";
	const editorDir = deps.editorDir ?? env.SCRATCHA_EDITOR_DIR ?? path.join(here, "..", "editor");
	const extensionSource = deps.extensionSource ?? loadExtensionSource(deps.extensionPath);
	const players = new Players({
		projectsDir: options.projects_dir,
		cacheDir: path.join(dataDir, "cache"),
		extensionSource: () => renderExtension(extensionSource, "relative:../"),
		logger
	});

	const hasEditor = () => fs.existsSync(path.join(editorDir, "editor.html"));

	// The editor is GPL-3.0. Its build records the exact source it came from.
	function editorSource() {
		try {
			const info = JSON.parse(fs.readFileSync(path.join(editorDir, "scratcha-source.json"), "utf8"));
			const safe = (url) => (typeof url === "string" && url.startsWith("https://github.com/") ? url : null);
			return { commit: String(info.commit ?? "").slice(0, 40), source: safe(info.source), patches: safe(info.patches) };
		} catch {
			return null;
		}
	}

	function publicConfig() {
		return {
			version,
			mode: target.mode,
			ha: core.status,
			events: "sse",
			poll_ms: 2000,
			timeout_ms: options.timeout_ms,
			editor: hasEditor(),
			editor_source: hasEditor() ? editorSource() : null,
			ssl: options.ssl,
			cors_allow_origins: options.cors_allow_origins,
			cors_allow_any: options.cors_allow_origins.includes("*"),
			cors_allow_null: options.cors_allow_origins.includes("null"),
			...policy.summary(),
			warnings
		};
	}

	function entityList(states) {
		return states
			.map((s) => ({
				entity_id: s.entity_id,
				name: String(s.attributes?.friendly_name ?? s.entity_id),
				domain: s.entity_id.split(".")[0]
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	core.on("state", (state) => hub.broadcast("state", state));
	core.on("entities", () => hub.broadcast("config", publicConfig()));
	core.on("status", (status) => logger.info(`Home Assistant connection: ${status}`));

	const app = express();
	app.disable("x-powered-by");
	app.set("etag", false);
	app.set("strict routing", true);

	// Listener checks: ingress only from the Supervisor, LAN only for safe Host names.
	app.use((req, res, next) => {
		const meta = req.scratcha ?? { kind: "lan", tls: false };
		req.scratcha = meta;
		if (meta.kind === "ingress") {
			const remote = String(req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
			if (!ingressAddresses.includes(remote)) {
				res.status(403).type("text/plain").send("Ingress port is only for the Supervisor.");
				return;
			}
			meta.ingress = true;
			meta.ingressPath = ingressPathOf(req);
			meta.trusted = Boolean(meta.ingressPath);
		} else if (!isHostAllowed(req.headers.host, options.allowed_hosts)) {
			logger.warn(`Refused request with Host "${String(req.headers.host ?? "").slice(0, 80)}". Add it to allowed_hosts if it is yours.`);
			res.status(421).type("text/plain").send("This host name is not allowed. Add it to allowed_hosts in the ScratcHA options.");
			return;
		}
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Referrer-Policy", "no-referrer");
		next();
	});

	app.use((req, res, next) => {
		const started = now();
		res.on("finish", () => {
			logger.debug(`${req.method} ${req.path} ${res.statusCode} ${now() - started}ms`);
		});
		next();
	});

	const cors = corsMiddleware(options.cors_allow_origins);
	app.use("/bridge", cors);
	app.use("/extension", cors);

	app.get("/bridge/health", (req, res) => {
		res.json({ status: "ok", ha: core.status, mode: target.mode, version });
	});

	app.get("/bridge/config", (req, res) => {
		res.json({ ...publicConfig(), can_upload: Boolean(req.scratcha.trusted) });
	});

	app.get("/bridge/entities", wrap(async (req, res) => {
		policy.takeRead(clientIdOf(req));
		res.json(entityList(await core.getStates()));
	}));

	app.get("/bridge/states", wrap(async (req, res) => {
		policy.takeRead(clientIdOf(req));
		res.json(await core.getStates());
	}));

	app.get("/bridge/states/:entityId", wrap(async (req, res) => {
		policy.takeRead(clientIdOf(req));
		const entityId = req.params.entityId;
		policy.assertReadable(entityId);
		res.json(await core.getState(entityId));
	}));

	const jsonBody = express.json({ limit: maxBodyBytes, strict: true });
	app.post("/bridge/services/:domain/:service", (req, res, next) => {
		if (!req.is("application/json")) {
			next(bridgeError("bad_request", 415, "Send service data as application/json."));
			return;
		}
		next();
	}, jsonBody, wrap(async (req, res) => {
		const client = clientIdOf(req);
		const { domain, service } = req.params;
		const body = req.body ?? {};
		let checked;
		try {
			checked = policy.checkServiceCall({ domain, service, body, client, pin: req.headers["x-scratcha-pin"] });
		} catch (error) {
			logger.info(`Refused ${domain}.${service} from ${client}: ${error.code ?? error.message}`);
			throw error;
		}
		const changed = await core.callService(domain, service, body);
		logger.info(`Called ${checked.name} on ${checked.entities.join(", ") || "(no target)"} for ${client}`);
		res.json({ ok: true, changed });
	}));

	app.get("/bridge/events", wrap(async (req, res) => {
		let filter = null;
		if (typeof req.query.entities === "string" && req.query.entities) {
			filter = new Set(req.query.entities.split(",").map((s) => s.trim()).filter((s) => entityIdShape.test(s)));
		}
		const initial = [["config", publicConfig()], ...[...core.mirror.values()].map((s) => ["state", s])];
		hub.open(req, res, { filter, initial });
	}));

	app.use("/bridge", (req, res, next) => {
		next(bridgeError("not_found", 404));
	});

	app.get("/extension/scratcha.js", wrap(async (req, res) => {
		res.setHeader("Content-Type", "text/javascript; charset=utf-8");
		res.setHeader("Cache-Control", "no-cache");
		if (req.query.download === undefined) {
			res.send(renderExtension(extensionSource, bridgeUrlOf(req)));
			return;
		}
		// A copy to load from a file in turbowarp.org or TurboWarp Desktop.
		// It holds the allowed list, so the menus work there even though the
		// blocks cannot reach home. An ingress path means nothing outside the
		// panel, so that copy falls back to homeassistant.local.
		policy.takeRead(clientIdOf(req));
		let known = null;
		try {
			known = entityList(await core.getStates());
		} catch (error) {
			logger.warn(`Download without the allowed list: ${error.code ?? error.message}`);
		}
		res.setHeader("Content-Disposition", "attachment; filename=\"scratcha.js\"");
		res.send(renderExtension(extensionSource, req.scratcha.ingress ? "" : bridgeUrlOf(req), known));
	}));

	app.get("/", (req, res) => sendPage(res, "index.html"));
	app.get("/status", (req, res) => sendPage(res, "status.html"));
	app.use("/assets", express.static(publicDir, { index: false, maxAge: 0 }));

	app.get("/editor", (req, res) => res.redirect(302, "editor/"));
	app.use("/editor", (req, res, next) => {
		if (!hasEditor()) {
			res.status(404).type("text/plain").send("The editor is not part of this build. Use Play a project instead.");
			return;
		}
		next();
	}, express.static(editorDir, { index: "editor.html", maxAge: 0 }));

	app.get("/play", (req, res) => res.redirect(302, "play/"));
	app.get("/play/", wrap(async (req, res) => {
		const list = await players.list();
		const items = list.map((p) => `<li><a href="${escapeHtml(encodeURIComponent(p.name))}.html">${escapeHtml(p.name)}</a></li>`).join("\n");
		res.type("html").send(playListPage(items));
	}));
	app.get("/play/list.json", wrap(async (req, res) => {
		res.json(await players.list());
	}));
	app.get("/play/:file", wrap(async (req, res) => {
		const file = req.params.file;
		if (!file.endsWith(".html")) {
			throw bridgeError("not_found", 404);
		}
		const html = await players.render(`${file.slice(0, -5)}.sb3`);
		res.setHeader("Cache-Control", "no-cache");
		res.type("html").send(html);
	}));

	app.post("/projects", (req, res, next) => {
		if (!req.scratcha.trusted) {
			next(bridgeError("not_allowed", 403, "Uploads only work from the ScratcHA panel in Home Assistant."));
			return;
		}
		next();
	}, express.raw({ type: "*/*", limit: maxProjectBytes }), wrap(async (req, res) => {
		const name = String(req.query.name ?? "");
		if (!projectNameShape.test(name)) {
			throw bridgeError("bad_request", 400, "Name must be letters, numbers, spaces, - or _, ending in .sb3.");
		}
		if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
			throw bridgeError("bad_request", 400, "The file is empty.");
		}
		try {
			const zip = await JSZip.loadAsync(req.body);
			if (!zip.file("project.json")) {
				throw new Error("no project.json");
			}
		} catch {
			throw bridgeError("bad_request", 400, "That is not a valid .sb3 file.");
		}
		await fsp.mkdir(options.projects_dir, { recursive: true });
		await fsp.writeFile(path.join(options.projects_dir, name), req.body);
		logger.info(`Saved project ${name}`);
		res.json({ ok: true, name });
	}));

	app.use("/www", express.static(options.static_dir, { maxAge: 0 }));

	app.use((req, res) => {
		res.status(404).type("text/plain").send("Not found.");
	});

	// Errors become { error, message }. Core bodies and stack traces stay in the log.
	app.use((err, req, res, next) => {
		let error = err;
		if (!(error instanceof BridgeError)) {
			if (err.type === "entity.too.large") {
				error = bridgeError("bad_request", 413, "That is too big.");
			} else if (err.type === "entity.parse.failed") {
				error = bridgeError("bad_request", 400, "That is not valid JSON.");
			} else {
				logger.error(`Unexpected error on ${req.method} ${req.path}: ${err.stack ?? err.message}`);
				error = bridgeError("ha_error", 500, "Something went wrong in the bridge.");
			}
		}
		if (res.headersSent) {
			res.end();
			return;
		}
		res.status(error.status ?? 500).json({ error: error.code, message: error.message });
	});

	function handler(listener = { kind: "lan", tls: false }) {
		return (req, res) => {
			req.scratcha = { ...listener };
			app(req, res);
		};
	}

	return {
		app,
		handler,
		core,
		hub,
		policy,
		players,
		publicConfig,
		start() {
			core.start();
		},
		close() {
			core.stop();
			hub.close();
		}
	};
}

function wrap(fn) {
	return (req, res, next) => {
		Promise.resolve(fn(req, res, next)).catch(next);
	};
}

function sendPage(res, name) {
	res.setHeader("Cache-Control", "no-cache");
	res.sendFile(path.join(publicDir, name));
}

function escapeHtml(text) {
	return String(text).replace(/[&<>"']/g, (c) => htmlEscapes[c]);
}

function playListPage(items) {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Play a project</title>
<link rel="stylesheet" href="../assets/app.css">
</head>
<body>
<main class="page">
<p><a href="../">Back</a></p>
<h1>Play a project</h1>
${items ? `<ul class="projects">${items}</ul>` : "<p>No projects yet. A grown-up can put .sb3 files in the projects folder.</p>"}
</main>
</body>
</html>
`;
}
