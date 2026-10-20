import { bridgeError } from "./errors.js";

// Server-Sent Events fan-out for /bridge/events.
// maxStreams is for everyone. maxPerClient stops one device, or one web
// page, from using them all up.
export class EventHub {
	constructor({ maxStreams = 20, maxPerClient = 4, pingMs = 25000 } = {}) {
		this.maxStreams = maxStreams;
		this.maxPerClient = maxPerClient;
		this.clients = new Set();
		this.perClient = new Map();
		this.pinger = setInterval(() => this.ping(), pingMs);
		this.pinger.unref?.();
	}

	get size() {
		return this.clients.size;
	}

	// filter is null for "every allowed entity", or a Set of entity IDs.
	open(req, res, { filter = null, initial = [], clientId = "unknown" } = {}) {
		const mine = this.perClient.get(clientId) ?? 0;
		if (mine >= this.maxPerClient) {
			throw bridgeError("busy", 503, "Too many live connections from this device.");
		}
		if (this.clients.size >= this.maxStreams) {
			throw bridgeError("busy", 503);
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no"
		});
		res.write("retry: 3000\n\n");
		const client = { res, filter };
		this.clients.add(client);
		this.perClient.set(clientId, mine + 1);
		for (const [event, data] of initial) {
			this.write(client, event, data);
		}
		const done = () => {
			if (!this.clients.delete(client)) {
				return;
			}
			const left = (this.perClient.get(clientId) ?? 1) - 1;
			if (left > 0) {
				this.perClient.set(clientId, left);
			} else {
				this.perClient.delete(clientId);
			}
		};
		req.on("close", done);
		res.on("error", done);
		return client;
	}

	write(client, event, data) {
		if (event === "state" && client.filter && !client.filter.has(data.entity_id)) {
			return;
		}
		client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	}

	broadcast(event, data) {
		for (const client of this.clients) {
			this.write(client, event, data);
		}
	}

	ping() {
		for (const client of this.clients) {
			client.res.write(": ping\n\n");
		}
	}

	close() {
		clearInterval(this.pinger);
		for (const client of this.clients) {
			client.res.end();
		}
		this.clients.clear();
		this.perClient.clear();
	}
}
