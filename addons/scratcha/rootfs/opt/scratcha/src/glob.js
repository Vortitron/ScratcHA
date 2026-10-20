// Entity and service patterns: exact IDs or globs with "*" only.
// "*" matches any run of [a-z0-9_] inside one part. A pattern that is just "*"
// matches everything.

const patternShape = /^[a-z0-9_*]+\.[a-z0-9_*]+$/;

export function isValidPattern(pattern) {
	return pattern === "*" || patternShape.test(pattern);
}

export function compilePattern(pattern) {
	if (pattern === "*") {
		return /^.*$/;
	}
	const body = pattern
		.split("*")
		.map((part) => part.replace(/[.]/g, "\\."))
		.join("[a-z0-9_]*");
	return new RegExp(`^${body}$`);
}

// Returns a matcher function. An empty list matches nothing.
export function compileList(patterns) {
	const regexes = (patterns ?? []).map(compilePattern);
	const matcher = (value) => regexes.some((re) => re.test(value));
	matcher.empty = regexes.length === 0;
	return matcher;
}

export function hasWildcardAll(patterns) {
	return (patterns ?? []).some((p) => p === "*" || p === "*.*");
}
