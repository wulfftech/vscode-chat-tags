// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 WulffTech

import * as fs from 'fs';
import * as vscode from 'vscode';
import { readArchivedSessionIds, stateDbBeside } from '../core/archiveSeed';
import { ChatSessionInfo, activityStateOf, compareSessions, listSessions } from '../core/sessions';
import { PALETTE, TagStore } from '../model/categories';
import { OpenTarget, prepareForOpen, readActivityThresholds, readListPreferences, readPreferences, readSubtitlePreferences, writeSetting, writeTarget } from '../layout';
import { deleteSession, newSession, openSession } from '../navigation';
import { isDefaultPermission } from '../core/permissions';
import { SessionApprovalTracker } from '../core/sessionApproval';
import { GenerationMode } from '../core/subtitleText';
import { SubtitleService } from '../subtitles';

// activity is time-based, so the view has to repaint even when nothing on disk moved
const REPAINT_INTERVAL_MS = 20_000;

// long enough that a run of appends from one live chat collapses into a single scan,
// short enough that a new session still appears while the user is looking for it
const REFRESH_DEBOUNCE_MS = 400;

// how long a chat started from the + button stays eligible to claim the selection. a new
// chat reaches disk only when its first message lands, and that is however long the user
// takes to type it
const NEW_SESSION_GRACE_MS = 5 * 60_000;

interface RenderedSession {
	sessionId: string;
	title: string;
	// true when the title shown is ours rather than the one in the session file
	titleOverridden: boolean;
	titleSource?: 'manual' | 'llm';
	subtitle?: string;
	subtitleSource?: 'manual' | 'llm';
	requestCount: number;
	lastActivityAt: number;
	createdAt: number;
	activity: string;
	categoryId?: string;
	needsAttention: boolean;
	generating: boolean;
	archived: boolean;
	// absent on a default session, so the common row carries nothing extra and the view
	// has no decision to make about whether to draw the pill
	permissionLevel?: string;
	// "Allow All Commands in this Session" is live for this chat, as of the last terminal
	// command it ran. the picker level says nothing about this one — under a policy that
	// blocks the elevated levels it is the only route left
	autoApproving?: boolean;
}

function nonce(): string {
	let text = '';
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}

export class SessionsViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'chatTags.sessions';

	private view?: vscode.WebviewView;
	private sessions: ChatSessionInfo[] = [];
	private readonly approvals = new SessionApprovalTracker();
	private timer?: NodeJS.Timeout;
	// which row draws as selected. the pane cannot read editor focus — a chat editor
	// reaches the tabs api as TabInputKind.Unknown, so tab.input is undefined and carries
	// no session uri. this is what we opened ourselves, which is the same thing in practice
	private activeSessionId?: string;
	// a chat started from + has no file until its first message, so there is no row to
	// select yet. these hold the intent until the session turns up on disk
	private awaitingNewSession = false;
	private knownBeforeNewChat = new Set<string>();
	private awaitingUntil = 0;
	// the watcher fires once per append, and an active chat appends constantly. these
	// hold the storm to one scan at a time with at most one more queued behind it
	private refreshTimer?: NodeJS.Timeout;
	private refreshing = false;
	private refreshQueued = false;
	// vs code's archive is read once per window, on the first pass that knows the list
	private seededArchive = false;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly directories: string[],
		private readonly tags: TagStore,
		private readonly subtitles: SubtitleService,
		private readonly log: vscode.OutputChannel
	) {
		this.tags.onDidChange(() => this.post());
		this.subtitles.onDidChange(() => this.post());
	}

	async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
		};
		view.webview.html = this.html(view.webview);
		view.webview.onDidReceiveMessage(message => this.handle(message));

		view.onDidDispose(() => {
			if (this.timer) {
				clearInterval(this.timer);
				this.timer = undefined;
			}
			if (this.refreshTimer) {
				clearTimeout(this.refreshTimer);
				this.refreshTimer = undefined;
			}
			this.view = undefined;
		});

		// a hidden pane has nothing to repaint, and the repaint walks every session
		view.onDidChangeVisibility(() => {
			if (view.visible) {
				this.post();
			}
		});

		this.timer = setInterval(() => {
			if (this.view?.visible) {
				this.post();
			}
		}, REPAINT_INTERVAL_MS);
		await this.refresh();
	}

	// what the file watcher asks for. a burst of appends collapses into one scan rather
	// than one scan apiece, each of which used to walk the whole store
	scheduleRefresh(): void {
		if (this.refreshTimer) {
			return;
		}
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			void this.refresh();
		}, REFRESH_DEBOUNCE_MS);
	}

	async refresh(): Promise<void> {
		// a refresh arriving mid-scan used to start a second full fan-out over the store
		// on top of the first, which is how a large store took the extension host down
		if (this.refreshing) {
			this.refreshQueued = true;
			return;
		}
		this.refreshing = true;
		try {
			await this.scan();
			if (this.refreshQueued) {
				// whatever landed while we were reading is worth exactly one more pass
				this.refreshQueued = false;
				await this.scan();
			}
		} finally {
			this.refreshing = false;
			this.refreshQueued = false;
		}
	}

	private async scan(): Promise<void> {
		const perDirectory = await Promise.all(this.directories.map(dir => listSessions(dir, {
			onParseError: ({ filePath, parseError }) => this.log.appendLine(`[session] ${filePath}: ${parseError}`)
		})));
		this.sessions = perDirectory.flat().sort((a, b) => b.lastActivityAt - a.lastActivityAt);
		await this.seedArchiveOnce();
		// the first pass only records where the files already ended — see the tracker for
		// why anything written before this window started cannot be read as live
		await this.approvals.update(this.sessions);
		this.adoptNewSession();
		this.post();
	}

	// the chat the + button started shows up seconds later, once the user has sent
	// something. at that moment it is still the chat they are looking at, so it takes the
	// selection — unless they opened something else while typing, which says otherwise
	private adoptNewSession(): void {
		if (!this.awaitingNewSession) {
			return;
		}
		if (Date.now() > this.awaitingUntil) {
			this.awaitingNewSession = false;
			return;
		}
		// sessions are newest first, so the first unrecognised id is the one just created
		const fresh = this.sessions.find(session => !this.knownBeforeNewChat.has(session.sessionId));
		if (fresh) {
			this.activeSessionId = fresh.sessionId;
			this.awaitingNewSession = false;
		}
	}

	// chats archived in vs code's own chat view were all showing as live here, because
	// its archive and ours are separate stores that never reconcile. take it once, and
	// only for sessions actually in the list — a stale page then cannot archive a row
	// that isn't ours to begin with
	private async seedArchiveOnce(): Promise<void> {
		if (this.seededArchive) {
			return;
		}
		this.seededArchive = true;
		const known = new Set(this.sessions.map(session => session.sessionId));
		for (const directory of this.directories) {
			const database = stateDbBeside(directory);
			try {
				const found = await readArchivedSessionIds(database);
				const archived = found.filter(sessionId => known.has(sessionId));
				const adopted = archived.length ? await this.tags.seedArchived(archived) : 0;
				// logged even at zero: on a machine reporting chats it archived over there
				// still showing here, this line is the difference between a database we
				// could not read and one that genuinely holds nothing
				this.log.appendLine(
					`[archive] ${database}: ${found.length} archived, ${archived.length} in the list, ${adopted} adopted`
				);
			} catch (error) {
				// a missing archive is not worth a broken pane
				this.log.appendLine(`[archive] ${database}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	openCategories(): void {
		void this.view?.webview.postMessage({ type: 'openPanel', panel: 'categories' });
		this.view?.show?.(true);
	}

	private post(): void {
		if (!this.view) {
			return;
		}
		const now = Date.now();
		const thresholds = readActivityThresholds();
		const preferences = readPreferences();
		const subtitles = readSubtitlePreferences();
		const list = readListPreferences();
		const inFlight = new Set(this.subtitles.inFlight);
		const all: RenderedSession[] = this.sessions.map(session => {
			const meta = this.tags.meta(session.sessionId);
			return {
				sessionId: session.sessionId,
				title: meta.title ?? session.title,
				titleOverridden: Boolean(meta.title),
				titleSource: meta.titleSource,
				subtitle: meta.subtitle,
				subtitleSource: meta.subtitleSource,
				requestCount: session.requestCount,
				lastActivityAt: session.lastActivityAt,
				createdAt: session.createdAt,
				activity: activityStateOf(session, now, thresholds),
				categoryId: meta.categoryId,
				needsAttention: this.tags.needsAttention(session.sessionId, session.lastActivityAt),
				generating: inFlight.has(session.sessionId),
				archived: Boolean(meta.archivedAt),
				permissionLevel: isDefaultPermission(session.permissionLevel)
					? undefined
					: session.permissionLevel,
				autoApproving: this.approvals.isApproving(session.sessionId) || undefined
			};
		});

		const archivedCount = all.filter(session => session.archived).length;
		const rendered = (list.showArchived ? all : all.filter(session => !session.archived))
			.sort(compareSessions(list.sortBy));

		void this.view.webview.postMessage({
			type: 'render',
			sessions: rendered,
			categories: this.tags.categories,
			collapsedGroups: this.tags.collapsedGroups,
			archivedCount,
			activeSessionId: this.activeSessionId,
			settings: {
				openTarget: preferences.target,
				dedicatedColumnRatio: preferences.ratio,
				activeSeconds: Math.round(thresholds.activeMs / 1000),
				recentMinutes: Math.round(thresholds.recentMs / 60_000),
				autoSubtitle: subtitles.auto,
				subtitleIdleSeconds: Math.round(subtitles.idleMs / 1000),
				subtitleMode: subtitles.mode,
				subtitleModel: subtitles.model,
				sortBy: list.sortBy,
				groupBy: list.groupBy,
				showArchived: list.showArchived
			},
			models: this.subtitles.availableModels
		});

		// queueing fires onDidChange, which reposts — so this runs last, or the row that
		// just got queued would paint without its spinner until the next repaint.
		// archived sessions are out of sight, so they don't get billable generations
		this.subtitles.considerAuto(this.sessions
			.filter(session => !this.tags.meta(session.sessionId).archivedAt)
			.map(session => ({
				sessionId: session.sessionId,
				title: session.title,
				filePath: session.filePath,
				lastActivityAt: session.lastActivityAt
			})));
	}

	private generate(sessionId: string, mode?: GenerationMode): void {
		const session = this.sessions.find(entry => entry.sessionId === sessionId);
		if (!session) {
			return;
		}
		this.subtitles.request({
			sessionId: session.sessionId,
			// feed the model whatever is on screen, override included — a regenerated title
			// should be judged against the one it is replacing
			title: this.tags.meta(session.sessionId).title ?? session.title,
			filePath: session.filePath,
			lastActivityAt: session.lastActivityAt
		}, true, mode ?? readSubtitlePreferences().mode);
	}

	openSettingsPanel(): void {
		void this.view?.webview.postMessage({ type: 'openPanel', panel: 'settings' });
		this.view?.show?.(true);
	}

	// a palette entry has no row to act on, so it asks which session
	private async pickSession(placeHolder: string): Promise<string | undefined> {
		if (!this.sessions.length) {
			await this.refresh();
		}
		const picked = await vscode.window.showQuickPick(
			this.sessions.map(session => {
				const meta = this.tags.meta(session.sessionId);
				return {
					label: meta.title ?? session.title,
					description: meta.archivedAt ? 'archived' : meta.subtitle,
					sessionId: session.sessionId
				};
			}),
			{ placeHolder, matchOnDescription: true }
		);
		return picked?.sessionId;
	}

	async generateViaPicker(mode: GenerationMode): Promise<void> {
		const sessionId = await this.pickSession(mode === 'title'
			? 'Regenerate the title of which session?'
			: 'Generate a subtitle for which session?');
		if (sessionId) {
			this.generate(sessionId, mode);
		}
	}

	// one entry for both directions — picking an archived session restores it
	async archiveViaPicker(): Promise<void> {
		const sessionId = await this.pickSession('Archive or restore which session?');
		if (sessionId) {
			await this.tags.setArchived(sessionId, !this.tags.meta(sessionId).archivedAt);
		}
	}

	async deleteViaPicker(): Promise<void> {
		const sessionId = await this.pickSession('Delete which session? This cannot be undone.');
		if (sessionId) {
			await this.delete(sessionId);
		}
	}

	private async handle(message: any): Promise<void> {
		switch (message?.type) {
			case 'ready':
				this.post();
				return;
			case 'refresh':
				await this.refresh();
				return;
			case 'open':
				await this.open(message.sessionId);
				return;
			case 'newChat':
				await this.newChat();
				return;
			case 'setCategory':
				await this.tags.setCategory(message.sessionId, message.categoryId ?? undefined);
				return;
			case 'setArchived':
				await this.tags.setArchived(message.sessionId, Boolean(message.archived));
				return;
			case 'deleteSession':
				await this.delete(message.sessionId);
				return;
			case 'setSubtitle':
				await this.tags.setSubtitle(message.sessionId, message.text, 'manual');
				return;
			case 'generateSubtitle':
				this.generate(message.sessionId, message.mode);
				return;
			case 'setTitle':
				await this.tags.setTitle(message.sessionId, message.text, 'manual');
				return;
			case 'openInExtensions':
				await openInExtensions();
				return;
			case 'createCategory':
				await this.tags.createCategory('New category', this.nextColour());
				return;
			case 'updateCategory':
				await this.tags.updateCategory(message.id, {
					...(message.name !== undefined ? { name: message.name } : {}),
					...(message.colour !== undefined ? { colour: message.colour } : {})
				});
				return;
			case 'deleteCategory':
				await this.confirmDelete(message.id);
				return;
			case 'setOpenTarget':
				await writeTarget(message.target as OpenTarget);
				this.post();
				return;
			case 'setSetting':
				await writeSetting(message.key, message.value);
				this.post();
				return;
			case 'markAllRead':
				await this.tags.markAllSeen(this.sessions.map(session => session.sessionId));
				return;
			case 'toggleGroupCollapsed':
				await this.tags.toggleGroupCollapsed(message.groupId);
				return;
		}
	}

	// cycle the palette so a new category never lands on the colour just used
	private nextColour(): string {
		const used = new Set(this.tags.categories.map(category => category.colour.toLowerCase()));
		const free = PALETTE.find(entry => !used.has(entry.colour.toLowerCase()));
		return (free ?? PALETTE[this.tags.categories.length % PALETTE.length]!).colour;
	}

	private async confirmDelete(id: string): Promise<void> {
		const category = this.tags.category(id);
		if (!category) {
			return;
		}
		const confirm = await vscode.window.showWarningMessage(
			`Delete category "${category.name}"? Sessions using it keep their subtitles but lose the colour.`,
			{ modal: true },
			'Delete'
		);
		if (confirm === 'Delete') {
			await this.tags.deleteCategory(id);
		}
	}

	// vs code runs its own confirmation dialog, names the session and warns that it can't
	// be undone, so there is nothing worth asking here first
	private async delete(sessionId: string): Promise<void> {
		const session = this.sessions.find(entry => entry.sessionId === sessionId);
		try {
			await deleteSession(sessionId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.log.appendLine(`[delete] ${sessionId} failed: ${message}`);
			const choice = await vscode.window.showWarningMessage(
				'Chat Tags could not delete that session. The workbench command may have changed in this VS Code version.',
				'Show Log'
			);
			if (choice === 'Show Log') {
				this.log.show(true);
			}
			return;
		}

		// the command resolves whether the user confirmed or cancelled, so the file is the
		// only evidence of what happened
		const gone = session ? !fs.existsSync(session.filePath) : true;
		this.log.appendLine(`[delete] ${sessionId} ${gone ? 'removed' : 'still on disk — cancelled, or absent from this session index'}`);
		if (gone) {
			await this.tags.forget(sessionId);
		}
		await this.refresh();
	}

	private async open(sessionId: string): Promise<void> {
		this.activeSessionId = sessionId;
		// opening something by hand settles the question of what the user is looking at, so a
		// pending new chat no longer gets to take the selection off them
		this.awaitingNewSession = false;

		// opening is what clears the attention state — that's the whole contract of the
		// left border, so mark first and let the result post the repaint
		await this.tags.markSeen(sessionId);

		// arrange the window first — the open path targets whichever group is active
		await prepareForOpen(readPreferences());

		const result = await openSession(sessionId);
		this.log.appendLine(`[open] ${sessionId} -> ${result.succeeded ?? 'ALL RUNGS FAILED'}`);
		if (!result.succeeded) {
			const choice = await vscode.window.showWarningMessage(
				'Chat Tags could not open that session. The workbench command may have changed in this VS Code version.',
				'Show Log'
			);
			if (choice === 'Show Log') {
				this.log.show(true);
			}
		}
	}

	async newChat(): Promise<void> {
		// same arrangement the click path uses, so a new chat lands where an opened one
		// would rather than wherever the workbench felt like putting it
		await prepareForOpen(readPreferences());

		const result = await newSession();
		this.log.appendLine(`[new] -> ${result.succeeded ?? 'ALL RUNGS FAILED'}`);
		if (!result.succeeded) {
			const choice = await vscode.window.showWarningMessage(
				'Chat Tags could not start a new chat. The workbench command may have changed in this VS Code version.',
				'Show Log'
			);
			if (choice === 'Show Log') {
				this.log.show(true);
			}
			return;
		}

		// the workbench writes nothing until the chat has its first message, so this refresh
		// finds no new row. the watcher fires when the file finally lands, and adoptNewSession
		// hands the selection over then
		this.knownBeforeNewChat = new Set(this.sessions.map(session => session.sessionId));
		this.awaitingNewSession = true;
		this.awaitingUntil = Date.now() + NEW_SESSION_GRACE_MS;
		await this.refresh();
	}

	private html(webview: vscode.Webview): string {
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'view.css'));
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'view.js'));
		const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png'));
		const id = nonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${id}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>Chat Tags</title>
</head>
<body data-logo="${logoUri}">
<div id="root"></div>
<script nonce="${id}" src="${scriptUri}"></script>
</body>
</html>`;
	}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
		}
	}
}

// both commands exist in the 1.134.0 workbench bundle. extension.open takes
// [id, tab, preserveFocus] and lands on the detail page; the search fallback only opens
// the view with a query, which is still better than nothing
const EXTENSION_ID = 'wulfftech.chat-tags';

async function openInExtensions(): Promise<void> {
	try {
		await vscode.commands.executeCommand('extension.open', EXTENSION_ID);
	} catch {
		await vscode.commands.executeCommand('workbench.extensions.search', `@id:${EXTENSION_ID}`);
	}
}
