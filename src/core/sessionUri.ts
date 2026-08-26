// local sessions are addressed as vscode-chat-session://local/<base64url(sessionId)>
// mirrors the workbench's ChatSessionUri.forSession — url-safe base64, no padding,
// session type as the authority. SessionType.Local is the string "local"

export const LOCAL_SESSION_SCHEME = 'vscode-chat-session';
export const LOCAL_SESSION_AUTHORITY = 'local';

function toBase64Url(value: string): string {
	return Buffer.from(value, 'utf8')
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
	return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// workbench URI for a local chat session id
export function localSessionUriString(sessionId: string): string {
	return `${LOCAL_SESSION_SCHEME}://${LOCAL_SESSION_AUTHORITY}/${toBase64Url(sessionId)}`;
}

// inverse of localSessionUriString — undefined for anything that is not a local session
export function parseLocalSessionUri(uri: string): string | undefined {
	const match = /^vscode-chat-session:\/\/([^/]+)\/([^/?#]+)$/.exec(uri);
	if (!match || match[1] !== LOCAL_SESSION_AUTHORITY) {
		return undefined;
	}
	try {
		return fromBase64Url(match[2]);
	} catch {
		return undefined;
	}
}
