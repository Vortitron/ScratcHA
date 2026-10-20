import assert from "node:assert/strict";
import { test } from "node:test";
import { createPolicy } from "./policy.js";
import { normalizeOptions } from "./options.js";

function policyFor(raw, clock = { t: 1_000_000 }) {
	const { options } = normalizeOptions(raw);
	return { policy: createPolicy(options, { now: () => clock.t }), clock };
}

function codeOf(fn) {
	try {
		fn();
		return "ok";
	} catch (error) {
		return error.code ?? error.message;
	}
}

const base = {
	allowed_entities: ["input_boolean.*", "light.kids_lamp", "scene.party"],
	denied_entities: ["input_boolean.house_main_power"],
	min_interval_ms: 0,
	rate_limit_calls: 100
};

function call(policy, domain, service, body, extra = {}) {
	return codeOf(() => policy.checkServiceCall({ domain, service, body, client: "c1", ...extra }));
}

test("empty allowlist allows nothing", () => {
	const { policy } = policyFor({});
	assert.equal(policy.isEntityAllowed("light.a"), false);
	assert.equal(codeOf(() => policy.assertReadable("light.a")), "not_allowed");
	assert.equal(call(policy, "homeassistant", "turn_on", { entity_id: "light.a" }), "not_allowed");
});

test("deny wins over allow", () => {
	const { policy } = policyFor(base);
	assert.equal(policy.isEntityAllowed("input_boolean.lamp"), true);
	assert.equal(policy.isEntityAllowed("input_boolean.house_main_power"), false);
	assert.equal(call(policy, "homeassistant", "turn_off", { entity_id: "input_boolean.house_main_power" }), "not_allowed");
});

test("block services work for allowed entities, others must be listed", () => {
	const { policy } = policyFor(base);
	assert.equal(call(policy, "homeassistant", "toggle", { entity_id: "input_boolean.lamp" }), "ok");
	assert.equal(call(policy, "light", "turn_on", { entity_id: "light.kids_lamp", brightness_pct: 50 }), "ok");
	assert.equal(call(policy, "input_boolean", "turn_on", { entity_id: "input_boolean.lamp" }), "not_allowed");
	const listed = policyFor({ ...base, allowed_services: ["input_boolean.*"] }).policy;
	assert.equal(call(listed, "input_boolean", "turn_on", { entity_id: "input_boolean.lamp" }), "ok");
	assert.equal(call(listed, "input_boolean", "turn_on", { entity_id: "input_boolean.house_main_power" }), "not_allowed");
});

test("entity_id as string, comma list and array", () => {
	const { policy } = policyFor(base);
	assert.equal(call(policy, "homeassistant", "turn_on", { entity_id: "input_boolean.a, input_boolean.b" }), "ok");
	assert.equal(call(policy, "homeassistant", "turn_on", { entity_id: ["input_boolean.c", "input_boolean.d"] }), "ok");
	assert.equal(call(policy, "homeassistant", "turn_on", { entity_id: ["input_boolean.e", "input_boolean.house_main_power"] }), "not_allowed");
});

test("entities named only in target are refused, because Core REST ignores target", () => {
	const { policy } = policyFor({ ...base, min_interval_ms: 500 });
	assert.equal(call(policy, "homeassistant", "toggle", { target: { entity_id: "input_boolean.f" } }), "bad_request");
	assert.equal(call(policy, "homeassistant", "turn_on", { target: { entity_id: "input_boolean.house_main_power" } }), "bad_request");
	assert.equal(call(policy, "homeassistant", "turn_on", { entity_id: "input_boolean.f", target: { entity_id: "input_boolean.g" } }), "bad_request");
	assert.equal(call(policy, "homeassistant", "turn_on", { entity_id: "input_boolean.h", target: {} }), "ok");
	// The refused call did not use up the per-entity interval.
	assert.equal(call(policy, "homeassistant", "toggle", { entity_id: "input_boolean.f" }), "ok");
});

test("all, area, device, floor and label targets are rejected", () => {
	const { policy } = policyFor({ ...base, allowed_services: ["*"] });
	assert.equal(call(policy, "homeassistant", "turn_off", { entity_id: "all" }), "not_allowed");
	assert.equal(call(policy, "homeassistant", "turn_off", { entity_id: ["input_boolean.a", "all"] }), "not_allowed");
	for (const key of ["area_id", "device_id", "floor_id", "label_id"]) {
		assert.equal(call(policy, "homeassistant", "turn_off", { entity_id: "input_boolean.a", [key]: "x" }), "not_allowed", key);
		assert.equal(call(policy, "homeassistant", "turn_off", { target: { [key]: "x" } }), "not_allowed", `target ${key}`);
	}
});

test("a missing target is rejected unless listed", () => {
	const { policy } = policyFor({ ...base, allowed_services: ["*"] });
	assert.equal(call(policy, "homeassistant", "restart", {}), "not_allowed");
	const notify = policyFor({ ...base, allowed_services_without_target: ["notify.kids_tablet"] }).policy;
	assert.equal(call(notify, "notify", "kids_tablet", { message: "hi" }), "ok");
	assert.equal(call(notify, "notify", "everyone", { message: "hi" }), "not_allowed");
});

test("more than 20 entities is a bad request", () => {
	const { policy } = policyFor(base);
	const ids = Array.from({ length: 21 }, (_, i) => `input_boolean.x${i}`);
	assert.equal(call(policy, "homeassistant", "turn_on", { entity_id: ids }), "bad_request");
	assert.equal(call(policy, "homeassistant", "turn_on", { entity_id: ids.slice(0, 20) }), "ok");
});

test("validation: bad entity IDs, names, body shape and depth", () => {
	const { policy } = policyFor(base);
	assert.equal(call(policy, "homeassistant", "turn_on", { entity_id: "Input_Boolean.A" }), "bad_request");
	assert.equal(call(policy, "homeassistant", "turn_on", { entity_id: "../etc" }), "bad_request");
	assert.equal(call(policy, "homeassistant", "turn_on", { entity_id: 5 }), "bad_request");
	assert.equal(call(policy, "Home", "turn_on", { entity_id: "input_boolean.a" }), "bad_request");
	assert.equal(call(policy, "homeassistant", "turn-on", { entity_id: "input_boolean.a" }), "bad_request");
	assert.equal(call(policy, "homeassistant", "turn_on", ["input_boolean.a"]), "bad_request");
	assert.equal(call(policy, "homeassistant", "turn_on", "x"), "bad_request");
	assert.equal(call(policy, "homeassistant", "turn_on", { entity_id: "input_boolean.a", x: { a: { b: { c: { d: { e: 1 } } } } } }), "bad_request");
	assert.equal(call(policy, "homeassistant", "turn_on", { entity_id: "input_boolean.a", x: { a: { b: { c: { d: 1 } } } } }), "ok");
	assert.equal(call(policy, "homeassistant", "turn_on", { entity_id: "input_boolean.a", target: "x" }), "bad_request");
	assert.equal(codeOf(() => policy.assertReadable("bad id")), "bad_request");
});

test("read-only refuses every call", () => {
	const { policy } = policyFor({ ...base, read_only: true });
	assert.equal(call(policy, "homeassistant", "turn_on", { entity_id: "input_boolean.lamp" }), "read_only");
	assert.equal(codeOf(() => policy.assertReadable("input_boolean.lamp")), "ok");
});

test("PIN: right, wrong, missing", () => {
	const { policy } = policyFor({ ...base, protected_entities: ["scene.*"], pin_code: "4321" });
	assert.equal(call(policy, "scene", "turn_on", { entity_id: "scene.party" }), "pin_required");
	assert.equal(call(policy, "scene", "turn_on", { entity_id: "scene.party" }, { pin: "0000" }), "pin_wrong");
	assert.equal(call(policy, "scene", "turn_on", { entity_id: "scene.party" }, { pin: "4321" }), "ok");
	assert.equal(call(policy, "homeassistant", "turn_on", { entity_id: "input_boolean.lamp" }), "ok");
});

test("PIN on protected services", () => {
	const { policy } = policyFor({ ...base, protected_services: ["homeassistant.turn_off"], pin_code: "4321" });
	assert.equal(call(policy, "homeassistant", "turn_off", { entity_id: "input_boolean.lamp" }), "pin_required");
	assert.equal(call(policy, "homeassistant", "turn_on", { entity_id: "input_boolean.lamp" }), "ok");
});

test("PIN lockout after 5 wrong tries, per client, for 5 minutes", () => {
	const { policy, clock } = policyFor({ ...base, protected_entities: ["scene.party"], pin_code: "4321" });
	const body = { entity_id: "scene.party" };
	for (let i = 0; i < 4; i += 1) {
		assert.equal(call(policy, "scene", "turn_on", body, { pin: "1111" }), "pin_wrong");
	}
	assert.equal(call(policy, "scene", "turn_on", body, { pin: "1111" }), "pin_locked");
	assert.equal(call(policy, "scene", "turn_on", body, { pin: "4321" }), "pin_locked");
	assert.equal(call(policy, "scene", "turn_on", body, { pin: "4321", client: "c2" }), "ok");
	clock.t += 5 * 60 * 1000 + 1;
	assert.equal(call(policy, "scene", "turn_on", body, { pin: "4321" }), "ok");
});

test("protected but no PIN set fails closed", () => {
	const { policy } = policyFor({ ...base, protected_entities: ["scene.party"] });
	assert.equal(call(policy, "scene", "turn_on", { entity_id: "scene.party" }, { pin: "" }), "pin_required");
	assert.equal(policy.summary().pin_missing, true);
});

test("per client token bucket", () => {
	const { policy, clock } = policyFor({ ...base, rate_limit_calls: 10, rate_limit_window_s: 10 });
	const results = [];
	for (let i = 0; i < 7; i += 1) {
		results.push(call(policy, "homeassistant", "turn_on", { entity_id: `input_boolean.n${i}` }));
	}
	assert.deepEqual(results, ["ok", "ok", "ok", "ok", "ok", "rate_limited", "rate_limited"]);
	assert.equal(call(policy, "homeassistant", "turn_on", { entity_id: "input_boolean.z" }, { client: "other" }), "ok");
	clock.t += 1000;
	assert.equal(call(policy, "homeassistant", "turn_on", { entity_id: "input_boolean.y" }), "ok");
	assert.equal(call(policy, "homeassistant", "turn_on", { entity_id: "input_boolean.y2" }), "rate_limited");
});

test("per entity minimum interval across clients", () => {
	const { policy, clock } = policyFor({ ...base, min_interval_ms: 500 });
	const body = { entity_id: "input_boolean.lamp" };
	assert.equal(call(policy, "homeassistant", "toggle", body), "ok");
	assert.equal(call(policy, "homeassistant", "toggle", body, { client: "c2" }), "rate_limited");
	clock.t += 499;
	assert.equal(call(policy, "homeassistant", "toggle", body), "rate_limited");
	clock.t += 1;
	assert.equal(call(policy, "homeassistant", "toggle", body), "ok");
});

test("read limit: 30 per second per client", () => {
	const { policy, clock } = policyFor(base);
	let ok = 0;
	for (let i = 0; i < 40; i += 1) {
		if (codeOf(() => policy.takeRead("r")) === "ok") {
			ok += 1;
		}
	}
	assert.equal(ok, 30);
	clock.t += 1000;
	assert.equal(codeOf(() => policy.takeRead("r")), "ok");
});

test("summary flags empty list and star", () => {
	assert.equal(policyFor({}).policy.summary().allow_list_empty, true);
	assert.equal(policyFor({ allowed_entities: ["*"] }).policy.summary().allow_everything, true);
	const s = policyFor({ ...base, pin_code: "1" }).policy.summary();
	assert.equal(s.pin_enabled, true);
	assert.equal(JSON.stringify(s).includes("\"1\""), false);
});
