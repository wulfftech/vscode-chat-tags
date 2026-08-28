// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 WulffTech

import * as fs from 'fs';

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

const CHUNK_BYTES = 256 * 1024;
// enough that a pattern straddling a chunk boundary is still whole in the next pass
const OVERLAP = Math.max(APPROVAL_MARKER.length, TERMINAL_TOOL.length) - 1;

export interface TailScan {
	// what the appended bytes say the state became, absent when they said nothing either way
	approving?: boolean;
	// only ever advanced to a record boundary, so a half-written line is re-read next time
	offset: number;
}

// reads the bytes appended since `from` and reports the last thing they say about session
// auto-approval. session files are append-only, so this costs the size of the delta rather
// than the size of the session — the markers sit deep in request payloads and re-reading a
// 10mb file on every keystroke is not an option
export async function scanTail(filePath: string, from: number): Promise<TailScan> {
	const handle = await fs.promises.open(filePath, 'r');
	try {
		const { size } = await handle.stat();
		if (size <= from) {
			// shorter than last time means truncated or replaced. resync to the new end
			// rather than replaying history that belongs to a window which has gone
			return { offset: Math.min(from, size) };
		}

		const buffer = Buffer.alloc(CHUNK_BYTES);
		let position = from;
		let carry = '';
		let carryStart = from;
		// absolute offset past every event already accounted for, so the overlap between
		// chunks cannot count the same marker twice
		let scannedTo = from;
		let pendingMarker = false;
		let approving: boolean | undefined;
		let lastNewline = -1;

		while (position < size) {
			const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, position);
			if (bytesRead === 0) {
				break;
			}
			const text = carry + buffer.subarray(0, bytesRead).toString('utf8');
			const textStart = carryStart;
			position += bytesRead;

			for (const event of events(text)) {
				const absolute = textStart + event.index;
				if (absolute < scannedTo) {
					continue;
				}
				scannedTo = absolute + event.length;
				if (event.marker) {
					pendingMarker = true;
				} else {
					approving = pendingMarker;
					pendingMarker = false;
				}
			}

			const newline = text.lastIndexOf('\n');
			if (newline !== -1) {
				lastNewline = textStart + newline;
			}

			carry = text.slice(Math.max(0, text.length - OVERLAP));
			carryStart = textStart + text.length - carry.length;
		}

		return {
			approving,
			offset: lastNewline === -1 ? from : lastNewline + 1
		};
	} finally {
		await handle.close();
	}
}

interface Event {
	index: number;
	length: number;
	marker: boolean;
}

// both patterns in one ordered pass — order is the whole signal, since a terminal command
// with no marker ahead of it is one the session approval did not cover
function events(text: string): Event[] {
	const found: Event[] = [];
	collect(text, APPROVAL_MARKER, true, found);
	collect(text, TERMINAL_TOOL, false, found);
	return found.sort((a, b) => a.index - b.index);
}

function collect(text: string, needle: string, marker: boolean, into: Event[]): void {
	let at = text.indexOf(needle);
	while (at !== -1) {
		into.push({ index: at, length: needle.length, marker });
		at = text.indexOf(needle, at + needle.length);
	}
}

interface TrackedSession {
	sessionId: string;
	filePath: string;
	fileSize: number;
}

// the workbench's map is per-window and the extension host restarts with the window, so
// anything written before this process started belongs to a window that no longer exists.
// baselining at activation is what turns a one-way trace into a live reading
export class SessionApprovalTracker {
	private offsets = new Map<string, number>();
	private approving = new Map<string, boolean>();
	private started = false;

	// first pass records where each file already ended without reading any of it, so old
	// markers cannot be mistaken for this window's state
	baseline(sessions: TrackedSession[]): void {
		for (const session of sessions) {
			this.offsets.set(session.sessionId, session.fileSize);
		}
		this.started = true;
	}

	async update(sessions: TrackedSession[]): Promise<void> {
		if (!this.started) {
			this.baseline(sessions);
			return;
		}

		const live = new Set(sessions.map(session => session.sessionId));
		for (const id of [...this.offsets.keys()]) {
			if (!live.has(id)) {
				this.offsets.delete(id);
				this.approving.delete(id);
			}
		}

		await Promise.all(sessions.map(async session => {
			// a file first seen after activation was written entirely by this window, so it
			// is read from the top rather than baselined away
			const from = this.offsets.get(session.sessionId) ?? 0;
			if (session.fileSize === from) {
				return;
			}
			try {
				const scan = await scanTail(session.filePath, from);
				this.offsets.set(session.sessionId, scan.offset);
				if (scan.approving !== undefined) {
					this.approving.set(session.sessionId, scan.approving);
				}
			} catch {
				// a session file that cannot be read says nothing about approval, and the
				// list is more useful than a thrown refresh
			}
		}));
	}

	isApproving(sessionId: string): boolean {
		return this.approving.get(sessionId) === true;
	}
}
