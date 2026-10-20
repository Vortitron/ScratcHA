// Token buckets keyed by client, plus a per-key minimum interval.

export class TokenBuckets {
	constructor({ capacity, refillPerMs, now = Date.now, maxKeys = 5000 }) {
		this.capacity = capacity;
		this.refillPerMs = refillPerMs;
		this.now = now;
		this.maxKeys = maxKeys;
		this.buckets = new Map();
	}

	take(key) {
		const t = this.now();
		let bucket = this.buckets.get(key);
		if (!bucket) {
			if (this.buckets.size >= this.maxKeys) {
				this.buckets.clear();
			}
			bucket = { tokens: this.capacity, at: t };
			this.buckets.set(key, bucket);
		}
		bucket.tokens = Math.min(this.capacity, bucket.tokens + (t - bucket.at) * this.refillPerMs);
		bucket.at = t;
		if (bucket.tokens < 1) {
			return false;
		}
		bucket.tokens -= 1;
		return true;
	}
}

export class MinInterval {
	constructor({ intervalMs, now = Date.now }) {
		this.intervalMs = intervalMs;
		this.now = now;
		this.last = new Map();
	}

	// Checks every key first, then records them, so a refused call never
	// blocks the next one.
	takeAll(keys) {
		if (this.intervalMs <= 0) {
			return true;
		}
		const t = this.now();
		for (const key of keys) {
			const last = this.last.get(key);
			if (last !== undefined && t - last < this.intervalMs) {
				return false;
			}
		}
		for (const key of keys) {
			this.last.set(key, t);
		}
		if (this.last.size > 5000) {
			for (const [key, at] of this.last) {
				if (t - at >= this.intervalMs) {
					this.last.delete(key);
				}
			}
		}
		return true;
	}
}
