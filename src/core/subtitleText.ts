import { LastExchange } from './sessionContent';

// what a generation run is for. 'status' reads the end of the session, the other two
// read the opening messages — a task summary and a title are both about the original aim
export type GenerationMode = 'status' | 'task' | 'title';

// which of those two a stored subtitle came from, so an automatic sweep can regenerate
// it the way it was originally asked for rather than however the setting reads today
export type SubtitleMode = Extract<GenerationMode, 'status' | 'task'>;

// prompt building and answer cleanup, kept free of vscode so the probe can exercise them
// without an extension host — the model call is the only part that needs one

// rows are 54px and the second line is one line
export const MAX_SUBTITLE_CHARS = 48;
// the title line is bigger and has the row to itself
export const MAX_TITLE_CHARS = 60;

// ── redaction ────────────────────────────────────────────────────────────────
// running the tools is consented to; a prompt is different, because it hands whatever
// the tools touched to a third-party model provider verbatim. one real session held a
// live vault session token in its tool activity and a password in its last request, so
// the shapes that are unambiguously credentials get masked on the way into a prompt.
// deliberately small — this is not a scanner, it is a stop on the obvious cases
const SECRETS: ReadonlyArray<RegExp> = [
	// an assignment whose name says what it holds, quoted or bare, as tool activity logs it
	/\b[A-Za-z_][A-Za-z0-9_]*(?:SESSION|TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|KEY|CREDENTIAL)\s*=\s*['"]?[^\s'";|&]+/gi,
	// said out loud, which is how a password usually reaches a chat in the first place
	/\b(?:password|passwd|passphrase|pw)\s*(?:is|are|=|:)\s*\S+/gi,
	// vendor-prefixed keys identify themselves, so they need no surrounding context
	/\b(?:sk-|ghp_|gho_|ghs_|ghu_|github_pat_|xox[abprs]-|AKIA)[A-Za-z0-9_-]{8,}/g,
	/\bBearer\s+[A-Za-z0-9._-]{16,}/gi,
	/-----BEGIN[^-]*PRIVATE KEY-----/g
];

// applied to the finished prompt rather than field by field, so a new field can't be
// added later that quietly bypasses it
export function redact(text: string): string {
	return SECRETS.reduce((current, pattern) => current.replace(pattern, '[redacted]'), text);
}

export function buildStatusPrompt(title: string, exchange: LastExchange): string {
	const lines = [
		'Label a coding-chat session for a sidebar. Write ONE short status line saying where the session is right now.',
		'',
		'Rules:',
		'- two to five words, 48 characters maximum',
		'- describe the current state, not the topic — the title already carries the topic',
		'- say what it is waiting on, blocked by, or has just finished',
		'- when the work is finished, say so and name what comes next',
		'- no quotes, no markdown, no trailing full stop',
		'- reply with the line and nothing else',
		'',
		'Examples: Waiting for API key / Tests failing on CI / Committed, awaiting deploy / Retrying after request errors / Refactor applied, unverified',
		'',
		`Session title: ${title}`
	];

	if (exchange.userText) {
		lines.push(`Last request: ${exchange.userText}`);
	}
	if (exchange.assistantText) {
		lines.push(`Assistant last said: ${exchange.assistantText}`);
	}
	if (exchange.activity.length) {
		lines.push(`Recent tool activity: ${exchange.activity.join('; ')}`);
	}
	if (exchange.pendingConfirmation) {
		lines.push(`Parked on a confirmation: ${exchange.pendingConfirmation}`);
	}
	return redact(lines.join('\n'));
}

// models answer in quotes, in bold, as a bullet, or with a sentence of preamble
export function tidy(raw: string, limit = MAX_SUBTITLE_CHARS): string {
	const first = raw
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean)[0] ?? '';

	let text = first
		.replace(/^[-*•]\s+/, '')
		// a label the model prefixed itself, as in 'Status: waiting for review'
		.replace(/^(status|subtitle|answer|label)\s*:\s*/i, '')
		.replace(/[*_`]/g, '')
		.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
		.replace(/\s+/g, ' ')
		.replace(/[.!。]+$/, '')
		.trim();

	if (text.length > limit) {
		const cut = text.slice(0, limit);
		const boundary = cut.lastIndexOf(' ');
		text = (boundary > limit / 2 ? cut.slice(0, boundary) : cut).trim();
	}
	// a trailing comma or dash survives the word-boundary cut
	return text.replace(/[,;:—–-]+$/, '').trim();
}

function numbered(messages: string[]): string {
	return messages.map((text, index) => `${index + 1}. ${text}`).join('\n');
}

export function buildTaskPrompt(title: string, messages: string[]): string {
	return redact([
		'Below are the opening messages of a coding chat. Write ONE short line saying what the person asked for.',
		'',
		'Rules:',
		'- three to seven words, 48 characters maximum',
		'- describe the task, not the progress and not the outcome',
		'- start with a verb where it reads naturally',
		'- no quotes, no markdown, no trailing full stop',
		'- reply with the line and nothing else',
		'',
		'Examples: Add CSV export to the downloader / Debug backslash handling in commands / Upgrade OpenVPN on the LAN server',
		'',
		`Current title: ${title}`,
		'',
		'Opening messages:',
		numbered(messages)
	].join('\n'));
}

export function buildTitlePrompt(title: string, messages: string[]): string {
	return redact([
		'Below are the opening messages of a coding chat. Write ONE title for it.',
		'',
		'Rules:',
		'- three to eight words, 60 characters maximum',
		'- name the overall aim of the chat, not the first step and not the current state',
		'- sentence case, no trailing full stop',
		'- no quotes, no markdown',
		'- reply with the title and nothing else',
		'',
		'Examples: Forward-accumulating dataset collectors / OpenVPN access server upgrade / Chat session colour-coding extension',
		'',
		`Existing title, which may be poor: ${title}`,
		'',
		'Opening messages:',
		numbered(messages)
	].join('\n'));
}

// same cleanup, longer ceiling — a title gets the whole row
export function tidyTitle(raw: string): string {
	return tidy(raw, MAX_TITLE_CHARS);
}
