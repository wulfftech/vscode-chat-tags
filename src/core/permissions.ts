// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 WulffTech

// vs code keeps a permission level per session, written straight into the session file at
// inputState.permissionLevel and patched there whenever the picker changes. the four
// levels come from the workbench's own enum, which marks every non-default one elevated
// and then scores them separately — assisted 1, autoApprove and autopilot 2. the view
// splits on that score, not on the elevated flag
export const PERMISSION_LEVELS = ['default', 'assisted', 'autoApprove', 'autopilot'] as const;

export type PermissionLevel = typeof PERMISSION_LEVELS[number];

// the workbench still migrates these two spellings, so old session files carry them
const LEGACY_LEVELS: Record<string, PermissionLevel> = {
	manual: 'default',
	allowAll: 'autoApprove'
};

// an unrecognised level is kept verbatim rather than folded into 'default' — a level added
// upstream should surface as an unfamiliar pill instead of quietly reading as safe
export function normalisePermissionLevel(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const level = value.trim();
	if (!level) {
		return undefined;
	}
	return LEGACY_LEVELS[level] ?? level;
}

// the only question the list asks: is this row worth a pill
export function isDefaultPermission(level: string | undefined): boolean {
	return !level || level === 'default';
}
