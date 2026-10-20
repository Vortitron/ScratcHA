import { bridgeError } from "./errors.js";

// Server-Sent Events fan-out for /bridge/events.
export class EventHub {
	constructor({ maxStreams = 20, pingMs = 25000 } = {}) {
		this.maxStreams = maxStreams;
		this.clients = new Set();
		this.pinger = setInterval(() => this.ping(), pingMs);
		this.pinger.unref?.();
	}

	get size() {
		return this.clients.size;
	}

	// filter is null for "every allowed entity", or a Set of entity IDs.
	open(req, res, { filter = null, initial = [] } = {}) {
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
		for (const [event, data] of initial) {
			this.write(client, event, data);
		}
		const done = () => this.clients.delete(client);
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
	}
}
