// Builds examples/ScratcHA demo.sb3. Run from test/: node tools/build-demo.mjs
// The demo uses light.kids_room and sensor.room_temperature.
//
// The extension is stored in the project as a data: URL. An http:// URL
// cannot load on turbowarp.org (mixed content), and then the project would
// not open there at all. The add-on player swaps in its own live copy.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "@turbowarp/jszip";
import { loadExtensionSource, renderExtension } from "../../addons/scratcha/rootfs/opt/scratcha/src/extension.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const lamp = "light.kids_room";
const sensor = "sensor.room_temperature";

const backdrop = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"480\" height=\"360\" viewBox=\"0 0 480 360\"><rect width=\"480\" height=\"360\" fill=\"#eaf8fe\"/><rect y=\"300\" width=\"480\" height=\"60\" fill=\"#bfe9f8\"/></svg>";
const house = fs.readFileSync(path.join(root, "art", "icon.svg"), "utf8");

function asset(svg) {
	const md5 = crypto.createHash("md5").update(svg).digest("hex");
	return { md5, file: `${md5}.svg`, svg };
}

const assets = [asset(backdrop), asset(house)];
let counter = 0;
const blocks = {};

function block(opcode, { inputs = {}, fields = {}, parent = null, top = false, x = 0, y = 0, shadow = false } = {}) {
	const id = `b${(counter += 1)}`;
	blocks[id] = { opcode, next: null, parent, inputs, fields, shadow, topLevel: top, ...(top ? { x, y } : {}) };
	return id;
}

function menu(parent, opcode, field, value) {
	return block(opcode, { parent, fields: { [field]: [value, null] }, shadow: true });
}

function chain(...ids) {
	for (let i = 0; i < ids.length - 1; i += 1) {
		blocks[ids[i]].next = ids[i + 1];
		blocks[ids[i + 1]].parent = ids[i];
	}
	return ids[0];
}

function reporterInto(parentId, inputName, reporterId, fallback = "") {
	blocks[reporterId].parent = parentId;
	blocks[parentId].inputs[inputName] = [3, reporterId, [10, fallback]];
}

function say(textOrReporter, secs = 2) {
	const id = block("looks_sayforsecs", { inputs: { SECS: [1, [4, String(secs)]] } });
	if (!(textOrReporter in blocks)) {
		blocks[id].inputs.MESSAGE = [1, [10, textOrReporter]];
	} else {
		reporterInto(id, "MESSAGE", textOrReporter, "Hello!");
	}
	return id;
}

function join(text, reporterId) {
	const id = block("operator_join", { inputs: { STRING1: [1, [10, text]] } });
	reporterInto(id, "STRING2", reporterId);
	return id;
}

function entityReporter(opcode, entity) {
	const id = block(opcode);
	blocks[id].inputs.ENTITY = [1, menu(id, "scratcha_menu_entities", "entities", entity)];
	return id;
}

// Green flag: say what we can use, then the temperature.
const flag = block("event_whenflagclicked", { top: true, x: 20, y: 20 });
chain(
	flag,
	say(join("I can use: ", block("scratcha_allEntities")), 3),
	say(join("Room temperature: ", entityReporter("scratcha_numberOf", sensor)), 3),
	say("Click me to toggle the lamp!", 3)
);

// Click: toggle the lamp, and say any error.
const clicked = block("event_whenthisspriteclicked", { top: true, x: 20, y: 320 });
const toggle = block("scratcha_toggle");
blocks[toggle].inputs.SWITCHABLE = [1, menu(toggle, "scratcha_menu_switchables", "switchables", lamp)];
const ifError = block("control_if");
const not = block("operator_not", { parent: ifError });
const equals = block("operator_equals", { parent: not, inputs: { OPERAND2: [1, [10, ""]] } });
reporterInto(equals, "OPERAND1", block("scratcha_lastError"));
blocks[not].inputs.OPERAND = [2, equals];
blocks[ifError].inputs.CONDITION = [2, not];
const sayError = say(block("scratcha_lastError"), 2);
blocks[sayError].parent = ifError;
blocks[ifError].inputs.SUBSTACK = [2, sayError];
chain(clicked, toggle, ifError);

// Hat: say the new lamp state when it changes.
const hat = block("scratcha_whenChanges", { top: true, x: 420, y: 20, fields: { ENTITY_FIELD: [lamp, null] } });
chain(hat, say(join("The lamp is now ", entityReporter("scratcha_stateOf", lamp)), 2));

function extensionDataUrl() {
	const known = [{ entity_id: lamp, name: "Kids room light" }, { entity_id: sensor, name: "Room temperature" }];
	const code = renderExtension(loadExtensionSource(), "", known);
	return `data:text/javascript;base64,${Buffer.from(code, "utf8").toString("base64")}`;
}

const costume = (name, a, cx, cy) => ({ name, dataFormat: "svg", assetId: a.md5, md5ext: a.file, rotationCenterX: cx, rotationCenterY: cy });
const project = {
	targets: [
		{ isStage: true, name: "Stage", variables: {}, lists: {}, broadcasts: {}, blocks: {}, comments: {}, currentCostume: 0, costumes: [costume("backdrop1", assets[0], 240, 180)], sounds: [], volume: 100, layerOrder: 0, tempo: 60, videoTransparency: 50, videoState: "on", textToSpeechLanguage: null },
		{ isStage: false, name: "House", variables: {}, lists: {}, broadcasts: {}, blocks, comments: {}, currentCostume: 0, costumes: [costume("house", assets[1], 64, 64)], sounds: [], volume: 100, layerOrder: 1, visible: true, x: -60, y: -40, size: 100, direction: 90, draggable: false, rotationStyle: "all around" }
	],
	monitors: [],
	extensions: ["scratcha"],
	extensionURLs: { scratcha: extensionDataUrl() },
	meta: { semver: "3.0.0", vm: "0.2.0", agent: "ScratcHA demo builder" }
};

const zip = new JSZip();
zip.file("project.json", JSON.stringify(project));
for (const a of assets) {
	zip.file(a.file, a.svg);
}
const out = path.join(root, "examples", "ScratcHA demo.sb3");
fs.writeFileSync(out, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
console.log(`Wrote ${path.relative(root, out)}`);
