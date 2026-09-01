// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 WulffTech

// asserts what the pane reads about a chat's model and how full its context is. three
// readers have to agree: readSelectedModel on the shape, scanSessionDeltas on the forward
// pass, and scanTail on the live one — and the rule that matters most is the one that says
// when *not* to answer. a stale context reading is worse than a blank: it says a chat is a
// tenth full when it is nearly out of room.
//
// fixtures are built here rather than found on disk, because the cases worth testing are
// the ones a real store does not conveniently hold: a value cut by the record prefix cap,
// a number split across a chunk boundary, a forward scan that hit its byte ceiling

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { readSelectedModel } = require('../out/core/sessionModel.js');
const { scanSessionDeltas } = require('../out/core/deltaScan.js');
const { scanTail } = require('../out/core/sessionLive.js');
const { readSession } = require('../out/core/sessions.js');

// mirrors the constants upstream. duplicated on purpose, exactly as probe-turn.mjs does
// it — the boundary cases below are only boundary cases if these are the real numbers
const CHUNK_BYTES = 256 * 1024;
const PREFIX_BYTES = 2048;
const DELTA_SCAN_CAP = 4 * 1024 * 1024;
const TOKENS_NEEDLE = ',"promptTokens"],"v":';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-tags-model-probe-'));
let failures = 0;

function check(label, actual, expected) {
	const same = JSON.stringify(actual) === JSON.stringify(expected);
	if (same) {
		console.log(`  ok   ${label}`);
	} else {
		console.log(`  !!   ${label}: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`);
		failures++;
	}
}

// ── record shapes, exactly as vs code writes them ────────────────────────────

const modelValue = (name, maxInputTokens, extra = {}) => ({
	identifier: `openrouter/OpenRouter/${name}`,
	metadata: { extension: { value: 'GitHub.copilot-chat' }, id: name, vendor: 'openrouter', name, maxInputTokens, ...extra }
});

const header = (fields = {}) => JSON.stringify({
	kind: 0,
	v: {
		version: 3, creationDate: 1788057423144, sessionId: 'fixture', requests: [],
		inputState: { permissionLevel: 'default', ...fields }
	}
});
const pickModel = value => JSON.stringify({ kind: 1, k: ['inputState', 'selectedModel'], v: value });
const tokens = (index, value) => JSON.stringify({ kind: 1, k: ['requests', index, 'promptTokens'], v: value });
const tokenDetails = index => JSON.stringify({
	kind: 1, k: ['requests', index, 'promptTokenDetails'],
	v: [{ category: 'System', label: 'Tool Definitions', percentageOfPrompt: 78 }]
});
const append = () => JSON.stringify({ kind: 2, k: ['requests'], v: [{ requestId: 'r', message: { text: 'go' } }] });
const filler = size => JSON.stringify({ kind: 1, k: ['responderUsername'], v: 'x'.repeat(Math.max(0, size)) });

function writeFixture(name, lines, head = header()) {
	const file = path.join(dir, name);
	fs.writeFileSync(file, [head, ...lines].join('\n') + '\n');
	return file;
}

// ── the shape ────────────────────────────────────────────────────────────────

console.log('reading a selectedModel value:');
{
	check('  name and window come off the metadata',
		readSelectedModel(modelValue('Ox Alpha', 917504)), { name: 'Ox Alpha', maxInputTokens: 917504 });

	const nameless = modelValue('x', 128000);
	delete nameless.metadata.name;
	check('  a nameless entry falls back to its identifier',
		readSelectedModel(nameless), { name: 'openrouter/OpenRouter/x', maxInputTokens: 128000 });

	check('  a window of zero is no window rather than an empty one',
		readSelectedModel(modelValue('Auto', 0)), { name: 'Auto', maxInputTokens: undefined });
	check('  a window that is not a number is dropped, the name is not',
		readSelectedModel(modelValue('Auto', '128k')), { name: 'Auto', maxInputTokens: undefined });
	check('  no metadata at all still yields the identifier',
		readSelectedModel({ identifier: 'bare/model' }), { name: 'bare/model', maxInputTokens: undefined });
	check('  nothing nameable is nothing', readSelectedModel({ metadata: { vendor: 'x' } }), undefined);
	check('  a non-object is nothing', readSelectedModel('Ox Alpha'), undefined);
	check('  undefined is nothing', readSelectedModel(undefined), undefined);
}

// ── the header ───────────────────────────────────────────────────────────────

console.log('a session that never moved either picker:');
{
	const file = writeFixture('header-only.jsonl', [append()],
		header({ selectedModel: modelValue('Claude Haiku 4.5', 128000) }));
	const info = await readSession(file);
	check('  the model comes off the header', info.model, { name: 'Claude Haiku 4.5', maxInputTokens: 128000 });
	check('  and no context reading is invented', info.promptTokens, undefined);
}

// ── the forward pass ─────────────────────────────────────────────────────────

console.log('the forward scan over patch records:');
{
	const file = writeFixture('moved.jsonl', [
		append(),
		pickModel(modelValue('Ox Alpha', 917504)),
		tokens(0, 33534),
		tokenDetails(0),
		pickModel(modelValue('Claude Haiku 4.5', 128000)),
		tokens(0, 41351),
		tokens(0, 62286)
	], header({ selectedModel: modelValue('Auto', 935793) }));

	const deltas = await scanSessionDeltas(file);
	check('  the last move of the picker wins', deltas.model, { name: 'Claude Haiku 4.5', maxInputTokens: 128000 });
	check('  the last prompt size wins', deltas.promptTokens, 62286);
	check('  the scan did not hit its ceiling', deltas.truncated, false);

	const info = await readSession(file);
	check('  a delta beats the header it went stale against', info.model?.name, 'Claude Haiku 4.5');
	check('  and the reading reaches the row', info.promptTokens, 62286);
}

console.log('records that look like the ones we want and are not:');
{
	const file = writeFixture('lookalikes.jsonl', [
		append(),
		tokens(0, 5000),
		// promptTokenDetails shares the prefix and carries an array of percentages. the
		// closing bracket in the needle is the whole reason it cannot be mistaken for a size
		tokenDetails(0),
		// a completion size is a different number on the same request
		JSON.stringify({ kind: 1, k: ['requests', 0, 'completionTokens'], v: 999999 }),
		// and a value that is not a number at all
		JSON.stringify({ kind: 1, k: ['requests', 0, 'promptTokens'], v: null })
	]);
	const deltas = await scanSessionDeltas(file);
	check('  details, completions and nulls all leave the reading alone', deltas.promptTokens, 5000);

	const scan = await scanTail(file, 0);
	check('  and the tail scan agrees', scan.promptTokens, 5000);
}

console.log('a selectedModel value too long for the record prefix cap:');
{
	// vs code writes a configurationSchema into some of these. every one on this machine
	// still lands under the cap — the largest is 1193 bytes against 2048 — but a provider
	// with a longer schema would push the value past it, and a half-read object must not
	// overwrite a whole one
	const huge = modelValue('Verbose Provider', 200000, { tooltip: 'y'.repeat(PREFIX_BYTES) });
	const file = writeFixture('oversized-value.jsonl', [
		append(),
		pickModel(modelValue('Ox Alpha', 917504)),
		pickModel(huge)
	]);
	const deltas = await scanSessionDeltas(file);
	check('  the cut record is not read', deltas.model?.name, 'Ox Alpha');
	check('  and it did not clear the window either', deltas.model?.maxInputTokens, 917504);
}

console.log('a file longer than the forward scan will read:');
{
	// the cap is the whole point: past it the last record read is an *early* one, and an
	// early prompt size is a lie about a session that has been running for hours
	const file = writeFixture('over-the-cap.jsonl', [
		append(),
		pickModel(modelValue('Ox Alpha', 917504)),
		tokens(0, 12000),
		filler(DELTA_SCAN_CAP),
		tokens(0, 640000)
	]);
	const deltas = await scanSessionDeltas(file);
	check('  the scan reports it stopped early', deltas.truncated, true);
	check('  and read only what it reached', deltas.promptTokens, 12000);

	const info = await readSession(file);
	check('  so the row is given no reading at all', info.promptTokens, undefined);
	check('  but keeps the model, which does not go stale the same way', info.model?.name, 'Ox Alpha');

	// the tail scan is what covers this case in the product
	const scan = await scanTail(file, 0);
	check('  the tail scan finds the newest one', scan.promptTokens, 640000);
}

// ── the live pass ────────────────────────────────────────────────────────────

console.log('a prompt size split across a chunk boundary:');
{
	// the digits have to land either side of a 256 kb read. the run is dropped on the pass
	// that cannot see all of it and picked up whole by the overlap on the next one — the
	// same bargain the model state's single digit makes
	const lead = [header(), append()].join('\n').length + 1;
	const record = tokens(0, 657638);
	const digitsAt = record.indexOf(TOKENS_NEEDLE) + TOKENS_NEEDLE.length;
	// pad so the boundary falls two digits into the number
	const pad = CHUNK_BYTES - lead - (digitsAt + 2) - 1;
	const file = writeFixture('split-number.jsonl', [append(), filler(pad - filler(0).length), record]);

	const at = fs.readFileSync(file).indexOf(TOKENS_NEEDLE) + TOKENS_NEEDLE.length;
	check('  the fixture really does straddle the boundary', at < CHUNK_BYTES && at + 6 > CHUNK_BYTES, true);
	const scan = await scanTail(file, 0);
	check('  and the whole number is still read', scan.promptTokens, 657638);
}

console.log('the live pass, replayed the way a watcher replays it:');
{
	const file = writeFixture('replay.jsonl', [
		append(), tokens(0, 1000), tokens(0, 2000), tokenDetails(0), tokens(0, 3000)
	]);
	const source = fs.readFileSync(file);

	// a watcher fires per append, so the same file is read as a run of small deltas. the
	// answer has to survive being assembled that way
	let offset = 0;
	let seen;
	let misaligned = 0;
	for (let cut = 1; cut <= source.length; cut += 7) {
		const partial = path.join(dir, 'replay-partial.jsonl');
		fs.writeFileSync(partial, source.subarray(0, Math.min(cut, source.length)));
		const scan = await scanTail(partial, offset);
		offset = scan.offset;
		if (scan.promptTokens !== undefined) { seen = scan.promptTokens; }
		if (offset > 0 && source[offset - 1] !== 0x0a) { misaligned++; }
	}
	check('  replaying in slices lands on the same reading', seen, 3000);
	check('  offsets stay on record boundaries', misaligned, 0);

	const whole = await scanTail(file, 0);
	check('  and one pass over the whole file agrees', whole.promptTokens, 3000);
}

console.log('bytes that say nothing about either question:');
{
	const file = writeFixture('quiet.jsonl', [append(), JSON.stringify({ kind: 1, k: ['customTitle'], v: 'A chat' })]);
	const scan = await scanTail(file, 0);
	check('  a delta with no prompt size in it reports none', scan.promptTokens, undefined);

	const shrunk = await scanTail(file, fs.statSync(file).size + 5000);
	check('  and a file that shrank invents none either', shrunk.promptTokens, undefined);
}

fs.rmSync(dir, { recursive: true, force: true });

if (failures) {
	console.error(`FAIL: ${failures} check(s) failed`);
	process.exit(1);
}
console.log('OK');
