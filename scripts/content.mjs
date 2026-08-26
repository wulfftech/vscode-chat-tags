// one source of display text for both the harness and the README screenshot, so
// sanitising the shot doesn't leave the harness showing something else
import * as fs from 'node:fs';

const SOURCE = 'dev/screenshot-content.json';

// fixed so a rebuild produces a byte-identical page — a moving 'now' would rewrite
// every relative timestamp and make every regenerated screenshot a diff
export const NOW = 1787000000000;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export function loadContent() {
	const raw = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));

	const sessions = raw.sessions.map(entry => ({
		sessionId: entry.id,
		title: entry.title,
		subtitle: entry.subtitle,
		subtitleSource: entry.subtitleSource,
		titleOverridden: Boolean(entry.titleOverridden),
		titleSource: entry.titleSource,
		categoryId: entry.category,
		requestCount: entry.requestCount ?? 0,
		activity: entry.activity ?? 'idle',
		generating: Boolean(entry.generating),
		archived: Boolean(entry.archived),
		needsAttention: Boolean(entry.unread),
		lastActivityAt: NOW - Math.round((entry.ageMinutes ?? 0) * MINUTE),
		createdAt: NOW - Math.round((entry.createdDaysAgo ?? 0) * DAY)
	}));

	return { categories: raw.categories, models: raw.models, sessions };
}

// mirrors compareSessions() in core/sessions.ts. the provider sorts before posting and
// the view only groups, so anything rendering the view outside the extension has to
// sort for itself or 'Created' comes out in array order
export function order(sessions, sortBy) {
	const compare = sortBy === 'created'
		? (a, b) => (b.createdAt || b.lastActivityAt) - (a.createdAt || a.lastActivityAt)
		: (a, b) => b.lastActivityAt - a.lastActivityAt;
	return sessions.slice().sort(compare);
}
