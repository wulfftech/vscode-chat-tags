import * as vscode from 'vscode';

// where a clicked session lands. 'activeGroup' is the default because it's the least
// surprising; the other two rearrange the window and should be opt-in.
export type OpenTarget = 'activeGroup' | 'beside' | 'dedicatedRight';

export interface OpenPreferences {
	target: OpenTarget;
	// share of width given to the dedicated column, 0.2–0.8
	ratio: number;
}

const CONFIG_SECTION = 'chatTags';

export function readPreferences(): OpenPreferences {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const target = config.get<OpenTarget>('openTarget', 'activeGroup');
	const ratio = Math.min(0.8, Math.max(0.2, config.get<number>('dedicatedColumnRatio', 0.4)));
	return { target, ratio };
}

export async function writeTarget(target: OpenTarget): Promise<void> {
	await writeSetting('openTarget', target);
}

// every in-pane control routes through here, so the pane and the Settings UI stay
// two views of the same stored value rather than two competing stores
export async function writeSetting(key: string, value: unknown): Promise<void> {
	await vscode.workspace.getConfiguration(CONFIG_SECTION)
		.update(key, value, vscode.ConfigurationTarget.Global);
}

export interface ActivityThresholds {
	activeMs: number;
	recentMs: number;
}

export interface SubtitlePreferences {
	auto: boolean;
	idleMs: number;
	// what a plain 'Generate subtitle' does, and what the automatic sweep uses
	mode: 'status' | 'task';
	// model id, or empty to take the cheapest the window has
	model: string;
}

export function readSubtitlePreferences(): SubtitlePreferences {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const idleSeconds = Math.min(3600, Math.max(10, config.get<number>('subtitleIdleSeconds', 120)));
	const mode = config.get<string>('subtitleMode', 'status');
	return {
		auto: config.get<boolean>('autoSubtitle', false),
		idleMs: idleSeconds * 1000,
		mode: mode === 'task' ? 'task' : 'status',
		model: config.get<string>('subtitleModel', '').trim()
	};
}

// how the list is ordered and grouped. these are view controls rather than settings,
// but they persist the same way everything else in the pane does
export interface ListPreferences {
	// 'activity' is the file mtime, 'created' is the header's creationDate. they put about
	// two thirds of real sessions in different places, so these are genuinely two orders
	sortBy: 'activity' | 'created';
	groupBy: 'none' | 'category';
	showArchived: boolean;
}

export function readListPreferences(): ListPreferences {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const sortBy = config.get<string>('sortBy', 'activity');
	const groupBy = config.get<string>('groupBy', 'none');
	return {
		sortBy: sortBy === 'created' ? 'created' : 'activity',
		groupBy: groupBy === 'category' ? 'category' : 'none',
		showArchived: config.get<boolean>('showArchived', false)
	};
}

export function readActivityThresholds(): ActivityThresholds {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const activeSeconds = Math.min(600, Math.max(5, config.get<number>('activeSeconds', 45)));
	const recentMinutes = Math.min(1440, Math.max(1, config.get<number>('recentMinutes', 10)));
	return { activeMs: activeSeconds * 1000, recentMs: recentMinutes * 60_000 };
}

interface EditorLayout {
	orientation?: number;
	groups?: Array<{ size?: number; groups?: unknown[] }>;
}

/**
 * Guarantees a full-height column on the right and focuses it, so a subsequent open
 * lands there. Composed from setEditorLayout + a focus command rather than passing a
 * view column to the open call — the chat open path routes through workbench actions
 * that target the *active* group, so moving the active group is what actually works.
 */
export async function focusDedicatedColumn(ratio: number): Promise<void> {
	let layout: EditorLayout | undefined;
	try {
		layout = await vscode.commands.executeCommand<EditorLayout>('vscode.getEditorLayout');
	} catch {
		layout = undefined;
	}

	const horizontal = (layout?.orientation ?? 0) === 0;
	const rootGroups = layout?.groups?.length ?? 0;
	// only rearrange when there isn't already a right-hand column — otherwise every
	// click would stomp on a layout the user set up themselves
	const nested = layout?.groups?.some(group => Array.isArray(group.groups) && group.groups.length > 0) ?? false;

	if (!horizontal || rootGroups < 2 || nested) {
		await vscode.commands.executeCommand('vscode.setEditorLayout', {
			orientation: 0,
			groups: [{ size: 1 - ratio }, { size: ratio }]
		});
		await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
		return;
	}

	await vscode.commands.executeCommand('workbench.action.focusLastEditorGroup');
}

export async function focusSideGroup(): Promise<void> {
	// splitting when only one group exists gives 'beside' something to open into
	const layout = await vscode.commands
		.executeCommand<EditorLayout>('vscode.getEditorLayout')
		.then(value => value, () => undefined);
	if ((layout?.groups?.length ?? 0) < 2) {
		await vscode.commands.executeCommand('workbench.action.splitEditorRight');
	}
	await vscode.commands.executeCommand('workbench.action.focusLastEditorGroup');
}

/** Applies whatever window arrangement the chosen target needs before opening. */
export async function prepareForOpen(preferences: OpenPreferences): Promise<void> {
	if (preferences.target === 'dedicatedRight') {
		await focusDedicatedColumn(preferences.ratio);
	} else if (preferences.target === 'beside') {
		await focusSideGroup();
	}
}
