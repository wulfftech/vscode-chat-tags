// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 WulffTech

// one-shot pass to bring comments in line with the house style: lowercase, no
// docstrings, why-not-what. the edits list carries the current batch only — an applied
// batch is dead weight, and one entry outliving its file takes the whole run down.
import * as fs from 'node:fs';

const edits = [
	['src/layout.ts', [
		[
			'/**\n * Guarantees a full-height column on the right and focuses it, so a subsequent open\n * lands there. Composed from setEditorLayout + a focus command rather than passing a\n * view column to the open call — the chat open path routes through workbench actions\n * that target the *active* group, so moving the active group is what actually works.\n */',
			'// composed from setEditorLayout plus a focus command rather than passing a view column\n// to the open call — the chat open path routes through workbench actions that target the\n// *active* group, so moving the active group is the only thing that actually works'
		],
		['/** Applies whatever window arrangement the chosen target needs before opening. */\n', '']
	]],

	['src/webview/sessionsView.ts', [
		['\t/** Opens the in-pane categories panel. */\n', ''],
		['\t/** Opens the in-pane settings panel. */\n', '']
	]]
];

let applied = 0;
const missing = [];

for (const [file, replacements] of edits) {
	// a file that has since been renamed or deleted is a stale entry, not a crash
	if (!fs.existsSync(file)) {
		missing.push(`${file}: no such file`);
		continue;
	}
	let source = fs.readFileSync(file, 'utf8');
	for (const [from, to] of replacements) {
		if (!source.includes(from)) {
			missing.push(`${file}: ${from.split('\n')[0].slice(0, 60)}`);
			continue;
		}
		source = source.replace(from, to);
		applied++;
	}
	fs.writeFileSync(file, source, 'utf8');
}

console.log(`applied ${applied} replacement(s)`);
for (const entry of missing) {
	console.log(`  MISSING ${entry}`);
}
