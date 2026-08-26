import { LastExchange } from './sessionContent';

// what a generation run is for. 'status' reads the end of the session, the other two
// read the opening messages — a task summary and a title are both about the original aim
export type GenerationMode = 'status' | 'task' | 'title';

// prompt building and answer cleanup, kept free of vscode so the probe can exercise them
// without an extension host — the model call is the only part that needs one

// rows are 54px and the second line is one line
export const MAX_SUBTITLE_CHARS = 48;
// the title line is bigger and has the row to itself
export const MAX_TITLE_CHARS = 60;

export function buildStatusPrompt(title: string, exchange: LastExchange): string {
	const lines = [
		'Label a coding-chat session for a sidebar. Write ONE short status line saying where the session is right now.',
		'',
		'Rules:',
		'- two to five words, 48 characters maximum',
		'- describe the current state, not the topic — the title already carries the topic',
		'- say what it is waiting on, blocked by, or has just finished',
		'- no quotes, no markdown, no trailing full stop',
		'- reply with the line and nothing else',
		'',
		'Examples: Waiting for API key / Tests failing on CI / Retrying after request errors / Refactor applied, unverified',
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
	return lines.join('\n');
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
	return [
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
	].join('\n');
}

export function buildTitlePrompt(title: string, messages: string[]): string {
	return [
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
	].join('\n');
}

// same cleanup, longer ceiling — a title gets the whole row
export function tidyTitle(raw: string): string {
	return tidy(raw, MAX_TITLE_CHARS);
}
