// Small levelled logger. It never prints request headers, so tokens and PINs
// cannot end up in the log.
const levels = { debug: 10, info: 20, warning: 30, error: 40 };

export function createLogger(level = "info", sink = console) {
	const min = levels[level] ?? levels.info;
	const make = (name, method) => (...args) => {
		if (levels[name] >= min) {
			sink[method](`[scratcha] ${name}:`, ...args);
		}
	};
	return {
		debug: make("debug", "log"),
		info: make("info", "log"),
		warn: make("warning", "warn"),
		error: make("error", "error")
	};
}
