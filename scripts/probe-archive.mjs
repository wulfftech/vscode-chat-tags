// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 WulffTech

// reports what the archive seed would take from vs code's own store, and asserts the
// stale-page rule that decides it. read-only — it touches neither the memento nor a db

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
	findStateArrays, newestArray, readArchivedSessionIds, readStateCopies, stateDbBeside
} = require('../out/core/archiveSeed.js');

const user = process.env.CHAT_TAGS_USER_DIR
	?? path.join(process.env.APPDATA ?? '', 'Code', 'User');
const root = path.join(user, 'workspaceStorage');

let failures = 0;

function maxRead(entries) {
	let read = 0;
	for (const entry of entries ?? []) {
		if (typeof entry.read === 'number' && entry.read > read) {
			read = entry.read;
		}
	}
	return read;
}

// ── stale pages ──────────────────────────────────────────────────────────────

// a freed page can still hold a superseded copy of the array, so a file is only
// unambiguous when it holds one. where it holds more the newest has to win, or the seed
// can archive a chat the user restored. checked against every database, not only the
// ones with sessions beside them — the multi-copy files are usually the other kind
console.log('── copies per database ──');
let multiCopy = 0;
for (const hash of fs.readdirSync(root)) {
	const database = path.join(root, hash, 'state.vscdb');
	if (!fs.existsSync(database)) {
		continue;
	}
	const copies = await readStateCopies(database);
	if (copies.length < 2) {
		continue;
	}
	multiCopy++;
	const chosenRead = maxRead(newestArray(copies));
	const reads = copies.map(maxRead);
	const stale = reads.filter(read => read > chosenRead).length;
	console.log(`${hash}: ${copies.length} copies, reads ${reads.join(', ')} → chose ${chosenRead}`);
	if (stale) {
		console.log('  !! resolved to a copy older than one in the same file');
		failures++;
	}
}
console.log(`files holding more than one copy: ${multiCopy}`);

// the on-disk set is whatever this machine happens to hold, and it has been one-copy
// for whole releases at a time. this pins the rule down regardless
const synthetic = Buffer.from(
	'agentSessions.state.cache[{"resource":"vscode-chat-session://local/YQ","archived":true,"read":100}]'
	+ 'agentSessions.state.cache[{"resource":"vscode-chat-session://local/Yg","archived":true,"read":900}]'
	+ 'agentSessions.state.cache',
	'utf8'
);
const syntheticCopies = findStateArrays(synthetic);
const syntheticChosen = newestArray(syntheticCopies);
if (syntheticCopies.length !== 2) {
	console.log(`  !! synthetic: expected 2 copies, got ${syntheticCopies.length}`);
	failures++;
} else if (maxRead(syntheticChosen) !== 900) {
	console.log(`  !! synthetic: chose the copy read at ${maxRead(syntheticChosen)}, wanted 900`);
	failures++;
} else {
	console.log('synthetic two-copy file: newest won, trailing keyless hit ignored');
}

// ── seeding rules ────────────────────────────────────────────────────────────

// the store needs vscode for its event emitter, and nothing else. stubbing that one
// class is cheaper than leaving the rule that protects a restore untested
const Module = require('module');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	return request === 'vscode' ? 'vscode' : resolve.call(this, request, ...rest);
};
require.cache.vscode = {
	id: 'vscode', filename: 'vscode', loaded: true,
	exports: { EventEmitter: class { get event() { return () => ({ dispose() {} }); } fire() {} dispose() {} } }
};
const { TagStore } = require('../out/model/categories.js');

function fakeMemento() {
	const values = new Map();
	return {
		get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
		update: (key, value) => { values.set(key, value); return Promise.resolve(); }
	};
}

function check(label, actual, expected) {
	if (actual === expected) {
		console.log(`  ok   ${label}`);
	} else {
		console.log(`  !!   ${label}: got ${actual}, wanted ${expected}`);
		failures++;
	}
}

console.log('');
console.log('── seeding rules ──');
{
	const tags = new TagStore(fakeMemento());

	check('first seed takes both', await tags.seedArchived(['a', 'b']), 2);
	check('a is archived', Boolean(tags.meta('a').archivedAt), true);

	check('a second pass takes nothing', await tags.seedArchived(['a', 'b']), 0);

	// the rule the whole design turns on: a restore here outlives the next read
	await tags.setArchived('a', false);
	check('restore cleared it', Boolean(tags.meta('a').archivedAt), false);
	check('reseeding a restored chat takes nothing', await tags.seedArchived(['a']), 0);
	check('it stays restored', Boolean(tags.meta('a').archivedAt), false);

	// a chat archived over there after the first pass still arrives
	check('a newly archived chat is taken', await tags.seedArchived(['c']), 1);
	check('c is archived', Boolean(tags.meta('c').archivedAt), true);

	// an existing archive date is not overwritten by the seed
	const tags2 = new TagStore(fakeMemento());
	await tags2.setArchived('d', true);
	const stamped = tags2.meta('d').archivedAt;
	await tags2.seedArchived(['d']);
	check('an existing date survives', tags2.meta('d').archivedAt, stamped);

	// metadata that has nothing to do with archiving is left alone
	const tags3 = new TagStore(fakeMemento());
	await tags3.setCategory('e', 'cat_x');
	await tags3.seedArchived(['e']);
	check('other metadata survives', tags3.meta('e').categoryId, 'cat_x');
}

// ── what the seed would take ─────────────────────────────────────────────────

console.log('');
console.log('── archived sessions ──');
let workspaces = 0;
let archivedTotal = 0;
let takenTotal = 0;
let missingTotal = 0;

for (const hash of fs.readdirSync(root)) {
	const sessions = path.join(root, hash, 'chatSessions');
	if (!fs.existsSync(sessions)) {
		continue;
	}
	workspaces++;

	const database = stateDbBeside(sessions);
	const archived = await readArchivedSessionIds(database);
	archivedTotal += archived.length;
	if (!archived.length) {
		continue;
	}

	// the seed only takes ids that are in the list, so a stale or misread page cannot
	// archive a row that was never ours. report both sides of that filter
	const onDisk = new Set(
		fs.readdirSync(sessions)
			.filter(name => name.endsWith('.jsonl'))
			.map(name => name.slice(0, -'.jsonl'.length))
	);
	const taken = archived.filter(id => onDisk.has(id));
	takenTotal += taken.length;
	missingTotal += archived.length - taken.length;

	console.log(`${hash}: ${archived.length} archived, ${taken.length} in the list`);
	for (const id of archived) {
		console.log(`    ${onDisk.has(id) ? '+' : '-'} ${id}`);
	}
}

console.log('');
console.log(`workspaces with chatSessions: ${workspaces}`);
console.log(`archived in vs code: ${archivedTotal}`);
console.log(`  the seed would take: ${takenTotal}`);
console.log(`  skipped, not in the list: ${missingTotal}`);

if (failures) {
	console.error(`FAIL: ${failures} check(s) failed`);
	process.exit(1);
}
console.log('OK');
