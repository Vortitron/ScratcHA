// Bridge errors carry a short code for the extension, an HTTP status and a
// message that is safe to show. Core error bodies never go in here.
export class BridgeError extends Error {
	constructor(code, status, message) {
		super(message);
		this.code = code;
		this.status = status;
	}
}

export const messages = {
	bad_request: "That request did not make sense.",
	not_found: "Not found.",
	not_allowed: "That is not on the allowed list.",
	read_only: "ScratcHA is in read-only mode.",
	pin_required: "That needs a PIN.",
	pin_wrong: "Wrong PIN.",
	pin_locked: "Too many wrong PINs. Try again later.",
	rate_limited: "Too many requests. Slow down a bit.",
	busy: "Too many live connections.",
	ha_unavailable: "Home Assistant cannot be reached.",
	ha_error: "Home Assistant could not do that.",
	timeout: "Home Assistant took too long to answer."
};

export function bridgeError(code, status, message) {
	return new BridgeError(code, status, message ?? messages[code] ?? "Something went wrong.");
}
