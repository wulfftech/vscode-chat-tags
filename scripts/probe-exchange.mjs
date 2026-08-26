// offline check of the last-exchange reader against this machine's real sessions
// the llm layer can't be exercised without an extension host, but everything it is fed
// can be, so this proves the input before anything is spent generating from it
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const { readLastExchange, readOpeningMessages } = require('../out/core/sessionContent.js');
const { buildStatusPrompt, buildTaskPrompt, buildTitlePrompt, tidy, tidyTitle } = require('../out/core/subtitleText.js');
const { listSessions } = require('../out/core/sessions.js');
const { WORKSPACE_SESSIONS_DIRNAME, EMPTY_WINDOW_SESSIONS_DIRNAME } = require('../out/core/locations.js');

const userDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User');

function sessionDirs() {
	const dirs = [];
	const emptyWindow = path.join(userDir, 'globalStorage', EMPTY_WINDOW_SESSIONS_DIRNAME);
	if (fs.existsSync(emptyWindow)) {
		dirs.push(emptyWindow);
	}
	const workspaceStorage = path.join(userDir, 'workspaceStorage');
	if (fs.existsSync(workspaceStorage)) {
		for (const hash of fs.readdirSync(workspaceStorage)) {
			const candidate = path.join(workspaceStorage, hash, WORKSPACE_SESSIONS_DIRNAME);
			if (fs.existsSync(candidate)) {
				dirs.push(candidate);
			}
		}
	}
	return dirs;
}

const verbose = process.argv.includes('--verbose');
const showPrompt = process.argv.includes('--prompt');

// how models actually answer when asked for a short line
const TIDY_CASES = [
	['Waiting for API key', 'Waiting for API key'],
	['"Waiting for API key"', 'Waiting for API key'],
	['**Tests failing on CI**', 'Tests failing on CI'],
	['- Retrying after request errors', 'Retrying after request errors'],
	['Status: Waiting for review', 'Waiting for review'],
	['Waiting for API key.', 'Waiting for API key'],
	['Here is a status line:\nBlocked on schema migration', 'Here is a status line'],
	['   Refactor applied, unverified   ', 'Refactor applied, unverified'],
	['A very long status line that runs well past the forty-eight character ceiling', 'A very long status line that runs well past the'],
	['Supercalifragilisticexpialidociousunbrokenwordthatcannotbesplitanywhereatall', 'Supercalifragilisticexpialidociousunbrokenwordth'],
	['', ''],
	['`waiting on user`', 'waiting on user']
];

let tidyFailures = 0;
for (const [input, expected] of TIDY_CASES) {
	const actual = tidy(input);
	if (actual !== expected) {
		tidyFailures++;
		console.log(`tidy MISMATCH ${JSON.stringify(input)}`);
		console.log(`     expected ${JSON.stringify(expected)}`);
		console.log(`     actual   ${JSON.stringify(actual)}`);
	}
	if (actual.length > 48) {
		tidyFailures++;
		console.log(`tidy OVER 48 CHARS: ${JSON.stringify(actual)}`);
	}
}
console.log(`tidy: ${TIDY_CASES.length - tidyFailures} of ${TIDY_CASES.length} cases pass`);
console.log('');
const dirs = sessionDirs();
const sessions = (await Promise.all(dirs.map(dir => listSessions(dir)))).flat();
sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);

console.log(`sessions: ${sessions.length}`);
console.log('');

let openingOk = 0;
let openingMs = 0;
let openingBytes = 0;
let withUser = 0;
let withAssistant = 0;
let withConfirmation = 0;
let failures = 0;
let totalMs = 0;
let scanned = 0;

for (const session of sessions) {
	const started = Date.now();
	let exchange;
	try {
		exchange = await readLastExchange(session.filePath);
	} catch (error) {
		failures++;
		console.log(`FAIL ${session.title}: ${error.message}`);
		continue;
	}
	const elapsed = Date.now() - started;
	totalMs += elapsed;
	scanned += exchange.bytesScanned;

	if (exchange.userText) { withUser++; }
	if (exchange.assistantText) { withAssistant++; }
	if (exchange.pendingConfirmation) { withConfirmation++; }

	const mb = (session.fileSize / 1048576).toFixed(1);
	console.log(
		`${String(elapsed).padStart(5)}ms ${String(mb).padStart(6)}mb  req#${String(exchange.requestIndex).padStart(3)}  ` +
		`${exchange.userText ? 'u' : '-'}${exchange.assistantText ? 'a' : '-'}` +
		`${exchange.activity.length ? 'v' : '-'}${exchange.pendingConfirmation ? 'c' : '-'}` +
		`${exchange.systemInitiated ? 's' : '-'}${exchange.truncated ? 'T' : '-'}  ${session.title.slice(0, 46)}`
	);

	const openStarted = Date.now();
	let opening;
	try {
		opening = await readOpeningMessages(session.filePath, 5);
	} catch (error) {
		opening = { messages: [], bytesScanned: 0 };
		console.log(`OPENING FAIL ${session.title}: ${error.message}`);
	}
	openingMs += Date.now() - openStarted;
	openingBytes += opening.bytesScanned;
	if (opening.messages.length) { openingOk++; }

	if (showPrompt) {
		const prompt = buildStatusPrompt(session.title, exchange);
		console.log('        ── prompt (' + prompt.length + ' chars) ──');
		console.log(prompt.split('\n').map(l => '        ' + l).join('\n'));
		console.log('');
	}

	if (verbose) {
		console.log(`        open : ${opening.messages.length} msg · ${(opening.bytesScanned/1048576).toFixed(2)}mb scanned`);
		opening.messages.forEach((m, i) => console.log(`          ${i + 1}. ${m.slice(0, 120)}`));
		console.log(`        user : ${(exchange.userText ?? '(none)').slice(0, 140)}`);
		console.log(`        asst : ${(exchange.assistantText ?? '(none)').slice(0, 140)}`);
		if (exchange.activity.length) {
			console.log(`        did  : ${exchange.activity.join(' | ').slice(0, 140)}`);
		}
		if (exchange.pendingConfirmation) {
			console.log(`        wait : ${exchange.pendingConfirmation.slice(0, 140)}`);
		}
		console.log('');
	}
}

console.log('');
console.log(`user text recovered      : ${withUser} of ${sessions.length}`);
console.log(`assistant text recovered : ${withAssistant} of ${sessions.length}`);
console.log(`parked on a confirmation : ${withConfirmation}`);
console.log(`failures                 : ${failures}`);
console.log(`total scan time          : ${totalMs}ms over ${(scanned / 1048576).toFixed(0)}mb`);
console.log(`opening msgs recovered   : ${openingOk} of ${sessions.length}`);
console.log(`opening scan time        : ${openingMs}ms over ${(openingBytes / 1048576).toFixed(0)}mb`);
