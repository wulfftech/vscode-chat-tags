import * as vscode from 'vscode';
import { localSessionUriString } from './core/sessionUri';
import { ChatSessionInfo } from './core/sessions';
import { NEW_SESSION_LADDER, OPEN_COMMAND, openLadder } from './navigation';

// confirms the undocumented open path against a live workbench
// a command that doesn't throw hasn't necessarily done anything, so each rung is
// judged on whether an editor tab actually appeared

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
		const ladder = openLadder(vscode.Uri.parse(uriString));
		for (const [index, { rung, run }] of ladder.entries()) {
			rungs.push(await runRung(`${index + 1}-${rung}`, run));
		}

		await closeAllTabs();
	}

	const winner = rungs.find(rung => rung.opened);
	const verdict = !target
		? 'NO SESSIONS — nothing to test against'
		: winner
			? `PASS via ${winner.rung} (${rungs.filter(r => r.opened).length}/${rungs.length} rungs opened a session)`
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

// ── new chat spike ─────────────────────────────────────────

// what a rung did
//   opened    — an editor tab appeared, the same evidence the open rungs are held to
//   reachable — the id exists and invoking it didn't throw, which is all a panel-only
//               rung can ever show from out here
//   no-op     — resolved and left nothing behind. the silent break this file exists for
//   threw     — registered but rejected the call
//   missing   — the id has gone from the build, so upstream renamed or dropped it
export type NewSessionVerdict = 'opened' | 'reachable' | 'no-op' | 'threw' | 'missing';

export interface NewSessionRungReport {
	rung: string;
	command: string;
	registered: boolean;
	threw: boolean;
	error?: string;
	expectsTab: boolean;
	openedTabs: TabSnapshot[];
	opened: boolean;
	verdict: NewSessionVerdict;
	// only filled in for a missing id — see neighbours()
	siblings?: string[];
}

export interface NewSessionSpikeReport {
	rungs: NewSessionRungReport[];
	verdict: string;
}

// a missing id is more often a renamed suffix than a deleted command — openNewSessionEditor
// is registered as `openNewSessionEditor.${type}`, one per session type, and betting on the
// wrong type is how the + shipped broken. the ids sharing the prefix are the lead worth having
function neighbours(commands: string[], command: string): string[] {
	const prefix = command.slice(0, command.lastIndexOf('.') + 1);
	return commands.filter(id => id !== command && id.startsWith(prefix)).sort();
}

function judge(spec: { landsTab: boolean }, registered: boolean, result: RungReport): NewSessionVerdict {
	// checked before the throw, because an unregistered id throws "command not found"
	// and that reads as a broken call rather than a renamed command
	if (!registered) {
		return 'missing';
	}
	if (result.threw) {
		return 'threw';
	}
	if (!spec.landsTab) {
		return 'reachable';
	}
	return result.opened ? 'opened' : 'no-op';
}

// walks the same ladder newSession() ships. an untouched chat is held in memory and never
// written to disk, so this leaves no session files to clean up — closing the tabs is enough
export async function runNewSessionSpike(): Promise<NewSessionSpikeReport> {
	const commands = await vscode.commands.getCommands(true);
	const rungs: NewSessionRungReport[] = [];

	for (const spec of NEW_SESSION_LADDER) {
		const absent = spec.commands.filter(command => !commands.includes(command));
		const result = await runRung(spec.rung, spec.run);
		rungs.push({
			rung: spec.rung,
			command: spec.commands.join(' + '),
			registered: absent.length === 0,
			threw: result.threw,
			error: result.error,
			expectsTab: spec.landsTab,
			openedTabs: result.openedTabs,
			opened: result.opened,
			verdict: judge(spec, absent.length === 0, result),
			siblings: absent.length
				? absent.flatMap(command => neighbours(commands, command))
				: undefined
		});
	}

	await closeAllTabs();

	// judged on the top rung alone, because newSession() stops at the first command that
	// doesn't throw — a rung 1 that resolves and does nothing reports success and the
	// fallbacks below it never run, however healthy they look here
	const top = rungs[0];
	const gone = rungs.filter(rung => rung.verdict === 'missing').map(rung => rung.command);
	// whichever rung stops the fall is the one the shipped ladder reports as its success,
	// so name it — 'reachable' there means the user pressed + and got nothing
	const lands = rungs.find(rung => rung.verdict === 'opened' || rung.verdict === 'reachable');
	const verdict = !top
		? 'NO RUNGS — the ladder is empty'
		: top.verdict === 'opened'
			? `PASS via ${top.rung}${gone.length ? ` — fallback ids gone: ${gone.join(', ')}` : ''}`
			: lands
				? `FAIL — ${top.rung} came back ${top.verdict}, so + falls through to ${lands.rung} and reports success with no tab to show for it`
				: `FAIL — every rung came back unusable (${rungs.map(rung => rung.verdict).join(', ')})`;

	return { rungs, verdict };
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
