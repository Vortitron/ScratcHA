// Renders art/icon.svg and art/logo.svg to the PNG files the add-on store
// uses. Run from test/: node tools/render-art.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const jobs = [
	["art/icon.svg", "addons/scratcha/icon.png", 128, 128],
	["art/logo.svg", "addons/scratcha/logo.png", 250, 100]
];

const browser = await chromium.launch();
try {
	for (const [from, to, width, height] of jobs) {
		const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
		const svg = fs.readFileSync(path.join(root, from), "utf8");
		await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
		await page.locator("svg").screenshot({ path: path.join(root, to), omitBackground: true });
		await page.close();
		console.log(`Wrote ${to}`);
	}
	// Same icon for the bridge pages.
	fs.copyFileSync(path.join(root, "art/icon.svg"), path.join(root, "addons/scratcha/rootfs/opt/scratcha/public/icon.svg"));
} finally {
	await browser.close();
}
