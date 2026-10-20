// Browser tests (Playwright Chromium) against the real bridge and a
// throwaway Home Assistant.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, before, after, describe } from "node:test";
import { chromium } from "playwright-core";
import { TestHa, findHass, makeTempDir } from "../e2e/start-ha.mjs";
import { BridgeProcess } from "../e2e/bridge-process.mjs";
import { testSb3 } from "./sb3.mjs";

const hass = findHass();
const skip = hass ? false : "no hass binary (set SCRATCHA_HASS)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const safeOptions = {
	allowed_entities: ["input_boolean.*", "input_number.temp", "light.kids_lamp", "scene.party"],
	denied_entities: ["input_boolean.house_main_power"],
	min_interval_ms: 500
};

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

let ha;
let browser;
let projectsDir;

before(async () => {
	if (skip) {
		return;
	}
	ha = new TestHa({ hass });
	await ha.start();
	browser = await chromium.launch({ headless: true });
	projectsDir = makeTempDir("projects-");
	fs.writeFileSync(path.join(projectsDir, "test.sb3"), await testSb3());
}, { timeout: 300000 });

after(async () => {
	await browser?.close();
	await ha?.cleanup();
	if (projectsDir) {
		fs.rmSync(projectsDir, { recursive: true, force: true });
	}
});

async function resetLamp() {
	await ha.call("input_boolean", "turn_off", { entity_id: "input_boolean.lamp" });
	await waitUntil(async () => (await ha.state("input_boolean.lamp")) === "off", 5000, "lamp off");
	await sleep(600);
}

async function stageVariables(page) {
	return page.evaluate(() => {
		const stage = window.vm.runtime.getTargetForStage();
		const out = {};
		for (const v of Object.values(stage.variables)) {
			out[v.name] = v.value;
		}
		return out;
	});
}

describe("packaged player", { skip }, () => {
	let bridge;

	before(async () => {
		bridge = new BridgeProcess({ options: { ...safeOptions, projects_dir: projectsDir, access_token: ha.token, homeassistant_url: ha.url } });
		await bridge.start();
	});

	after(async () => {
		await bridge?.stop();
	});

	test("lists the project", async () => {
		const page = await browser.newPage();
		try {
			await page.goto(`${bridge.url}/play/`);
			assert.equal(await page.locator("ul.projects a").first().textContent(), "test");
		} finally {
			await page.close();
		}
	});

	test("runs the project: command, reporter and hat all reach Home Assistant", { timeout: 120000 }, async () => {
		await resetLamp();
		const page = await browser.newPage();
		const consoleLines = [];
		page.on("console", (msg) => consoleLines.push(msg.text()));
		try {
			await page.goto(`${bridge.url}/play/test.html`);
			await page.waitForFunction(() => window.vm && window.vm.extensionManager.isExtensionLoaded("scratcha"), null, { timeout: 30000 });
			// Wait for the extension's live connection so the hat sees the change.
			await waitUntil(async () => (await (await fetch(`${bridge.url}/bridge/health`)).json()).ha === "connected", 5000, "bridge");
			await sleep(1000);
			await page.evaluate(() => window.scaffolding.start());
			await waitUntil(async () => (await ha.state("input_boolean.lamp")) === "on", 15000, "lamp on in HA");
			await page.waitForFunction(() => {
				const stage = window.vm.runtime.getTargetForStage();
				const hat = Object.values(stage.variables).find((v) => v.name === "hat");
				return hat && hat.value === "yes";
			}, null, { timeout: 15000 });
			const vars = await stageVariables(page);
			assert.equal(vars.temp, await ha.state("input_number.temp"));
			assert.equal(vars.error, "");
			assert.equal(vars.hat, "yes");
		} catch (error) {
			error.message += `\nBrowser console:\n${consoleLines.join("\n")}`;
			throw error;
		} finally {
			await page.close();
		}
	});
});

describe("status page", { skip }, () => {
	test("warns when the allowlist is empty", async () => {
		const bridge = new BridgeProcess({ options: { access_token: ha.token, homeassistant_url: ha.url } });
		await bridge.start();
		const page = await browser.newPage();
		try {
			await page.goto(`${bridge.url}/status`);
			await page.locator(".notice.bad", { hasText: "The allowed list is empty" }).waitFor({ timeout: 10000 });
			await page.locator("#entities", { hasText: "No allowed entities" }).waitFor();
		} finally {
			await page.close();
			await bridge.stop();
		}
	});

	test("test button toggles the lamp", { timeout: 60000 }, async () => {
		await resetLamp();
		const bridge = new BridgeProcess({ options: { ...safeOptions, access_token: ha.token, homeassistant_url: ha.url } });
		await bridge.start();
		const page = await browser.newPage();
		try {
			await page.goto(`${bridge.url}/status`);
			const row = page.locator("tr[data-entity='input_boolean.lamp']");
			await row.waitFor({ timeout: 10000 });
			assert.equal(await page.locator("tr[data-entity='input_boolean.house_main_power']").count(), 0);
			await row.locator("button[data-service='toggle']").click();
			await waitUntil(async () => (await ha.state("input_boolean.lamp")) === "on", 10000, "lamp toggled on");
			await page.locator("tr[data-entity='input_boolean.lamp'] td:nth-child(2)", { hasText: "on" }).waitFor({ timeout: 10000 });
			await page.locator("#result", { hasText: "Done" }).waitFor();
		} finally {
			await page.close();
			await bridge.stop();
		}
	});
});

describe("landing page", { skip }, () => {
	test("shows the kid buttons and the list of things", async () => {
		const bridge = new BridgeProcess({ options: { ...safeOptions, access_token: ha.token, homeassistant_url: ha.url } });
		await bridge.start();
		const page = await browser.newPage();
		try {
			await page.goto(`${bridge.url}/`);
			await page.getByRole("link", { name: /Play a project/ }).waitFor();
			assert.equal(await page.locator("#make").isHidden(), true, "no editor in this build");
			await page.getByRole("button", { name: /What can I control/ }).click();
			await page.locator("#things-body", { hasText: "input_boolean.lamp" }).waitFor({ timeout: 10000 });
			assert.equal(await page.locator("#things-body", { hasText: "house_main_power" }).count(), 0);
		} finally {
			await page.close();
			await bridge.stop();
		}
	});
});
