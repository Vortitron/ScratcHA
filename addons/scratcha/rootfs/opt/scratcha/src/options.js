import fs from "node:fs";
import { isValidPattern } from "./glob.js";

const defaultOptionsPath = "/data/options.json";

const listKeys = [
	"allowed_entities",
	"denied_entities",
	"allowed_services",
	"allowed_services_without_target",
	"protected_services",
	"protected_entities"
];

const ranges = {
	rate_limit_calls: [1, 100, 10],
	rate_limit_window_s: [1, 600, 10],
	min_interval_ms: [0, 10000, 500],
	timeout_ms: [1000, 60000, 8000]
};

const legacyKeys = ["cache_seconds", "host", "port", "cors_allow_origin"];
const logLevels = ["debug", "info", "warning", "error"];

export const defaults = Object.freeze({
	allowed_entities: [],
	denied_entities: [],
	allowed_services: [],
	allowed_services_without_target: [],
	read_only: false,
	protected_services: [],
	protected_entities: [],
	pin_code: "",
	rate_limit_calls: 10,
	rate_limit_window_s: 10,
	min_interval_ms: 500,
	cors_allow_origins: ["null"],
	allowed_hosts: [],
	projects_dir: "/share/scratcha/projects",
	static_dir: "/share/scratcha/www",
	ssl: false,
	certfile: "fullchain.pem",
	keyfile: "privkey.pem",
	timeout_ms: 8000,
	access_token: "",
	homeassistant_url: "http://homeassistant:8123",
	log_level: "info"
});

// Reads the add-on options. A missing or broken file gives the safe defaults
// (nothing allowed) so the status page can still explain what is wrong.
export function loadOptions(path = process.env.OPTIONS_PATH ?? defaultOptionsPath) {
	let raw = {};
	const warnings = [];
	try {
		const text = fs.readFileSync(path, "utf8");
		raw = text.trim() ? JSON.parse(text) : {};
	} catch (error) {
		warnings.push(`Could not read options from ${path} (${error.code ?? error.message}). Using safe defaults.`);
	}
	const result = normalizeOptions(raw);
	result.warnings.unshift(...warnings);
	return result;
}

export function normalizeOptions(raw = {}) {
	const warnings = [];
	const options = {};
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push("Options must be an object. Using safe defaults.");
		raw = {};
	}

	for (const key of legacyKeys) {
		if (raw[key] !== undefined) {
			warnings.push(`Option "${key}" is no longer used and was ignored.`);
		}
	}

	for (const key of listKeys) {
		options[key] = patternList(raw[key], key, warnings);
	}

	options.read_only = raw.read_only === true;
	options.ssl = raw.ssl === true;
	options.pin_code = raw.pin_code === undefined || raw.pin_code === null ? "" : String(raw.pin_code).trim();

	for (const [key, [min, max, fallback]] of Object.entries(ranges)) {
		options[key] = intInRange(raw[key], min, max, fallback, key, warnings);
	}

	options.cors_allow_origins = stringList(raw.cors_allow_origins, defaults.cors_allow_origins, "cors_allow_origins", warnings);
	options.allowed_hosts = stringList(raw.allowed_hosts, [], "allowed_hosts", warnings).map((h) => h.toLowerCase());

	for (const key of ["projects_dir", "static_dir", "certfile", "keyfile"]) {
		options[key] = typeof raw[key] === "string" && raw[key].trim() ? raw[key].trim() : defaults[key];
	}

	options.access_token = typeof raw.access_token === "string" ? raw.access_token.trim() : "";
	options.homeassistant_url = typeof raw.homeassistant_url === "string" && raw.homeassistant_url.trim()
		? raw.homeassistant_url.trim().replace(/\/+$/, "")
		: defaults.homeassistant_url;
	if (!/^https?:\/\//.test(options.homeassistant_url)) {
		warnings.push("homeassistant_url is not an http(s) URL. Using the default.");
		options.homeassistant_url = defaults.homeassistant_url;
	}

	options.log_level = logLevels.includes(raw.log_level) ? raw.log_level : "info";

	if (options.allowed_entities.length === 0) {
		warnings.push("allowed_entities is empty, so nothing can be read or controlled yet.");
	}
	return { options, warnings };
}

function patternList(value, key, warnings) {
	const list = stringList(value, [], key, warnings);
	const good = [];
	for (const item of list) {
		const pattern = item.toLowerCase();
		if (isValidPattern(pattern)) {
			good.push(pattern);
		} else {
			warnings.push(`Ignored "${item}" in ${key}. Use domain.name, for example light.kitchen or light.*.`);
		}
	}
	return good;
}

function stringList(value, fallback, key, warnings) {
	if (value === undefined || value === null) {
		return [...fallback];
	}
	if (!Array.isArray(value)) {
		warnings.push(`Option "${key}" must be a list. Using the default.`);
		return [...fallback];
	}
	return value.filter((v) => typeof v === "string").map((v) => v.trim()).filter(Boolean);
}

function intInRange(value, min, max, fallback, key, warnings) {
	if (value === undefined || value === null || value === "") {
		return fallback;
	}
	const n = Number(value);
	if (!Number.isInteger(n) || n < min || n > max) {
		warnings.push(`Option "${key}" must be a whole number from ${min} to ${max}. Using ${fallback}.`);
		return fallback;
	}
	return n;
}
