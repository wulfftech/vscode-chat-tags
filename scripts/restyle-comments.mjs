// one-shot pass to bring comments in line with the house style: lowercase, no
// docstrings, why-not-what. kept in the repo so the next batch of files can reuse it.
import * as fs from 'node:fs';

const edits = [
	['src/core/sessionUri.ts', [
		[
			'/**\n * Local chat sessions are addressed by a URI of the form:\n *\n *   vscode-chat-session://local/<base64url(sessionId)>\n *\n * Derived from the workbench\'s own `ChatSessionUri.forSession`, which base64-encodes\n * the session id URL-safe and unpadded, and uses the session type as the authority.\n * `SessionType.Local` is the string "local".\n */',
			'// local sessions are addressed as vscode-chat-session://local/<base64url(sessionId)>\n// mirrors the workbench\'s ChatSessionUri.forSession — url-safe base64, no padding,\n// session type as the authority. SessionType.Local is the string "local"'
		],
		['/** Builds the workbench URI for a local chat session id. */', '// workbench URI for a local chat session id'],
		['/** Inverse of {@link localSessionUriString}; returns undefined for anything else. */', '// inverse of localSessionUriString — undefined for anything that is not a local session']
	]],

	['src/core/deltaScan.ts', [
		[
			'/**\n * After the `kind: 0` header, each line is a patch record:\n *\n *   {"kind":1,"k":["customTitle"],"v":"Assess public datasets"}   // set value at path k\n *   {"kind":2,"k":["requests"],"v":[ ... ]}                       // append to array at path k\n *\n * The header is written once at session creation and never rewritten, so a busy\n * session can show zero requests and no title there while carrying megabytes of\n * patches. Anything user-visible therefore has to come from this log.\n *\n * Records that matter are short and appear early; the ones that are huge are request\n * appends whose payload we do not need. So we stream the file and only look at the\n * first slice of each line, which keeps a 50 MB session cheap to inspect.\n */',
			'// after the kind:0 header every line is a patch record:\n//   {"kind":1,"k":["customTitle"],"v":"..."}  set value at path k\n//   {"kind":2,"k":["requests"],"v":[...]}     append to array at path k\n// the header is written once at creation and never rewritten — a 954-line session\n// reports zero requests and no title there, so anything user-visible comes from here\n// the records we want are short and early; the huge ones are request appends whose\n// payload we do not need, so we read only the first slice of each line'
		],
		['\t/** First thing the user typed — a decent title when no customTitle was ever set. */', '\t// first thing the user typed — the title when no customTitle was ever set'],
		['\t/** True when the byte cap stopped us early, so counts are a lower bound. */', '\t// byte cap stopped us early, so counts are a lower bound'],
		['\t\t// Short records arrive whole, so a real parse is both safe and exact.', '\t\t// short records arrive whole, so a real parse is exact'],
		['\t\t// Truncated by the prefix cap: recover the value with a narrower match.', '\t\t// truncated by the prefix cap — recover the value with a narrower match'],
		['\t\t\t// Later records win: the title can be regenerated or renamed mid-session.', '\t\t\t// later records win — the title gets regenerated or renamed mid-session'],
		[
			'/**\n * Streams a session file and pulls out the few fields the UI needs. Only the first\n * {@link PREFIX_BYTES} of each line are retained, and scanning stops after\n * `maxScanBytes` so one enormous session cannot stall a refresh.\n */',
			'// pulls the few fields the UI needs out of a session file\n// stops after maxScanBytes so one 50mb session cannot stall a refresh'
		],
		['firstLineSkipped = true; // the kind:0 header is parsed elsewhere', 'firstLineSkipped = true; // kind:0 header is parsed elsewhere'],
		['\t\t\t// Keep only enough of an unterminated line to identify it.', '\t\t\t// keep only enough of an unterminated line to identify it'],
		['\t\t\t\t// Drop the rest of this line without holding it in memory.', '\t\t\t\t// drop the rest rather than buffering 10mb of request payload'],
		['\t\t\t\t\t// Skip ahead to the next newline in the file.', '\t\t\t\t\t// skip ahead to the next newline'],
		['/** Advances past the remainder of an over-long line, returning any text after it. */', '// advances past the remainder of an over-long line, returning any text after it']
	]],

	['src/core/sessions.ts', [
		[
			'/**\n * Session files are append-structured JSONL: a `kind: 0` snapshot followed by patch\n * records. The snapshot is written at creation and not rewritten, so titles and\n * request counts are read from the patch log and only fall back to the header.\n * Last-activity comes from the file\'s mtime, which stays correct regardless of format.\n */',
			'// session files are append-structured jsonl — a kind:0 snapshot then patch records\n// the snapshot goes stale immediately, so titles and counts come from the patch log\n// and only fall back to the header\n// last-activity is the file mtime, which stays right regardless of format churn'
		],
		['\t/** No requests and no title — a session that was opened but never used. */', '\t// no requests and no title — opened but never used'],
		['\t/** Below this age (ms) a session counts as actively responding. */', '\t// below this age (ms) a session counts as actively responding'],
		['\t/** Below this age (ms) a session counts as recently touched. */', '\t// below this age (ms) a session counts as recently touched'],
		['/** Reads just the first line; session files reach tens of megabytes. */', '// reads just the first line — session files reach tens of megabytes'],
		['/** Reads one session file, preferring patch-log values over the stale header. */', '// reads one session file, preferring patch-log values over the stale header'],
		['\t/** Drop sessions that were opened but never used; the native list hides these too. */', '\t// drop sessions opened but never used — the native list hides these too'],
		['/** Reads every `*.jsonl` session in a directory, newest activity first. */', '// every *.jsonl session in a directory, newest activity first']
	]],

	['src/tree.ts', [
		[
			'/**\n * Phase 1 renders a flat, activity-coloured list. Categories and subtitles land in\n * later phases; the colours here come from built-in theme ids rather than a\n * contributed palette so there is nothing to maintain until that work starts.\n */',
			'// phase 1 is a flat activity-coloured list — categories and subtitles come later\n// colours are built-in theme ids, not a contributed palette, so there is nothing to\n// maintain until phase 2 actually needs one'
		],
		['\t/** Re-reads every session directory, then repaints. */', '\t// re-reads every session directory, then repaints'],
		['\t/** Repaints without re-reading, so activity colours decay on their own. */', '\t// repaint without re-reading so activity colours decay on their own']
	]],

	['src/core/locations.ts', [
		['\t/** How the workspace directory was found — reported in the log so surprises are visible. */', '\t// how the workspace directory was found — logged so surprises are visible']
	]]
];

let applied = 0;
const missing = [];

for (const [file, replacements] of edits) {
	let source = fs.readFileSync(file, 'utf8');
	for (const [from, to] of replacements) {
		if (!source.includes(from)) {
			missing.push(`${file}: ${from.split('\n')[0].slice(0, 60)}`);
			continue;
		}
		source = source.replace(from, to);
		applied++;
	}
	fs.writeFileSync(file, source, 'utf8');
}

console.log(`applied ${applied} replacement(s)`);
for (const entry of missing) {
	console.log(`  MISSING ${entry}`);
}
