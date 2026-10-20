import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const defaultExtensionPath = path.join(here, "..", "extension", "scratcha.js");
const placeholder = "\"__SCRATCHA_BRIDGE_URL__\"";
const knownPlaceholder = "\"__SCRATCHA_KNOWN_ENTITIES__\"";

export function loadExtensionSource(file = defaultExtensionPath) {
	const source = fs.readFileSync(file, "utf8");
	if (!source.includes(placeholder)) {
		throw new Error(`Extension at ${file} has no bridge URL placeholder`);
	}
	return source;
}

// Writes the bridge URL into the extension. JSON.stringify keeps any odd
// characters inside the string literal, and "<" is escaped so the result is
// also safe inside an inline script. A list of { entity_id, name } entries,
// when given, is written in too, so menus work where home cannot be reached.
export function renderExtension(source, bridgeUrl, knownEntities = null) {
	const literal = JSON.stringify(String(bridgeUrl)).replace(/</g, "\\u003c");
	let out = source.replace(placeholder, () => literal);
	if (Array.isArray(knownEntities)) {
		const list = knownEntities.map((e) => ({ entity_id: String(e.entity_id), name: String(e.name ?? e.entity_id) }));
		const listLiteral = JSON.stringify(list).replace(/</g, "\\u003c");
		out = out.replace(knownPlaceholder, () => listLiteral);
	}
	return out;
}

export function hashOf(text) {
	return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}
