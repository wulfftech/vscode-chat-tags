// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 WulffTech

import * as fs from 'fs';
import * as path from 'path';
import { parseLocalSessionUri } from './sessionUri';

// vs code keeps its own chat archive, and nothing reconciles it with ours: it writes
// [{resource,archived,pinned,read}] under the key below into the workspace-scoped
// state.vscdb, while ours is an archivedAt in globalState. a machine that archived its
// chats over there therefore showed every one of them live in this pane
//
// there is no api for it. vscode.d.ts carries no mention of archive at all, and the
// workbench path throws for a local chat, which has no registered item controller —
// setChatSessionItemArchived is only reachable for contributed session types. reading
// the file is the only route, and it is read-only and one-way on purpose

const STATE_DB = 'state.vscdb';
const STATE_KEY = 'agentSessions.state.cache';
// largest here is 5.4 MB across 24 workspaces; the ceiling is only so a pathological
// file cannot be pulled into memory whole
const MAX_DB_BYTES = 64 * 1024 * 1024;

const OPEN_BRACKET = 0x5B;
const CLOSE_BRACKET = 0x5D;
const OPEN_BRACE = 0x7B;
const CLOSE_BRACE = 0x7D;
const QUOTE = 0x22;
const BACKSLASH = 0x5C;

export interface StateEntry {
	resource?: unknown;
	archived?: unknown;
	read?: unknown;
}

// the sessions directory is workspaceStorage/<hash>/chatSessions, and the database is
// its sibling — same reason as locations.ts, we never want to recompute the hash
export function stateDbBeside(sessionsDir: string): string {
	return path.join(path.dirname(sessionsDir), STATE_DB);
}

// ── reading ──────────────────────────────────────────────────────────────────

// json in a raw page has nothing after it to stop on, so walk it: depth over brackets
// and braces, blind to anything inside a string. returns one past the closing bracket
function matchBracket(buffer: Buffer, start: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < buffer.length; i++) {
		const byte = buffer[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString) {
			if (byte === BACKSLASH) {
				escaped = true;
			} else if (byte === QUOTE) {
				inString = false;
			}
			continue;
		}
		if (byte === QUOTE) {
			inString = true;
		} else if (byte === OPEN_BRACKET || byte === OPEN_BRACE) {
			depth++;
		} else if (byte === CLOSE_BRACKET || byte === CLOSE_BRACE) {
			depth--;
			if (depth === 0) {
				return i + 1;
			}
		}
	}
	return -1;
}

// a table leaf stores the key immediately before its value, so one scan finds both.
// two things make a hit ambiguous: the same key also sits in the primary-key index with
// no value behind it, and a freed page can still hold a superseded copy. requiring a '['
// straight after the key rules out the first, and the caller settles the second
export function findStateArrays(buffer: Buffer): StateEntry[][] {
	const key = Buffer.from(STATE_KEY, 'utf8');
	const found: StateEntry[][] = [];
	let at = 0;
	while ((at = buffer.indexOf(key, at)) !== -1) {
		const start = at + key.length;
		at = start;
		if (buffer[start] !== OPEN_BRACKET) {
			continue;
		}
		const end = matchBracket(buffer, start);
		if (end === -1) {
			continue;
		}
		try {
			const parsed = JSON.parse(buffer.subarray(start, end).toString('utf8'));
			if (Array.isArray(parsed)) {
				found.push(parsed);
			}
		} catch {
			// a torn or half-overwritten page — the copy we want is elsewhere in the file
		}
	}
	return found;
}

// every entry carries the epoch it was last read at, so the copy holding the newest one
// is the live page. measured on this machine: a freed page still held a copy 76 seconds
// behind the live one, and a strict subset of it
export function newestArray(arrays: StateEntry[][]): StateEntry[] | undefined {
	let best: StateEntry[] | undefined;
	let bestRead = -1;
	for (const entries of arrays) {
		let read = 0;
		for (const entry of entries) {
			if (typeof entry.read === 'number' && entry.read > read) {
				read = entry.read;
			}
		}
		if (read > bestRead || (read === bestRead && best && entries.length > best.length)) {
			best = entries;
			bestRead = read;
		}
	}
	return best;
}

// the loader accepts a string or a revived uri object, so both shapes reach the file
function resourceString(resource: unknown): string | undefined {
	if (typeof resource === 'string') {
		return resource;
	}
	if (!resource || typeof resource !== 'object') {
		return undefined;
	}
	const parts = resource as { scheme?: unknown; authority?: unknown; path?: unknown };
	if (typeof parts.scheme !== 'string' || typeof parts.authority !== 'string' || typeof parts.path !== 'string') {
		return undefined;
	}
	return `${parts.scheme}://${parts.authority}${parts.path}`;
}

// every copy of the array the file still holds, live page and freed alike. empty for
// anything unreadable — a missing archive is a worse reason to fail activation than to
// ignore, and the pane is useful without it
export async function readStateCopies(dbPath: string): Promise<StateEntry[][]> {
	let buffer: Buffer;
	try {
		const stat = await fs.promises.stat(dbPath);
		if (stat.size > MAX_DB_BYTES) {
			return [];
		}
		buffer = await fs.promises.readFile(dbPath);
	} catch {
		return [];
	}
	return findStateArrays(buffer);
}

// session ids of the chats vs code has archived in this workspace
export async function readArchivedSessionIds(dbPath: string): Promise<string[]> {
	const entries = newestArray(await readStateCopies(dbPath));
	if (!entries) {
		return [];
	}

	const ids: string[] = [];
	for (const entry of entries) {
		if (entry.archived !== true) {
			continue;
		}
		const uri = resourceString(entry.resource);
		const sessionId = uri ? parseLocalSessionUri(uri) : undefined;
		if (sessionId) {
			ids.push(sessionId);
		}
	}
	return ids;
}
