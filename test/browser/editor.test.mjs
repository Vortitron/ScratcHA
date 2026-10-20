// Editor test. Runs only when a built editor exists: set SCRATCHA_EDITOR_DIR
// to an unpacked turbowarp-editor-<sha>.tar.gz from the Editor build workflow.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, before, after, describe } from "node:test";
import { chromium } from "playwright-core";
import { TestHa, findHass } from "../e2e/start-ha.mjs";
import { BridgeProcess } from "../e2e/bridge-process.mjs";
import { testSb3 } from "./sb3.mjs";

const editorDir = process.env.SCRATCHA_EDITOR_DIR;
const hass = findHass();
const skip = !editorDir || !fs.existsSync(path.join(editorDir, "editor.html")) ? "no editor build (set SCRATCHA_EDITOR_DIR)"
	: !hass ? "no hass binary"
	: false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(check, timeoutMs, what) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (await check()) {
			return;
		}
		await sleep(100);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

describe("self-hosted editor", { skip }, () => {
	let ha;
	let bridge;
	let browser;

	before(async () => {
		ha = new TestHa({ hass });
		await ha.start();
		bridge = new BridgeProcess({
			options: { allowed_entities: ["input_boolean.*", "input_number.temp"], denied_entities: ["input_boolean.house_main_power"], access_token: ha.token, homeassistant_url: ha.url },
			env: { SCRATCHA_EDITOR_DIR: path.resolve(editorDir) }
		});
		await bridge.start();
		browser = await chromium.launch();
	}, { timeout: 300000 });

	after(async () => {
		await browser?.close();
		await bridge?.stop();
		await ha?.cleanup();
	});

	test("loads the blocks with no sandbox prompt and runs a saved project", { timeout: 180000 }, async () => {
		await ha.call("input_boolean", "turn_off", { entity_id: "input_boolean.lamp" });
		await sleep(600);
		const page = await browser.newPage();
		const logs = [];
		page.on("console", (m) => logs.push(m.text()));
		try {
			await page.goto(`${bridge.url}/`);
			const make = page.getByRole("link", { name: /Make a project/ });
			await make.waitFor({ timeout: 10000 });
			await make.click();
			await page.locator(".scratchCategoryMenuItem", { hasText: "Home" }).waitFor({ timeout: 90000 });
			assert.equal(await page.locator(".ReactModal__Content").count(), 0, "no sandbox prompt");
			assert.ok(logs.some((l) => /scratcha\.js unsandboxed/.test(l)), "loaded unsandboxed");
			// The project points at a different scratcha.js URL. TurboWarp must
			// keep the one already loaded instead of loading that one.
			const sb3 = (await testSb3()).toString("base64");
			await page.evaluate(async (data) => {
				const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
				await window.vm.loadProject(bytes.buffer);
			}, sb3);
			assert.equal(await page.locator(".ReactModal__Content").count(), 0, "no prompt for the project's extension URL");
			await sleep(1000);
			await page.evaluate(() => window.vm.greenFlag());
			await waitUntil(async () => (await ha.state("input_boolean.lamp")) === "on", 15000, "lamp on");
			await page.waitForFunction(() => {
				const v = Object.values(window.vm.runtime.getTargetForStage().variables);
				return v.find((x) => x.name === "hat")?.value === "yes" && v.find((x) => x.name === "temp")?.value !== "";
			}, null, { timeout: 15000 });
		} finally {
			await page.close();
		}
	});
});
