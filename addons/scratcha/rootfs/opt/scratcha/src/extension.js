import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const defaultExtensionPath = path.join(here, "..", "extension", "scratcha.js");
const placeholder = "\"__SCRATCHA_BRIDGE_URL__\"";

export function loadExtensionSource(file = defaultExtensionPath) {
	const source = fs.readFileSync(file, "utf8");
	if (!source.includes(placeholder)) {
		throw new Error(`Extension at ${file} has no bridge URL placeholder`);
	}
	return source;
}

// Writes the bridge URL into the extension. JSON.stringify keeps any odd
// characters inside the string literal, and "<" is escaped so the result is
// also safe inside an inline script.
export function renderExtension(source, bridgeUrl) {
	const literal = JSON.stringify(String(bridgeUrl)).replace(/</g, "\\u003c");
	return source.replace(placeholder, literal);
}

export function hashOf(text) {
	return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}
