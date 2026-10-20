import crypto from "node:crypto";
import { compileList, hasWildcardAll } from "./glob.js";
import { bridgeError } from "./errors.js";
import { assertEntityId, assertName, assertServiceBody } from "./validate.js";
import { TokenBuckets, MinInterval } from "./ratelimit.js";

// Services the blocks use. They are allowed without listing, but only for
// allowed entities.
export const blockServices = [
	"homeassistant.turn_on",
	"homeassistant.turn_off",
	"homeassistant.toggle",
	"light.turn_on",
	"scene.turn_on",
	"script.turn_on",
	"button.press",
	"input_button.press"
];

const targetKeys = ["area_id", "device_id", "floor_id", "label_id"];
const maxEntities = 20;
const pinMaxFails = 5;
const pinLockMs = 5 * 60 * 1000;

export function createPolicy(options, deps = {}) {
	const now = deps.now ?? Date.now;
	const allowEntity = compileList(options.allowed_entities);
	const denyEntity = compileList(options.denied_entities);
	const allowService = compileList(options.allowed_services);
	const allowNoTarget = compileList(options.allowed_services_without_target);
	const protectService = compileList(options.protected_services);
	const protectEntity = compileList(options.protected_entities);
	const pin = options.pin_code ?? "";

	const burst = Math.max(1, Math.min(5, options.rate_limit_calls));
	const callBuckets = new TokenBuckets({
		capacity: burst,
		refillPerMs: options.rate_limit_calls / (options.rate_limit_window_s * 1000),
		now
	});
	const readBuckets = new TokenBuckets({ capacity: 30, refillPerMs: 30 / 1000, now });
	const entityInterval = new MinInterval({ intervalMs: options.min_interval_ms, now });
	const pinFails = new Map();

	function isEntityAllowed(entityId) {
		return allowEntity(entityId) && !denyEntity(entityId);
	}

	function assertReadable(entityId) {
		assertEntityId(entityId);
		if (!isEntityAllowed(entityId)) {
			throw bridgeError("not_allowed", 403);
		}
	}

	function takeRead(client) {
		if (!readBuckets.take(client)) {
			throw bridgeError("rate_limited", 429);
		}
	}

	// Collects entity IDs from data and target, rejecting broad targets.
	function targetsOf(body) {
		const found = [];
		const scopes = [body];
		if (body.target !== undefined) {
			if (body.target === null || typeof body.target !== "object" || Array.isArray(body.target)) {
				throw bridgeError("bad_request", 400, "target must be an object.");
			}
			scopes.push(body.target);
		}
		for (const scope of scopes) {
			for (const key of targetKeys) {
				if (scope[key] !== undefined) {
					throw bridgeError("not_allowed", 403, `Targets by ${key.replace("_id", "")} are not allowed. Name each entity.`);
				}
			}
			if (scope.entity_id === undefined) {
				continue;
			}
			const ids = Array.isArray(scope.entity_id)
				? scope.entity_id
				: typeof scope.entity_id === "string" ? scope.entity_id.split(",").map((s) => s.trim()) : [scope.entity_id];
			for (const id of ids) {
				if (id === "all" || id === "none") {
					throw bridgeError("not_allowed", 403, "entity_id \"all\" is not allowed. Name each entity.");
				}
				found.push(assertEntityId(id));
			}
		}
		return [...new Set(found)];
	}

	function checkPin(client, given, needed) {
		if (!needed) {
			return;
		}
		if (!pin) {
			throw bridgeError("pin_required", 403, "That needs a PIN, but no PIN is set in the add-on options.");
		}
		let record = pinFails.get(client);
		if (record && record.lockedUntil) {
			if (record.lockedUntil > now()) {
				throw bridgeError("pin_locked", 403);
			}
			pinFails.delete(client);
			record = undefined;
		}
		if (!given) {
			throw bridgeError("pin_required", 403);
		}
		if (!safeEqual(String(given), pin)) {
			const fails = (record?.fails ?? 0) + 1;
			const locked = fails >= pinMaxFails;
			pinFails.set(client, { fails, lockedUntil: locked ? now() + pinLockMs : 0 });
			throw bridgeError(locked ? "pin_locked" : "pin_wrong", 403);
		}
		pinFails.delete(client);
	}

	// Runs every safety rule for one service call. Returns the entities named.
	function checkServiceCall({ domain, service, body, client, pin: givenPin }) {
		assertName(domain, "domain");
		assertName(service, "service");
		const name = `${domain}.${service}`;
		if (options.read_only) {
			throw bridgeError("read_only", 403);
		}
		assertServiceBody(body);
		const entities = targetsOf(body);
		if (entities.length > maxEntities) {
			throw bridgeError("bad_request", 400, `At most ${maxEntities} entities per call.`);
		}
		if (entities.length === 0) {
			if (!allowNoTarget(name)) {
				throw bridgeError("not_allowed", 403, "Name the entity to control.");
			}
		} else {
			if (!allowService(name) && !blockServices.includes(name)) {
				throw bridgeError("not_allowed", 403, `Service ${name} is not on the allowed list.`);
			}
			for (const id of entities) {
				if (!isEntityAllowed(id)) {
					throw bridgeError("not_allowed", 403, `${id} is not on the allowed list.`);
				}
			}
		}
		const needsPin = protectService(name) || entities.some((id) => protectEntity(id));
		checkPin(client, givenPin, needsPin);
		if (!callBuckets.take(client)) {
			throw bridgeError("rate_limited", 429);
		}
		if (!entityInterval.takeAll(entities)) {
			throw bridgeError("rate_limited", 429, "That was changed a moment ago. Wait a little.");
		}
		return { name, entities };
	}

	function summary() {
		return {
			read_only: options.read_only,
			allowed_entities: options.allowed_entities,
			denied_entities: options.denied_entities,
			allowed_services: options.allowed_services,
			allowed_services_without_target: options.allowed_services_without_target,
			block_services: blockServices,
			protected_services: options.protected_services,
			protected_entities: options.protected_entities,
			pin_enabled: Boolean(pin),
			pin_missing: !pin && (!protectService.empty || !protectEntity.empty),
			allow_list_empty: allowEntity.empty,
			allow_everything: hasWildcardAll(options.allowed_entities),
			rate_limits: {
				calls: options.rate_limit_calls,
				window_s: options.rate_limit_window_s,
				burst,
				min_interval_ms: options.min_interval_ms,
				reads_per_s: 30
			}
		};
	}

	return { isEntityAllowed, assertReadable, takeRead, checkServiceCall, summary, isProtectedEntity: protectEntity };
}

function safeEqual(a, b) {
	const ha = crypto.createHash("sha256").update(a).digest();
	const hb = crypto.createHash("sha256").update(b).digest();
	return crypto.timingSafeEqual(ha, hb);
}
