// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 WulffTech

import * as fs from 'fs';
import * as path from 'path';

// context.storageUri is workspaceStorage/<hash>/<publisher.ext>, so chat sessions are
// a sibling directory — same trick for the empty-window store next to globalStorage
// saves recomputing vs code's workspace hash, which we'd get wrong sooner or later

export const WORKSPACE_SESSIONS_DIRNAME = 'chatSessions';
export const EMPTY_WINDOW_SESSIONS_DIRNAME = 'emptyWindowChatSessions';
export const WORKSPACE_STORAGE_DIRNAME = 'workspaceStorage';

export function siblingSessionsDir(storageFsPath: string | undefined): string | undefined {
	if (!storageFsPath) {
		return undefined;
	}
	return path.join(path.dirname(storageFsPath), WORKSPACE_SESSIONS_DIRNAME);
}

export function emptyWindowSessionsDir(globalStorageFsPath: string | undefined): string | undefined {
	if (!globalStorageFsPath) {
		return undefined;
	}
	return path.join(path.dirname(globalStorageFsPath), EMPTY_WINDOW_SESSIONS_DIRNAME);
}

// globalStorageUri is <User>/globalStorage/<publisher.ext>, so two levels up is <User>
export function userDirFrom(globalStorageFsPath: string | undefined): string | undefined {
	if (!globalStorageFsPath) {
		return undefined;
	}
	return path.dirname(path.dirname(globalStorageFsPath));
}

// the extension development host stores under workspaceStorage/ext-dev rather than the
// real workspace hash, so the sibling lookup finds nothing while debugging
// match the open folder against each workspace.json instead
export function findSessionsDirByFolder(userDir: string, folderUri: string): string | undefined {
	const root = path.join(userDir, WORKSPACE_STORAGE_DIRNAME);
	let hashes: string[];
	try {
		hashes = fs.readdirSync(root);
	} catch {
		return undefined;
	}

	const wanted = normaliseFolderUri(folderUri);
	for (const hash of hashes) {
		const meta = path.join(root, hash, 'workspace.json');
		try {
			const parsed = JSON.parse(fs.readFileSync(meta, 'utf8'));
			if (typeof parsed?.folder !== 'string') {
				continue;
			}
			if (normaliseFolderUri(parsed.folder) !== wanted) {
				continue;
			}
			const sessions = path.join(root, hash, WORKSPACE_SESSIONS_DIRNAME);
			if (fs.existsSync(sessions)) {
				return sessions;
			}
		} catch {
			// unreadable or malformed entry — nothing to match on
		}
	}
	return undefined;
}

// workspace.json percent-encodes the drive colon and casing varies across writes
function normaliseFolderUri(uri: string): string {
	return decodeURIComponent(uri).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export interface ResolveOptions {
	storageFsPath: string | undefined;
	globalStorageFsPath: string;
	workspaceFolderUri: string | undefined;
}

export interface ResolvedLocations {
	directories: string[];
	// how the workspace directory was found — logged so surprises are visible
	workspaceSource: 'sibling' | 'folder-match' | 'none';
	// the path the sibling lookup tried, kept for diagnostics when it misses
	siblingCandidate: string;
}

export function resolveSessionDirectories(options: ResolveOptions): ResolvedLocations {
	const directories: string[] = [];
	let workspaceSource: ResolvedLocations['workspaceSource'] = 'none';

	const sibling = siblingSessionsDir(options.storageFsPath);
	if (sibling && fs.existsSync(sibling)) {
		directories.push(sibling);
		workspaceSource = 'sibling';
	} else {
		const userDir = userDirFrom(options.globalStorageFsPath);
		if (userDir && options.workspaceFolderUri) {
			const matched = findSessionsDirByFolder(userDir, options.workspaceFolderUri);
			if (matched) {
				directories.push(matched);
				workspaceSource = 'folder-match';
			}
		}
	}

	const emptyWindow = emptyWindowSessionsDir(options.globalStorageFsPath);
	if (emptyWindow && fs.existsSync(emptyWindow)) {
		directories.push(emptyWindow);
	}

	return { directories, workspaceSource, siblingCandidate: sibling ?? '(no workspace storage)' };
}
