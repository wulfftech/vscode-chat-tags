// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 WulffTech

import * as vscode from 'vscode';
import { localSessionUriString } from './core/sessionUri';

// three ways to open a chat session, confirmed working on 1.134.0 — tried in order of
// how likely they are to survive an update:
//   1. vscode.open on the session URI — public documented api, nothing internal
//   2. bare { resource } — BaseAgentSessionAction.run treats it as an IAgentSession
//   3. marshalled context — needs MarshalledId.AgentSessionContext, a const enum
//      inlined at compile time, so the literal below shifts if upstream inserts a
//      member above it. last resort.
// openSession reports which rung worked so a break is visible instead of silent

export const OPEN_COMMAND = 'workbench.action.chat.openSessionInEditorGroup';
const MARSHALLED_AGENT_SESSION_CONTEXT = 25;

export type NavigationRung = 'vscode-open' | 'bare-resource' | 'marshalled-context';

export interface Attempt<R extends string> {
	rung: R;
	ok: boolean;
	error?: string;
}

export type NavigationAttempt = Attempt<NavigationRung>;

export interface NavigationResult {
	sessionId: string;
	uri: string;
	succeeded?: NavigationRung;
	attempts: NavigationAttempt[];
}

async function attempt<R extends string>(rung: R, run: () => Thenable<unknown>): Promise<Attempt<R>> {
	try {
		await run();
		return { rung, ok: true };
	} catch (error) {
		return { rung, ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export interface Rung<R extends string> {
	rung: R;
	run: () => Thenable<unknown>;
}

// the spike walks this array rather than keeping its own copy, so what it proves is the
// ladder that ships. the marshalled id especially — two copies of a compile-time literal
// drift apart and the spike goes green on a number the extension no longer sends
export function openLadder(uri: vscode.Uri): Array<Rung<NavigationRung>> {
	return [
		{ rung: 'vscode-open', run: () => vscode.commands.executeCommand('vscode.open', uri) },
		{ rung: 'bare-resource', run: () => vscode.commands.executeCommand(OPEN_COMMAND, { resource: uri }) },
		{
			rung: 'marshalled-context', run: () => vscode.commands.executeCommand(OPEN_COMMAND, {
				$mid: MARSHALLED_AGENT_SESSION_CONTEXT,
				session: { resource: uri }
			})
		}
	];
}

// walks the ladder until a rung sticks
// a command resolving only means it didn't throw — see spike.ts for real evidence
export async function openSession(sessionId: string): Promise<NavigationResult> {
	const uriString = localSessionUriString(sessionId);
	const uri = vscode.Uri.parse(uriString);
	const attempts: NavigationAttempt[] = [];

	for (const { rung, run } of openLadder(uri)) {
		const result = await attempt(rung, run);
		attempts.push(result);
		if (result.ok) {
			return { sessionId, uri: uriString, succeeded: rung, attempts };
		}
	}

	return { sessionId, uri: uriString, attempts };
}

// starting a chat is the same shape of problem as opening one — no public api, and more
// than one workbench command that looks like the right answer. what the spike found on
// 1.135.0, after this shipped betting on a command that isn't registered there:
//   - openNewSessionEditor is registered by ChatSessionsContribution._registerCommands,
//     once per *contributed* session type. the suffixes that exist are copilotcli,
//     copilot-cloud-agent and agent-host-copilotcli. 'local' is a SessionType member but
//     not a contribution, so openNewSessionEditor.local has no registration to find
//   - newLocalChat carries precondition chat.location == panel, which turns out not to
//     matter: registerAction2 puts the bare run() in the commands registry and only menus
//     and keybindings consult the precondition. its no-widget branch opens the chat view
//     and calls startNewLocalSession, so it works wherever chat is docked
//   - it leaves the session in the view though, and this extension opens everything else
//     as an editor tab. openInEditor ("Move Chat into Editor Area") moves the focused
//     widget across, which is the half that was missing
const NEW_LOCAL_CHAT = 'workbench.action.chat.newLocalChat';
const OPEN_IN_EDITOR = 'workbench.action.chat.openInEditor';
const NEW_CHAT = 'workbench.action.chat.newChat';

export type NewSessionRung = 'local-in-editor' | 'new-chat';

export interface NewSessionResult {
	succeeded?: NewSessionRung;
	attempts: Array<Attempt<NewSessionRung>>;
}

export interface NewSessionRungSpec {
	rung: NewSessionRung;
	// a rung is only as registered as its rarest command, and the spike checks all of them
	commands: string[];
	run: () => Thenable<unknown>;
	// only the first rung leaves a tab behind. newChat acts on the panel widget, which the
	// extension host cannot see, so the spike has to judge that one some other way
	landsTab: boolean;
}

export const NEW_SESSION_LADDER: NewSessionRungSpec[] = [
	{
		rung: 'local-in-editor',
		commands: [NEW_LOCAL_CHAT, OPEN_IN_EDITOR],
		landsTab: true,
		run: async () => {
			await vscode.commands.executeCommand(NEW_LOCAL_CHAT);
			// the session exists the moment that resolves. a move that fails leaves a real
			// chat in the view, so falling through to the next rung would only make a second one
			try {
				await vscode.commands.executeCommand(OPEN_IN_EDITOR);
			} catch {
				// the spike's no-op verdict is what surfaces this, not a second attempt
			}
		}
	},
	{
		rung: 'new-chat',
		commands: [NEW_CHAT],
		landsTab: false,
		run: () => vscode.commands.executeCommand(NEW_CHAT)
	}
];

// same caveat as openSession — a command that resolves has not necessarily done anything,
// so the rung that stuck goes to the log where a break is visible
export async function newSession(): Promise<NewSessionResult> {
	const attempts: Array<Attempt<NewSessionRung>> = [];

	for (const { rung, run } of NEW_SESSION_LADDER) {
		const result = await attempt(rung, run);
		attempts.push(result);
		if (result.ok) {
			return { succeeded: rung, attempts };
		}
	}

	return { attempts };
}

// deleting goes through the workbench, never through fs.unlink. the session index lives
// in state.vscdb and ChatSessionStore.internalDeleteSession returns early on an id that
// isn't in it — remove the file behind its back and the native list keeps a phantom
// entry pointing at nothing.
const DELETE_COMMAND = 'agentSession.delete';

// deliberately the bare item rather than the marshalled { $mid: 25 } context used as
// rung 3 above. BaseAgentSessionAction resolves a marshalled resource through the
// sessions model, and when that lookup misses it falls back to whatever is focused in
// the native sessions viewer — for a delete that would take the wrong chat. A bare
// object skips the lookup entirely, and providerType 'local' is what routes it down
// the local branch that clears the widget and removes the history entry.
export async function deleteSession(sessionId: string): Promise<void> {
	await vscode.commands.executeCommand(DELETE_COMMAND, {
		providerType: 'local',
		resource: vscode.Uri.parse(localSessionUriString(sessionId))
	});
}

// renaming has to go through the workbench too, and for a harder reason than delete. the
// title an editor tab shows comes from ChatEditorInput.getName(), which reads the chat
// model's own title — nothing an extension can reach. Tab.label is readonly in
// vscode.d.ts and ChatSession appears in it nowhere, so a title kept in extension state
// is drawn over the list and the tab keeps showing the session's own, reopened or not.
//
// agentSession.rename is registered by the same BaseAgentSessionAction family as the
// delete above, and that base run() passes a bare argument straight through as the
// session item rather than resolving it. so `label` is what its quick input opens
// prefilled with: the user gets VS Code's own rename box with the Chat Tags title
// already in it, and one Enter puts that through chatService.setChatSessionTitle, which
// is the value the tab, the native list and the session file all read.
//
// no way round the box. the other callers of setChatSessionTitle are a /rename slash
// command registered with the chat registry rather than the command registry, the
// agent-host title sync, and the chat editor restoring a preferred title for a session
// locked to a coding agent. none of the three is reachable from out here.
const RENAME_COMMAND = 'agentSession.rename';

export async function renameSession(sessionId: string, label: string): Promise<void> {
	await vscode.commands.executeCommand(RENAME_COMMAND, {
		providerType: 'local',
		resource: vscode.Uri.parse(localSessionUriString(sessionId)),
		label
	});
}
