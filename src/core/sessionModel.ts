// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 WulffTech

// which model a chat is set to, and how full that model's context window is.
//
// both come out of the session file rather than any api. the picker's value is
// inputState.selectedModel — written into the header at creation and re-written as a
// patch record every time the picker moves, which is the same shape permissionLevel
// already uses. usage is requests[n].promptTokens, patched over and over while a turn
// runs: it is the size of the prompt actually sent, so it climbs as tool results pile up
// within a turn and drops again when the conversation gets trimmed.
//
// neither is guaranteed. across the 59 sessions on this machine 58 name a model and 18
// carry a token count — the provider writes that number or it doesn't, and no amount of
// reading harder produces one that was never recorded

export interface SelectedModel {
	// what the picker itself shows. 'Auto' stays 'Auto', because that is genuinely what
	// the chat is set to — the model Auto resolved to for a given turn is written inside
	// the request payload, past every cheap read this extension makes
	name: string;
	// the model's context window, absent when the metadata carried no usable number
	maxInputTokens?: number;
}

// vs code writes { identifier, metadata: { id, vendor, name, family, maxInputTokens … } }
export function readSelectedModel(value: unknown): SelectedModel | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const metadata = (value as { metadata?: unknown }).metadata;
	const fields = metadata && typeof metadata === 'object'
		? metadata as Record<string, unknown>
		: undefined;

	const name = typeof fields?.name === 'string' ? fields.name.trim() : '';
	// the identifier is the fallback because it still says something: nobody wants to
	// read 'openrouter/OpenRouter/stealth/ox-alpha' off a row, but it beats a blank
	const identifier = (value as { identifier?: unknown }).identifier;
	const label = name || (typeof identifier === 'string' ? identifier.trim() : '');
	if (!label) {
		return undefined;
	}

	const max = fields?.maxInputTokens;
	return {
		name: label,
		maxInputTokens: typeof max === 'number' && Number.isFinite(max) && max > 0 ? max : undefined
	};
}
