import { createApp } from "./app.js";
import { loadOptions } from "./options.js";

const options = loadOptions();
const app = createApp(options);

const listenHost = options.host;
const listenPort = Number(options.port);

app.listen(listenPort, listenHost, () => {
	console.log(
		`[scratha] listening on http://${listenHost}:${listenPort} (HA: ${options.homeassistant_url}, cache: ${options.cache_seconds}s)`
	);
});

