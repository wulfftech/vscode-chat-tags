// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 WulffTech

// inlines the real media/view.css and media/view.js into a standalone page so the
// webview can be eyeballed outside VS Code. inlining rather than linking because the
// preview renders as a snapshot and relative asset paths don't resolve there.
import * as fs from 'node:fs';
import { NOW, loadContent } from './content.mjs';

const { categories, models, sessions } = loadContent();

const css = fs.readFileSync('media/view.css', 'utf8');
const js = fs.readFileSync('media/view.js', 'utf8');

// stock dark+/light+ values, read off the workbench's own colour registry. warningForeground
// is null in both, so it stays undefined and the css falls back the way the real webview
// does — without these the armed button and the elevated pill both paint focus-blue here
// and the harness quietly disagrees with the product
const THEMES = {
	dark: {
		'--vscode-foreground': '#cccccc',
		'--vscode-descriptionForeground': '#9d9d9d',
		'--vscode-sideBar-background': '#181818',
		'--vscode-sideBarSectionHeader-border': '#2b2b2b',
		'--vscode-list-hoverBackground': '#2a2d2e',
		'--vscode-list-activeSelectionBackground': '#04395e',
		'--vscode-list-activeSelectionForeground': '#ffffff',
		'--vscode-button-secondaryBackground': '#313131',
		'--vscode-button-secondaryForeground': '#cccccc',
		'--vscode-button-secondaryHoverBackground': '#3c3c3c',
		'--vscode-focusBorder': '#0078d4',
		'--vscode-inputValidation-warningBackground': '#352A05',
		'--vscode-inputValidation-warningBorder': '#B89500',
		page: '#181818'
	},
	light: {
		'--vscode-foreground': '#3b3b3b',
		'--vscode-descriptionForeground': '#767676',
		'--vscode-sideBar-background': '#f8f8f8',
		'--vscode-sideBarSectionHeader-border': '#e5e5e5',
		'--vscode-list-hoverBackground': '#e8e8e8',
		'--vscode-list-activeSelectionBackground': '#0060c0',
		'--vscode-list-activeSelectionForeground': '#ffffff',
		'--vscode-button-secondaryBackground': '#e5e5e5',
		'--vscode-button-secondaryForeground': '#3b3b3b',
		'--vscode-button-secondaryHoverBackground': '#dcdcdc',
		'--vscode-focusBorder': '#005fb8',
		'--vscode-inputValidation-warningBackground': '#F6F5D2',
		'--vscode-inputValidation-warningBorder': '#B89500',
		page: '#f8f8f8'
	}
};

function vars(theme) {
	return Object.entries(THEMES[theme])
		.filter(([key]) => key.startsWith('--'))
		.map(([key, value]) => `\t\t${key}: ${value};`)
		.join('\n');
}

const panes = ['dark', 'light'].map(theme => `
	<div class="pane ${theme}">
		<div class="harness-label">${theme} · 340px</div>
		<div class="host" id="host-${theme}"></div>
	</div>`).join('');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Chat Tags — view harness</title>
<style>
${css}

body { margin: 0; font-family: -apple-system, "Segoe UI", sans-serif; background: #0d0d0d; }
.panes { display: flex; gap: 16px; padding: 16px; align-items: flex-start; }
.pane { width: 340px; border-radius: 6px; overflow: hidden; }
.pane.dark { ${Object.entries(THEMES.dark).filter(([k]) => k.startsWith('--')).map(([k, v]) => `${k}:${v}`).join(';')}; background: ${THEMES.dark.page}; color: ${THEMES.dark['--vscode-foreground']}; }
.pane.light { ${Object.entries(THEMES.light).filter(([k]) => k.startsWith('--')).map(([k, v]) => `${k}:${v}`).join(';')}; background: ${THEMES.light.page}; color: ${THEMES.light['--vscode-foreground']}; }
.pane { --vscode-font-family: -apple-system, "Segoe UI", sans-serif; --vscode-font-size: 13px; }
.harness-label { font-size: 11px; opacity: 0.5; padding: 6px 10px 2px; }
</style>
</head>
<body>
<div class="panes">${panes}</div>

<script>
const NOW = ${NOW};
const CATEGORIES = ${JSON.stringify(categories)};
const MODELS = ${JSON.stringify(models)};
const SESSIONS = ${JSON.stringify(sessions)};

// view.js binds to #root and window messages, so each pane gets its own run with
// those two things scoped to it
function mount(hostId, listSettings) {
	const host = document.getElementById(hostId);
	const root = document.createElement('div');
	root.id = 'root';
	host.appendChild(root);

	const realGet = document.getElementById.bind(document);
	document.getElementById = id => (id === 'root' ? root : realGet(id));

	const listeners = [];
	const realAdd = window.addEventListener.bind(window);
	window.addEventListener = (type, fn, opts) => {
		if (type === 'message') { listeners.push(fn); } else { realAdd(type, fn, opts); }
	};
	window.acquireVsCodeApi = () => ({ postMessage: m => console.log(hostId, JSON.stringify(m)) });

	${js}

	document.getElementById = realGet;
	window.addEventListener = realAdd;
	Date.now = () => NOW;
	const SETTINGS = Object.assign({ openTarget: 'dedicatedRight', dedicatedColumnRatio: 0.4, activeSeconds: 45, recentMinutes: 10, autoSubtitle: true, subtitleIdleSeconds: 120, subtitleMode: 'status', subtitleModel: '' }, listSettings);
	// the provider sorts before posting, so anything rendering the view outside the
	// extension has to sort for itself. mirrors compareSessions() in core/sessions.ts
	const compare = SETTINGS.sortBy === 'created'
		? (a, b) => (b.createdAt || b.lastActivityAt) - (a.createdAt || a.lastActivityAt)
		: (a, b) => b.lastActivityAt - a.lastActivityAt;
	const visible = (SETTINGS.showArchived ? SESSIONS : SESSIONS.filter(s => !s.archived)).slice().sort(compare);
	const archivedCount = SESSIONS.filter(s => s.archived).length;
	listeners.forEach(fn => fn({ data: { type: 'render', sessions: visible, categories: CATEGORIES, archivedCount: archivedCount, settings: SETTINGS, models: MODELS } }));
	if (hostId === 'host-light') {
		listeners.forEach(fn => fn({ data: { type: 'openPanel', panel: 'settings' } }));
	}
}

// dark shows the new list shape: grouped by category, archived section at the bottom.
// light keeps the settings panel open and hides archived, so the footer count shows
mount('host-dark', { sortBy: 'activity', groupBy: 'category', showArchived: true });
mount('host-light', { sortBy: 'created', groupBy: 'none', showArchived: false });
</script>
</body>
</html>
`;

fs.mkdirSync('dev', { recursive: true });
fs.writeFileSync('dev/preview.html', html, 'utf8');
console.log('wrote dev/preview.html (' + html.length + ' bytes)');
