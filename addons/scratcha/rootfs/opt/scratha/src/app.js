import fs from "node:fs";
import assert from "node:assert/strict";
import express from "express";
import morgan from "morgan";

export function createApp(config, deps = {}) {
	const fetchImpl = deps.fetch ?? fetch;
	const now = deps.now ?? Date.now;
	const logger = deps.logger ?? console;

	const baseUrl = (config.homeassistant_url ?? "").replace(/\/+$/, "");
	const token = (config.access_token ?? "").trim();
	const allowedEntities = new Set(config.allowed_entities ?? []);
	const allowedServices = new Set(config.allowed_services ?? []);
	const allowAllEntities = allowedEntities.size === 0;
	const allowAllServices = allowedServices.size === 0;
	const cacheSeconds = Number(config.cache_seconds ?? 0);
	const corsAllowOrigin = (config.cors_allow_origin ?? "").trim();
	const staticDir = config.static_dir;
	const timeoutMs = Number(config.timeout_ms);
	const protectedServices = new Set(config.protected_services ?? []);
	const pinCode = (config.pin_code ?? "").trim();

	assert(baseUrl, "homeassistant_url is required");
	assert(token, "access_token is required. Create a scoped HA token for ScratcHA.");

	const cache = new Map();

	const app = express();
	app.disable("x-powered-by");
	app.use(express.json({ limit: "256kb" }));
	app.use(morgan("combined"));

	if (corsAllowOrigin) {
		app.use((req, res, next) => {
			res.setHeader("Access-Control-Allow-Origin", corsAllowOrigin === "*" ? "*" : corsAllowOrigin);
			res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
			res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,x-scratcha-pin");
			if (req.method === "OPTIONS") {
				return res.sendStatus(204);
			}
			next();
		});
	}

	if (fs.existsSync(staticDir)) {
		app.use(express.static(staticDir, { fallthrough: true }));
	}

	app.get("/bridge/health", (req, res) => {
		res.json({ status: "ok", timestamp: now() });
	});

	app.get("/bridge/config", (req, res) => {
		res.json({
			base_url: baseUrl,
			allow_all_entities: allowAllEntities,
			allow_all_services: allowAllServices,
			allowed_entities: Array.from(allowedEntities),
			allowed_services: Array.from(allowedServices),
			cache_seconds: cacheSeconds,
			static_dir: fs.existsSync(staticDir) ? staticDir : null,
			timeout_ms: timeoutMs
		});
	});

	app.get("/bridge/states", async (req, res, next) => {
		try {
			const cached = readCache(cache, cacheSeconds, "states", now);
			if (cached) {
				return res.json(cached);
			}
			const states = await fetchStates(baseUrl, token, timeoutMs, fetchImpl);
			const filtered = filterEntities(states, allowAllEntities, allowedEntities);
			writeCache(cache, cacheSeconds, "states", filtered, now);
			res.json(filtered);
		} catch (error) {
			next(error);
		}
	});

	app.get("/bridge/states/:entityId", async (req, res, next) => {
		try {
			const entityId = decodeURIComponent(req.params.entityId);
			assertEntityAllowed(entityId, allowAllEntities, allowedEntities);
			const cached = readCache(cache, cacheSeconds, `state:${entityId}`, now);
			if (cached) {
				return res.json(cached);
			}
			const state = await fetchState(baseUrl, token, timeoutMs, fetchImpl, entityId);
			writeCache(cache, cacheSeconds, `state:${entityId}`, state, now);
			res.json(state);
		} catch (error) {
			next(error);
		}
	});

	app.post("/bridge/services/:domain/:service", async (req, res, next) => {
		try {
			const domain = req.params.domain;
			const service = req.params.service;
			const serviceName = `${domain}.${service}`;
			assertServiceAllowed(serviceName, allowAllServices, allowedServices);
			enforcePin(serviceName, protectedServices, pinCode, req);
			const body = req.body ?? {};
			const response = await haRequest(baseUrl, token, timeoutMs, fetchImpl, `/api/services/${domain}/${service}`, {
				method: "POST",
				body: JSON.stringify(body)
			});
			const payload = await response.json();
			res.json(payload);
		} catch (error) {
			next(error);
		}
	});

	app.use((err, req, res, next) => {
		logger.error("[scratcha] error", err);
		const status = err.status || 500;
		res.status(status).json({
			error: err.message ?? "Unexpected error",
			status
		});
	});

	return app;
}

function filterEntities(states, allowAllEntities, allowedEntities) {
	if (allowAllEntities) {
		return states;
	}
	return states.filter((item) => allowedEntities.has(item.entity_id));
}

function assertEntityAllowed(entityId, allowAllEntities, allowedEntities) {
	if (allowAllEntities) {
		return;
	}
	if (!allowedEntities.has(entityId)) {
		const error = new Error(`Entity ${entityId} is not allowed`);
		error.status = 403;
		throw error;
	}
}

function assertServiceAllowed(serviceName, allowAllServices, allowedServices) {
	if (allowAllServices) {
		return;
	}
	if (!allowedServices.has(serviceName)) {
		const error = new Error(`Service ${serviceName} is not allowed`);
		error.status = 403;
		throw error;
	}
}

function enforcePin(serviceName, protectedServices, pinCode, req) {
	if (!pinCode || protectedServices.size === 0) {
		return;
	}
	if (!protectedServices.has(serviceName)) {
		return;
	}
	const headerPin = (req.headers["x-scratcha-pin"] ?? "").toString();
	if (headerPin !== pinCode) {
		const error = new Error(`Service ${serviceName} requires a valid PIN`);
		error.status = 403;
		throw error;
	}
}

async function fetchStates(baseUrl, token, timeoutMs, fetchImpl) {
	const response = await haRequest(baseUrl, token, timeoutMs, fetchImpl, "/api/states");
	return response.json();
}

async function fetchState(baseUrl, token, timeoutMs, fetchImpl, entityId) {
	const response = await haRequest(
		baseUrl,
		token,
		timeoutMs,
		fetchImpl,
		`/api/states/${encodeURIComponent(entityId)}`
	);
	return response.json();
}

async function haRequest(baseUrl, token, timeoutMs, fetchImpl, pathname, init = {}) {
	const target = new URL(pathname, baseUrl).toString();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const headers = {
		Accept: "application/json",
		"Content-Type": "application/json",
		Authorization: `Bearer ${token}`,
		...(init.headers ?? {})
	};

	try {
		const response = await fetchImpl(target, {
			...init,
			headers,
			signal: controller.signal
		});
		if (!response.ok) {
			const text = await response.text();
			const error = new Error(`HA request failed ${response.status}: ${text}`);
			error.status = response.status;
			throw error;
		}
		return response;
	} catch (error) {
		if (error.name === "AbortError") {
			error.status = 504;
			error.message = `HA request timed out after ${timeoutMs}ms`;
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

function readCache(cache, cacheSeconds, key, now) {
	if (cacheSeconds <= 0) {
		return null;
	}
	const hit = cache.get(key);
	if (!hit) {
		return null;
	}
	if (now() > hit.expiresAt) {
		cache.delete(key);
		return null;
	}
	return hit.value;
}

function writeCache(cache, cacheSeconds, key, value, now) {
	if (cacheSeconds <= 0) {
		return;
	}
	cache.set(key, {
		value,
		expiresAt: now() + cacheSeconds * 1000
	});
}

