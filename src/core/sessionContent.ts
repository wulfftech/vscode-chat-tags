// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 WulffTech

import * as fs from 'fs';
import { readFirstLine } from './sessions';

// the parts of a session worth feeding a model: the last request/response pair, which
// says where the session is now, and the opening messages, which say what it set out to do
//
// it is not at the end of the file. response parts stream in as separate records *after*
// the request that owns them, so measured across 45 real sessions the last whole-request
// append sat between 5 kb and 4.1 mb before eof. reading the tail finds responses with no
// message attached.
//
// so: one forward pass that decodes only the head of each line and remembers byte offsets,
// then a second targeted read of the few records worth parsing. one response record hit
// 431 kb in the wild, which is why nothing here parses a line it hasn't chosen first.

const CHUNK_BYTES = 256 * 1024;
// enough to cover {"kind":2,"k":["requests",123,"response"] with room to spare
const HEAD_BYTES = 256;
const DEFAULT_MAX_SCAN_BYTES = 64 * 1024 * 1024;

// trailing records to keep offsets for — enough to walk back past system-initiated
// requests, and one response can span 48 records so the offset list stays generous
// offsets cost 16 bytes each; parsing is what's expensive, and that's budgeted below
const KEEP_REQUESTS = 10;
const KEEP_RESPONSES = 64;

// ceilings on what the second pass actually parses
const PARSE_BUDGET_BYTES = 2 * 1024 * 1024;
const PARSE_RECORD_LIMIT = 24;

const MAX_USER_CHARS = 700;
const MAX_ASSISTANT_CHARS = 900;
const MAX_ACTIVITY_ITEMS = 5;
const MAX_ACTIVITY_CHARS = 120;

export interface LastExchange {
	// -1 when no response record was found, which is a session that hasn't answered yet
	requestIndex: number;
	userText?: string;
	// true when the last request was a terminal notification rather than something typed
	systemInitiated?: boolean;
	assistantText?: string;
	// trailing tool invocations, oldest first — what the session was doing
	activity: string[];
	// a chat parked on a confirmation is waiting for the user, which is worth a subtitle
	pendingConfirmation?: string;
	// byte cap stopped the scan early
	truncated: boolean;
	bytesScanned: number;
}

interface Span {
	start: number;
	length: number;
}

const RECORD_HEAD = /^\{"kind":(\d+),"k":\[([^\]]*)\]/;
const RESPONSE_PATH = /^"requests",(\d+),"response"$/;

// the retry button and the slash commands write real request records carrying no intent
// at all, and across 23 real sessions '@agent Try Again' was the newest request in eight
// of them — walk past these to whatever the user actually asked
// bare acknowledgements are the same problem wearing a friendlier face: 'cool' is a real
// message that tells a status prompt nothing, and it was the last word in two sessions
const BOILERPLATE = /^(@agent\b|\/(compact|clear|help|new)\b|(continue|try again|go on|proceed|carry on|yes|yep|yeah|ok|okay|k|go|cool|nice|great|good|thanks|thanx|cheers|ta|perfect|sweet|awesome|excellent|brilliant|lovely|sure|done)\b[.!?]?$|(omg\s+)?(yes|yeah|yep|ok|okay)\b[\s,]*(please|do it|go ahead|proceed|carry on)\b[.!]?$)/i;

// terminal notifications arrive as ordinary requests — isSystemInitiated is set on some
// of them and not others, so the text is what has to be trusted
const TERMINAL_NOTIFICATION = /^\[Terminal[^\]]*notification:/i;

function substantive(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.length > 2
		&& !BOILERPLATE.test(trimmed)
		&& !TERMINAL_NOTIFICATION.test(trimmed);
}

interface Offsets {
	requests: Span[];
	// the other end of the file — what the session was originally asked to do
	opening: Span[];
	responses: Span[];
	// the index below, kept because the newest request is often a terminal notification
	// that was never answered — its response says nothing a subtitle can use
	previous: Span[];
	responseIndex: number;
	truncated: boolean;
	bytesScanned: number;
}

interface ScanOptions {
	maxScanBytes: number;
	// stop once this many request appends have gone by. reaching the fifth request can
	// mean walking 98.5% of a file, because response records sit between them — but it
	// can also mean 0.1%, and an opening read has no reason to pay for the rest
	stopAfterRequests?: number;
}

// pass one — classify every line from its first few bytes, keep offsets, parse nothing
async function scanOffsets(filePath: string, options: ScanOptions): Promise<Offsets> {
	const maxScanBytes = options.maxScanBytes;
	const stopAfter = options.stopAfterRequests ?? Infinity;
	let seenRequests = 0;
	const found: Offsets = {
		requests: [],
		opening: [],
		responses: [],
		previous: [],
		responseIndex: -1,
		truncated: false,
		bytesScanned: 0
	};

	const consider = (head: Buffer, start: number, length: number): void => {
		const match = RECORD_HEAD.exec(head.toString('utf8'));
		if (!match) {
			return;
		}
		const kind = match[1];
		const rawPath = match[2]!;

		if (kind === '2' && rawPath === '"requests"') {
			seenRequests++;
			// only an opening read wants these, and it always sets a stop — a full scan
			// would otherwise accumulate a span for every request in the session
			if (found.opening.length < stopAfter && stopAfter !== Infinity) {
				found.opening.push({ start, length });
			}
			found.requests.push({ start, length });
			if (found.requests.length > KEEP_REQUESTS) {
				found.requests.shift();
			}
			return;
		}

		const response = kind === '2' ? RESPONSE_PATH.exec(rawPath) : null;
		if (!response) {
			return;
		}
		// index off a response path only. a request that exists but hasn't been answered
		// contributes nothing to a subtitle, and clearing on it would throw away the last
		// thing the session actually said
		const index = Number(response[1]);
		if (index > found.responseIndex) {
			found.responseIndex = index;
			found.previous = found.responses;
			found.responses = [];
		}
		if (index === found.responseIndex) {
			found.responses.push({ start, length });
			if (found.responses.length > KEEP_RESPONSES) {
				found.responses.shift();
			}
		}
	};

	const handle = await fs.promises.open(filePath, 'r');
	try {
		const buffer = Buffer.alloc(CHUNK_BYTES);
		let position = 0;
		let lineStart = 0;
		let head: Buffer = Buffer.alloc(0);
		let enough = false;

		while (position < maxScanBytes && !enough) {
			const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, position);
			if (bytesRead === 0) {
				break;
			}
			const chunk = buffer.subarray(0, bytesRead);
			const chunkStart = position;
			let cursor = 0;

			while (cursor < bytesRead) {
				const newline = chunk.indexOf(0x0A, cursor);
				const end = newline === -1 ? bytesRead : newline;
				if (head.length < HEAD_BYTES) {
					const take = Math.min(end, cursor + HEAD_BYTES - head.length);
					head = Buffer.concat([head, chunk.subarray(cursor, take)]);
				}
				if (newline === -1) {
					break;
				}
				consider(head, lineStart, chunkStart + newline - lineStart);
				head = Buffer.alloc(0);
				lineStart = chunkStart + newline + 1;
				cursor = newline + 1;
				if (seenRequests >= stopAfter) {
					enough = true;
					break;
				}
			}

			position = enough ? chunkStart + cursor : position + bytesRead;
		}

		found.bytesScanned = position;
		if (position >= maxScanBytes) {
			found.truncated = true;
		} else if (head.length && !enough) {
			// a file still being written doesn't end in a newline
			consider(head, lineStart, position - lineStart);
		}
	} finally {
		await handle.close();
	}

	return found;
}

async function readSpan(handle: fs.promises.FileHandle, span: Span): Promise<any> {
	const buffer = Buffer.alloc(span.length);
	await handle.read(buffer, 0, span.length, span.start);
	try {
		return JSON.parse(buffer.toString('utf8'));
	} catch {
		return undefined;
	}
}

function plain(markdown: string): string {
	return markdown
		.replace(/```[\s\S]*?```/g, ' ')
		// keep the link text, drop the command: uri behind it
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[*_`>#]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

// keeps both ends — a pasted terminal dump buries the actual ask in the middle
function clamp(value: string, limit: number): string {
	const text = value.replace(/\s+/g, ' ').trim();
	if (text.length <= limit) {
		return text;
	}
	const head = Math.ceil(limit * 0.6);
	return `${text.slice(0, head)} … ${text.slice(text.length - (limit - head))}`;
}

// the latest thing said is the current state, so this drops the front
function clampTail(value: string, limit: number): string {
	const text = value.replace(/\s+/g, ' ').trim();
	return text.length <= limit ? text : `… ${text.slice(text.length - limit)}`;
}

interface Harvest {
	prose: string[];
	activity: string[];
	confirmation?: string;
}

// an agent turn repeats itself — 'Read , lines 1317 to 1600' five times running, or the
// same retry notice — and the last five of that tell you nothing
function pushActivity(into: Harvest, raw: string): void {
	// a file-link label can be empty, leaving 'Read ,' behind once the uri is stripped
	const text = plain(raw).replace(/^(\w+)\s*[,.]\s*/, '$1 ').trim();
	if (text.length < 4 || text === into.activity[into.activity.length - 1]) {
		return;
	}
	into.activity.push(clamp(text, MAX_ACTIVITY_CHARS));
}

function harvestPart(part: any, into: Harvest): void {
	if (!part || typeof part !== 'object') {
		return;
	}

	// assistant prose serialises as a bare MarkdownString — no kind discriminator at all
	if (!part.kind && typeof part.value === 'string') {
		const text = plain(part.value);
		if (text) {
			into.prose.push(text);
		}
		return;
	}

	if (part.kind === 'confirmation') {
		const title = typeof part.title === 'string' ? part.title : '';
		const message = typeof part.message?.value === 'string' ? plain(part.message.value) : '';
		const text = [title, message].filter(Boolean).join(' — ');
		if (text) {
			into.confirmation = clamp(text, 220);
		}
		return;
	}

	if (part.kind === 'toolInvocationSerialized') {
		const label = part.pastTenseMessage?.value ?? part.invocationMessage?.value;
		if (typeof label === 'string') {
			pushActivity(into, label);
		}
		return;
	}

	if (part.kind === 'progressTaskSerialized' && typeof part.content?.value === 'string') {
		pushActivity(into, part.content.value);
	}
	// thinking, textEditGroup, undoStop, codeblockUri and inlineReference say nothing a
	// subtitle can use
}

// newest record first, stopping as soon as there's enough prose to work with — a long
// agent turn ends on tool calls, so the sentence explaining it sits well back in the stream
async function harvestResponses(handle: fs.promises.FileHandle, spans: Span[]): Promise<Harvest> {
	const harvest: Harvest = { prose: [], activity: [] };
	const parsed: any[][] = [];
	let budget = PARSE_BUDGET_BYTES;
	let proseChars = 0;

	for (let i = spans.length - 1; i >= 0 && budget > 0 && parsed.length < PARSE_RECORD_LIMIT; i--) {
		const span = spans[i]!;
		budget -= span.length;
		const record = await readSpan(handle, span);
		if (!Array.isArray(record?.v)) {
			continue;
		}
		parsed.unshift(record.v);
		for (const part of record.v) {
			if (part && !part.kind && typeof part.value === 'string') {
				proseChars += part.value.length;
			}
		}
		if (proseChars >= MAX_ASSISTANT_CHARS) {
			break;
		}
	}

	for (const parts of parsed) {
		for (const part of parts) {
			harvestPart(part, harvest);
		}
	}
	return harvest;
}

export interface OpeningMessages {
	messages: string[];
	truncated: boolean;
	bytesScanned: number;
}

// how many appends to walk for a given number of wanted messages. retries and terminal
// notifications are requests too, and they cluster, so the allowance is generous
const OPENING_APPEND_RATIO = 3;
const MAX_OPENING_CHARS = 500;

// the header carries the first request or three before the append log takes over
function headerRequestTexts(line: string): string[] {
	try {
		const record = JSON.parse(line);
		const requests = record?.kind === 0 ? record?.v?.requests : undefined;
		if (!Array.isArray(requests)) {
			return [];
		}
		return requests
			.map((request: any) => request?.message?.text)
			.filter((text: unknown): text is string => typeof text === 'string');
	} catch {
		return [];
	}
}

// what the session set out to do, which is a different question from where it is now
export async function readOpeningMessages(
	filePath: string,
	count: number,
	options: ReadOptions = {}
): Promise<OpeningMessages> {
	const candidates: string[] = headerRequestTexts(await readFirstLine(filePath));
	const wanted = count * OPENING_APPEND_RATIO;
	let truncated = false;
	let bytesScanned = 0;

	if (candidates.filter(substantive).length < count) {
		const offsets = await scanOffsets(filePath, {
			maxScanBytes: options.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES,
			stopAfterRequests: wanted
		});
		truncated = offsets.truncated;
		bytesScanned = offsets.bytesScanned;

		const handle = await fs.promises.open(filePath, 'r');
		try {
			for (const span of offsets.opening) {
				const record = await readSpan(handle, span);
				const entries: any[] = Array.isArray(record?.v) ? record.v : [];
				for (const request of entries) {
					const text = request?.message?.text;
					if (typeof text === 'string') {
						candidates.push(text);
					}
				}
			}
		} finally {
			await handle.close();
		}
	}

	const messages = candidates
		.filter(substantive)
		.slice(0, count)
		.map(text => clamp(text, MAX_OPENING_CHARS));

	return { messages, truncated, bytesScanned };
}

export interface ReadOptions {
	maxScanBytes?: number;
}

export async function readLastExchange(
	filePath: string,
	options: ReadOptions = {}
): Promise<LastExchange> {
	const offsets = await scanOffsets(filePath, {
		maxScanBytes: options.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES
	});
	const result: LastExchange = {
		requestIndex: offsets.responseIndex,
		activity: [],
		truncated: offsets.truncated,
		bytesScanned: offsets.bytesScanned
	};

	const handle = await fs.promises.open(filePath, 'r');
	try {
		// newest first, stopping at the first thing a person actually typed. there is no
		// fallback to the newest record on purpose — it reinstates the boilerplate this just
		// walked past, and no 'Last request' line at all beats one the model reads as intent
		let best: string | undefined;
		let newest = true;

		outer:
		for (let i = offsets.requests.length - 1; i >= 0; i--) {
			const record = await readSpan(handle, offsets.requests[i]!);
			const entries: any[] = Array.isArray(record?.v) ? record.v : [];
			for (let j = entries.length - 1; j >= 0; j--) {
				const request = entries[j];
				const text = request?.message?.text;
				if (typeof text !== 'string' || !text.trim()) {
					continue;
				}
				if (newest) {
					result.systemInitiated = Boolean(request?.isSystemInitiated);
					newest = false;
				}
				if (!request?.isSystemInitiated && substantive(text)) {
					best = text;
					break outer;
				}
			}
		}

		if (best) {
			result.userText = clamp(best, MAX_USER_CHARS);
		}

		const harvest = await harvestResponses(handle, offsets.responses);
		// a turn that ends on tool calls has no prose of its own, and a terminal
		// notification gets no answer at all — the last sentence the assistant wrote is
		// still the best description of where the session is. activity stays current
		if (!harvest.prose.length && offsets.previous.length) {
			const earlier = await harvestResponses(handle, offsets.previous);
			harvest.prose = earlier.prose;
			harvest.confirmation = harvest.confirmation ?? earlier.confirmation;
		}

		if (harvest.prose.length) {
			result.assistantText = clampTail(harvest.prose.join(' '), MAX_ASSISTANT_CHARS);
		}
		result.activity = harvest.activity.slice(-MAX_ACTIVITY_ITEMS);
		result.pendingConfirmation = harvest.confirmation;
	} finally {
		await handle.close();
	}

	return result;
}
