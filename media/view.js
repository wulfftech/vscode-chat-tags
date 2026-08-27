// @ts-check
(function () {
	const vscode = acquireVsCodeApi();
	const root = document.getElementById('root');

	const DEFAULT_SETTINGS = {
		openTarget: 'activeGroup', dedicatedColumnRatio: 0.4, activeSeconds: 45, recentMinutes: 10,
		autoSubtitle: false, subtitleIdleSeconds: 120, subtitleMode: 'status', subtitleModel: '',
		sortBy: 'activity', groupBy: 'none', showArchived: false
	};
	let state = { sessions: [], categories: [], settings: DEFAULT_SETTINGS, models: [], archivedCount: 0 };
	let selectedId = null;
	// last row scrolled to, so a repaint does not keep yanking the list back
	let revealedId = null;
	// null | 'categories' | 'settings' — one at a time, they are separate things
	let openPanel = null;
	let editingSubtitleFor = null;

	// inline svg rather than text glyphs — a glyph renders at whatever weight the user's
	// font decides, and ⚙ in particular lands as an emoji on some systems
	const SVG_NS = 'http://www.w3.org/2000/svg';
	const ICON_PATHS = {
		plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
		gear: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.03-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z',
		refresh: 'M17.65 6.35A7.96 7.96 0 0 0 12 4c-4.42 0-7.99 3.58-8 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
		clock: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z',
		notes: 'M14 17H4v2h10v-2zM20 9H4v2h16V9zM4 15h16v-2H4v2zM4 5v2h16V5H4z',
		pencil: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
		dots: 'M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm12 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm-6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
		sort: 'M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z',
		archive: 'M20.54 5.23l-1.39-1.68A1.45 1.45 0 0 0 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23A1.98 1.98 0 0 0 3 6.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.5c0-.49-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z',
		unarchive: 'M20.55 5.22l-1.39-1.68A1.51 1.51 0 0 0 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.22C3.17 5.57 3 6.01 3 6.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.5c0-.49-.17-.93-.45-1.28zM12 9.5l5.5 5.5H14v2h-4v-2H6.5L12 9.5zM5.12 5l.82-1h12l.93 1H5.12z',
		trash: 'M6 19c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z'
	};

	function icon(name, size) {
		const svg = document.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('width', String(size || 13));
		svg.setAttribute('height', String(size || 13));
		svg.setAttribute('aria-hidden', 'true');
		svg.setAttribute('focusable', 'false');
		const path = document.createElementNS(SVG_NS, 'path');
		path.setAttribute('d', ICON_PATHS[name]);
		path.setAttribute('fill', 'currentColor');
		svg.appendChild(path);
		return svg;
	}

	function relativeTime(timestamp, now) {
		const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
		if (seconds < 60) { return seconds + 's ago'; }
		const minutes = Math.round(seconds / 60);
		if (minutes < 60) { return minutes + 'm ago'; }
		const hours = Math.round(minutes / 60);
		if (hours < 24) { return hours + 'h ago'; }
		return Math.round(hours / 24) + 'd ago';
	}

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) { node.className = className; }
		// titles come from session files on disk — always set as text, never as html
		if (text !== undefined) { node.textContent = text; }
		return node;
	}

	function send(message) {
		vscode.postMessage(message);
	}

	function togglePanel(panel) {
		openPanel = openPanel === panel ? null : panel;
		render();
	}

	function closePopovers() {
		document.querySelectorAll('.popover').forEach(node => node.remove());
	}

	// ── popovers ──────────────────────────────────────────────

	// anchored under whichever button opened it, clamped to the pane so a menu opened on
	// the right-hand edge of a narrow sidebar still lands fully on screen
	function placePopover(popover, anchor) {
		document.body.appendChild(popover);
		const box = anchor.getBoundingClientRect();
		const width = popover.offsetWidth;
		popover.style.top = (box.bottom + window.scrollY + 2) + 'px';
		popover.style.left = Math.max(4, Math.min(box.left, window.innerWidth - width - 6)) + 'px';
	}

	function addAction(popover, label, run, className) {
		const button = el('button', className);
		button.appendChild(el('span', 'swatch'));
		button.appendChild(el('span', null, label));
		button.addEventListener('click', event => {
			event.stopPropagation();
			closePopovers();
			run();
		});
		popover.appendChild(button);
		return button;
	}

	// a checkable menu entry — the tick keeps its column whether or not it is set, so the
	// labels don't shuffle sideways as you toggle things
	function addChoice(popover, label, checked, run) {
		const button = el('button');
		button.appendChild(el('span', 'tick', checked ? '✓' : ''));
		button.appendChild(el('span', null, label));
		button.setAttribute('aria-checked', String(checked));
		button.setAttribute('role', 'menuitemcheckbox');
		button.addEventListener('click', event => {
			event.stopPropagation();
			closePopovers();
			run();
		});
		popover.appendChild(button);
		return button;
	}

	// the row's ⋯ menu: categories, then the two things that take a session out of the list
	function openPopover(anchor, session) {
		closePopovers();
		const popover = el('div', 'popover');

		for (const category of state.categories) {
			const button = el('button');
			const swatch = el('span', 'swatch');
			swatch.style.setProperty('--swatch', category.colour);
			button.appendChild(swatch);
			button.appendChild(el('span', null, category.name + (category.id === session.categoryId ? '  ✓' : '')));
			button.addEventListener('click', event => {
				event.stopPropagation();
				closePopovers();
				send({ type: 'setCategory', sessionId: session.sessionId, categoryId: category.id });
			});
			popover.appendChild(button);
		}

		if (state.categories.length) {
			popover.appendChild(el('div', 'sep'));
		}

		addAction(popover, 'No category',
			() => send({ type: 'setCategory', sessionId: session.sessionId, categoryId: null }));
		addAction(popover, 'Edit categories…', () => { openPanel = 'categories'; render(); }, 'plain');

		popover.appendChild(el('div', 'sep'));

		addAction(popover, session.archived ? 'Restore from archive' : 'Archive',
			() => send({ type: 'setArchived', sessionId: session.sessionId, archived: !session.archived }), 'plain');

		// vs code runs its own confirmation, which is why this reads as a dialog opener
		addAction(popover, 'Delete…',
			() => send({ type: 'deleteSession', sessionId: session.sessionId }), 'danger');

		placePopover(popover, anchor);
	}

	// ── list menu ─────────────────────────────────────────────

	// order and grouping are flipped often enough that burying them in the settings panel
	// would be wrong, so they get their own menu rather than a row of radio buttons
	function openListMenu(anchor) {
		closePopovers();
		const settings = state.settings;
		const popover = el('div', 'popover');

		popover.appendChild(el('div', 'menu-label', 'Sort by'));
		addChoice(popover, 'Last message', settings.sortBy !== 'created',
			() => send({ type: 'setSetting', key: 'sortBy', value: 'activity' }));
		addChoice(popover, 'Created', settings.sortBy === 'created',
			() => send({ type: 'setSetting', key: 'sortBy', value: 'created' }));

		popover.appendChild(el('div', 'sep'));
		addChoice(popover, 'Group by category', settings.groupBy === 'category',
			() => send({
				type: 'setSetting',
				key: 'groupBy',
				value: settings.groupBy === 'category' ? 'none' : 'category'
			}));

		popover.appendChild(el('div', 'sep'));
		addChoice(popover, 'Show archived', settings.showArchived,
			() => send({ type: 'setSetting', key: 'showArchived', value: !settings.showArchived }));

		placePopover(popover, anchor);
	}

	// ── categories panel ──────────────────────────────────────

	function buildCategoriesPanel() {
		const panel = el('div', 'panel');
		panel.appendChild(el('h2', null, 'Categories'));

		for (const category of state.categories) {
			const row = el('div', 'cat-row');

			const colour = document.createElement('input');
			colour.type = 'color';
			colour.value = category.colour;
			colour.title = 'Colour';
			// 'change' not 'input' — 'input' fires continuously while dragging the picker
			colour.addEventListener('change', () => {
				send({ type: 'updateCategory', id: category.id, colour: colour.value });
			});

			const name = document.createElement('input');
			name.type = 'text';
			name.value = category.name;
			name.spellcheck = false;
			const commitName = () => {
				const next = name.value.trim();
				if (next && next !== category.name) {
					send({ type: 'updateCategory', id: category.id, name: next });
				}
			};
			name.addEventListener('blur', commitName);
			name.addEventListener('keydown', event => {
				if (event.key === 'Enter') { name.blur(); }
				if (event.key === 'Escape') { name.value = category.name; name.blur(); }
			});

			const remove = el('button', 'remove', '✕');
			remove.title = 'Delete category';
			remove.addEventListener('click', () => send({ type: 'deleteCategory', id: category.id }));

			row.appendChild(colour);
			row.appendChild(name);
			row.appendChild(remove);
			panel.appendChild(row);
		}

		const add = el('button', 'add', '+ Add category');
		add.addEventListener('click', () => send({ type: 'createCategory' }));
		panel.appendChild(add);

		if (!state.categories.length) {
			panel.appendChild(el('div', 'hint', 'Add a category, then use the ⋯ button on any session to assign it.'));
		}
		return panel;
	}

	// ── settings panel ────────────────────────────────────────

	function buildSettingsPanel() {
		const panel = el('div', 'panel');
		panel.appendChild(buildLayoutSection());
		return panel;
	}

	const OPEN_TARGETS = [
		{ id: 'activeGroup', label: 'Active editor group', hint: 'Opens wherever you already are.' },
		{ id: 'beside', label: 'Split to the side', hint: 'Splits right the first time, then reuses it.' },
		{ id: 'dedicatedRight', label: 'Dedicated right column', hint: 'Keeps a full-height column on the right for every chat.' }
	];

	function numberField(labelText, suffix, value, min, max, key) {
		const field = el('div', 'field');
		field.appendChild(el('span', 'field-label', labelText));
		const input = document.createElement('input');
		input.type = 'number';
		input.min = String(min);
		input.max = String(max);
		input.value = String(value);
		const commit = () => {
			const next = Math.min(max, Math.max(min, Number(input.value) || value));
			input.value = String(next);
			if (next !== value) { send({ type: 'setSetting', key: key, value: next }); }
		};
		input.addEventListener('blur', commit);
		input.addEventListener('keydown', event => {
			event.stopPropagation();
			if (event.key === 'Enter') { input.blur(); }
		});
		field.appendChild(input);
		field.appendChild(el('span', 'field-suffix', suffix));
		return field;
	}

	function toggleField(labelText, value, key, hint) {
		const field = el('div', 'field toggle');
		const box = document.createElement('input');
		box.type = 'checkbox';
		box.checked = Boolean(value);
		box.id = 'toggle-' + key;
		box.addEventListener('change', () => send({ type: 'setSetting', key: key, value: box.checked }));
		const label = document.createElement('label');
		label.htmlFor = box.id;
		label.textContent = labelText;
		field.appendChild(box);
		field.appendChild(label);
		const wrap = el('div', 'toggle-wrap');
		wrap.appendChild(field);
		if (hint) { wrap.appendChild(el('div', 'hint', hint)); }
		return wrap;
	}

	function selectField(labelText, value, options, key) {
		const field = el('div', 'field');
		field.appendChild(el('span', 'field-label', labelText));
		const select = document.createElement('select');
		for (const option of options) {
			const node = document.createElement('option');
			node.value = option.value;
			node.textContent = option.label;
			if (option.value === value) { node.selected = true; }
			select.appendChild(node);
		}
		// a model the setting names but the window no longer offers, so the picker still
		// shows what is actually configured instead of silently reading as automatic
		if (value && !options.some(option => option.value === value)) {
			const node = document.createElement('option');
			node.value = value;
			node.textContent = value + ' (not available)';
			node.selected = true;
			select.appendChild(node);
		}
		select.addEventListener('change', () => send({ type: 'setSetting', key: key, value: select.value }));
		field.appendChild(select);
		return field;
	}

	function buildModelField() {
		const models = state.models || [];
		const options = [{ value: '', label: models.length ? 'Automatic (cheapest)' : 'Automatic' }];
		for (const model of models) {
			const vendor = model.vendor ? model.vendor + ' · ' : '';
			options.push({ value: model.id, label: vendor + (model.name || model.family || model.id) });
		}
		const field = selectField('Model', state.settings.subtitleModel || '', options, 'subtitleModel');
		if (!models.length) {
			field.classList.add('empty');
		}
		return field;
	}

	function buildSubtitleSection() {
		const settings = state.settings;
		const section = el('div', 'section');
		section.appendChild(el('h2', null, 'Subtitles'));
		section.appendChild(el('div', 'sub-label', 'Default mode'));
		radioRows(section, SUBTITLE_MODES, settings.subtitleMode,
			id => send({ type: 'setSetting', key: 'subtitleMode', value: id }));
		section.appendChild(toggleField(
			'Generate when a session goes quiet',
			settings.autoSubtitle,
			'autoSubtitle',
			'Every generation is a request against your chat provider. Sessions you have written a subtitle for yourself are left alone.'
		));
		if (settings.autoSubtitle) {
			section.appendChild(numberField('Quiet for', 'sec', settings.subtitleIdleSeconds, 10, 3600, 'subtitleIdleSeconds'));
		}
		section.appendChild(buildModelField());
		if (!(state.models || []).length) {
			section.appendChild(el('div', 'hint',
				'No language model is available in this window. Sign in to a chat provider, or add one under Chat: Manage Language Models.'));
		}
		section.appendChild(el('div', 'hint',
			'Every row has its own buttons: a clock for recent status, lines for a task summary, and a refresh on the title.'));
		return section;
	}

	const SUBTITLE_MODES = [
		{ id: 'status', label: 'Recent status', hint: 'Where the session is now, from its most recent messages.' },
		{ id: 'task', label: 'Task summary', hint: 'What it was asked to do, from its opening messages.' }
	];

	function radioRows(section, options, current, onPick) {
		for (const option of options) {
			const chosen = current === option.id;
			const row = el('button', chosen ? 'opt-row chosen' : 'opt-row');
			row.appendChild(el('span', 'radio', chosen ? '●' : '○'));
			const text = el('span', 'opt-text');
			text.appendChild(el('span', 'opt-label', option.label));
			text.appendChild(el('span', 'opt-hint', option.hint));
			row.appendChild(text);
			row.addEventListener('click', () => onPick(option.id));
			section.appendChild(row);
		}
	}

	function buildLayoutSection() {
		const settings = state.settings;
		const section = el('div', 'section');
		section.appendChild(el('h2', null, 'When a session is clicked'));
		radioRows(section, OPEN_TARGETS, settings.openTarget, id => send({ type: 'setOpenTarget', target: id }));

		// width only matters for the dedicated column, so it only appears with it
		if (settings.openTarget === 'dedicatedRight') {
			const width = el('div', 'field');
			width.appendChild(el('span', 'field-label narrow', 'Width'));
			const slider = document.createElement('input');
			slider.type = 'range';
			slider.min = '20';
			slider.max = '80';
			slider.step = '5';
			slider.value = String(Math.round(settings.dedicatedColumnRatio * 100));
			const readout = el('span', 'field-suffix', slider.value + '%');
			slider.addEventListener('input', () => { readout.textContent = slider.value + '%'; });
			// 'change' not 'input' — dragging would otherwise write on every pixel
			slider.addEventListener('change', () => {
				send({ type: 'setSetting', key: 'dedicatedColumnRatio', value: Number(slider.value) / 100 });
			});
			width.appendChild(slider);
			width.appendChild(readout);
			section.appendChild(width);
			section.appendChild(el('div', 'hint', 'Applied when the column is first created. Resize it yourself afterwards and Chat Tags leaves it alone.'));
		}

		const activity = el('div', 'section');
		activity.appendChild(el('h2', null, 'Activity'));
		activity.appendChild(numberField('Bright while active for', 'sec', settings.activeSeconds, 5, 600, 'activeSeconds'));
		activity.appendChild(numberField('Counts as recent for', 'min', settings.recentMinutes, 1, 1440, 'recentMinutes'));
		section.appendChild(activity);
		section.appendChild(buildSubtitleSection());

		return section;
	}

	// ── rows ──────────────────────────────────────────────────

	// one editor for both lines. writing either one by hand marks it 'manual', which is
	// what makes the generate buttons ask before overwriting it
	const FIELDS = {
		title: {
			selector: '.title, .line .row-input',
			message: 'setTitle',
			// clearing it is the reset — setTitle drops the override on an empty string
			placeholder: session => session.titleOverridden
				? 'Clear to restore the original title'
				: 'Name this session',
			current: session => session.title || ''
		},
		subtitle: {
			selector: '.subtitle, .subtitle-line .row-input',
			message: 'setSubtitle',
			placeholder: () => 'e.g. Waiting for API key',
			current: session => session.subtitle || ''
		}
	};

	function startEdit(row, session, field) {
		const spec = FIELDS[field];
		editingSubtitleFor = session.sessionId;
		const existing = row.querySelector(spec.selector);
		if (!existing) { return; }
		// the buttons beside it would otherwise sit on top of a full-width input
		row.querySelectorAll('.row-actions').forEach(node => { node.style.display = 'none'; });

		const input = document.createElement('input');
		input.type = 'text';
		input.className = 'row-input ' + field + '-input';
		input.value = spec.current(session);
		input.placeholder = spec.placeholder(session);
		input.spellcheck = false;

		const commit = save => {
			if (editingSubtitleFor !== session.sessionId) { return; }
			editingSubtitleFor = null;
			if (save) {
				send({ type: spec.message, sessionId: session.sessionId, text: input.value });
			} else {
				render();
			}
		};
		input.addEventListener('keydown', event => {
			event.stopPropagation();
			if (event.key === 'Enter') { commit(true); }
			if (event.key === 'Escape') { commit(false); }
		});
		input.addEventListener('blur', () => commit(true));
		input.addEventListener('click', event => event.stopPropagation());

		existing.replaceWith(input);
		input.focus();
		input.select();
	}

	// a generate button over something the user wrote themselves arms on the first click
	// and fires on the second. armed state lives here rather than in the session so a
	// repaint from the file watcher doesn't silently disarm it mid-decision
	let armed = null;
	let armedTimer = null;

	function disarm() {
		if (armedTimer) { clearTimeout(armedTimer); armedTimer = null; }
		if (armed) { armed = null; render(); }
	}

	function generateButton(session, mode, options) {
		const key = session.sessionId + ':' + mode;
		const isArmed = armed === key;
		const guarded = options.guarded;
		const classes = ['gen'];
		if (guarded) { classes.push('guarded'); }
		if (isArmed) { classes.push('armed'); }

		const button = el('button', classes.join(' '));
		button.appendChild(icon(options.iconName));
		button.title = isArmed
			? 'You have customised this ' + options.noun + ' already, confirm regenerate?'
			: options.label;
		button.setAttribute('aria-label', options.label + ' for ' + session.title);

		button.addEventListener('click', event => {
			event.stopPropagation();
			if (guarded && !isArmed) {
				armed = key;
				if (armedTimer) { clearTimeout(armedTimer); }
				// long enough to read the tooltip, short enough that it doesn't stay hot
				armedTimer = setTimeout(disarm, 6000);
				render();
				return;
			}
			disarm();
			send({ type: 'generateSubtitle', sessionId: session.sessionId, mode: mode });
		});
		return button;
	}

	// only non-default sessions arrive with a level, so the presence of one is the whole
	// decision. labels and hints are the workbench's own copy — 'autoApprove' is called
	// Allow all in the picker, and a pill that disagrees with the thing the user clicked
	// is worse than no pill
	const PERMISSION_PILLS = {
		assisted: {
			label: 'Assisted',
			hint: "An LLM judge evaluates each tool call. Tools it doesn't approve require your approval."
		},
		autoApprove: {
			label: 'Allow all',
			hint: 'Auto-approves every tool call and retries on errors.'
		},
		autopilot: {
			label: 'Autopilot',
			hint: 'Auto-approves every tool call and continues until the task is done.'
		}
	};

	// the workbench marks all three non-default levels elevated, so that flag cannot drive
	// the split. its risk map scores assisted 1 and the other two 2, which can — assisted
	// still puts a judge in front of every call, the other two put nothing
	const LOUD = ['autoApprove', 'autopilot'];

	// the session button leaves no flag to read — this pill comes from watching the session
	// file for commands it auto-approved, so it means "as of the last terminal command",
	// and it goes when the window reloads because the workbench state goes with it
	function sessionApprovalPill() {
		const pill = el('span', 'pill', 'Auto-approving');
		pill.dataset.elevated = 'true';
		pill.dataset.live = 'true';
		pill.title = 'Allow All Commands in this Session is on — terminal commands run without asking. It clears when the window reloads.';
		return pill;
	}

	function permissionPill(level) {
		const known = PERMISSION_PILLS[level];
		// a level added upstream lands here unrecognised — showing it raw beats treating
		// an unfamiliar permission as if it were the safe one
		const pill = el('span', 'pill', known ? known.label : level);
		pill.dataset.level = level;
		pill.dataset.elevated = String(LOUD.includes(level));
		pill.title = known ? known.hint : 'Permission level ' + level + ', which this version does not recognise.';
		return pill;
	}

	function buildRow(session, now) {
		const category = state.categories.find(c => c.id === session.categoryId);
		const row = el('li', 'row');
		row.tabIndex = 0;
		row.dataset.sessionId = session.sessionId;
		row.dataset.state = session.activity;
		row.dataset.attention = String(Boolean(session.needsAttention));
		if (session.archived) { row.classList.add('archived'); }
		row.setAttribute('role', 'option');
		row.setAttribute('aria-selected', String(session.sessionId === selectedId));

		if (category) {
			row.dataset.category = category.id;
			row.style.setProperty('--row-colour', category.colour);
			row.style.setProperty('--dot-colour', category.colour);
		}
		if (session.sessionId === selectedId) {
			row.classList.add('selected');
		}

		// ── title row ─────────────────────────────────────────
		const top = el('div', 'line');
		top.appendChild(el('span', 'dot'));
		const title = el('span', 'title', session.title);
		if (session.needsAttention) {
			title.title = 'New activity since you last opened this';
		}
		if (session.titleOverridden) {
			// the native list still shows the session's own title — this one is only ours
			title.dataset.overridden = 'true';
			title.title = session.titleSource === 'manual'
				? 'Your title. Double-click to edit.'
				: 'Generated title. Double-click to edit.';
		}
		title.addEventListener('dblclick', event => {
			event.stopPropagation();
			startEdit(row, session, 'title');
		});
		top.appendChild(title);
		if (session.autoApproving) {
			top.appendChild(sessionApprovalPill());
		}
		if (session.permissionLevel) {
			top.appendChild(permissionPill(session.permissionLevel));
		}

		const titleEdit = el('button', 'edit');
		titleEdit.appendChild(icon('pencil'));
		titleEdit.title = 'Edit title';
		titleEdit.setAttribute('aria-label', 'Edit title for ' + session.title);
		titleEdit.addEventListener('click', event => {
			event.stopPropagation();
			startEdit(row, session, 'title');
		});
		const titleActions = el('span', 'row-actions');
		// an archived row is being put away, not worked on — restoring it is the only
		// thing worth a button, and generating over it would be a billable request on
		// something the user has already dismissed
		if (session.archived) {
			const restore = el('button', 'edit');
			restore.appendChild(icon('unarchive'));
			restore.title = 'Restore from archive';
			restore.setAttribute('aria-label', 'Restore ' + session.title + ' from archive');
			restore.addEventListener('click', event => {
				event.stopPropagation();
				send({ type: 'setArchived', sessionId: session.sessionId, archived: false });
			});
			titleActions.appendChild(restore);
		} else {
			titleActions.appendChild(titleEdit);
			titleActions.appendChild(generateButton(session, 'title', {
				iconName: 'refresh',
				label: 'Regenerate title',
				noun: 'title',
				guarded: session.titleSource === 'manual'
			}));
		}

		const menuButton = el('button', 'actions');
		menuButton.appendChild(icon('dots'));
		menuButton.title = 'Category';
		menuButton.setAttribute('aria-label', 'Category for ' + session.title);
		menuButton.addEventListener('click', event => {
			event.stopPropagation();
			openPopover(menuButton, session);
		});
		titleActions.appendChild(menuButton);
		if (armed === session.sessionId + ':title') {
			titleActions.classList.add('has-armed');
		}
		top.appendChild(titleActions);

		// ── subtitle row ──────────────────────────────────────
		const hasSubtitle = Boolean(session.subtitle);
		const subtitleText = session.generating
			? 'Generating…'
			: hasSubtitle
				? session.subtitle
				: session.requestCount + (session.requestCount === 1 ? ' request' : ' requests')
					+ ' · ' + relativeTime(session.lastActivityAt, now);

		const subtitleLine = el('div', 'subtitle-line');
		const subtitle = el('span',
			session.generating ? 'subtitle generating' : hasSubtitle ? 'subtitle' : 'subtitle placeholder',
			subtitleText);
		if (hasSubtitle && session.subtitleSource === 'llm') {
			subtitle.title = 'Generated. Edit it and it stops being regenerated.';
		}

		const editButton = el('button', 'edit');
		editButton.appendChild(icon('pencil'));
		editButton.title = 'Edit subtitle';
		editButton.setAttribute('aria-label', 'Edit subtitle for ' + session.title);
		editButton.addEventListener('click', event => {
			event.stopPropagation();
			startEdit(row, session, 'subtitle');
		});

		const guardSubtitle = session.subtitleSource === 'manual';
		const subtitleActions = el('span', 'row-actions');
		if (!session.archived) {
			subtitleActions.appendChild(editButton);
			subtitleActions.appendChild(generateButton(session, 'status', {
				iconName: 'clock',
				label: 'Subtitle from recent status',
				noun: 'subtitle',
				guarded: guardSubtitle
			}));
			subtitleActions.appendChild(generateButton(session, 'task', {
				iconName: 'notes',
				label: 'Subtitle from task summary',
				noun: 'subtitle',
				guarded: guardSubtitle
			}));
		}
		if (armed === session.sessionId + ':status' || armed === session.sessionId + ':task') {
			subtitleActions.classList.add('has-armed');
		}
		subtitleLine.appendChild(subtitle);
		subtitleLine.appendChild(subtitleActions);

		row.appendChild(top);
		row.appendChild(subtitleLine);

		row.addEventListener('click', () => open(session.sessionId));
		row.addEventListener('contextmenu', event => {
			event.preventDefault();
			openPopover(menuButton, session);
		});
		return row;
	}

	function open(sessionId) {
		selectedId = sessionId;
		send({ type: 'open', sessionId });
	}

	function focusOffset(delta) {
		const rows = Array.from(document.querySelectorAll('.row'));
		if (!rows.length) { return; }
		const current = rows.findIndex(row => row === document.activeElement);
		const next = Math.min(rows.length - 1, Math.max(0, (current === -1 ? 0 : current + delta)));
		rows[next].focus();
	}

	// grouping is only ever by category, so the order is the order the categories were
	// defined in and everything without one falls to the bottom
	function groupSessions(sessions) {
		if (state.settings.groupBy !== 'category') {
			return [{ category: null, label: null, sessions: sessions }];
		}
		const groups = [];
		for (const category of state.categories) {
			const members = sessions.filter(session => session.categoryId === category.id);
			if (members.length) {
				groups.push({ category: category, label: category.name, sessions: members });
			}
		}
		// a session pointing at a category that has since been deleted belongs here too
		const known = new Set(state.categories.map(category => category.id));
		const loose = sessions.filter(session => !known.has(session.categoryId));
		if (loose.length) {
			groups.push({ category: null, label: 'Uncategorised', sessions: loose });
		}
		return groups;
	}

	function sectionHeader(label, count, colour) {
		const header = el('li', 'group');
		// a heading inside a listbox is furniture, not an option
		header.setAttribute('role', 'presentation');
		const swatch = el('span', 'swatch');
		if (colour) { swatch.style.setProperty('--swatch', colour); }
		header.appendChild(swatch);
		header.appendChild(el('span', 'group-name', label));
		header.appendChild(el('span', 'group-count', String(count)));
		return header;
	}

	function render() {
		const now = Date.now();
		closePopovers();
		root.textContent = '';

		const live = state.sessions.filter(session => !session.archived);
		const archived = state.sessions.filter(session => session.archived);
		// archived rows are out of sight by definition, so they don't get to ask for you
		const unread = live.filter(session => session.needsAttention).length;

		const toolbar = el('div', 'toolbar');
		const categories = el('button', openPanel === 'categories' ? 'active' : null, 'Categories');
		categories.title = openPanel === 'categories' ? 'Close categories' : 'Categories';
		categories.setAttribute('aria-pressed', String(openPanel === 'categories'));
		categories.addEventListener('click', () => togglePanel('categories'));
		toolbar.appendChild(categories);

		if (unread) {
			const markRead = el('button', null, '✓ Mark all read');
			markRead.addEventListener('click', () => send({ type: 'markAllRead' }));
			toolbar.appendChild(markRead);
		}

		toolbar.appendChild(el('div', 'spacer'));
		toolbar.appendChild(el('span', 'count',
			unread ? unread + ' new · ' + live.length : String(live.length)));

		const newChat = el('button', 'icon');
		newChat.appendChild(icon('plus', 16));
		newChat.title = 'New chat';
		newChat.setAttribute('aria-label', 'New chat');
		newChat.addEventListener('click', () => send({ type: 'newChat' }));
		toolbar.appendChild(newChat);

		const sort = el('button', 'icon');
		sort.appendChild(icon('sort', 15));
		sort.title = 'Sort, group and archived';
		sort.setAttribute('aria-label', 'Sort, group and archived');
		sort.addEventListener('click', event => {
			event.stopPropagation();
			openListMenu(sort);
		});
		toolbar.appendChild(sort);

		const gear = el('button', openPanel === 'settings' ? 'icon active' : 'icon');
		gear.appendChild(icon('gear', 15));
		gear.title = openPanel === 'settings' ? 'Close settings' : 'Settings';
		gear.setAttribute('aria-label', 'Settings');
		gear.setAttribute('aria-pressed', String(openPanel === 'settings'));
		gear.addEventListener('click', () => togglePanel('settings'));
		toolbar.appendChild(gear);

		const extensions = el('button', 'icon');
		const logo = document.createElement('img');
		logo.className = 'logo';
		logo.src = document.body.dataset.logo || '';
		logo.alt = '';
		extensions.appendChild(logo);
		extensions.title = 'View in Extensions';
		extensions.setAttribute('aria-label', 'View in Extensions');
		extensions.addEventListener('click', () => send({ type: 'openInExtensions' }));
		toolbar.appendChild(extensions);

		root.appendChild(toolbar);

		if (openPanel === 'categories') {
			root.appendChild(buildCategoriesPanel());
		} else if (openPanel === 'settings') {
			root.appendChild(buildSettingsPanel());
		}

		if (!state.sessions.length) {
			root.appendChild(el('div', 'empty', state.archivedCount
				? 'Everything here is archived. Show it again from the sort menu.'
				: 'No chat sessions found for this window. Open a folder that has chat history, or start a chat.'));
			return;
		}

		const list = el('ul', 'list');
		list.setAttribute('role', 'listbox');
		list.setAttribute('aria-label', 'Chat sessions');

		for (const group of groupSessions(live)) {
			if (group.label) {
				list.appendChild(sectionHeader(group.label, group.sessions.length,
					group.category ? group.category.colour : null));
			}
			for (const session of group.sessions) {
				list.appendChild(buildRow(session, now));
			}
		}

		// archived stays one block at the bottom whether or not the rest is grouped —
		// scattering it back through the categories would defeat the point of archiving
		if (archived.length) {
			list.appendChild(sectionHeader('Archived', archived.length));
			for (const session of archived) {
				list.appendChild(buildRow(session, now));
			}
		}
		root.appendChild(list);

		// a selection you cannot see is not a selection, and an adopted row can be anywhere
		if (selectedId && selectedId !== revealedId) {
			revealedId = selectedId;
			const chosen = list.querySelector('.row.selected');
			if (chosen && chosen.scrollIntoView) {
				chosen.scrollIntoView({ block: 'nearest' });
			}
		}

		// hidden archived sessions are otherwise invisible, and a count nobody can find is
		// how you end up thinking a chat was deleted
		if (!state.settings.showArchived && state.archivedCount) {
			const footer = el('button', 'footer',
				state.archivedCount + (state.archivedCount === 1 ? ' archived session' : ' archived sessions'));
			footer.title = 'Show archived';
			footer.addEventListener('click', () => send({ type: 'setSetting', key: 'showArchived', value: true }));
			root.appendChild(footer);
		}
	}

	document.addEventListener('click', closePopovers);

	document.addEventListener('keydown', event => {
		if (event.key === 'Escape') { closePopovers(); return; }
		if (editingSubtitleFor) { return; }
		if (event.key === 'ArrowDown') { event.preventDefault(); focusOffset(1); }
		else if (event.key === 'ArrowUp') { event.preventDefault(); focusOffset(-1); }
		else if (event.key === 'Enter' || event.key === ' ') {
			const active = document.activeElement;
			if (active instanceof HTMLElement && active.dataset.sessionId) {
				event.preventDefault();
				open(active.dataset.sessionId);
			}
		}
	});

	window.addEventListener('message', event => {
		const message = event.data;
		if (message && message.type === 'openPanel') {
			openPanel = message.panel;
			render();
			return;
		}
		if (message && message.type === 'render') {
			// the provider owns the selection once anything has been opened, so a row adopted
			// after a new chat lands shows up without the user clicking it
			if (message.activeSessionId !== undefined) {
				selectedId = message.activeSessionId;
			}
			state = {
				sessions: message.sessions,
				categories: message.categories,
				models: message.models || [],
				archivedCount: message.archivedCount || 0,
				settings: Object.assign({}, DEFAULT_SETTINGS, message.settings)
			};
			// a redraw mid-edit would throw away what's being typed
			if (!editingSubtitleFor) { render(); }
		}
	});

	render();
	send({ type: 'ready' });
}());
