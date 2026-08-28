// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 WulffTech

import * as fs from 'fs';
import * as vscode from 'vscode';
import { ResolvedLocations, resolveSessionDirectories } from './core/locations';
import { listSessions } from './core/sessions';
import { prepareForOpen, readListPreferences, writeSetting } from './layout';
import { TagStore } from './model/categories';
import { openSession } from './navigation';
import { runLayoutSpike, runNewSessionSpike, runSpike } from './spike';
import { SubtitleService } from './subtitles';
import { SessionsViewProvider } from './webview/sessionsView';

// set to a file path to run the navigation spike headlessly and write the report there
const SPIKE_OUT_ENV = 'CHAT_TAGS_SPIKE_OUT';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const log = vscode.window.createOutputChannel('Chat Tags');
	context.subscriptions.push(log);

	const located = resolveSessionDirectories({
		storageFsPath: context.storageUri?.fsPath,
		globalStorageFsPath: context.globalStorageUri.fsPath,
		workspaceFolderUri: vscode.workspace.workspaceFolders?.[0]?.uri.toString()
	});

	const tags = new TagStore(context.globalState);
	await tags.ensureBaseline();
	context.subscriptions.push(tags);

	const subtitles = new SubtitleService(tags, log);
	context.subscriptions.push(subtitles);

	const provider = new SessionsViewProvider(context.extensionUri, located.directories, tags, subtitles, log);
	context.subscriptions.push(provider);

	// commands first — if anything below throws, these still exist and the failure is
	// visible through Show Log rather than a silently dead view
	context.subscriptions.push(
		vscode.commands.registerCommand('chatTags.newChat', () => provider.newChat()),
		vscode.commands.registerCommand('chatTags.refresh', () => provider.refresh()),
		vscode.commands.registerCommand('chatTags.showLog', () => log.show(true)),
		vscode.commands.registerCommand('chatTags.manageCategories', () => provider.openCategories()),
		vscode.commands.registerCommand('chatTags.openSettings', () => provider.openSettingsPanel()),
		vscode.commands.registerCommand('chatTags.generateSubtitle', () => provider.generateViaPicker('status')),
		vscode.commands.registerCommand('chatTags.generateTaskSubtitle', () => provider.generateViaPicker('task')),
		vscode.commands.registerCommand('chatTags.regenerateTitle', () => provider.generateViaPicker('title')),
		vscode.commands.registerCommand('chatTags.archiveSession', () => provider.archiveViaPicker()),
		vscode.commands.registerCommand('chatTags.deleteSession', () => provider.deleteViaPicker()),
		vscode.commands.registerCommand('chatTags.toggleGroupByCategory', () => toggleList('groupBy')),
		vscode.commands.registerCommand('chatTags.toggleShowArchived', () => toggleList('showArchived')),
		vscode.commands.registerCommand('chatTags.runNavigationSpike', async () => {
			// the new-chat ladder ends on a command that clears the chat widget, so anything
			// typed and unsent goes with it. the headless path below skips this on purpose
			const go = await vscode.window.showWarningMessage(
				'The spike closes every editor tab and starts several chats. Anything typed but unsent in the chat widget is lost.',
				{ modal: true },
				'Run Spike'
			);
			if (go !== 'Run Spike') {
				return;
			}
			const report = await runNavigationSpike(located, log);
			log.show(true);
			vscode.window.showInformationMessage(
				`Chat Tags spike — open: ${report.verdict} · new chat: ${report.newChat.verdict}`
			);
		})
	);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(SessionsViewProvider.viewType, provider)
	);

	log.appendLine(`[activate] workspace sessions via: ${located.workspaceSource}`);
	for (const dir of located.directories) {
		log.appendLine(`  - ${dir}`);
	}
	if (located.workspaceSource === 'none') {
		log.appendLine('[activate] no workspace session store found — listing empty-window sessions only');
	}

	for (const dir of located.directories) {
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.file(dir), '*.jsonl')
		);
		// debounced rather than immediate: a live chat appends to its session file
		// continuously, and each append is a watcher event
		const onChange = () => { provider.scheduleRefresh(); };
		watcher.onDidCreate(onChange, undefined, context.subscriptions);
		watcher.onDidChange(onChange, undefined, context.subscriptions);
		watcher.onDidDelete(onChange, undefined, context.subscriptions);
		context.subscriptions.push(watcher);
	}

	// mirror the resolution to disk — the output channel is the only other record and
	// you can't read it when diagnosing why a window came up empty
	void writeDiagnostics(context, located, log);

	const spikeOut = process.env[SPIKE_OUT_ENV];
	if (spikeOut) {
		const report: any = await runNavigationSpike(located, log);
		if (report.targetSessionId) {
			report.layout = await runLayoutSpike(
				report.targetSessionId,
				['activeGroup', 'beside', 'dedicatedRight'],
				target => prepareForOpen({ target: target as any, ratio: 0.4 }),
				id => openSession(id)
			);
			for (const rung of report.layout) {
				log.appendLine(`  ${rung.landedRight ? 'RIGHT ' : 'left  '} ${rung.target} groups=${rung.groupCount} chatCol=${rung.chatInColumn}`);
			}
		}
		await fs.promises.writeFile(spikeOut, JSON.stringify(report, null, 2), 'utf8');
		log.appendLine(`[spike] report written to ${spikeOut}`);
		// headless run — close the dev host so it doesn't linger
		await vscode.commands.executeCommand('workbench.action.closeWindow');
	}
}

async function writeDiagnostics(
	context: vscode.ExtensionContext,
	located: ResolvedLocations,
	log: vscode.OutputChannel
): Promise<void> {
	try {
		await fs.promises.mkdir(context.globalStorageUri.fsPath, { recursive: true });
		const target = vscode.Uri.joinPath(context.globalStorageUri, 'last-activation.json').fsPath;
		await fs.promises.writeFile(target, JSON.stringify({
			vscodeVersion: vscode.version,
			workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? null,
			workspaceStorage: context.storageUri?.fsPath ?? null,
			workspaceSource: located.workspaceSource,
			siblingCandidate: located.siblingCandidate,
			directories: located.directories
		}, null, 2), 'utf8');
	} catch (error) {
		log.appendLine(`[activate] could not write diagnostics: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function runNavigationSpike(located: ResolvedLocations, log: vscode.OutputChannel) {
	const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? '(no folder open)';
	const shown = (await Promise.all(located.directories.map(dir => listSessions(dir)))).flat();
	const all = (await Promise.all(
		located.directories.map(dir => listSessions(dir, { includeEmpty: true }))
	)).flat();
	shown.sort((a, b) => b.lastActivityAt - a.lastActivityAt);

	const report = await runSpike(shown, {
		directories: located.directories,
		workspaceSource: located.workspaceSource,
		sessionsOnDisk: all.length,
		workspaceFolderUri: folderUri,
		siblingCandidate: located.siblingCandidate
	});

	// second, because this half starts chats and the open rungs should be measured against
	// a window that has had none started in it
	const newChat = await runNewSessionSpike();

	log.appendLine('');
	log.appendLine('=== navigation spike ===');
	log.appendLine(`vscode           : ${report.vscodeVersion}`);
	log.appendLine(`workspace source : ${report.workspaceSource}`);
	log.appendLine(`sessions shown   : ${report.sessionsShown}`);
	for (const rung of report.rungs) {
		log.appendLine(`  ${rung.opened ? 'OPENED' : rung.threw ? 'threw ' : 'no-op '} ${rung.rung}`);
	}
	log.appendLine(`verdict          : ${report.verdict}`);

	log.appendLine('');
	log.appendLine('=== new chat spike ===');
	for (const rung of newChat.rungs) {
		log.appendLine(`  ${rung.verdict.toUpperCase().padEnd(9)} ${rung.rung} — ${rung.command}`);
		if (rung.error) {
			log.appendLine(`            ${rung.error}`);
		}
		if (rung.siblings?.length) {
			log.appendLine(`            registered instead: ${rung.siblings.join(', ')}`);
		}
	}
	log.appendLine(`verdict          : ${newChat.verdict}`);

	return { ...report, newChat };
}

// the pane's own menu is the primary control; these exist so the palette and keybindings
// can reach the same two toggles
async function toggleList(key: 'groupBy' | 'showArchived'): Promise<void> {
	const current = readListPreferences();
	if (key === 'showArchived') {
		await writeSetting('showArchived', !current.showArchived);
		return;
	}
	await writeSetting('groupBy', current.groupBy === 'category' ? 'none' : 'category');
}

export function deactivate(): void {
	// disposables are handled by the extension context
}
