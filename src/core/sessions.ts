// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 WulffTech

import * as fs from 'fs';
import * as path from 'path';
import { scanSessionDeltas } from './deltaScan';
import { normalisePermissionLevel } from './permissions';

// session files are append-structured jsonl — a kind:0 snapshot then patch records
// the snapshot goes stale immediately, so titles and counts come from the patch log
// and only fall back to the header
// last-activity is the file mtime, which stays right regardless of format churn

export type ActivityState = 'active' | 'recent' | 'idle';

export type TitleSource =
	| 'deltaTitle'
	| 'headerTitle'
	| 'firstRequest'
	| 'inputText'
	| 'fallback';

export interface ChatSessionInfo {
	sessionId: string;
	title: string;
	titleSource: TitleSource;
	createdAt: number;
	lastActivityAt: number;
	requestCount: number;
	// no requests and no title — opened but never used
	isEmpty: boolean;
	// what the next request in this session will run as, not what past ones ran as — the
	// per-request level sits past the delta scan's prefix cap and is not worth the read
	permissionLevel: string;
	filePath: string;
	fileSize: number;
	parseError?: string;
}

export interface ActivityThresholds {
	// below this age (ms) a session counts as actively responding
	activeMs: number;
	// below this age (ms) a session counts as recently touched
	recentMs: number;
}

export const DEFAULT_THRESHOLDS: ActivityThresholds = {
	activeMs: 45_000,
	recentMs: 10 * 60_000
};

const HEADER_PREFIX_BYTES = 512 * 1024;

interface FirstLineResult {
	text: string;
	// a newline never turned up inside the byte cap — the line is longer than we read,
	// not merely short. readSession uses this to tell a forked session's giant header
	// apart from one that is just malformed
	truncated: boolean;
}

async function probeFirstLine(filePath: string, maxBytes: number): Promise<FirstLineResult> {
	const handle = await fs.promises.open(filePath, 'r');
	try {
		const chunkSize = 64 * 1024;
		const buffer = Buffer.alloc(chunkSize);
		let collected = '';
		let position = 0;

		while (position < maxBytes) {
			const { bytesRead } = await handle.read(buffer, 0, chunkSize, position);
			if (bytesRead === 0) {
				return { text: collected, truncated: false };
			}
			const text = buffer.subarray(0, bytesRead).toString('utf8');
			const newlineIndex = text.indexOf('\n');
			if (newlineIndex !== -1) {
				return { text: collected + text.slice(0, newlineIndex), truncated: false };
			}
			collected += text;
			position += bytesRead;
		}
		return { text: collected, truncated: true };
	} finally {
		await handle.close();
	}
}

// reads just the first line — session files reach tens of megabytes
export async function readFirstLine(filePath: string, maxBytes = HEADER_PREFIX_BYTES): Promise<string> {
	return (await probeFirstLine(filePath, maxBytes)).text;
}

interface HeaderFields {
	sessionId?: string;
	customTitle?: string;
	firstRequestText?: string;
	createdAt: number;
	requestCount: number;
	permissionLevel?: string;
	parseError?: string;
}

function firstRequestText(header: any): string | undefined {
	const requests = header?.requests;
	if (!Array.isArray(requests)) {
		return undefined;
	}
	for (const request of requests) {
		const text: unknown = request?.message?.text;
		if (typeof text === 'string' && text.trim()) {
			return text.trim();
		}
	}
	return undefined;
}

function firstLineOf(value: string, limit = 80): string {
	const line = value.split(/\r?\n/, 1)[0]!.trim();
	return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

export function parseSessionHeader(line: string): HeaderFields {
	try {
		const record = JSON.parse(line);
		const header = record?.v;
		if (record?.kind !== 0 || !header) {
			throw new Error(`expected a kind:0 header record, got kind:${record?.kind}`);
		}
		const custom = typeof header.customTitle === 'string' ? header.customTitle.trim() : '';
		return {
			sessionId: typeof header.sessionId === 'string' ? header.sessionId : undefined,
			customTitle: custom || undefined,
			firstRequestText: firstRequestText(header),
			createdAt: typeof header.creationDate === 'number' ? header.creationDate : 0,
			requestCount: Array.isArray(header.requests) ? header.requests.length : 0,
			permissionLevel: normalisePermissionLevel(header.inputState?.permissionLevel)
		};
	} catch (error) {
		return {
			createdAt: 0,
			requestCount: 0,
			parseError: error instanceof Error ? error.message : String(error)
		};
	}
}

function extractStringField(text: string, key: string): string | undefined {
	const match = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
	if (!match) {
		return undefined;
	}
	try {
		return JSON.parse(`"${match[1]}"`);
	} catch {
		return undefined;
	}
}

function extractNumberField(text: string, key: string): number | undefined {
	const match = new RegExp(`"${key}":(-?\\d+(?:\\.\\d+)?)`).exec(text);
	return match ? Number(match[1]) : undefined;
}

const REQUESTS_ARRAY_KEY = Buffer.from('"requests":[', 'utf8');
// a genuine fork can run into real megabytes of embedded history — this is a ceiling
// against a pathological file, not a limit anyone with real data should reach. same
// reasoning as the ceiling in archiveSeed.ts, against a different store
const MAX_HEADER_SCAN_BYTES = 64 * 1024 * 1024;
const HEADER_SCAN_CHUNK_BYTES = 256 * 1024;

const QUOTE_BYTE = 0x22;
const BACKSLASH_BYTE = 0x5C;
const OPEN_BRACE_BYTE = 0x7B;
const CLOSE_BRACE_BYTE = 0x7D;
const OPEN_BRACKET_BYTE = 0x5B;
const CLOSE_BRACKET_BYTE = 0x5D;

// counts the top-level elements of the header's requests array without parsing any of
// them. vs code writes 'requests' as the last field of the header object, so the key
// search only ever has to look past vs code's own short metadata fields — nothing a
// user typed sits ahead of it. counting still means walking every byte of the array,
// since that is the only way to know how many elements it holds, but nothing is ever
// turned into a string: only structural bytes are inspected, exactly like deltaScan
async function countHeaderRequests(filePath: string): Promise<{ count: number; complete: boolean }> {
	const handle = await fs.promises.open(filePath, 'r');
	try {
		const buffer = Buffer.allocUnsafe(HEADER_SCAN_CHUNK_BYTES);
		let position = 0;
		let tail = Buffer.alloc(0);
		let depth = 0; // 0 before the array starts, 1 once inside it and no deeper
		let inString = false;
		let escaped = false;
		let count = 0;

		while (position < MAX_HEADER_SCAN_BYTES) {
			const { bytesRead } = await handle.read(buffer, 0, HEADER_SCAN_CHUNK_BYTES, position);
			if (bytesRead === 0) {
				return { count, complete: false };
			}
			position += bytesRead;
			let chunk: Buffer = buffer.subarray(0, bytesRead);

			if (depth === 0) {
				const hay = tail.length ? Buffer.concat([tail, chunk]) : chunk;
				const at = hay.indexOf(REQUESTS_ARRAY_KEY);
				if (at === -1) {
					// keep enough of this chunk to bridge a key split across the next read
					const keep = Math.min(hay.length, REQUESTS_ARRAY_KEY.length - 1);
					tail = Buffer.from(hay.subarray(hay.length - keep));
					continue;
				}
				tail = Buffer.alloc(0);
				chunk = hay.subarray(at + REQUESTS_ARRAY_KEY.length);
				depth = 1; // the '[' is already consumed by the key match
			}

			for (let i = 0; i < chunk.length; i++) {
				const byte = chunk[i]!;
				if (escaped) {
					escaped = false;
					continue;
				}
				if (inString) {
					if (byte === BACKSLASH_BYTE) {
						escaped = true;
					} else if (byte === QUOTE_BYTE) {
						inString = false;
					}
					continue;
				}
				if (byte === QUOTE_BYTE) {
					inString = true;
				} else if (byte === OPEN_BRACE_BYTE) {
					if (depth === 1) {
						count++;
					}
					depth++;
				} else if (byte === OPEN_BRACKET_BYTE) {
					depth++;
				} else if (byte === CLOSE_BRACE_BYTE || byte === CLOSE_BRACKET_BYTE) {
					depth--;
					if (depth === 0) {
						return { count, complete: true };
					}
				}
			}
		}
		return { count, complete: false };
	} finally {
		await handle.close();
	}
}

// vs code writes a forked session as one giant kind:0 line — the whole source
// conversation embedded in the header, rather than the near-empty stub every other
// session starts from. the strict parse above always throws on it once the header
// outgrows the prefix cap, and a session with zero requests and no title is exactly
// what listSessions already treats as opened-but-never-used, so a large fork was
// vanishing from the list rather than merely losing its title. customTitle and
// creationDate sit within the first few hundred bytes regardless of how huge the
// requests array gets, so they come off the same prefix the strict parse already read
async function scanOversizedHeader(filePath: string, prefixText: string): Promise<HeaderFields> {
	const customTitle = extractStringField(prefixText, 'customTitle');
	const sessionId = extractStringField(prefixText, 'sessionId');
	const createdAt = extractNumberField(prefixText, 'creationDate') ?? 0;
	const { count, complete } = await countHeaderRequests(filePath);

	let parseError: string | undefined;
	if (!customTitle && count === 0) {
		parseError = 'oversized header carried neither a recognisable title nor a countable request';
	} else if (!complete) {
		// the row will still show up — count is a lower bound the moment any request has
		// started — but it is worth a log line rather than a number quietly under-reporting
		parseError = `oversized header — request count stopped at the scan cap, ${count} counted so far`;
	}

	return {
		sessionId,
		customTitle,
		createdAt,
		requestCount: count,
		firstRequestText: undefined,
		permissionLevel: undefined,
		parseError
	};
}

// a store of several hundred sessions used to fan out over every file at once, each
// holding its own read buffer and its own decode. bounding it keeps peak memory flat in
// the size of the store rather than linear in it
const SCAN_CONCURRENCY = 8;

async function mapBounded<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (let index = next++; index < items.length; index = next++) {
			results[index] = await run(items[index]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

interface CacheEntry {
	mtimeMs: number;
	size: number;
	info: ChatSessionInfo;
}

// session files are append-only, so one whose size and mtime both still match the last
// read cannot have changed. without this every refresh re-read every session in the
// store, and during an active chat the watcher asks for a refresh on every append
const cache = new Map<string, CacheEntry>();

// reads one session file, preferring patch-log values over the stale header
export async function readSession(filePath: string): Promise<ChatSessionInfo> {
	// the stat comes first and alone: on a hit it is the entire cost of the call
	const stat = await fs.promises.stat(filePath);
	const cached = cache.get(filePath);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return cached.info;
	}

	const fallbackId = path.basename(filePath).replace(/\.jsonl$/, '');
	const { text: headerLine, truncated } = await probeFirstLine(filePath, HEADER_PREFIX_BYTES);
	let header = parseSessionHeader(headerLine);
	if (header.parseError && truncated) {
		header = await scanOversizedHeader(filePath, headerLine);
	}
	const deltas = await scanSessionDeltas(filePath);

	const requestCount = header.requestCount + deltas.appendedRequests;

	let title: string;
	let titleSource: TitleSource;
	if (deltas.customTitle) {
		title = firstLineOf(deltas.customTitle);
		titleSource = 'deltaTitle';
	} else if (header.customTitle) {
		title = firstLineOf(header.customTitle);
		titleSource = 'headerTitle';
	} else if (header.firstRequestText) {
		title = firstLineOf(header.firstRequestText);
		titleSource = 'firstRequest';
	} else if (deltas.firstInputText) {
		title = firstLineOf(deltas.firstInputText);
		titleSource = 'inputText';
	} else {
		title = fallbackId;
		titleSource = 'fallback';
	}

	const info: ChatSessionInfo = {
		sessionId: header.sessionId ?? fallbackId,
		title,
		titleSource,
		createdAt: header.createdAt,
		lastActivityAt: stat.mtimeMs,
		requestCount,
		isEmpty: requestCount === 0 && titleSource === 'fallback',
		// unlike the title, the header value here is live at creation and only goes stale
		// once the picker moves, which is exactly what the delta carries
		permissionLevel: deltas.permissionLevel ?? header.permissionLevel ?? 'default',
		filePath,
		fileSize: stat.size,
		parseError: header.parseError
	};

	cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, info });
	return info;
}

export interface ListOptions {
	// drop sessions opened but never used — the native list hides these too
	includeEmpty?: boolean;
	// a session that came back with parseError set, whether or not it ended up empty —
	// the only route this ever had to the log, since a swallowed exception here used to
	// mean a file just quietly never appeared
	onParseError?: (info: { filePath: string; parseError: string }) => void;
}

// every *.jsonl session in a directory, newest activity first
export async function listSessions(directory: string, options: ListOptions = {}): Promise<ChatSessionInfo[]> {
	let entries: string[];
	try {
		entries = await fs.promises.readdir(directory);
	} catch {
		return [];
	}

	const paths = entries
		.filter(name => name.endsWith('.jsonl'))
		.map(name => path.join(directory, name));

	// a session deleted from under us would otherwise keep its metadata for as long as
	// the window lives, and the pane can be open for days
	const present = new Set(paths);
	// derived through join so it is normalised the same way the keys are, and taken from
	// the directory rather than the listing so an emptied one still gets swept
	const owned = path.dirname(path.join(directory, 'x.jsonl'));
	for (const key of cache.keys()) {
		if (path.dirname(key) === owned && !present.has(key)) {
			cache.delete(key);
		}
	}

	const sessions = await mapBounded(paths, SCAN_CONCURRENCY, async (file): Promise<ChatSessionInfo | undefined> => {
		try {
			return await readSession(file);
		} catch {
			return undefined;
		}
	});

	if (options.onParseError) {
		for (const session of sessions) {
			if (session?.parseError) {
				options.onParseError({ filePath: session.filePath, parseError: session.parseError });
			}
		}
	}

	return sessions
		.filter((session): session is ChatSessionInfo => session !== undefined)
		.filter(session => options.includeEmpty || !session.isEmpty)
		.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

export function activityStateOf(
	session: ChatSessionInfo,
	now: number,
	thresholds: ActivityThresholds = DEFAULT_THRESHOLDS
): ActivityState {
	const age = now - session.lastActivityAt;
	if (age <= thresholds.activeMs) {
		return 'active';
	}
	if (age <= thresholds.recentMs) {
		return 'recent';
	}
	return 'idle';
}

export type SortKey = 'activity' | 'created';

// newest first either way. createdAt is the header's creationDate, which was populated
// on all 23 real sessions here — but a zero would sort to the bottom and look like a
// parse failure, so it falls back to the mtime
export function compareSessions<T extends { createdAt: number; lastActivityAt: number }>(
	sortBy: SortKey
): (a: T, b: T) => number {
	if (sortBy === 'created') {
		return (a, b) => (b.createdAt || b.lastActivityAt) - (a.createdAt || a.lastActivityAt);
	}
	return (a, b) => b.lastActivityAt - a.lastActivityAt;
}
