import assert from "node:assert/strict";
import { test } from "node:test";
import { compileList, hasWildcardAll, isValidPattern } from "./glob.js";

test("exact match", () => {
	const m = compileList(["light.kitchen"]);
	assert.equal(m("light.kitchen"), true);
	assert.equal(m("light.kitchen_2"), false);
	assert.equal(m("light.kitche"), false);
});

test("domain glob", () => {
	const m = compileList(["light.*"]);
	assert.equal(m("light.kitchen"), true);
	assert.equal(m("switch.kitchen"), false);
	assert.equal(m("lights.kitchen"), false);
});

test("prefix glob stays inside the object id", () => {
	const m = compileList(["sensor.kids_room_*"]);
	assert.equal(m("sensor.kids_room_temp"), true);
	assert.equal(m("sensor.kids_room_"), true);
	assert.equal(m("sensor.kids_rooms"), false);
	assert.equal(m("sensor.kids_room_temp.x"), false);
});

test("dots in patterns are literal", () => {
	const m = compileList(["light.a"]);
	assert.equal(m("lightxa"), false);
});

test("empty list matches nothing", () => {
	const m = compileList([]);
	assert.equal(m.empty, true);
	assert.equal(m("light.kitchen"), false);
});

test("star alone matches everything and is flagged", () => {
	assert.equal(compileList(["*"])("anything.at_all"), true);
	assert.equal(hasWildcardAll(["*"]), true);
	assert.equal(hasWildcardAll(["*.*"]), true);
	assert.equal(hasWildcardAll(["light.*"]), false);
});

test("pattern shape", () => {
	assert.equal(isValidPattern("light.*"), true);
	assert.equal(isValidPattern("*"), true);
	assert.equal(isValidPattern("light"), false);
	assert.equal(isValidPattern("light.kitchen lamp"), false);
	assert.equal(isValidPattern("Light.a"), false);
});
