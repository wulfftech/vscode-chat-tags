// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 WulffTech

// the rules behind reordering categories. the pane draws the drop line and names the gap;
// everything that decides what the list actually becomes is in TagStore.moveCategory, and
// this is what pins it. no session files are read — it is all memento

import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// the store needs vscode for its event emitter and nothing else, so that one class is
// stubbed rather than dragging in a whole extension host. the emitter counts its fires:
// half of what is being asserted here is that a move which changes nothing stays silent
const Module = require('module');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	return request === 'vscode' ? 'vscode' : resolve.call(this, request, ...rest);
};
let fires = 0;
require.cache.vscode = {
	id: 'vscode', filename: 'vscode', loaded: true,
	exports: {
		EventEmitter: class {
			get event() { return () => ({ dispose() { } }); }
			fire() { fires++; }
			dispose() { }
		}
	}
};
const { TagStore } = require('../out/model/categories.js');

let failures = 0;

function fakeMemento() {
	const values = new Map();
	return {
		get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
		update: (key, value) => { values.set(key, value); return Promise.resolve(); }
	};
}

function check(label, actual, expected) {
	if (actual === expected) {
		console.log(`  ok   ${label}`);
	} else {
		console.log(`  !!   ${label}: got ${actual}, wanted ${expected}`);
		failures++;
	}
}

// four categories named after their starting position, so an order reads as a sentence
async function seeded() {
	const tags = new TagStore(fakeMemento());
	for (const name of ['a', 'b', 'c', 'd']) {
		await tags.createCategory(name, '#000000');
	}
	return tags;
}

const order = tags => tags.categories.map(entry => entry.name).join('');
const idOf = (tags, name) => tags.categories.find(entry => entry.name === name).id;

console.log('');
console.log('── moving ──');
{
	const tags = await seeded();
	check('starts in creation order', order(tags), 'abcd');

	await tags.moveCategory(idOf(tags, 'd'), idOf(tags, 'a'));
	check('the last one lands in front of the first', order(tags), 'dabc');

	await tags.moveCategory(idOf(tags, 'd'), undefined);
	check('no anchor means the end of the list', order(tags), 'abcd');

	// what the pane sends for a drop in the gap below a row: the id of the row after it
	await tags.moveCategory(idOf(tags, 'a'), idOf(tags, 'c'));
	check('in front of c puts a between b and c', order(tags), 'bacd');

	// and for a drop in the gap above a row, which is the same gap named from the other side
	await tags.moveCategory(idOf(tags, 'd'), idOf(tags, 'a'));
	check('in front of a puts d between b and a', order(tags), 'bdac');
}

console.log('');
console.log('── moves that change nothing ──');
{
	const tags = await seeded();
	const before = fires;

	// dropping a row on the gap it already occupies. the pane suppresses the line for this
	// one, but a stale list can still send it and it must not write or repaint
	await tags.moveCategory(idOf(tags, 'b'), idOf(tags, 'c'));
	check('b in front of c leaves abcd alone', order(tags), 'abcd');
	check('and fires nothing', fires - before, 0);

	await tags.moveCategory(idOf(tags, 'd'), undefined);
	check('the last one sent to the end stays put', order(tags), 'abcd');
	check('still nothing', fires - before, 0);

	await tags.moveCategory(idOf(tags, 'b'), idOf(tags, 'b'));
	check('a row in front of itself is not a move', order(tags), 'abcd');
	check('still nothing', fires - before, 0);

	await tags.moveCategory('cat_gone', idOf(tags, 'a'));
	check('moving an id that is not there does nothing', order(tags), 'abcd');
	check('still nothing', fires - before, 0);

	// one real move, to prove the counter was ever going to move at all
	await tags.moveCategory(idOf(tags, 'a'), undefined);
	check('a real move does write', order(tags), 'bcda');
	check('and fires once', fires - before, 1);
}

console.log('');
console.log('── a pane a repaint behind ──');
{
	// the drag started against a list that has since changed. an index would land in the
	// wrong gap here; an anchor id either still names a gap or names nothing
	const tags = await seeded();
	const anchor = idOf(tags, 'c');

	await tags.deleteCategory(anchor);
	await tags.moveCategory(idOf(tags, 'a'), anchor);
	check('an anchor deleted mid-drag means the end', order(tags), 'bda');

	// the other direction: something added while the pointer was down
	const added = await tags.createCategory('e', '#000000');
	check('a new category lands at the end', order(tags), 'bdae');
	await tags.moveCategory(added.id, idOf(tags, 'd'));
	check('and moves by the same rule', order(tags), 'beda');
}

console.log('');
console.log('── order survives everything else ──');
{
	const tags = await seeded();
	await tags.moveCategory(idOf(tags, 'd'), idOf(tags, 'a'));
	check('reordered', order(tags), 'dabc');

	await tags.updateCategory(idOf(tags, 'a'), { name: 'A', colour: '#ffffff' });
	check('a rename edits in place', order(tags), 'dAbc');

	await tags.deleteCategory(idOf(tags, 'b'));
	check('a delete closes the gap', order(tags), 'dAc');

	await tags.createCategory('e', '#000000');
	check('a create appends', order(tags), 'dAce');
}

console.log('');
console.log(failures ? `PROBE FAILED — ${failures} check(s)` : 'OK');
process.exit(failures ? 1 : 0);
