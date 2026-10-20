// Optional: the extension in the real turbowarp.org editor. Needs internet,
// skipped when turbowarp.org cannot be reached.
//
// TurboWarp trusts http://localhost:8000 and loads it unsandboxed. Port 8000
// may be busy on a dev machine, so the bridge runs on a free port and
// Playwright routes localhost:8000 (and :8001 for the sandboxed run) to it.
// The browser still sees the turbowarp.org origin, so CORS is checked for
// real. SSE is aborted in the route because routed responses are buffered,
// which also exercises the polling fallback.
import assert from "node:assert/strict";
import { test, before, after, describe } from "node:test";
import { chromium } from "playwright-core";
import { TestHa, findHass } from "../e2e/start-ha.mjs";
import { BridgeProcess } from "../e2e/bridge-process.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function online() {
	try {
		const res = await fetch("https://turbowarp.org/", { signal: AbortSignal.timeout(8000) });
		return res.ok;
	} catch {
		return false;
	}
}

const hass = findHass();
const skip = process.env.SCRATCHA_SKIP_ONLINE ? "SCRATCHA_SKIP_ONLINE is set"
	: !hass ? "no hass binary"
	: !(await online()) ? "turbowarp.org is not reachable"
	: false;

async function waitUntil(check, timeoutMs, what) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (await check()) {
			return;
		}
		await sleep(200);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

describe("real turbowarp.org editor", { skip }, () => {
	// Unsandboxed first, then sandboxed.
	let ha;
	let bridge;
	let browser;
	const seenOrigins = new Set();

	before(async () => {
		ha = new TestHa({ hass });
		await ha.start();
		bridge = new BridgeProcess({
			options: {
				allowed_entities: ["light.kids_lamp", "input_boolean.lamp"],
				cors_allow_origins: ["null", "https://turbowarp.org"],
				min_interval_ms: 500,
				access_token: ha.token,
				homeassistant_url: ha.url
			}
		});
		await bridge.start();
		browser = await chromium.launch({ headless: true });
	}, { timeout: 300000 });

	after(async () => {
		await browser?.close();
		await bridge?.stop();
		await ha?.cleanup();
	});

	async function newContext() {
		const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
		await context.route(/^http:\/\/localhost:800[01]\//, async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			seenOrigins.add(request.headers().origin ?? "(none)");
			if (url.pathname === "/bridge/events") {
				await route.abort();
				return;
			}
			const response = await route.fetch({
				url: `${bridge.url}${url.pathname}${url.search}`,
				headers: { ...request.headers(), host: url.host }
			});
			await route.fulfill({ response });
		});
		return context;
	}

	async function clickTurnOn(page) {
		await page.locator(".scratchCategoryMenuItem", { hasText: "Home" }).click();
		const block = page.locator(".blocklyFlyout g.blocklyDraggable")
			.filter({ hasText: "turn" })
			// Blockly draws spaces as non-breaking spaces.
			.filter({ hasText: /Kids.lamp/ })
			.first();
		try {
			await block.waitFor({ timeout: 20000 });
		} catch (error) {
			const texts = await page.evaluate(() => [...document.querySelectorAll(".blocklyFlyout g.blocklyDraggable")].map((g) => JSON.stringify(g.textContent)).slice(0, 40));
			if (process.env.SCRATCHA_SHOT) {
				await page.screenshot({ path: process.env.SCRATCHA_SHOT });
			}
			error.message += `\nFlyout blocks:\n${texts.join("\n")}`;
			throw error;
		}
		await block.click({ position: { x: 12, y: 12 } });
	}

	test("loads unsandboxed from localhost:8000 and turns on the lamp", { timeout: 120000 }, async () => {
		await ha.call("input_boolean", "turn_off", { entity_id: "input_boolean.kids_lamp_power" });
		const context = await newContext();
		const page = await context.newPage();
		const logs = [];
		page.on("console", (m) => logs.push(m.text()));
		try {
			await page.goto("https://turbowarp.org/editor?extension=http://localhost:8000/extension/scratcha.js", { timeout: 60000 });
			await page.locator(".scratchCategoryMenuItem", { hasText: "Home" }).waitFor({ timeout: 60000 });
			assert.ok(logs.some((l) => /scratcha\.js unsandboxed/.test(l)), "loaded unsandboxed");
			assert.equal(await page.locator(".ReactModal__Content").count(), 0, "no sandbox prompt");
			await clickTurnOn(page);
			await waitUntil(async () => (await ha.state("light.kids_lamp")) === "on", 15000, "kids lamp on");
			assert.ok(seenOrigins.has("https://turbowarp.org"));
		} finally {
			await context.close();
		}
	});

	test("loads sandboxed from another port, with Origin null CORS", { timeout: 120000 }, async () => {
		await sleep(600);
		await ha.call("input_boolean", "turn_off", { entity_id: "input_boolean.kids_lamp_power" });
		seenOrigins.clear();
		const context = await newContext();
		const page = await context.newPage();
		const logs = [];
		page.on("console", (m) => logs.push(m.text()));
		try {
			// URL parameter extensions from untrusted hosts load sandboxed, with no prompt.
			await page.goto("https://turbowarp.org/editor?extension=http://localhost:8001/extension/scratcha.js", { timeout: 60000 });
			await page.locator(".scratchCategoryMenuItem", { hasText: "Home" }).waitFor({ timeout: 60000 });
			assert.ok(!logs.some((l) => /scratcha\.js unsandboxed/.test(l)), "must not be unsandboxed");
			await clickTurnOn(page);
			await waitUntil(async () => (await ha.state("light.kids_lamp")) === "on", 15000, "kids lamp on (sandboxed)");
			assert.ok(seenOrigins.has("null"), `origins seen: ${[...seenOrigins].join(", ")}`);
		} finally {
			await context.close();
		}
	});
});
