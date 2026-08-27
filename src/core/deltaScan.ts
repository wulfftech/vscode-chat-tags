import * as fs from 'fs';
import { normalisePermissionLevel } from './permissions';

// after the kind:0 header every line is a patch record:
//   {"kind":1,"k":["customTitle"],"v":"..."}  set value at path k
//   {"kind":2,"k":["requests"],"v":[...]}     append to array at path k
// the header is written once at creation and never rewritten — a 954-line session
// reports zero requests and no title there, so anything user-visible comes from here
// the records we want are short and early; the huge ones are request appends whose
// payload we do not need, so we read only the first slice of each line

const PREFIX_BYTES = 2048;
const DEFAULT_MAX_SCAN_BYTES = 4 * 1024 * 1024;

export interface DeltaScanResult {
	customTitle?: string;
	// first thing the user typed — the title when no customTitle was ever set
	firstInputText?: string;
	appendedRequests: number;
	// byte cap stopped us early, so counts are a lower bound
	truncated: boolean;
	// last value the permission picker was moved to, absent if it never moved
	permissionLevel?: string;
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
		if (!match) {
			return undefined;
		}
		try {
			return JSON.parse(`"${match[1]}"`);
		} catch {
			return undefined;
		}
	}
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

	if (kind === 2 && path.length === 1 && path[0] === 'requests') {
		result.appendedRequests++;
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
		const chunkSize = 256 * 1024;
		const buffer = Buffer.alloc(chunkSize);
		let position = 0;
		let pending = '';
		let firstLineSkipped = false;

		while (position < maxScanBytes) {
			const { bytesRead } = await handle.read(buffer, 0, chunkSize, position);
			if (bytesRead === 0) {
				break;
			}
			position += bytesRead;
			pending += buffer.subarray(0, bytesRead).toString('utf8');

			let newlineIndex: number;
			while ((newlineIndex = pending.indexOf('\n')) !== -1) {
				const line = pending.slice(0, newlineIndex);
				pending = pending.slice(newlineIndex + 1);
				if (!firstLineSkipped) {
					firstLineSkipped = true; // kind:0 header is parsed elsewhere
					continue;
				}
				consider(line, result);
			}

			// keep only enough of an unterminated line to identify it
			if (pending.length > PREFIX_BYTES) {
				const head = pending.slice(0, PREFIX_BYTES);
				consider(head, result);
				// drop the rest rather than buffering 10mb of request payload
				const nextNewline = pending.indexOf('\n');
				pending = nextNewline === -1 ? '' : pending.slice(nextNewline + 1);
				if (nextNewline === -1) {
					// skip ahead to the next newline
					const skipped = await skipToNextLine(handle, position, maxScanBytes);
					position = skipped.position;
					pending = skipped.remainder;
				}
			}
		}

		if (position >= maxScanBytes) {
			result.truncated = true;
		} else if (pending && firstLineSkipped) {
			consider(pending.slice(0, PREFIX_BYTES), result);
		}
	} finally {
		await handle.close();
	}

	return result;
}

// advances past the remainder of an over-long line, returning any text after it
async function skipToNextLine(
	handle: fs.promises.FileHandle,
	position: number,
	maxScanBytes: number
): Promise<{ position: number; remainder: string }> {
	const chunkSize = 256 * 1024;
	const buffer = Buffer.alloc(chunkSize);

	while (position < maxScanBytes) {
		const { bytesRead } = await handle.read(buffer, 0, chunkSize, position);
		if (bytesRead === 0) {
			return { position, remainder: '' };
		}
		position += bytesRead;
		const text = buffer.subarray(0, bytesRead).toString('utf8');
		const newlineIndex = text.indexOf('\n');
		if (newlineIndex !== -1) {
			return { position, remainder: text.slice(newlineIndex + 1) };
		}
	}
	return { position, remainder: '' };
}
