import * as vscode from 'vscode';
import { localSessionUriString } from './core/sessionUri';
import { ChatSessionInfo } from './core/sessions';

// confirms the undocumented open path against a live workbench
// a command that doesn't throw hasn't necessarily done anything, so each rung is
// judged on whether an editor tab actually appeared

const OPEN_COMMAND = 'workbench.action.chat.openSessionInEditorGroup';
const MARSHALLED_AGENT_SESSION_CONTEXT = 25;

interface TabSnapshot {
	label: string;
	inputType: string;
}

export interface RungReport {
	rung: string;
	threw: boolean;
	error?: string;
	tabsBefore: number;
	tabsAfter: number;
	openedTabs: TabSnapshot[];
	// the only result that matters — a tab appeared
	opened: boolean;
}

export interface SpikeReport {
	vscodeVersion: string;
	commandRegistered: boolean;
	directories: string[];
	workspaceSource: string;
	workspaceFolderUri: string;
	siblingCandidate: string;
	targetSessionId: string;
	targetTitle: string;
	targetTitleSource: string;
	sessionUri: string;
	sessionsFound: number;
	sessionsShown: number;
	rungs: RungReport[];
	verdict: string;
}

function snapshotTabs(): TabSnapshot[] {
	return vscode.window.tabGroups.all
		.flatMap(group => group.tabs)
		.map(tab => ({
			label: tab.label,
			inputType: tab.input?.constructor?.name ?? 'unknown'
		}));
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function closeAllTabs(): Promise<void> {
	const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
	if (tabs.length) {
		await vscode.window.tabGroups.close(tabs, true);
		await delay(250);
	}
}

async function runRung(rung: string, invoke: () => Thenable<unknown>): Promise<RungReport> {
	await closeAllTabs();
	const before = snapshotTabs();

	let threw = false;
	let error: string | undefined;
	try {
		await invoke();
	} catch (caught) {
		threw = true;
		error = caught instanceof Error ? caught.message : String(caught);
	}

	// opening an editor is async even once the command resolves
	await delay(1200);
	const after = snapshotTabs();
	const openedTabs = after.filter(
		tab => !before.some(prior => prior.label === tab.label && prior.inputType === tab.inputType)
	);

	return {
		rung,
		threw,
		error,
		tabsBefore: before.length,
		tabsAfter: after.length,
		openedTabs,
		opened: openedTabs.length > 0
	};
}

export async function runSpike(
	sessions: ChatSessionInfo[],
	context: { directories: string[]; workspaceSource: string; sessionsOnDisk: number; workspaceFolderUri: string; siblingCandidate: string }
): Promise<SpikeReport> {
	const target = sessions[0];
	const uriString = target ? localSessionUriString(target.sessionId) : '';
	const commands = await vscode.commands.getCommands(true);
	const commandRegistered = commands.includes(OPEN_COMMAND);

	const rungs: RungReport[] = [];
	if (target) {
		const uri = vscode.Uri.parse(uriString);

		rungs.push(await runRung('1-vscode-open', () =>
			vscode.commands.executeCommand('vscode.open', uri)));

		rungs.push(await runRung('2-bare-resource', () =>
			vscode.commands.executeCommand(OPEN_COMMAND, { resource: uri })));

		rungs.push(await runRung('3-marshalled-context', () =>
			vscode.commands.executeCommand(OPEN_COMMAND, {
				$mid: MARSHALLED_AGENT_SESSION_CONTEXT,
				session: { resource: uri }
			})));

		await closeAllTabs();
	}

	const winner = rungs.find(rung => rung.opened);
	const verdict = !target
		? 'NO SESSIONS — nothing to test against'
		: winner
			? `PASS via ${winner.rung} (${rungs.filter(r => r.opened).length}/3 rungs opened a session)`
			: 'FAIL — no rung opened a session';

	return {
		vscodeVersion: vscode.version,
		commandRegistered,
		directories: context.directories,
		workspaceSource: context.workspaceSource,
		workspaceFolderUri: context.workspaceFolderUri,
		siblingCandidate: context.siblingCandidate,
		targetSessionId: target?.sessionId ?? '',
		targetTitle: target?.title ?? '',
		targetTitleSource: target?.titleSource ?? '',
		sessionUri: uriString,
		sessionsFound: context.sessionsOnDisk,
		sessionsShown: sessions.length,
		rungs,
		verdict
	};
}

// ── layout spike ──────────────────────────────────────────

export interface LayoutRungReport {
	target: string;
	layoutOrientation?: number;
	rootGroups?: number;
	groupCount: number;
	chatInColumn?: number;
	rightmostColumn: number;
	landedRight: boolean;
	error?: string;
}

async function currentLayout(): Promise<{ orientation?: number; groups?: unknown[] } | undefined> {
	try {
		return await vscode.commands.executeCommand('vscode.getEditorLayout');
	} catch {
		return undefined;
	}
}

// proves the dedicated-column arrangement actually places the chat on the right,
// rather than merely not throwing
export async function runLayoutSpike(
	sessionId: string,
	targets: string[],
	prepare: (target: string) => Promise<void>,
	open: (sessionId: string) => Promise<unknown>
): Promise<LayoutRungReport[]> {
	const reports: LayoutRungReport[] = [];

	for (const target of targets) {
		try {
			await closeAllTabs();
			await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{}] });
			await delay(300);

			await prepare(target);
			await open(sessionId);
			await delay(1400);

			const layout = await currentLayout();
			const groups = vscode.window.tabGroups.all;
			const columns = groups.map(group => group.viewColumn);
			const rightmost = columns.length ? Math.max(...columns) : 1;
			const chatGroup = groups.find(group => group.tabs.length > 0);

			reports.push({
				target,
				layoutOrientation: layout?.orientation,
				rootGroups: layout?.groups?.length,
				groupCount: groups.length,
				chatInColumn: chatGroup?.viewColumn,
				rightmostColumn: rightmost,
				landedRight: chatGroup !== undefined && chatGroup.viewColumn === rightmost && rightmost > 1
			});
		} catch (error) {
			reports.push({
				target,
				groupCount: vscode.window.tabGroups.all.length,
				rightmostColumn: 1,
				landedRight: false,
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}

	await closeAllTabs();
	await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{}] });
	return reports;
}
