// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 WulffTech

import * as fs from 'fs';
import { normalisePermissionLevel } from './permissions';
import { readSelectedModel, SelectedModel } from './sessionModel';

// after the kind:0 header every line is a patch record:
//   {"kind":1,"k":["customTitle"],"v":"..."}  set value at path k
//   {"kind":2,"k":["requests"],"v":[...]}     append to array at path k
// the header is written once at creation and never rewritten — a 954-line session
// reports zero requests and no title there, so anything user-visible comes from here
// the records we want are short and early; the huge ones are request appends whose
// payload we do not need, so we read only the first slice of each line

const PREFIX_BYTES = 2048;
const DEFAULT_MAX_SCAN_BYTES = 4 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;

export interface DeltaScanResult {
	customTitle?: string;
	// first thing the user typed — the title when no customTitle was ever set
	firstInputText?: string;
	appendedRequests: number;
	// byte cap stopped us early, so counts are a lower bound
	truncated: boolean;
	// last value the permission picker was moved to, absent if it never moved
	permissionLevel?: string;
	// last value the model picker was moved to, absent if it never moved. every one of
	// the 20 such records on this machine fits inside the prefix cap — the largest is
	// 1193 bytes against 2048 — so this one is read by parsing rather than by pattern
	model?: SelectedModel;
	// newest prompt size seen. only meaningful while `truncated` is false: past the byte
	// cap the last record read is an old one rather than the current one, and a stale
	// context reading is worse than none. the live tail scan covers the rest
	promptTokens?: number;
}

const RECORD_HEAD = /^\{"kind":(\d+),"k":\[([^\]]*)\]/;

function pathOf(rawPath: string): string[] {
	return rawPath.split(',').map(part => part.replace(/^"|"$/g, ''));
}

function stringValueOf(line: string): string | undefined {
	// short records arrive whole, so a real parse is exact
	try {
		const value = JSON.parse(line)?.v;
		return typeof value === 'string' ? value : undefined;
	} catch {
		// truncated by the prefix cap — recover the value with a narrower match
		const match = /"v":"((?:[^"\\]|\\.)*)"/.exec(line);
		if (match) {
			try {
				return JSON.parse(`"${match[1]}"`);
			} catch {
				return undefined;
			}
		}
		// the cap can also land inside the value, leaving no closing quote to match. what
		// is there still beats nothing: every caller uses this as a title, and a title is
		// cut to its first line before anyone sees it
		const open = /"v":"((?:[^"\\]|\\.)*)$/.exec(line);
		if (!open) {
			return undefined;
		}
		try {
			// a cut landing mid-escape leaves a lone backslash, which is not parseable
			return JSON.parse(`"${open[1]!.replace(/\\+$/, '')}"`);
		} catch {
			return undefined;
		}
	}
}

// the prefix cap can land inside a multi-byte character, and decoding a half character
// yields a replacement one. so the cut is walked back to the last complete character —
// which is also the whole of the corruption that used to happen at every chunk boundary,
// back when a chunk was decoded before its records were found
function completeBytes(view: Buffer): number {
	const end = view.length;
	for (let back = 0; back < 4 && back < end; back++) {
		const byte = view[end - 1 - back]!;
		if ((byte & 0xC0) === 0x80) {
			continue; // continuation byte, keep walking back to the lead
		}
		const needed = byte < 0x80 ? 1 : byte < 0xE0 ? 2 : byte < 0xF0 ? 3 : 4;
		return back + 1 >= needed ? end : end - back - 1;
	}
	return end;
}

function consider(line: string, result: DeltaScanResult): void {
	const head = RECORD_HEAD.exec(line);
	if (!head) {
		return;
	}
	const kind = Number(head[1]);
	const path = pathOf(head[2]!);

	if (kind === 1 && path.length === 1 && path[0] === 'customTitle') {
		const title = stringValueOf(line);
		if (title && title.trim()) {
			// later records win — the title gets regenerated or renamed mid-session
			result.customTitle = title.trim();
		}
		return;
	}

	if (kind === 1 && path.length === 2 && path[0] === 'inputState' && path[1] === 'inputText') {
		if (!result.firstInputText) {
			const text = stringValueOf(line);
			if (text && text.trim()) {
				result.firstInputText = text.trim();
			}
		}
		return;
	}

	if (kind === 1 && path.length === 2 && path[0] === 'inputState' && path[1] === 'permissionLevel') {
		// later records win — the picker can be moved any number of times in one session
		const level = normalisePermissionLevel(stringValueOf(line));
		if (level) {
			result.permissionLevel = level;
		}
		return;
	}

	if (kind === 1 && path.length === 2 && path[0] === 'inputState' && path[1] === 'selectedModel') {
		// later records win, for the same reason permissionLevel's do — the picker can be
		// moved any number of times, and only the last move says what the chat is on now
		const model = readSelectedModel(parsedValueOf(line));
		if (model) {
			result.model = model;
		}
		return;
	}

	if (kind === 1 && path.length === 3 && path[0] === 'requests' && path[2] === 'promptTokens') {
		const value = parsedValueOf(line);
		// records are read in file order, so the last one to land here is the newest one
		// written. within a turn these arrive dozens at a time as the prompt grows
		if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
			result.promptTokens = value;
		}
		return;
	}

	if (kind === 2 && path.length === 1 && path[0] === 'requests') {
		result.appendedRequests++;
	}
}

// for the records whose value is not a string. unlike a title there is nothing to salvage
// from a half-read one: half a number is a different number, and half an object is not an
// object at all — so a cut record is simply not read
function parsedValueOf(line: string): unknown {
	try {
		return JSON.parse(line)?.v;
	} catch {
		return undefined;
	}
}

// pulls the few fields the UI needs out of a session file
// stops after maxScanBytes so one 50mb session cannot stall a refresh
export async function scanSessionDeltas(
	filePath: string,
	maxScanBytes = DEFAULT_MAX_SCAN_BYTES
): Promise<DeltaScanResult> {
	const result: DeltaScanResult = { appendedRequests: 0, truncated: false };

	const handle = await fs.promises.open(filePath, 'r');
	try {
		// allocUnsafe on both: read() overwrites every byte it reports, and the prefix is
		// only ever read as far as prefixLength. zero-filling a quarter megabyte per file
		// is pure waste across a store of several hundred
		const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
		// the head of the record being assembled. a request append carries its whole
		// payload, hundreds of kb of it, and none of that is wanted — so bytes past the
		// cap are stepped over rather than kept, and never become a string
		const prefix = Buffer.allocUnsafe(PREFIX_BYTES);
		let prefixLength = 0;
		let position = 0;
		let firstLineSkipped = false;

		while (position < maxScanBytes) {
			const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, position);
			if (bytesRead === 0) {
				break;
			}
			const chunk = buffer.subarray(0, bytesRead);
			position += bytesRead;

			let cursor = 0;
			while (cursor < bytesRead) {
				// the record boundary is found as a byte. decoding a chunk to look for a
				// newline turns every megabyte of payload into a throwaway js string, and
				// that was most of the cost of a scan and all of its gc pressure
				const newline = chunk.indexOf(0x0A, cursor);
				const end = newline === -1 ? bytesRead : newline;
				if (prefixLength < PREFIX_BYTES) {
					const take = Math.min(end - cursor, PREFIX_BYTES - prefixLength);
					chunk.copy(prefix, prefixLength, cursor, cursor + take);
					prefixLength += take;
				}
				if (newline === -1) {
					break;
				}
				if (!firstLineSkipped) {
					firstLineSkipped = true; // kind:0 header is parsed elsewhere
				} else if (prefixLength > 0) {
					consider(decodePrefix(prefix, prefixLength), result);
				}
				prefixLength = 0;
				cursor = newline + 1;
			}
		}

		if (position >= maxScanBytes) {
			result.truncated = true;
		} else if (prefixLength > 0 && firstLineSkipped) {
			// a file that does not end on a newline still has a record worth reading
			consider(decodePrefix(prefix, prefixLength), result);
		}
	} finally {
		await handle.close();
	}

	return result;
}

function decodePrefix(prefix: Buffer, length: number): string {
	const view = prefix.subarray(0, length);
	return view.subarray(0, completeBytes(view)).toString('utf8');
}
