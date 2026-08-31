// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 WulffTech

import * as fs from 'fs';

// what the bytes appended to a session file say about the state it is in right now.
// two questions off one pass: whether "Allow All Commands in this Session" is live, and
// whether the newest turn is running, parked on a confirmation, or finished

// ── auto-approval ────────────────────────────────────────────────────────────

// "Allow All Commands in this Session" is held in a Map on the workbench's terminal chat
// service and never written anywhere, so there is no flag to read back. what does reach
// disk is the disable link the confirmation bakes into every command that button
// auto-approves, and the command id survives translation where the sentence around it
// does not — the English strings are nls entries and change with the display language
const APPROVAL_MARKER = 'workbench.action.terminal.chat.disableSessionAutoApproval';

// the marker lives in autoApproveInfo, which is written *before* the toolId of the same
// invocation — measured as MMTMMT… across the real sessions here, two markers apiece. so
// a toolId closes a window and is judged on whether a marker turned up since the last one
const TERMINAL_TOOL = '"toolId":"run_in_terminal"';

// ── turn state ───────────────────────────────────────────────────────────────

// a turn opens with a bare append to the requests array and closes when its result is
// written. nothing else in the file carries that boundary: the header goes stale at
// creation, and toolInvocationSerialized only reaches disk once the tool has finished —
// all 15,417 of them here are isComplete, so a tool call sitting on an approval prompt
// leaves no record of its own to find
const REQUEST_APPEND = '{"kind":2,"k":["requests"],';
const REQUEST_RESULT = ',"result"],"v":';

// ChatResponseModel._modelState, patched per request: 0 running, 1 completed,
// 2 cancelled, 3 errored, 4 parked on a confirmation. 4 is the workbench's own
// requestNeedsInput, the thing behind the Needs Input badge on its agents status bar
//
// only the patch log is honest about it. the whole-session serialiser rewrites both 0
// and 4 to {value:2} on the way out, so a header restored from disk claims every
// unfinished turn was cancelled
const MODEL_STATE = ',"modelState"],"v":{"value":';

const RUNNING = 0x30; // '0'
const NEEDS_INPUT = 0x34; // '4'

// all five needles were counted two ways across the 132 MB of session files on this
// machine — raw byte search against a structural pass over record heads — and agreed
// exactly: 208 appends, 192 results, 264 model states. none of them can appear inside a
// payload, because every quote in a json string is escaped and all five carry bare ones
const NEEDLE_LENGTHS = [
	APPROVAL_MARKER.length,
	TERMINAL_TOOL.length,
	REQUEST_APPEND.length,
	REQUEST_RESULT.length,
	// the model state needs the digit after it, so it straddles one byte further
	MODEL_STATE.length + 1
];

const CHUNK_BYTES = 256 * 1024;
// enough that a pattern straddling a chunk boundary is still whole in the next pass
const OVERLAP = Math.max(...NEEDLE_LENGTHS) - 1;

// how far back the first sight of a session reads. the approval verdict is thrown away
// from it — see seed() — but a turn that was already in flight when this window opened
// has no other way to be seen, and a window killed mid-confirmation restores with that
// confirmation still up
const SEED_BYTES = 256 * 1024;

// the turn currently open on a session, absent once the newest one has finished
export type OpenTurn = 'working' | 'waiting';

export interface TailScan {
	// what the appended bytes say the approval state became, absent when they said
	// nothing either way
	approving?: boolean;
	// the turn state those bytes leave the session in. carried in as well as out, because
	// a delta can easily hold no turn record at all
	open?: OpenTurn;
	// only ever advanced to a record boundary, so a half-written line is re-read next time
	offset: number;
}

// reads the bytes appended since `from`. session files are append-only, so this costs the
// size of the delta rather than the size of the session — the markers sit deep in request
// payloads and re-reading a 10mb file on every keystroke is not an option
export async function scanTail(filePath: string, from: number, open?: OpenTurn): Promise<TailScan> {
	const handle = await fs.promises.open(filePath, 'r');
	try {
		const { size } = await handle.stat();
		if (size <= from) {
			// shorter than last time means truncated or replaced. resync to the new end
			// rather than replaying history that belongs to a window which has gone
			return { open, offset: Math.min(from, size) };
		}

		// the search stays on the raw bytes instead of decoding to a string. every needle
		// is ascii, so a byte search finds exactly what a text search finds, and every
		// index it yields is already the byte offset a later resume can seek to. decoding
		// first made each index a *character* count, which falls short of the byte offset
		// by one for every extra byte of every multi-byte character in the range — 28 of
		// the 62 sessions on this machine carry enough non-ascii to resume mid-record, and
		// a resume landing between a marker and the command it approved sees that command
		// with no marker ahead of it, which clears the badge on a session still approving
		const buffer = Buffer.alloc(CHUNK_BYTES + OVERLAP);
		let position = from;
		// bytes held over from the previous chunk, sitting at the head of the buffer
		let carried = 0;
		// absolute offset of the first byte of the buffer
		let chunkStart = from;
		// absolute offset past every event already accounted for, so the overlap between
		// chunks cannot count the same marker twice
		let scannedTo = from;
		let pendingMarker = false;
		let approving: boolean | undefined;
		let lastNewline = -1;

		while (position < size) {
			const { bytesRead } = await handle.read(buffer, carried, CHUNK_BYTES, position);
			if (bytesRead === 0) {
				break;
			}
			const view = buffer.subarray(0, carried + bytesRead);
			position += bytesRead;

			for (const event of events(view)) {
				const absolute = chunkStart + event.index;
				if (absolute < scannedTo) {
					continue;
				}
				scannedTo = absolute + event.length;
				switch (event.kind) {
					case 'marker':
						pendingMarker = true;
						break;
					case 'terminal':
						approving = pendingMarker;
						pendingMarker = false;
						break;
					case 'append':
						open = 'working';
						break;
					case 'result':
						open = undefined;
						break;
					case 'state':
						// a session opened after months re-emits value 4 for every old
						// confirmation widget nobody ever clicked — seven of them in one
						// burst in the largest file here, all on turns that closed long ago.
						// a state record only counts while a turn is actually open
						if (open) {
							open = event.value === NEEDS_INPUT ? 'waiting'
								: event.value === RUNNING ? 'working'
									: undefined;
						}
						break;
				}
			}

			const newline = view.lastIndexOf(0x0a);
			if (newline !== -1) {
				lastNewline = chunkStart + newline;
			}

			carried = Math.min(OVERLAP, view.length);
			// copy() is safe across overlapping ranges of one buffer, so the tail slides
			// to the front rather than needing a second allocation per chunk
			view.copy(buffer, 0, view.length - carried);
			chunkStart += view.length - carried;
		}

		return {
			approving,
			open,
			offset: lastNewline === -1 ? from : lastNewline + 1
		};
	} finally {
		await handle.close();
	}
}

type EventKind = 'marker' | 'terminal' | 'append' | 'result' | 'state';

interface Event {
	index: number;
	length: number;
	kind: EventKind;
	// the byte after MODEL_STATE, which is the state digit
	value?: number;
}

// every needle in one ordered pass — order is the whole signal, for both readings. a
// terminal command with no marker ahead of it is one the session approval did not cover,
// and a model state with no open turn ahead of it belongs to a turn that already ended
function events(view: Buffer): Event[] {
	const found: Event[] = [];
	collect(view, APPROVAL_MARKER, 'marker', found);
	collect(view, TERMINAL_TOOL, 'terminal', found);
	collect(view, REQUEST_APPEND, 'append', found);
	collect(view, REQUEST_RESULT, 'result', found);
	collect(view, MODEL_STATE, 'state', found);
	return found.sort((a, b) => a.index - b.index);
}

// latin1 holds one needle character to one byte, which is what every needle already is,
// so the index handed back is a byte offset rather than a character count
function collect(view: Buffer, needle: string, kind: EventKind, into: Event[]): void {
	let at = view.indexOf(needle, 0, 'latin1');
	while (at !== -1) {
		if (kind === 'state') {
			const digit = at + needle.length;
			// the digit fell off the end of this chunk. dropped rather than guessed, and
			// scannedTo is left alone so the overlap finds the whole thing next pass
			if (digit < view.length) {
				into.push({ index: at, length: needle.length + 1, kind, value: view[digit] });
			}
		} else {
			into.push({ index: at, length: needle.length, kind });
		}
		at = view.indexOf(needle, at + needle.length, 'latin1');
	}
}

// ── tracker ──────────────────────────────────────────────────────────────────

interface TrackedSession {
	sessionId: string;
	filePath: string;
	fileSize: number;
}

// the workbench's approval map is per-window and the extension host restarts with the
// window, so anything written before this process started belongs to a window that no
// longer exists. baselining at activation is what turns a one-way trace into a live reading
export class SessionLiveTracker {
	private offsets = new Map<string, number>();
	private approving = new Map<string, boolean>();
	private open = new Map<string, OpenTurn>();
	private started = false;

	// first pass reads the tail of each file and keeps only the turn state out of it. an
	// approval marker down there would be a lie about a window that has gone, but a turn
	// left open is a fact, and there is no other way to learn it when the extension host
	// has started underneath a chat that was already running
	//
	// the offset still lands at the end of the file, exactly where it did before any of
	// this was read. resuming from inside the seed window instead would hand those same
	// history bytes to the approval reading on the very next refresh
	private async seed(sessions: TrackedSession[]): Promise<void> {
		this.started = true;
		await Promise.all(sessions.map(async session => {
			this.offsets.set(session.sessionId, session.fileSize);
			try {
				const scan = await scanTail(session.filePath, Math.max(0, session.fileSize - SEED_BYTES));
				if (scan.open) {
					this.open.set(session.sessionId, scan.open);
				}
			} catch {
				// unreadable at startup says nothing, and the list beats a thrown refresh
			}
		}));
	}

	async update(sessions: TrackedSession[]): Promise<void> {
		if (!this.started) {
			await this.seed(sessions);
			return;
		}

		const live = new Set(sessions.map(session => session.sessionId));
		for (const id of [...this.offsets.keys()]) {
			if (!live.has(id)) {
				this.offsets.delete(id);
				this.approving.delete(id);
				this.open.delete(id);
			}
		}

		await Promise.all(sessions.map(async session => {
			// a file first seen after activation was written entirely by this window, so it
			// is read from the top rather than seeded away
			const from = this.offsets.get(session.sessionId) ?? 0;
			if (session.fileSize === from) {
				return;
			}
			try {
				const scan = await scanTail(session.filePath, from, this.open.get(session.sessionId));
				this.offsets.set(session.sessionId, scan.offset);
				if (scan.approving !== undefined) {
					this.approving.set(session.sessionId, scan.approving);
				}
				if (scan.open) {
					this.open.set(session.sessionId, scan.open);
				} else {
					this.open.delete(session.sessionId);
				}
			} catch {
				// a session file that cannot be read says nothing about either question, and
				// the list is more useful than a thrown refresh
			}
		}));
	}

	isApproving(sessionId: string): boolean {
		return this.approving.get(sessionId) === true;
	}

	// absent means the newest turn has finished, or nothing has been seen since startup
	openTurn(sessionId: string): OpenTurn | undefined {
		return this.open.get(sessionId);
	}
}
