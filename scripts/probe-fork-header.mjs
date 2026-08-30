// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 WulffTech

// asserts that a forked session — one giant kind:0 header line, no patch records at
// all — reads correctly once its header outgrows the 512 KB strict-parse cap. builds
// its own fixtures rather than depending on a fork happening to exist on this machine

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { readSession } = require('../out/core/sessions.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-tags-fork-probe-'));
let failures = 0;

function check(label, actual, expected) {
	if (actual === expected) {
		console.log(`  ok   ${label}`);
	} else {
		console.log(`  !!   ${label}: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`);
		failures++;
	}
}

function makeRequest(id, textLen) {
	return {
		requestId: `req-${id}`,
		timestamp: id,
		agent: { extensionId: { value: 'GitHub.copilot-chat' }, extensionVersion: '0.62.0' },
		message: { text: 'x'.repeat(textLen) },
		response: [{ value: 'y'.repeat(textLen) }]
	};
}

function writeFixture(name, v) {
	const file = path.join(dir, name);
	fs.writeFileSync(file, JSON.stringify({ kind: 0, v }) + '\n');
	return file;
}

console.log('── fixtures ──');
console.log(`  ${dir}`);

// case 1: a real fork's shape, comfortably past the 512 KB cap
{
	const requests = Array.from({ length: 40 }, (_, i) => makeRequest(i, 20000));
	const file = writeFixture('big-fork.jsonl', {
		version: 3, creationDate: 1788057423144, customTitle: 'Forked: big one',
		initialLocation: 'panel', responderUsername: '', sessionId: 'fixture-big-fork',
		hasPendingEdits: false, requests
	});
	const info = await readSession(file);
	console.log('big fork, header well over the cap:');
	check('  title', info.title, 'Forked: big one');
	check('  titleSource', info.titleSource, 'headerTitle');
	check('  requestCount', info.requestCount, 40);
	check('  isEmpty', info.isEmpty, false);
	check('  parseError', info.parseError, undefined);
}

// case 2: a small fork stays on the strict path, unaffected by any of this
{
	const requests = Array.from({ length: 3 }, (_, i) => makeRequest(i, 50));
	const file = writeFixture('small-fork.jsonl', {
		version: 3, creationDate: 1788057423144, customTitle: 'Forked: small one',
		initialLocation: 'panel', responderUsername: '', sessionId: 'fixture-small-fork',
		hasPendingEdits: false, requests
	});
	const info = await readSession(file);
	console.log('small fork, under the cap:');
	check('  requestCount', info.requestCount, 3);
	check('  isEmpty', info.isEmpty, false);
}

// case 3: oversized header, genuinely zero requests, but a real title — the row must
// stay visible on the title alone, and the count must stay honest at zero
{
	const file = writeFixture('big-empty.jsonl', {
		version: 3, creationDate: 1788057423144, customTitle: 'Forked: empty but titled',
		initialLocation: 'panel', responderUsername: '', sessionId: 'fixture-empty',
		hasPendingEdits: false, padding: 'z'.repeat(600000), requests: []
	});
	const info = await readSession(file);
	console.log('oversized header, no requests, real title:');
	check('  requestCount', info.requestCount, 0);
	check('  isEmpty', info.isEmpty, false);
}

// case 4: adversarial content — braces, quotes and a fake "requests":[ inside the
// request text itself, designed to fool a scan that does not track string state
{
	const trap = 'literal braces {}{} and a fake key "requests":[ right here, plus a quote \\" and backslash \\\\';
	const requests = Array.from({ length: 5 }, (_, i) => ({
		requestId: `req-${i}`, timestamp: i, message: { text: trap }, response: [{ value: 'z'.repeat(600000) }]
	}));
	const file = writeFixture('adversarial.jsonl', {
		version: 3, creationDate: 1788057423144, customTitle: 'Forked: adversarial',
		initialLocation: 'panel', responderUsername: '', sessionId: 'fixture-adversarial',
		hasPendingEdits: false, requests
	});
	const info = await readSession(file);
	console.log('adversarial content inside the requests array:');
	check('  requestCount', info.requestCount, 5);
	check('  isEmpty', info.isEmpty, false);
}

// case 5: a genuinely corrupt small file must be unaffected — the fallback only ever
// triggers on a truncated read, never on a merely-malformed one
{
	const file = path.join(dir, 'corrupt-small.jsonl');
	fs.writeFileSync(file, '{"kind":0,"v":{not valid json\n');
	const info = await readSession(file);
	console.log('small corrupt header, not truncated:');
	check('  isEmpty', info.isEmpty, true);
	check('  parseError is set', typeof info.parseError === 'string', true);
}

// case 6: oversized and genuinely useless — neither a title nor any requests recoverable.
// the row should still be filtered, but parseError must explain why rather than being
// silently absent, since that silence is the second half of the bug this fixes
{
	const junk = '{"kind":0,"v":{"garbage":"' + 'q'.repeat(700000) + '"}}';
	const file = path.join(dir, 'big-nothing-useful.jsonl');
	fs.writeFileSync(file, junk);
	const info = await readSession(file);
	console.log('oversized header with nothing recoverable:');
	check('  isEmpty', info.isEmpty, true);
	check('  parseError is set', typeof info.parseError === 'string', true);
}

// case 7: a large but realistic fork should read in well under a second and without
// pulling the whole file into a string — this is the regression 0.12.1 exists to guard
{
	const requests = Array.from({ length: 300 }, (_, i) => makeRequest(i, 60000));
	const file = writeFixture('huge-realistic.jsonl', {
		version: 3, creationDate: 1788057423144, customTitle: 'Forked: huge realistic one',
		initialLocation: 'panel', responderUsername: '', sessionId: 'fixture-huge',
		hasPendingEdits: false, requests
	});
	const size = fs.statSync(file).size;
	const start = process.hrtime.bigint();
	const info = await readSession(file);
	const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
	console.log(`realistic scale (${(size / 1024 / 1024).toFixed(1)} MB, 300 requests):`);
	check('  requestCount', info.requestCount, 300);
	console.log(`  elapsed: ${elapsedMs.toFixed(1)} ms`);
	if (elapsedMs > 5000) {
		console.log('  !! took over 5s — this is the cost 0.12.1 exists to keep bounded');
		failures++;
	}
}

fs.rmSync(dir, { recursive: true, force: true });

if (failures) {
	console.error(`FAIL: ${failures} check(s) failed`);
	process.exit(1);
}
console.log('OK');
