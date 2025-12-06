import fs from "node:fs";
import assert from "node:assert/strict";

const defaultOptionsPath = process.env.OPTIONS_PATH ?? "/data/options.json";
const defaultHaUrl = "http://homeassistant:8123";
const defaultStaticDir = "/share/scratha/www";
const defaultHost = "0.0.0.0";
const defaultPort = 8099;
const defaultTimeoutMs = 8000;
const defaultProtectedServices = [];

export function loadOptions(path = defaultOptionsPath) {
	if (!fs.existsSync(path)) {
		throw new Error(`Options file not found at ${path}`);
	}
	const raw = fs.readFileSync(path, "utf8");
	assert(raw.trim().length > 0, "Options file is empty");
	const parsed = JSON.parse(raw);
	return normalizeOptions(parsed);
}

export function normalizeOptions(raw) {
	const homeassistant_url = (raw.homeassistant_url ?? defaultHaUrl).replace(/\/+$/, "");
	const access_token = (raw.access_token ?? "").trim();
	const allowed_entities = Array.isArray(raw.allowed_entities) ? raw.allowed_entities : [];
	const allowed_services = Array.isArray(raw.allowed_services) ? raw.allowed_services : [];
	const cache_seconds = Number(raw.cache_seconds ?? 0);
	const cors_allow_origin = (raw.cors_allow_origin ?? "").trim();
	const host = raw.host ?? defaultHost;
	const port = Number(raw.port ?? defaultPort);
	const static_dir = raw.static_dir ?? defaultStaticDir;
	const timeout_ms = Number(raw.timeout_ms ?? defaultTimeoutMs);
	const protected_services = Array.isArray(raw.protected_services) ? raw.protected_services : defaultProtectedServices;
	const pin_code = raw.pin_code ? String(raw.pin_code) : "";

	return {
		homeassistant_url,
		access_token,
		allowed_entities,
		allowed_services,
		cache_seconds,
		cors_allow_origin,
		host,
		port,
		static_dir,
		timeout_ms,
		protected_services,
		pin_code
	};
}

