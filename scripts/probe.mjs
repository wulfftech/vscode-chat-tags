// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 WulffTech

/**
 * Offline check of the read model against this machine's real chat sessions.
 * Exercises the same compiled code the extension uses, minus anything vscode-shaped,
 * so parsing and URI construction can be proven without an extension host.
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const { listSessions, activityStateOf, compareSessions } = require('../out/core/sessions.js');
const { localSessionUriString, parseLocalSessionUri } = require('../out/core/sessionUri.js');
const { scanTail } = require('../out/core/sessionApproval.js');
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

const now = Date.now();
const dirs = sessionDirs();
console.log(`session directories : ${dirs.length}`);

const started = Date.now();
const all = [];
const kept = [];
for (const dir of dirs) {
	all.push(...await listSessions(dir, { includeEmpty: true }));
	kept.push(...await listSessions(dir));
}
const elapsed = Date.now() - started;

const bySource = {};
const levels = {};
const states = { active: 0, recent: 0, idle: 0 };
let parseErrors = 0;
let bytes = 0;

for (const session of all) {
	bySource[session.titleSource] = (bySource[session.titleSource] ?? 0) + 1;
	levels[session.permissionLevel] = (levels[session.permissionLevel] ?? 0) + 1;
	bytes += session.fileSize;
	if (session.parseError) {
		parseErrors++;
	}
}
for (const session of kept) {
	states[activityStateOf(session, now)]++;
}

console.log(`sessions on disk    : ${all.length}`);
console.log(`shown (non-empty)   : ${kept.length}`);
console.log(`hidden (never used) : ${all.length - kept.length}`);
console.log(`parse errors        : ${parseErrors}`);
console.log(`title sources       : ${JSON.stringify(bySource)}`);
console.log(`activity states     : ${JSON.stringify(states)}`);
console.log(`permission levels   : ${JSON.stringify(levels)}`);

// scanned from the top rather than from an activation baseline, so this reports history
// rather than liveness — enough to prove the marker still parses out of real files
const approval = { approving: 0, stopped: 0, noTerminal: 0 };
for (const session of all) {
	const scan = await scanTail(session.filePath, 0);
	if (scan.approving === true) { approval.approving++; }
	else if (scan.approving === false) { approval.stopped++; }
	else { approval.noTerminal++; }
}
console.log(`session approval    : ${JSON.stringify(approval)}`);
console.log(`bytes on disk       : ${(bytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`scan time           : ${elapsed} ms (two full passes)`);

// the extension never scans from zero. it resumes from the offset the previous scan
// handed back, against a file that has grown since, and that is the loop where an
// offset which is not a real byte position does its damage — it resumes mid-record and
// reads a terminal command as one nothing approved. so the loop is walked rather than
// assumed: every session is replayed as a series of appends and has to end on the same
// verdict the single full scan reached. resuming reads only the delta, so replaying a
// session costs about one pass over it however many steps it is cut into
const RESUME_STEPS = 7;
const replayFile = path.join(os.tmpdir(), `chat-tags-resume-${process.pid}.jsonl`);
const resume = { replayed: 0, skipped: 0, misaligned: 0, mismatched: 0 };
const resumeProblems = [];

for (const session of all) {
	const full = await scanTail(session.filePath, 0);

	// an offset landing anywhere but just past a newline will resume mid-record
	if (full.offset > 0) {
		const boundary = Buffer.alloc(1);
		const handle = await fs.promises.open(session.filePath, 'r');
		await handle.read(boundary, 0, 1, full.offset - 1);
		await handle.close();
		if (boundary[0] !== 0x0A) {
			resume.misaligned++;
			resumeProblems.push(
				`${session.sessionId} offset ${full.offset} of ${session.fileSize} is not a record boundary`
			);
		}
	}

	// only sessions carrying a marker can disagree about a verdict, and replaying the
	// other 47 would write a hundred megabytes to say undefined seven more times
	if (full.approving === undefined) {
		resume.skipped++;
		continue;
	}

	const source = await fs.promises.open(session.filePath, 'r');
	const sink = await fs.promises.open(replayFile, 'w');
	try {
		const step = Math.ceil(session.fileSize / RESUME_STEPS);
		const slice = Buffer.alloc(step);
		let written = 0;
		let offset = 0;
		let verdict;
		while (written < session.fileSize) {
			const { bytesRead } = await source.read(slice, 0, step, written);
			if (bytesRead === 0) {
				break;
			}
			await sink.write(slice, 0, bytesRead, written);
			written += bytesRead;
			const scan = await scanTail(replayFile, offset);
			offset = scan.offset;
			if (scan.approving !== undefined) {
				verdict = scan.approving;
			}
		}
		resume.replayed++;
		if (verdict !== full.approving) {
			resume.mismatched++;
			resumeProblems.push(
				`${session.sessionId} replayed to ${verdict} but a full scan says ${full.approving}`
			);
		}
	} finally {
		await source.close();
		await sink.close();
	}
}
await fs.promises.unlink(replayFile).catch(() => {});

console.log(
	`resume replay       : ${resume.replayed} replayed in ${RESUME_STEPS} steps, ` +
	`${resume.skipped} with no marker skipped`
);
console.log(`offsets misaligned  : ${resume.misaligned} of ${all.length}`);
console.log(`verdicts changed    : ${resume.mismatched} of ${resume.replayed}`);

console.log('\n--- sessions as the tree would show them ---');
for (const session of kept.slice(0, 12)) {
	const uri = localSessionUriString(session.sessionId);
	const roundTrip = parseLocalSessionUri(uri) === session.sessionId;
	console.log(
		`  ${activityStateOf(session, now).padEnd(6)} ` +
		`${String(session.requestCount).padStart(3)} req  ` +
		`${session.titleSource.padEnd(12)} ` +
		`${roundTrip ? 'uri:ok' : 'uri:FAIL'}  ` +
		`${session.title}`
	);
}

// the two orders are only worth offering if they actually disagree on real data
const byActivity = [...kept].sort(compareSessions('activity'));
const byCreated = [...kept].sort(compareSessions('created'));
const agree = byActivity.filter((session, index) => byCreated[index] === session).length;
const noCreationDate = kept.filter(session => !session.createdAt).length;
const outOfOrder = byCreated.filter((session, index) =>
	index > 0 && (byCreated[index - 1].createdAt || 0) < (session.createdAt || 0)).length;

console.log('');
console.log(`sessions ordered    : ${kept.length}`);
console.log(`no creationDate     : ${noCreationDate}`);
console.log(`orders agree on     : ${agree} of ${kept.length} positions`);

const failures = [];
if (resumeProblems.length) {
	failures.push(...resumeProblems);
}
if (outOfOrder) {
	failures.push(`created order is wrong at ${outOfOrder} position(s)`);
}
if (byActivity.length !== kept.length || byCreated.length !== kept.length) {
	failures.push('sorting dropped sessions');
}
if (kept.length === 0) {
	failures.push('no sessions parsed');
}
if (parseErrors > 0) {
	failures.push(`${parseErrors} parse error(s)`);
}
const stillUuid = kept.filter(s => s.titleSource === 'fallback');
if (stillUuid.length) {
	failures.push(`${stillUuid.length} shown session(s) have no recoverable title`);
}
for (const session of kept) {
	if (parseLocalSessionUri(localSessionUriString(session.sessionId)) !== session.sessionId) {
		failures.push(`uri round-trip failed for ${session.sessionId}`);
	}
}

console.log('');
if (failures.length) {
	console.log(`PROBE FAILED: ${failures.join('; ')}`);
	process.exitCode = 1;
} else {
	console.log('PROBE PASSED');
}
