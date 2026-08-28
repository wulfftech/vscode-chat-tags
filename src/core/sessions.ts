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

// reads just the first line — session files reach tens of megabytes
export async function readFirstLine(filePath: string, maxBytes = 512 * 1024): Promise<string> {
	const handle = await fs.promises.open(filePath, 'r');
	try {
		const chunkSize = 64 * 1024;
		const buffer = Buffer.alloc(chunkSize);
		let collected = '';
		let position = 0;

		while (position < maxBytes) {
			const { bytesRead } = await handle.read(buffer, 0, chunkSize, position);
			if (bytesRead === 0) {
				break;
			}
			const text = buffer.subarray(0, bytesRead).toString('utf8');
			const newlineIndex = text.indexOf('\n');
			if (newlineIndex !== -1) {
				return collected + text.slice(0, newlineIndex);
			}
			collected += text;
			position += bytesRead;
		}
		return collected;
	} finally {
		await handle.close();
	}
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
	const headerLine = await readFirstLine(filePath);
	const header = parseSessionHeader(headerLine);
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
