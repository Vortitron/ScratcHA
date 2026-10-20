import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaults, loadOptions, normalizeOptions } from "./options.js";

test("defaults are safe: nothing allowed, no other web sites", () => {
	const { options, warnings } = normalizeOptions({});
	assert.deepEqual(options.allowed_entities, []);
	assert.deepEqual(options.allowed_services, []);
	assert.deepEqual(options.cors_allow_origins, []);
	assert.ok(!warnings.some((w) => /"null"/.test(w)));
	const optIn = normalizeOptions({ cors_allow_origins: ["null"] });
	assert.deepEqual(optIn.options.cors_allow_origins, ["null"]);
	assert.ok(optIn.warnings.some((w) => /contains "null"/.test(w)));
	assert.equal(options.read_only, false);
	assert.equal(options.rate_limit_calls, 10);
	assert.equal(options.min_interval_ms, 500);
	assert.equal(options.timeout_ms, defaults.timeout_ms);
	assert.ok(warnings.some((w) => /nothing can be read/.test(w)));
});

test("old keys are ignored with a warning", () => {
	const { options, warnings } = normalizeOptions({ cache_seconds: 5, host: "0.0.0.0", port: 1, cors_allow_origin: "*", allowed_entities: ["light.a"] });
	assert.equal(options.cache_seconds, undefined);
	assert.equal(options.port, undefined);
	for (const key of ["cache_seconds", "host", "port", "cors_allow_origin"]) {
		assert.ok(warnings.some((w) => w.includes(`"${key}"`)), key);
	}
});

test("bad patterns are dropped, good ones lower-cased", () => {
	const { options, warnings } = normalizeOptions({ allowed_entities: ["Light.Kitchen", "light.*", "bad pattern", "nodot", 7] });
	assert.deepEqual(options.allowed_entities, ["light.kitchen", "light.*"]);
	assert.equal(warnings.filter((w) => /Ignored/.test(w)).length, 2);
});

test("numbers out of range fall back with a warning", () => {
	const { options, warnings } = normalizeOptions({ rate_limit_calls: 0, timeout_ms: 999999, min_interval_ms: 250 });
	assert.equal(options.rate_limit_calls, 10);
	assert.equal(options.timeout_ms, 8000);
	assert.equal(options.min_interval_ms, 250);
	assert.equal(warnings.filter((w) => /whole number/.test(w)).length, 2);
});

test("lists must be lists, booleans must be true", () => {
	const { options, warnings } = normalizeOptions({ allowed_entities: "light.a", read_only: "yes", ssl: 1 });
	assert.deepEqual(options.allowed_entities, []);
	assert.equal(options.read_only, false);
	assert.equal(options.ssl, false);
	assert.ok(warnings.some((w) => /must be a list/.test(w)));
});

test("loadOptions survives a missing or broken file", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scratcha-opt-"));
	try {
		const missing = loadOptions(path.join(dir, "nope.json"));
		assert.deepEqual(missing.options.allowed_entities, []);
		assert.ok(missing.warnings[0].includes("Could not read options"));
		const broken = path.join(dir, "broken.json");
		fs.writeFileSync(broken, "{not json");
		assert.ok(loadOptions(broken).warnings[0].includes("Could not read options"));
		const good = path.join(dir, "good.json");
		fs.writeFileSync(good, JSON.stringify({ allowed_entities: ["light.a"], pin_code: 1234 }));
		const loaded = loadOptions(good);
		assert.deepEqual(loaded.options.allowed_entities, ["light.a"]);
		assert.equal(loaded.options.pin_code, "1234");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("homeassistant_url must be http(s) and loses its trailing slash", () => {
	assert.equal(normalizeOptions({ homeassistant_url: "http://ha:8123/" }).options.homeassistant_url, "http://ha:8123");
	assert.equal(normalizeOptions({ homeassistant_url: "file:///etc" }).options.homeassistant_url, "http://homeassistant:8123");
});
