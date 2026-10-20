import { bridgeError } from "./errors.js";

export const entityIdShape = /^[a-z0-9_]+\.[a-z0-9_]+$/;
export const nameShape = /^[a-z0-9_]+$/;
export const maxBodyBytes = 8 * 1024;
export const maxDepth = 5;

export function assertEntityId(value) {
	if (typeof value !== "string" || !entityIdShape.test(value)) {
		throw bridgeError("bad_request", 400, "That is not a valid entity ID.");
	}
	return value;
}

export function assertName(value, what) {
	if (typeof value !== "string" || !nameShape.test(value)) {
		throw bridgeError("bad_request", 400, `That is not a valid ${what} name.`);
	}
	return value;
}

export function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function depthOf(value) {
	if (value === null || typeof value !== "object") {
		return 0;
	}
	let deepest = 0;
	for (const child of Object.values(value)) {
		deepest = Math.max(deepest, depthOf(child));
	}
	return deepest + 1;
}

export function assertServiceBody(body) {
	if (!isPlainObject(body)) {
		throw bridgeError("bad_request", 400, "Service data must be a JSON object.");
	}
	if (depthOf(body) > maxDepth) {
		throw bridgeError("bad_request", 400, "Service data is nested too deeply.");
	}
	return body;
}
