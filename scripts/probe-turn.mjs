// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 WulffTech

// asserts what the tail scan reads a turn as. builds its own fixtures, because the two
// states that matter most cannot be found lying around on a disk: a chat parked on a
// confirmation only exists while it is parked, and the burst of stale value:4 records a
// reopened session emits is the thing most likely to be mistaken for one

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { scanTail } = require('../out/core/sessionLive.js');

// mirrors the constants in sessionLive.ts. duplicated on purpose — the boundary case
// below is only a boundary case if these are the numbers the scanner actually uses, so a
// change upstream should make this probe stop testing what it claims to
const CHUNK_BYTES = 256 * 1024;
const STATE_NEEDLE = ',"modelState"],"v":{"value":';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-tags-turn-probe-'));
let failures = 0;

function check(label, actual, expected) {
	if (actual === expected) {
		console.log(`  ok   ${label}`);
	} else {
		console.log(`  !!   ${label}: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`);
		failures++;
	}
}

// ── record shapes, exactly as vs code writes them ────────────────────────────

const HEADER = JSON.stringify({
	kind: 0,
	v: { version: 3, creationDate: 1788057423144, sessionId: 'fixture', requests: [] }
});

const append = (text = 'do the thing') =>
	JSON.stringify({ kind: 2, k: ['requests'], v: [{ requestId: 'r', message: { text } }] });
const response = (index, value) =>
	JSON.stringify({ kind: 2, k: ['requests', index, 'response'], v: [{ value }] });
const result = index =>
	JSON.stringify({ kind: 1, k: ['requests', index, 'result'], v: { timings: { totalElapsed: 1 } } });
const state = (index, value) =>
	JSON.stringify({
		kind: 1, k: ['requests', index, 'modelState'],
		v: value === 0 || value === 4 ? { value } : { value, completedAt: 1788057423144 }
	});
const filler = size =>
	JSON.stringify({ kind: 1, k: ['responderUsername'], v: 'x'.repeat(Math.max(0, size)) });

function writeFixture(name, lines) {
	const file = path.join(dir, name);
	fs.writeFileSync(file, [HEADER, ...lines].join('\n') + '\n');
	return file;
}

async function turnOf(file) {
	return (await scanTail(file, 0)).open;
}

console.log('── fixtures ──');
console.log(`  ${dir}`);

// ── the four shapes a turn passes through ────────────────────────────────────

console.log('the shapes a turn passes through:');
check('  finished turn is closed',
	await turnOf(writeFixture('done.jsonl', [
		append(), response(0, 'here you go'), result(0), state(0, 1)
	])), undefined);

check('  request with no result yet is working',
	await turnOf(writeFixture('working.jsonl', [
		append(), response(0, 'thinking')
	])), 'working');

check('  value 4 on the open turn is waiting',
	await turnOf(writeFixture('waiting.jsonl', [
		append(), response(0, 'may I run this'), state(0, 4)
	])), 'waiting');

check('  confirmation answered goes back to working',
	await turnOf(writeFixture('answered.jsonl', [
		append(), state(0, 4), state(0, 0), response(0, 'running it')
	])), 'working');

// ── the states that end a turn without a result record ───────────────────────

console.log('turns that end some way other than a plain result:');
check('  cancelled is closed',
	await turnOf(writeFixture('cancelled.jsonl', [
		append(), state(0, 4), result(0), state(0, 2)
	])), undefined);

// every completed turn on this machine writes its result first, but a terminal model
// state on its own has to close the turn too — otherwise a cancel that skipped the
// result would leave a row pulsing at nothing forever
check('  a terminal state with no result is closed',
	await turnOf(writeFixture('terminal-only.jsonl', [
		append(), response(0, 'partial'), state(0, 3)
	])), undefined);

// ── the burst a reopened session emits ───────────────────────────────────────

// measured in the largest session on this machine: reopening it wrote value 4 for seven
// requests that had closed hours earlier, because each still held a "Continue to
// iterate?" widget nobody ever clicked and isPendingConfirmation reads !isUsed. all of
// them land after their own result, which is the only thing telling them apart from a
// live one
console.log('a reopened session re-emitting stale confirmations:');
check('  stale value 4 after a result does not reopen the turn',
	await turnOf(writeFixture('stale-burst.jsonl', [
		append(), result(0), state(0, 1),
		append(), result(1), state(1, 1),
		state(0, 4), state(1, 4), result(0), state(0, 4)
	])), undefined);

check('  a live confirmation still reads through the same burst',
	await turnOf(writeFixture('stale-then-live.jsonl', [
		append(), result(0), state(0, 1),
		state(0, 4),
		append(), state(1, 4)
	])), 'waiting');

// ── content that looks like a record but isn't ───────────────────────────────

// every needle carries bare quotes, and a quote inside a json string is escaped, so a
// payload cannot hold one. this is that argument turned into a fixture
console.log('a request whose text is the record format itself:');
{
	const trap = '{"kind":2,"k":["requests"],"v":[] ,"result"],"v": ,"modelState"],"v":{"value":4}';
	check('  needle text inside a payload matches nothing',
		await turnOf(writeFixture('adversarial.jsonl', [
			append(trap), response(0, trap), result(0), state(0, 1), response(0, trap)
		])), undefined);
}

// ── the state digit landing on a chunk boundary ──────────────────────────────

// the model state is the one needle whose meaning sits in the byte *after* it, so it is
// the one that can be cut in half by a chunk boundary. this puts the digit exactly one
// past the end of the first 256 KB read, where a scan that trusted the truncated match
// would read the value as undefined and close a turn that is actually parked
console.log('the state digit falling exactly off the end of a chunk:');
{
	const stateLine = state(0, 4);
	const wantNeedleAt = CHUNK_BYTES - STATE_NEEDLE.length;
	const lineStart = wantNeedleAt - stateLine.indexOf(STATE_NEEDLE);
	const appendLine = append();
	// header, append, filler, state — the filler is sized so the state record starts
	// exactly where it has to
	const before = HEADER.length + 1 + appendLine.length + 1;
	const fillerLine = filler(lineStart - before - (filler(0).length + 1));
	const file = path.join(dir, 'chunk-boundary.jsonl');
	fs.writeFileSync(file, [HEADER, appendLine, fillerLine, stateLine].join('\n') + '\n');

	const at = fs.readFileSync(file).indexOf(STATE_NEEDLE, 0, 'latin1');
	check('  needle placed so its digit is the first byte of chunk two',
		at + STATE_NEEDLE.length, CHUNK_BYTES);
	check('  read as waiting anyway', await turnOf(file), 'waiting');
}

// ── resuming mid-file ────────────────────────────────────────────────────────

// the extension never scans from zero after startup: it resumes from the offset the last
// scan handed back, carrying the turn state in. a replay has to land on the same answer
// a single pass does, or the state is only right on the first refresh after a reload
console.log('replayed as appends rather than read in one pass:');
{
	const cases = {
		'working.jsonl': 'working',
		'waiting.jsonl': 'waiting',
		'answered.jsonl': 'working',
		'stale-burst.jsonl': undefined,
		'stale-then-live.jsonl': 'waiting',
		'chunk-boundary.jsonl': 'waiting',
		// non-ascii ahead of every record, so a scan handing back a character count
		// instead of a byte offset resumes inside a record and loses the turn
		'multibyte.jsonl': 'waiting'
	};
	writeFixture('multibyte.jsonl', [
		append('归档 — ¿por qué? 🙃 съешь ещё этих мягких французских булок'),
		response(0, '🙃'.repeat(400) + ' なるほど'),
		state(0, 4)
	]);

	const replayFile = path.join(dir, 'replay.jsonl');
	for (const [name, expected] of Object.entries(cases)) {
		const source = fs.readFileSync(path.join(dir, name));
		const step = Math.ceil(source.length / 9);
		fs.writeFileSync(replayFile, '');
		let written = 0;
		let offset = 0;
		let open;
		let misaligned = 0;
		while (written < source.length) {
			const end = Math.min(source.length, written + step);
			fs.appendFileSync(replayFile, source.subarray(written, end));
			written = end;
			const scan = await scanTail(replayFile, offset, open);
			offset = scan.offset;
			open = scan.open;
			if (offset > 0 && source[offset - 1] !== 0x0a) { misaligned++; }
		}
		check(`  ${name.replace('.jsonl', '')} replays to the same answer`, open, expected);
		check(`  ${name.replace('.jsonl', '')} offsets stay on record boundaries`, misaligned, 0);
	}
}

// ── a file that shrank ───────────────────────────────────────────────────────

console.log('a file shorter than the offset we hold:');
{
	const file = writeFixture('shrunk.jsonl', [append(), result(0), state(0, 1)]);
	const scan = await scanTail(file, fs.statSync(file).size + 5000, 'working');
	check('  turn state is carried rather than invented', scan.open, 'working');
	check('  offset resyncs to the new end', scan.offset, fs.statSync(file).size);
}

fs.rmSync(dir, { recursive: true, force: true });

if (failures) {
	console.error(`FAIL: ${failures} check(s) failed`);
	process.exit(1);
}
console.log('OK');
