// Request checks shared by both listeners: Host check, CORS, client identity
// and the bridge URL that gets written into the extension.

const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const builtInHosts = ["homeassistant", "homeassistant.local", "localhost"];
const ingressPathShape = /^\/api\/hassio_ingress\/[A-Za-z0-9_-]+$/;

export function hostnameOf(hostHeader) {
	if (typeof hostHeader !== "string" || !hostHeader || hostHeader.length > 255) {
		return null;
	}
	const host = hostHeader.trim().toLowerCase();
	if (host.startsWith("[")) {
		const end = host.indexOf("]");
		if (end < 0) {
			return null;
		}
		const rest = host.slice(end + 1);
		if (rest && !/^:\d{1,5}$/.test(rest)) {
			return null;
		}
		return host.slice(0, end + 1);
	}
	const m = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(host);
	return m ? m[1] : null;
}

// The LAN port only answers to names that cannot be rebound by an outside
// web page: IP literals, the usual Home Assistant names and allowed_hosts.
export function isHostAllowed(hostHeader, allowedHosts = []) {
	const name = hostnameOf(hostHeader);
	if (!name) {
		return false;
	}
	if (name.startsWith("[")) {
		return /^\[[0-9a-f:.]+\]$/.test(name);
	}
	const m = ipv4.exec(name);
	if (m) {
		return m.slice(1).every((part) => Number(part) <= 255);
	}
	return builtInHosts.includes(name) || allowedHosts.includes(name);
}

export function ingressPathOf(req) {
	const value = req.headers["x-ingress-path"];
	return typeof value === "string" && ingressPathShape.test(value) ? value : null;
}

// Who is asking, for rate limits and PIN lockout. Behind ingress every
// request comes from the Supervisor, so use the forwarded address instead.
// Core keeps whatever X-Forwarded-For the browser sent and adds the address
// it saw. The Supervisor then adds Core's address. So only the second to
// last entry can be trusted. The first is whatever the browser made up.
export function clientIdOf(req) {
	if (req.scratcha?.ingress) {
		const chain = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
		return chain.length >= 2 ? `ingress:${chain[chain.length - 2]}` : "ingress";
	}
	return String(req.socket?.remoteAddress ?? "unknown");
}

// The base URL the browser should use to reach the bridge.
export function bridgeUrlOf(req) {
	if (req.scratcha?.ingress) {
		return req.scratcha.ingressPath ?? "";
	}
	const proto = req.scratcha?.tls ? "https" : "http";
	return `${proto}://${req.headers.host}`;
}

export function corsMiddleware(allowedOrigins) {
	const allowAny = allowedOrigins.includes("*");
	return (req, res, next) => {
		const origin = req.headers.origin;
		if (origin !== undefined && (allowAny || allowedOrigins.includes(origin))) {
			res.setHeader("Access-Control-Allow-Origin", allowAny ? "*" : origin);
			res.setHeader("Vary", "Origin");
			res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
			res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-ScratcHA-PIN");
			res.setHeader("Access-Control-Max-Age", "600");
		}
		if (req.method === "OPTIONS") {
			res.status(204).end();
			return;
		}
		next();
	};
}
