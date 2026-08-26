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

const OPEN_COMMAND = 'workbench.action.chat.openSessionInEditorGroup';
const MARSHALLED_AGENT_SESSION_CONTEXT = 25;

export type NavigationRung = 'vscode-open' | 'bare-resource' | 'marshalled-context';

export interface NavigationAttempt {
	rung: NavigationRung;
	ok: boolean;
	error?: string;
}

export interface NavigationResult {
	sessionId: string;
	uri: string;
	succeeded?: NavigationRung;
	attempts: NavigationAttempt[];
}

async function attempt(rung: NavigationRung, run: () => Thenable<unknown>): Promise<NavigationAttempt> {
	try {
		await run();
		return { rung, ok: true };
	} catch (error) {
		return { rung, ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

// walks the ladder until a rung sticks
// a command resolving only means it didn't throw — see spike.ts for real evidence
export async function openSession(sessionId: string): Promise<NavigationResult> {
	const uriString = localSessionUriString(sessionId);
	const uri = vscode.Uri.parse(uriString);
	const attempts: NavigationAttempt[] = [];

	const ladder: Array<[NavigationRung, () => Thenable<unknown>]> = [
		['vscode-open', () => vscode.commands.executeCommand('vscode.open', uri)],
		['bare-resource', () => vscode.commands.executeCommand(OPEN_COMMAND, { resource: uri })],
		['marshalled-context', () => vscode.commands.executeCommand(OPEN_COMMAND, {
			$mid: MARSHALLED_AGENT_SESSION_CONTEXT,
			session: { resource: uri }
		})]
	];

	for (const [rung, run] of ladder) {
		const result = await attempt(rung, run);
		attempts.push(result);
		if (result.ok) {
			return { sessionId, uri: uriString, succeeded: rung, attempts };
		}
	}

	return { sessionId, uri: uriString, attempts };
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
