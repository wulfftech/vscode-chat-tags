// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 WulffTech

import * as vscode from 'vscode';
import { readLastExchange, readOpeningMessages } from './core/sessionContent';
import {
	GenerationMode,
	buildStatusPrompt,
	buildTaskPrompt,
	buildTitlePrompt,
	tidy,
	tidyTitle
} from './core/subtitleText';
import { readSubtitlePreferences } from './layout';
import { TagStore } from './model/categories';

// generated subtitles. the model is whatever the window has — this machine runs byok
// through openrouter with no copilot chat installed, so selecting on vendor:'copilot'
// would find nothing. selectChatModels() with no selector takes what's there.

// one request at a time, and a gap between automatic ones so a batch of sessions going
// idle together can't fire a burst of billable calls
const AUTO_GAP_MS = 20_000;
const AUTO_QUEUE_LIMIT = 5;

// a hung request would otherwise hold the queue forever
const REQUEST_TIMEOUT_MS = 30_000;

// cheap families first — a subtitle is not worth a frontier model
const CHEAP_MARKERS = ['mini', 'haiku', 'flash', 'small', 'lite', 'nano', 'turbo'];

// enough opening messages to see the aim past a false start, few enough that a long
// first prompt still fits comfortably
const OPENING_MESSAGE_COUNT = 5;

// what the pane needs to draw a model picker, which is a plain object because the
// webview only ever sees json
export interface ModelChoice {
	id: string;
	name: string;
	family: string;
	vendor: string;
}

export interface SubtitleTarget {
	sessionId: string;
	title: string;
	filePath: string;
	lastActivityAt: number;
}

interface QueueEntry {
	target: SubtitleTarget;
	explicit: boolean;
	mode: GenerationMode;
}

export class SubtitleService implements vscode.Disposable {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	private readonly queue: QueueEntry[] = [];
	private readonly generating = new Set<string>();
	private running = false;
	private lastAutoAt = 0;

	// set when the user declines the consent prompt — asking again on every idle sweep
	// would be its own kind of hostile
	private declined = false;
	// no provider signed in. the automatic sweep would otherwise re-select every 20s
	private noModel = false;
	private readonly startedAt = Date.now();
	private readonly listener: vscode.Disposable;
	private models: ModelChoice[] = [];

	constructor(
		private readonly tags: TagStore,
		private readonly log: vscode.OutputChannel
	) {
		// signing in mid-session is exactly when this should start working again
		this.listener = vscode.lm.onDidChangeChatModels(() => {
			this.noModel = false;
			void this.refreshModels();
		});
		void this.refreshModels();
	}

	get availableModels(): ModelChoice[] {
		return this.models;
	}

	// selectChatModels only enumerates — the consent prompt belongs to sendRequest, so
	// listing what's on offer costs nothing and asks the user nothing
	async refreshModels(): Promise<void> {
		try {
			const found = await vscode.lm.selectChatModels();
			this.models = found.map(model => ({
				id: model.id,
				name: model.name,
				family: model.family,
				vendor: model.vendor
			}));
			if (this.models.length) {
				this.noModel = false;
			}
		} catch (error) {
			this.log.appendLine(`[models] could not list: ${error instanceof Error ? error.message : String(error)}`);
			this.models = [];
		}
		this._onDidChange.fire();
	}

	get inFlight(): string[] {
		return [...this.generating];
	}

	request(target: SubtitleTarget, explicit: boolean, mode: GenerationMode): void {
		if (this.generating.has(target.sessionId)) {
			return;
		}
		if (this.queue.some(entry => entry.target.sessionId === target.sessionId)) {
			return;
		}
		this.queue.push({ target, explicit, mode });
		this.generating.add(target.sessionId);
		this._onDidChange.fire();
		void this.drain();
	}

	// called on every repaint, so everything here is a cheap in-memory check
	considerAuto(targets: SubtitleTarget[]): void {
		const preferences = readSubtitlePreferences();
		if (!preferences.auto || this.declined || this.noModel) {
			return;
		}
		if (this.queue.length >= AUTO_QUEUE_LIMIT || Date.now() - this.lastAutoAt < AUTO_GAP_MS) {
			return;
		}

		const now = Date.now();
		for (const target of targets) {
			const meta = this.tags.meta(target.sessionId);
			if (meta.subtitleSource === 'manual') {
				continue;
			}
			// only sessions that moved since this window opened. without it, switching the
			// setting on would backfill every session on disk in one go
			if (target.lastActivityAt <= this.startedAt) {
				continue;
			}
			if (now - target.lastActivityAt < preferences.idleMs) {
				continue;
			}
			if ((meta.subtitleUpdatedAt ?? 0) >= target.lastActivityAt) {
				continue;
			}
			this.lastAutoAt = now;
			// a status line the user asked for stays a status line, whatever the setting says
			this.request(target, false, meta.subtitleMode ?? preferences.mode);
			return;
		}
	}

	private async drain(): Promise<void> {
		if (this.running) {
			return;
		}
		this.running = true;
		try {
			while (this.queue.length) {
				const entry = this.queue.shift()!;
				try {
					await this.generate(entry);
				} catch (error) {
					this.report(error, entry.explicit);
				} finally {
					this.generating.delete(entry.target.sessionId);
					this._onDidChange.fire();
				}
			}
		} finally {
			this.running = false;
		}
	}

	private async generate(entry: QueueEntry): Promise<void> {
		const { target, explicit } = entry;
		const model = await pickModel();
		if (!model) {
			this.noModel = true;
			if (explicit) {
				void vscode.window.showWarningMessage(
					'Chat Tags found no language model. Sign in to a chat provider, or add one under Chat: Manage Language Models.'
				);
			}
			this.log.appendLine('[subtitle] no language model available');
			return;
		}

		const material = await this.gather(entry);
		if (!material) {
			if (explicit) {
				void vscode.window.showInformationMessage('Nothing in that session to summarise yet.');
			}
			return;
		}

		const { prompt, bytesScanned } = material;
		const source = new vscode.CancellationTokenSource();
		const timer = setTimeout(() => source.cancel(), REQUEST_TIMEOUT_MS);

		try {
			const response = await model.sendRequest(
				[vscode.LanguageModelChatMessage.User(prompt)],
				{ justification: 'Chat Tags summarises a chat session into a one-line status for its sidebar.' },
				source.token
			);

			let raw = '';
			for await (const chunk of response.text) {
				raw += chunk;
				// the answer is a few words; anything longer is the model ignoring the brief
				if (raw.length > 400) {
					break;
				}
			}

			const answer = entry.mode === 'title' ? tidyTitle(raw) : tidy(raw);
			if (!answer) {
				this.log.appendLine(`[${entry.mode}] ${target.sessionId} produced nothing usable from ${model.id}`);
				return;
			}

			if (entry.mode === 'title') {
				await this.tags.setTitle(target.sessionId, answer, 'llm');
			} else {
				await this.tags.setSubtitle(target.sessionId, answer, 'llm', entry.mode);
			}
			this.log.appendLine(
				`[${entry.mode}] ${target.sessionId} via ${model.id} (${bytesScanned} bytes scanned): ${answer}`
			);
		} finally {
			clearTimeout(timer);
			source.dispose();
		}
	}

	// 'status' reads the end of the session, the other two read the beginning
	private async gather(entry: QueueEntry): Promise<{ prompt: string; bytesScanned: number } | undefined> {
		const { target, mode } = entry;

		if (mode === 'status') {
			const exchange = await readLastExchange(target.filePath);
			if (!exchange.userText && !exchange.assistantText && !exchange.activity.length) {
				return undefined;
			}
			return {
				prompt: buildStatusPrompt(target.title, exchange),
				bytesScanned: exchange.bytesScanned
			};
		}

		const opening = await readOpeningMessages(target.filePath, OPENING_MESSAGE_COUNT);
		if (!opening.messages.length) {
			return undefined;
		}
		return {
			prompt: mode === 'title'
				? buildTitlePrompt(target.title, opening.messages)
				: buildTaskPrompt(target.title, opening.messages),
			bytesScanned: opening.bytesScanned
		};
	}

	private report(error: unknown, explicit: boolean): void {
		const message = error instanceof Error ? error.message : String(error);
		const code = error instanceof vscode.LanguageModelError ? error.code : undefined;
		this.log.appendLine(`[subtitle] failed${code ? ` (${code})` : ''}: ${message}`);

		if (code === 'NoPermissions') {
			this.declined = true;
			if (explicit) {
				void vscode.window.showWarningMessage(
					'Chat Tags needs permission to use a language model. Allow it when prompted, then try again.'
				);
			}
			return;
		}
		if (explicit) {
			void vscode.window.showWarningMessage(`Chat Tags could not generate a subtitle: ${message}`);
		}
	}

	dispose(): void {
		this.listener.dispose();
		this._onDidChange.dispose();
	}
}

async function pickModel(): Promise<vscode.LanguageModelChat | undefined> {
	const preferences = readSubtitlePreferences();
	if (preferences.model) {
		const byId = await vscode.lm.selectChatModels({ id: preferences.model });
		if (byId.length) {
			return byId[0];
		}
		// a family name is a reasonable thing to have typed into the setting by hand, and
		// a pinned id disappears when its provider is signed out
		const byFamily = await vscode.lm.selectChatModels({ family: preferences.model });
		if (byFamily.length) {
			return byFamily[0];
		}
	}

	const models = await vscode.lm.selectChatModels();
	if (!models.length) {
		return undefined;
	}
	const cheap = models.find(model =>
		CHEAP_MARKERS.some(marker => `${model.family} ${model.id}`.toLowerCase().includes(marker))
	);
	return cheap ?? models[0];
}
