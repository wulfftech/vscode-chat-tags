// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 WulffTech

// composes the README hero shot: four panes of the real view, two themes, with the
// config surfaces open. renders through headless chrome rather than a hand-drawn mock,
// so the shot can never drift from what the extension actually paints.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NOW, loadContent } from './content.mjs';

const css = fs.readFileSync('media/view.css', 'utf8');
const js = fs.readFileSync('media/view.js', 'utf8');
const logo = fs.readFileSync('media/icon.png').toString('base64');
const { categories, models, sessions, panes } = loadContent();

const PANE_WIDTH = 340;
const COLUMNS = 3;
const GAP = 18;
const PAD = 22;
const CAPTION = 28;
const WIDTH = PAD * 2 + PANE_WIDTH * COLUMNS + GAP * (COLUMNS - 1);

// one config surface per pane, so nothing worth seeing sits under anything else.
// row 1 holds the tall surfaces, row 2 the short ones — a uniform height would leave
// half the grid empty or cut the settings panel in half
const TALL = 720;
const SHORT = 470;

const PANES = [
	{
		id: 'grouped',
		theme: 'dark',
		height: TALL,
		caption: 'Grouped by category, archived at the bottom',
		settings: { sortBy: 'activity', groupBy: 'category', showArchived: true }
	},
	{
		id: 'settings',
		theme: 'light',
		height: TALL,
		caption: 'Every setting lives in the pane',
		settings: { sortBy: 'activity', groupBy: 'none', showArchived: false },
		panel: 'settings'
	},
	{
		id: 'categories',
		theme: 'dark',
		height: TALL,
		caption: 'Categories — name, colour, delete',
		settings: { sortBy: 'activity', groupBy: 'none', showArchived: false },
		panel: 'categories'
	},
	{
		id: 'sort',
		theme: 'light',
		height: SHORT,
		caption: 'Sort, group, show archived',
		settings: { sortBy: 'created', groupBy: 'none', showArchived: false },
		menu: 'sort'
	},
	{
		id: 'rowmenu',
		theme: 'dark',
		height: SHORT,
		caption: 'Assign, archive or delete a session',
		settings: { sortBy: 'activity', groupBy: 'none', showArchived: false },
		menu: 'row',
		hoverRow: 1
	},
	{
		id: 'buttons',
		theme: 'light',
		height: SHORT,
		// row 3 wrote both its title and its subtitle by hand, so its generate buttons
		// render dimmed — the guard is the thing worth showing
		caption: 'Row buttons, revealed on hover',
		settings: { sortBy: 'activity', groupBy: 'none', showArchived: false },
		hoverRow: 3
	}
];

const ROWS = Math.ceil(PANES.length / COLUMNS);
const rowHeight = index => Math.max(...PANES
	.filter((_, i) => Math.floor(i / COLUMNS) === index)
	.map(pane => pane.height));
const HEIGHT = PAD * 2
	+ Array.from({ length: ROWS }, (_, i) => rowHeight(i) + CAPTION).reduce((a, b) => a + b, 0)
	+ (ROWS - 1) * GAP;

const THEMES = {
	dark: {
		'--vscode-foreground': '#cccccc',
		'--vscode-descriptionForeground': '#9d9d9d',
		'--vscode-sideBar-background': '#181818',
		'--vscode-sideBarSectionHeader-border': '#2b2b2b',
		'--vscode-list-hoverBackground': '#2a2d2e',
		'--vscode-list-activeSelectionBackground': '#04395e',
		'--vscode-list-activeSelectionForeground': '#ffffff',
		'--vscode-inputOption-activeBackground': '#0078d44d',
		'--vscode-inputOption-activeBorder': '#0078d4',
		'--vscode-inputOption-activeForeground': '#ffffff',
		'--vscode-menu-background': '#1f1f1f',
		'--vscode-menu-foreground': '#cccccc',
		'--vscode-menu-border': '#454545',
		'--vscode-menu-selectionBackground': '#0078d4',
		'--vscode-menu-separatorBackground': '#454545',
		'--vscode-input-background': '#313131',
		'--vscode-input-border': '#3c3c3c',
		'--vscode-dropdown-background': '#313131',
		'--vscode-dropdown-border': '#3c3c3c',
		'--vscode-errorForeground': '#f85149',
		'--vscode-textLink-foreground': '#4daafc',
		'--vscode-focusBorder': '#0078d4',
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
		'--vscode-inputOption-activeBackground': '#005fb826',
		'--vscode-inputOption-activeBorder': '#005fb8',
		'--vscode-inputOption-activeForeground': '#000000',
		'--vscode-menu-background': '#ffffff',
		'--vscode-menu-foreground': '#3b3b3b',
		'--vscode-menu-border': '#cecece',
		'--vscode-menu-selectionBackground': '#005fb8',
		'--vscode-menu-separatorBackground': '#d4d4d4',
		'--vscode-input-background': '#ffffff',
		'--vscode-input-border': '#cecece',
		'--vscode-dropdown-background': '#ffffff',
		'--vscode-dropdown-border': '#cecece',
		'--vscode-errorForeground': '#c72e0f',
		'--vscode-textLink-foreground': '#005fb8',
		'--vscode-focusBorder': '#005fb8',
		page: '#f8f8f8'
	}
};

function themeVars(theme) {
	return Object.entries(THEMES[theme])
		.filter(([key]) => key.startsWith('--'))
		.map(([key, value]) => `${key}:${value}`)
		.join(';');
}

const paneMarkup = PANES.map(pane => `
	<figure class="pane ${pane.theme}" id="pane-${pane.id}">
		<div class="host" id="host-${pane.id}"></div>
		<figcaption>${pane.caption}</figcaption>
	</figure>`).join('');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Chat Tags</title>
<style>
${css}

html, body { margin: 0; padding: 0; }
body {
	width: ${WIDTH}px;
	font-family: -apple-system, "Segoe UI", sans-serif;
	background: #101014;
	background-image: radial-gradient(120% 90% at 50% 0%, #1c1c24 0%, #0d0d10 70%);
}
.sheet {
	display: grid;
	grid-template-columns: repeat(${COLUMNS}, ${PANE_WIDTH}px);
	gap: ${GAP}px;
	padding: ${PAD}px;
	justify-content: start;
}
.pane {
	margin: 0;
	width: ${PANE_WIDTH}px;
	--vscode-font-family: -apple-system, "Segoe UI", sans-serif;
	--vscode-font-size: 13px;
}
.pane .host {
	position: relative;
	overflow: hidden;
	border-radius: 8px;
	box-shadow: 0 10px 26px rgba(0, 0, 0, 0.45);
}

/* a pane is a fixed window onto a scrolling list, so something is always half-cut at the
   bottom. fading it says 'there is more' instead of 'the render broke' */
.pane .host::after {
	content: "";
	position: absolute;
	inset: auto 0 0 0;
	height: 46px;
	pointer-events: none;
	background: linear-gradient(transparent, var(--vscode-sideBar-background));
}
.pane figcaption {
	padding: 9px 2px 0;
	font-size: 12px;
	letter-spacing: 0.01em;
	color: #8b8b96;
}
${PANES.map(pane => `#pane-${pane.id} .host { height: ${pane.height}px; }`).join(' ')}

/* a lifted menu clone lives on the body, outside every .pane, so it has to carry the
   theme itself or it paints with no background at all */
.pane.dark, .shot-dark { ${themeVars('dark')}; }
.pane.dark .host { background: ${THEMES.dark.page}; color: ${THEMES.dark['--vscode-foreground']}; }
.pane.light, .shot-light { ${themeVars('light')}; }
.pane.light .host { background: ${THEMES.light.page}; color: ${THEMES.light['--vscode-foreground']}; }

/* the real popover is clamped to the webview's own width. here it gets clamped to its
   pane instead, which is the same thing at the same size */
.popover { box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5); }
</style>
</head>
<body data-logo="data:image/png;base64,${logo}">
<div class="sheet">${paneMarkup}</div>

<script>
const NOW = ${NOW};
const CATEGORIES = ${JSON.stringify(categories)};
const MODELS = ${JSON.stringify(models)};
const SESSIONS = ${JSON.stringify(sessions)};
const PANE_SESSIONS = ${JSON.stringify(panes)};
const PANES = ${JSON.stringify(PANES)};

// view.js binds to #root and window messages, so each pane gets its own run with those
// two things scoped to it
function mount(pane) {
	const host = document.getElementById('host-' + pane.id);
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
	window.acquireVsCodeApi = () => ({ postMessage: () => {} });

	${js}

	document.getElementById = realGet;
	window.addEventListener = realAdd;
	Date.now = () => NOW;

	const settings = Object.assign({
		openTarget: 'dedicatedRight', dedicatedColumnRatio: 0.4, activeSeconds: 45,
		recentMinutes: 10, autoSubtitle: true, subtitleIdleSeconds: 120,
		subtitleMode: 'status', subtitleModel: ''
	}, pane.settings);

	// the provider sorts before posting; mirrors compareSessions() in core/sessions.ts
	const compare = settings.sortBy === 'created'
		? (a, b) => (b.createdAt || b.lastActivityAt) - (a.createdAt || a.lastActivityAt)
		: (a, b) => b.lastActivityAt - a.lastActivityAt;
	// each pane draws its own slice of the pool. an unlisted pane falls back to the lot,
	// so adding a pane without a list still renders something rather than an empty box
	const picked = PANE_SESSIONS[pane.id];
	const pool = picked
		? picked.map(id => SESSIONS.find(s => s.sessionId === id)).filter(Boolean)
		: SESSIONS;
	const visible = (settings.showArchived ? pool : pool.filter(s => !s.archived))
		.slice().sort(compare);

	const post = message => listeners.forEach(fn => fn({ data: message }));
	post({
		type: 'render',
		sessions: visible,
		categories: CATEGORIES,
		collapsedGroups: [],
		archivedCount: pool.filter(s => s.archived).length,
		settings: settings,
		models: MODELS
	});
	if (pane.panel) { post({ type: 'openPanel', panel: pane.panel }); }
	return host;
}

// :hover can't be forced from script, so the hovered row borrows the same rules
const forced = document.createElement('style');
forced.textContent =
	'.row.shot-hover{background:var(--vscode-list-hoverBackground)}' +
	'.row.shot-hover[data-category]{background:color-mix(in srgb,var(--row-colour) var(--wash-hover),var(--vscode-list-hoverBackground))}' +
	'.row.shot-hover .row-actions{width:auto;opacity:1}' +
	'.row.shot-hover .edit,.row.shot-hover .gen,.row.shot-hover .actions{opacity:0.75}' +
	'.row.shot-hover .gen.guarded{opacity:0.35}';
document.head.appendChild(forced);

// every pane runs its own copy of view.js, but closePopovers() and the document click
// listener are global — so an open menu gets torn down by the next pane that mounts.
// each one is lifted out as a static clone and put back once nothing is left to run.
const menus = [];

for (const pane of PANES) {
	const host = mount(pane);
	const rows = host.querySelectorAll('.row');

	if (typeof pane.hoverRow === 'number' && rows[pane.hoverRow]) {
		rows[pane.hoverRow].classList.add('shot-hover');
	}

	let anchor = null;
	if (pane.menu === 'sort') {
		anchor = host.querySelector('.toolbar button[aria-label="Sort, group and archived"]');
	} else if (pane.menu === 'row' && rows[pane.hoverRow ?? 0]) {
		anchor = rows[pane.hoverRow ?? 0].querySelector('.actions');
	}
	if (!anchor) { continue; }

	anchor.click();
	const popover = document.querySelector('.popover');
	if (!popover) { continue; }
	const clone = popover.cloneNode(true);
	clone.classList.add('shot-' + pane.theme);
	menus.push({ node: clone, anchor: anchor, pane: host.closest('.pane') });
	popover.remove();
}

for (const menu of menus) {
	document.body.appendChild(menu.node);
	const anchor = menu.anchor.getBoundingClientRect();
	const pane = menu.pane.getBoundingClientRect();
	// the real popover clamps to the webview width; here the pane is the webview
	const left = Math.max(pane.left + 4, Math.min(anchor.left, pane.right - menu.node.offsetWidth - 6));
	menu.node.style.top = (anchor.bottom + window.scrollY + 2) + 'px';
	menu.node.style.left = (left + window.scrollX) + 'px';
}

document.documentElement.dataset.ready = 'true';
</script>
</body>
</html>
`;

fs.mkdirSync('dev', { recursive: true });
fs.writeFileSync('dev/screenshot.html', html, 'utf8');
console.log(`wrote dev/screenshot.html (${html.length} bytes, ${WIDTH}x${HEIGHT})`);

// ── render ───────────────────────────────────────────────

const BROWSERS = [
	`${process.env['ProgramFiles']}\\Google\\Chrome\\Application\\chrome.exe`,
	`${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
	`${process.env['LOCALAPPDATA']}\\Google\\Chrome\\Application\\chrome.exe`
];
const browser = BROWSERS.find(candidate => candidate && fs.existsSync(candidate));
if (!browser) {
	console.log('no chrome or edge found — dev/screenshot.html is written, render it yourself');
	process.exit(0);
}

const out = path.resolve('media/screenshot.png');
// a throwaway profile, or headless borrows the real one and fights whatever is running
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-tags-shot-'));

execFileSync(browser, [
	'--headless=new',
	'--disable-gpu',
	'--hide-scrollbars',
	`--user-data-dir=${profile}`,
	// 2x so the shot stays crisp after GitHub scales it into an 850px column
	'--force-device-scale-factor=2',
	`--window-size=${WIDTH},${HEIGHT}`,
	`--screenshot=${out}`,
	`file:///${path.resolve('dev/screenshot.html').replace(/\\/g, '/')}`
], { stdio: 'ignore' });

// chrome's crashpad handler still holds CrashpadMetrics-active.pma for a moment after
// the browser process exits, so on windows this throws EPERM about half the time. the
// shot is already on disk by here — a temp directory outliving the run is not a failure,
// and letting it throw meant a successful render reported nothing and exited non-zero
try {
	fs.rmSync(profile, { recursive: true, force: true });
} catch (error) {
	console.log(`left ${profile} behind (${error.code})`);
}
console.log(`wrote media/screenshot.png (${(fs.statSync(out).size / 1024).toFixed(0)} KB, ${WIDTH * 2}x${HEIGHT * 2})`);
