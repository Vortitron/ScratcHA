import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import Packager from "@turbowarp/packager";
import JSZip from "@turbowarp/jszip";
import { bridgeError } from "./errors.js";

export const projectNameShape = /^[A-Za-z0-9 _-]{1,64}\.sb3$/;
export const maxProjectBytes = 50 * 1024 * 1024;

// Turns .sb3 files from projects_dir into one-file players with the ScratcHA
// extension inlined. Results are cached by name, size, time and extension.
export class Players {
	constructor({ projectsDir, cacheDir, extensionSource, logger }) {
		this.projectsDir = projectsDir;
		this.cacheDir = cacheDir;
		this.extensionSource = extensionSource;
		this.logger = logger;
		this.inFlight = new Map();
	}

	async list() {
		let names;
		try {
			names = await fsp.readdir(this.projectsDir);
		} catch {
			return [];
		}
		const out = [];
		for (const name of names.sort()) {
			if (!projectNameShape.test(name)) {
				continue;
			}
			try {
				const stat = await fsp.stat(path.join(this.projectsDir, name));
				if (stat.isFile() && stat.size <= maxProjectBytes) {
					out.push({ name: name.slice(0, -4), file: name, size: stat.size, modified: stat.mtime.toISOString() });
				}
			} catch {
				// Gone between readdir and stat.
			}
		}
		return out;
	}

	async render(file) {
		if (!projectNameShape.test(file)) {
			throw bridgeError("bad_request", 400, "That is not a valid project name.");
		}
		const full = path.join(this.projectsDir, file);
		let stat;
		try {
			stat = await fsp.stat(full);
		} catch {
			throw bridgeError("not_found", 404, "That project does not exist.");
		}
		if (!stat.isFile()) {
			throw bridgeError("not_found", 404, "That project does not exist.");
		}
		if (stat.size > maxProjectBytes) {
			throw bridgeError("bad_request", 413, "That project is too big.");
		}
		const source = this.extensionSource();
		const key = crypto.createHash("sha256")
			.update(`${file}\n${stat.size}\n${stat.mtimeMs}\n`)
			.update(source)
			.digest("hex")
			.slice(0, 32);
		const cached = path.join(this.cacheDir, `${key}.html`);
		try {
			return await fsp.readFile(cached);
		} catch {
			// Not cached yet.
		}
		if (this.inFlight.has(key)) {
			return this.inFlight.get(key);
		}
		const job = this.build(full, file, source, cached).finally(() => this.inFlight.delete(key));
		this.inFlight.set(key, job);
		return job;
	}

	async build(full, file, source, cached) {
		const data = await fsp.readFile(full);
		const prepared = await withLocalExtension(data, source);
		const project = await Packager.loadProject(prepared);
		const packager = new Packager.Packager();
		packager.project = project;
		packager.options.app.windowTitle = file.slice(0, -4);
		packager.options.loadingScreen.text = file.slice(0, -4);
		packager.options.extensions = project.analysis.extensions;
		const result = await packager.package();
		const html = Buffer.from(result.data);
		try {
			fs.mkdirSync(this.cacheDir, { recursive: true });
			await fsp.writeFile(cached, html);
		} catch (error) {
			this.logger.warn(`Could not cache player: ${error.message}`);
		}
		return html;
	}
}

// Points the project's "scratcha" extension at an inline copy of this
// bridge's extension, so packaging needs no network.
export async function withLocalExtension(sb3, source) {
	let zip;
	try {
		zip = await JSZip.loadAsync(sb3);
	} catch {
		throw bridgeError("bad_request", 400, "That is not a valid .sb3 file.");
	}
	const entry = zip.file("project.json");
	if (!entry) {
		throw bridgeError("bad_request", 400, "That .sb3 file has no project.json.");
	}
	let project;
	try {
		project = JSON.parse(await entry.async("string"));
	} catch {
		throw bridgeError("bad_request", 400, "That project.json is not valid JSON.");
	}
	const uses = Array.isArray(project.extensions) && project.extensions.includes("scratcha");
	if (!uses) {
		return sb3;
	}
	project.extensionURLs = project.extensionURLs && typeof project.extensionURLs === "object" ? project.extensionURLs : {};
	project.extensionURLs.scratcha = `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
	zip.file("project.json", JSON.stringify(project));
	return zip.generateAsync({ type: "nodebuffer" });
}
