// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 WulffTech

// a field diagnostic for "chats I archived in VS Code still show as live in the pane".
// self-contained on purpose — no imports from the build, so it can be dropped onto a
// machine that has no checkout and run with `node diagnose-archive.mjs`.
//
// read-only. it opens state.vscdb and the session directory, writes nothing, and prints
// counts plus truncated ids rather than any chat content.
//
//   node diagnose-archive.mjs
//   node diagnose-archive.mjs "C:\\Users\\you\\AppData\\Roaming\\Code - Insiders\\User"

import fs from 'fs';
import path from 'path';
import os from 'os';

const STATE_KEY = 'agentSessions.state.cache';
const WORKSPACE_SESSIONS = 'chatSessions';
const EMPTY_WINDOW_SESSIONS = 'emptyWindowChatSessions';

function defaultUserDir() {
	if (process.platform === 'win32') {
		return path.join(process.env.APPDATA ?? '', 'Code', 'User');
	}
	if (process.platform === 'darwin') {
		return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User');
	}
	return path.join(os.homedir(), '.config', 'Code', 'User');
}

const userDir = process.argv[2] ?? defaultUserDir();

// ── the scan the extension actually uses ─────────────────────────────────────

function matchBracket(buffer, start) {
	let depth = 0, inString = false, escaped = false;
	for (let i = start; i < buffer.length; i++) {
		const byte = buffer[i];
		if (escaped) { escaped = false; continue; }
		if (inString) {
			if (byte === 0x5c) { escaped = true; }
			else if (byte === 0x22) { inString = false; }
			continue;
		}
		if (byte === 0x22) { inString = true; }
		else if (byte === 0x5b || byte === 0x7b) { depth++; }
		else if (byte === 0x5d || byte === 0x7d) { depth--; if (depth === 0) { return i + 1; } }
	}
	return -1;
}

// every site the key appears at, and what the scan makes of each one. the distinction
// that matters: a key with no '[' after it is the primary-key index and means nothing,
// a key whose value will not parse is a value too big for one page
function inspect(buffer) {
	const needle = Buffer.from(STATE_KEY, 'utf8');
	const sites = [];
	let at = 0;
	while ((at = buffer.indexOf(needle, at)) !== -1) {
		const start = at + needle.length;
		at = start;
		if (buffer[start] !== 0x5b) { sites.push({ kind: 'index entry, no value' }); continue; }
		const end = matchBracket(buffer, start);
		if (end === -1) {
			sites.push({ kind: 'value never closes', bytes: buffer.length - start });
			continue;
		}
		const slice = buffer.subarray(start, end);
		try {
			const parsed = JSON.parse(slice.toString('utf8'));
			sites.push({ kind: 'recovered', bytes: slice.length, entries: parsed });
		} catch (error) {
			sites.push({ kind: 'value will not parse', bytes: slice.length, why: String(error.message).slice(0, 70) });
		}
	}
	return sites;
}

function decodeSessionId(resource) {
	const uri = typeof resource === 'string' ? resource
		: (resource && typeof resource === 'object' && typeof resource.scheme === 'string')
			? `${resource.scheme}://${resource.authority ?? ''}${resource.path ?? ''}`
			: undefined;
	if (!uri) { return undefined; }
	const match = /^vscode-chat-session:\/\/local\/(.+)$/.exec(uri);
	if (!match) { return undefined; }
	try {
		const decoded = Buffer.from(decodeURIComponent(match[1]), 'base64').toString('utf8');
		return /^[0-9a-f-]{36}$/i.test(decoded) ? decoded : undefined;
	} catch {
		return undefined;
	}
}

function pageSize(buffer) {
	const raw = buffer.readUInt16BE(16);
	return raw === 1 ? 65536 : raw;
}

// ── report ───────────────────────────────────────────────────────────────────

console.log('user directory : ' + userDir);
console.log('platform       : ' + process.platform + ', node ' + process.version);
console.log('');

const places = [];
const workspaceRoot = path.join(userDir, 'workspaceStorage');
if (fs.existsSync(workspaceRoot)) {
	for (const hash of fs.readdirSync(workspaceRoot)) {
		const dir = path.join(workspaceRoot, hash, WORKSPACE_SESSIONS);
		if (fs.existsSync(dir)) {
			places.push({ label: 'workspace ' + hash.slice(0, 8), dir, db: path.join(workspaceRoot, hash, 'state.vscdb') });
		}
	}
}
const emptyWindow = path.join(userDir, 'globalStorage', EMPTY_WINDOW_SESSIONS);
if (fs.existsSync(emptyWindow)) {
	places.push({ label: 'empty-window chats', dir: emptyWindow, db: path.join(userDir, 'globalStorage', 'state.vscdb') });
}

if (!places.length) {
	console.log('No chat session directories found under that user directory.');
	console.log('If VS Code is installed somewhere unusual, pass its User folder as an argument.');
	process.exit(0);
}

// the payload a b-tree leaf cell can hold before sqlite spills the rest onto overflow
// pages, which is the ceiling the whole scan runs into
const localLimit = size => size - 35;

let totalFiles = 0, totalRecovered = 0, totalArchived = 0, unreadable = 0;

for (const place of places.sort((a, b) => count(b.dir) - count(a.dir))) {
	const files = fs.readdirSync(place.dir).filter(name => name.endsWith('.jsonl'));
	const onDisk = new Set(files.map(name => name.slice(0, -'.jsonl'.length)));
	totalFiles += files.length;

	console.log('── ' + place.label);
	console.log('   session files on disk : ' + files.length);

	if (!fs.existsSync(place.db)) {
		console.log('   state.vscdb           : MISSING at ' + place.db);
		console.log('');
		continue;
	}

	const buffer = fs.readFileSync(place.db);
	const page = pageSize(buffer);
	console.log('   state.vscdb           : ' + (buffer.length / 1024).toFixed(0) + ' KB, '
		+ page + '-byte pages, write format ' + buffer[18] + (buffer[18] === 2 ? ' (WAL)' : ' (rollback journal)'));
	const wal = place.db + '-wal';
	if (fs.existsSync(wal)) {
		console.log('   state.vscdb-wal       : ' + (fs.statSync(wal).size / 1024).toFixed(0) + ' KB  <-- unread by the extension');
	}

	const sites = inspect(buffer);
	const recovered = sites.filter(s => s.kind === 'recovered');
	const broken = sites.filter(s => s.kind === 'value never closes' || s.kind === 'value will not parse');

	console.log('   key sites in the file : ' + sites.length
		+ '  (' + recovered.length + ' recovered, ' + broken.length + ' unreadable, '
		+ sites.filter(s => s.kind === 'index entry, no value').length + ' index-only)');

	for (const site of broken) {
		console.log('     !! ' + site.kind + ', ' + site.bytes + ' bytes reachable'
			+ (site.bytes > localLimit(page) ? '' : '  (under the ' + localLimit(page) + '-byte cell limit)')
			+ (site.why ? '\n        ' + site.why : ''));
		unreadable++;
	}

	if (!recovered.length) {
		console.log('   VERDICT               : nothing readable — the seed adopts nothing here');
		console.log('');
		continue;
	}

	// the extension takes the copy whose newest `read` epoch is latest
	let best = recovered[0];
	let bestRead = -1;
	for (const site of recovered) {
		const read = site.entries.reduce((max, e) => typeof e.read === 'number' && e.read > max ? e.read : max, 0);
		if (read > bestRead) { best = site; bestRead = read; }
	}

	const entries = best.entries;
	const archived = entries.filter(e => e.archived === true);
	const parsed = archived.map(e => decodeSessionId(e.resource)).filter(Boolean);
	const inList = parsed.filter(id => onDisk.has(id));
	totalRecovered += entries.length;
	totalArchived += inList.length;

	console.log('   value taken           : ' + best.bytes + ' bytes of a ' + localLimit(page) + '-byte ceiling'
		+ (best.bytes > localLimit(page) * 0.8 ? '   <-- close to the ceiling' : ''));
	console.log('   entries               : ' + entries.length + ' (of ' + files.length + ' files on disk)');
	console.log('   archived: true        : ' + archived.length);
	console.log('   whose uri decodes     : ' + parsed.length);
	console.log('   and is in the list    : ' + inList.length + '   <-- what the seed would adopt');

	const schemes = new Set(entries.map(e => {
		const r = typeof e.resource === 'string' ? e.resource : JSON.stringify(e.resource);
		return String(r).split(':')[0];
	}));
	console.log('   resource schemes      : ' + [...schemes].join(', '));
	if (archived.length && !parsed.length) {
		console.log('   a rejected resource   : ' + JSON.stringify(archived[0].resource).slice(0, 120));
	}
	console.log('');
}

function count(dir) {
	try { return fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')).length; } catch { return 0; }
}

console.log('════════════════════════════════════════════════════════');
console.log('session files            : ' + totalFiles);
console.log('state entries recovered  : ' + totalRecovered);
console.log('the seed would adopt     : ' + totalArchived);
console.log('unreadable key sites     : ' + unreadable);
console.log('');
if (unreadable && !totalArchived) {
	console.log('This is the failure the report describes: the archive list is in the file');
	console.log('but too large to read back with a byte scan, so nothing gets adopted.');
} else if (!totalRecovered) {
	console.log('VS Code is not writing ' + STATE_KEY + ' where the extension looks.');
} else if (!totalArchived) {
	console.log('The archive list was read and genuinely holds nothing archived for these');
	console.log('sessions — which points somewhere other than the seed.');
}
