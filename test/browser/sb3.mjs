// Builds a tiny .sb3 that uses the ScratcHA blocks:
// - green flag: turn input_boolean.lamp on, then set "temp" to state of input_number.temp
// - when input_boolean.lamp changes: set "hat" to "yes"
import crypto from "node:crypto";
import JSZip from "@turbowarp/jszip";

const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"2\" height=\"2\" viewBox=\"0 0 2 2\"><rect width=\"2\" height=\"2\" fill=\"#18bcf2\"/></svg>";
const md5 = crypto.createHash("md5").update(svg).digest("hex");

function costume(name, x, y) {
	return { name, dataFormat: "svg", assetId: md5, md5ext: `${md5}.svg`, rotationCenterX: x, rotationCenterY: y };
}

function menu(id, parent, opcode, field, value) {
	return [id, { opcode, next: null, parent, inputs: {}, fields: { [field]: [value, null] }, shadow: true, topLevel: false }];
}

export function testProject({ extensionUrl = "http://homeassistant.local:8099/extension/scratcha.js" } = {}) {
	const blocks = Object.fromEntries([
		["flag", { opcode: "event_whenflagclicked", next: "turnon", parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 0, y: 0 }],
		["turnon", { opcode: "scratcha_turnOnOff", next: "settemp", parent: "flag", inputs: { SWITCHABLE: [1, "m1"], ONOFF: [1, "m2"] }, fields: {}, shadow: false, topLevel: false }],
		menu("m1", "turnon", "scratcha_menu_switchables", "switchables", "input_boolean.lamp"),
		menu("m2", "turnon", "scratcha_menu_onoff", "onoff", "on"),
		["settemp", { opcode: "data_setvariableto", next: "seterr", parent: "turnon", inputs: { VALUE: [3, "rep", [10, ""]] }, fields: { VARIABLE: ["temp", "var-temp"] }, shadow: false, topLevel: false }],
		["rep", { opcode: "scratcha_stateOf", next: null, parent: "settemp", inputs: { ENTITY: [1, "m3"] }, fields: {}, shadow: false, topLevel: false }],
		menu("m3", "rep", "scratcha_menu_entities", "entities", "input_number.temp"),
		["seterr", { opcode: "data_setvariableto", next: null, parent: "settemp", inputs: { VALUE: [3, "err", [10, ""]] }, fields: { VARIABLE: ["error", "var-error"] }, shadow: false, topLevel: false }],
		["err", { opcode: "scratcha_lastError", next: null, parent: "seterr", inputs: {}, fields: {}, shadow: false, topLevel: false }],
		["hat", { opcode: "scratcha_whenChanges", next: "sethat", parent: null, inputs: {}, fields: { ENTITY_FIELD: ["input_boolean.lamp", null] }, shadow: false, topLevel: true, x: 0, y: 300 }],
		["sethat", { opcode: "data_setvariableto", next: null, parent: "hat", inputs: { VALUE: [1, [10, "yes"]] }, fields: { VARIABLE: ["hat", "var-hat"] }, shadow: false, topLevel: false }]
	]);
	return {
		targets: [
			{
				isStage: true,
				name: "Stage",
				variables: { "var-temp": ["temp", ""], "var-hat": ["hat", "no"], "var-error": ["error", ""] },
				lists: {},
				broadcasts: {},
				blocks: {},
				comments: {},
				currentCostume: 0,
				costumes: [costume("backdrop1", 1, 1)],
				sounds: [],
				volume: 100,
				layerOrder: 0,
				tempo: 60,
				videoTransparency: 50,
				videoState: "on",
				textToSpeechLanguage: null
			},
			{
				isStage: false,
				name: "Robot",
				variables: {},
				lists: {},
				broadcasts: {},
				blocks,
				comments: {},
				currentCostume: 0,
				costumes: [costume("costume1", 1, 1)],
				sounds: [],
				volume: 100,
				layerOrder: 1,
				visible: true,
				x: 0,
				y: 0,
				size: 100,
				direction: 90,
				draggable: false,
				rotationStyle: "all around"
			}
		],
		monitors: [],
		extensions: ["scratcha"],
		extensionURLs: { scratcha: extensionUrl },
		meta: { semver: "3.0.0", vm: "0.2.0", agent: "scratcha-test" }
	};
}

export async function testSb3(options) {
	const zip = new JSZip();
	zip.file("project.json", JSON.stringify(testProject(options)));
	zip.file(`${md5}.svg`, svg);
	return zip.generateAsync({ type: "nodebuffer" });
}
