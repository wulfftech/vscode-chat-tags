# Contributing

Everything here is the stuff a user doesn't need and a contributor can't work without. The user-facing half lives in [README.md](README.md).

## Setup

```bash
npm install && npm run compile
```

Run the extension:

```bash
code --extensionDevelopmentPath=. --new-window --folder-uri "file:///d%3A/Code/stonks"
```

Use `--folder-uri`. Passing a plain folder path alongside `--extensionDevelopmentPath` opens an empty window and silently hands you no workspace sessions at all — no error, no warning, just an empty list and half an hour of your life.

The other one: the Extension Development Host stores under `workspaceStorage/ext-dev`, not the real workspace hash, so the sibling-directory lookup finds nothing while debugging. The extension falls back to matching the open folder against each `workspace.json`. That fallback exists for dev. The sibling path is what runs in production.

Package it:

```bash
npm run package
```

## The read model

Sessions live in `workspaceStorage/<hash>/chatSessions/<uuid>.jsonl`, plus `globalStorage/emptyWindowChatSessions` for sessions opened without a folder.

The files are append-structured. First line is a `kind: 0` snapshot. Everything after it is a patch record:

```
{"kind":1,"k":["customTitle"],"v":"Assess public datasets"}   set value at path k
{"kind":2,"k":["requests"],"v":[ ... ]}                       append to array at path k
```

Here's the part that matters: **the snapshot is written once at session creation and never rewritten.** A session with 954 patch lines and 10 MB of content reports zero requests and no title in its header. Read only the header and half your sessions come back as raw UUIDs.

So titles come from the patch log, and last-activity comes from the file's mtime. Scanning reads only the first 2 KB of each line, which keeps a 50 MB session cheap. Sessions opened but never used get filtered out — the native list hides them too.

Measured across 49 real sessions, 94 MB on disk:

| | |
|---|---|
| Sessions on disk | 49 |
| Shown after filtering | 23 |
| Parse errors | 0 |
| Titles recovered | 23 of 23 |
| Scan time | ~80 ms per full pass |

`createdAt` comes from `creationDate` in the header, populated on all 23. A session missing one falls back to its mtime rather than sinking to the bottom of a created-order sort looking like a parse failure.

`npm run probe` prints how many positions the activity order and the created order agree on. Expect roughly a third, and expect the exact number to move — it is measured against live session files, and using a chat changes its mtime. Don't paste that figure into the docs as a fixed fact.

### Scan cost on a large store

A store is not always this machine's 66 files and 113 MB. A report from a 614-file, 3 GB store had the extension host dying four times in 22 minutes, with 83% of a CPU profile in one function. Five things were wrong and they compounded.

**Finding a record boundary is a byte search.** The scan used to decode every 256 KB chunk into a string and look for a newline in that. A request append carries its whole payload, so a session file is mostly payload, and all of it became throwaway JS strings. `Buffer.indexOf(0x0A)` answers the same question against the bytes. That change alone took the two-pass probe here from 267 ms to 102 ms, and it is the whole of the 83%.

**Only the prefix is decoded.** Bytes past `PREFIX_BYTES` are stepped over rather than accumulated, so a 400 KB request record costs a byte scan of its length and 2 KB of decode. Nothing further into the record was ever wanted.

**The fan-out is bounded.** `listSessions` ran `Promise.all` across the directory, so 614 files were read simultaneously, each holding a 256 KB buffer and its own transient strings. Six overlapping scans of a 96 MB store peaked at 872 MB RSS. Bounded to eight at a time, the same six peak at 100 MB.

**Unchanged sessions are not re-read.** The files are append-only, so a size and mtime that both still match mean the last read still stands. Repeat scans of that store drop from ~140 ms to nothing.

**The watcher is debounced and the scan is single-flight.** A live chat appends to its session file continuously and every append is a watcher event, so refreshes stacked — a second full fan-out starting on top of the first, which is what actually took the host down. Events now collapse into one scan after 400 ms, and a refresh arriving mid-scan queues exactly one more pass rather than starting its own.

The old skip carried a correctness bug as well. `skipToNextLine` consumed the `kind:0` header without ever setting `firstLineSkipped`, so in any session whose header ran past a chunk boundary the *next* real record was swallowed as though it were the header. Four sessions here were wrong because of it, one reporting no request appends at all against seven on disk and losing its `autopilot` level with them. The check for that is a full read of the file rather than a comparison against the old numbers, since the old numbers were the thing under suspicion.

### A fork is the one session whose header is not a stub

Everything above assumes the header is close to empty and the patch log carries the content. **Forking a chat breaks that assumption outright.** VS Code clones the source conversation in memory and persists the result as one `kind:0` line holding the whole thing — full title, every request, every response — with no patch lines after it, ever. A report said forked chats never showed up at all, and this is why: `readFirstLine` caps a header read at 512 KB, chosen because a normal header is a few hundred bytes and anything past that is someone else's payload. A forked conversation's header *is* the payload. Past 512 KB the read lands mid-object, `JSON.parse` throws, and the session comes back with zero requests and no title — exactly what an untouched chat looks like, so `listSessions` drops it on the same filter that hides those.

Measured against the session that first showed this: a 50 MB original conversation forked into a 49 MB single-line header. `readSession` on it reported `requestCount: 0`, `title` fallen back to the raw session id, `parseError: "Unterminated string in JSON at position 522423"` — the exact position `readFirstLine`'s cap lands at. A historical fork already on the same machine, 517 KB, parsed fine — the same code path, just short enough not to trip the cap.

Fixing it without paying to decode 49 MB into one JS string: `customTitle`, `sessionId` and `creationDate` sit within the first few hundred bytes of the header no matter how huge `requests` gets, because VS Code writes `requests` last. Those come off the same 512 KB prefix the strict parse already read, by regex rather than a full parse. The request count is the one field that needs the whole array walked — there is no way to know how many elements it holds without passing over all of them — but walking is not parsing: `countHeaderRequests` tracks bracket depth and string/escape state one byte at a time, exactly like the delta scanner's own record-boundary search, and never turns a request's payload into a string. A synthetic 36 MB, 300-request fixture reads in ~110 ms at ~48 MB RSS. An adversarial fixture whose request text is deliberately built from stray `{`, `}`, `"requests":[` and backslash sequences still counts correctly, because those bytes are inspected while `inString` is true and never treated as structure.

The fallback only runs when the strict parse failed *and* the header read hit its byte cap rather than finding a newline — a `truncated` flag on the read, not a guess from the error text. A small file that is genuinely malformed still fails exactly as before; scanning further would not recover anything from real corruption; it only recovers from a true header being longer than the cap. And the ceiling on how far the request-count walk goes is generous rather than infinite — 64 MB, matching the reasoning behind the equivalent ceiling in `archiveSeed.ts` — because the count only has to reach 1 for the row to stop being empty, and that happens the moment the first request begins, so even a walk that hits the ceiling before the array closes has already stopped the session from vanishing.

`parseError` was captured on `ChatSessionInfo` from the start and never read anywhere — a session that failed for a real, unrecoverable reason vanished exactly as silently as one that failed for a fixable one. `listSessions` now takes an `onParseError` hook, and the pane logs through it, so a session that still can't be read leaves a line in Show Log instead of nothing.

## Archive, and the two stores

Archiving is ours, but VS Code has its own and the two do not meet. Left alone, a machine that did its archiving in the chat view shows every one of those chats sitting live in this pane — which is what a report described, and it is not a bug in our tracking so much as an absence of one.

| | Chat Tags | VS Code |
|---|---|---|
| Where | `globalStorage/state.vscdb`, our `globalState` | `workspaceStorage/<hash>/state.vscdb`, key `agentSessions.state.cache` |
| Shape | `chatTags.sessionMeta[id].archivedAt`, a timestamp | `[{resource, archived, pinned, read}]` |
| Scope | global — one flag for every window | per workspace |
| Written | on every change | on `onWillSaveState` |

Measured here: 5 archived sessions across 3 of 14 workspaces on one side, 5 unrelated ones on the other, and the key absent from `globalStorage` entirely, which is what pins its scope to workspace rather than profile.

### The write direction is shut, not the read

The earlier note in this file had these the wrong way round — it said we could write their flag but never read it back. Both halves were wrong.

There is no archive in the extension API at all: `vscode.d.ts` at 1.134.0 mentions chat 216 times and archive zero times. Inside the workbench, `setArchived` hands provider-backed sessions to `chatSessionsService.setChatSessionItemArchived`, which throws unless a registered item controller supplies the method. A plain local chat has no controller, so it falls through to a workspace-scoped cache that no extension can reach. Writing is the closed direction.

Reading is the open one, by the same byte scan this file already describes for `warningAccepted`. That reverses the standing refusal to touch `state.vscdb`, and the trade is worth naming: the alternative was a pane that silently disagrees with the chat view about what you put away.

### Seeding

`archiveSeed.ts` reads the database beside each sessions directory and hands the archived ids to `TagStore.seedArchived`. Four things hold it together:

**It runs one way.** Their flag can set ours; ours never touches theirs, and an unarchive here is never reported back.

**A session is taken once.** `vscodeArchiveSeeded` on the meta records that their flag has been accounted for, and it survives unarchiving. Without it the next seed would undo a restore, every window, forever. It is per session rather than per workspace, so a chat archived over there *after* the first pass still arrives.

**Only sessions in the list are taken.** The ids are intersected with what the scan actually found on disk, so a misread page cannot archive a row that was never ours.

**The newest copy wins.** A table leaf stores the key immediately before its value, so one scan finds both — but the same key also sits in the primary-key index with nothing behind it, and a freed page can still hold a superseded copy. Requiring a `[` straight after the key rules out the index. For the rest, every entry carries the epoch it was last read at, and the copy holding the newest one is the live page. On this machine one file holds two copies and the freed one is 76 seconds behind, a strict subset of the other.

`npm run probe:archive` reports both sides and asserts the last of those. It carries a synthetic two-copy buffer as well, because the real files here have been single-copy for whole releases at a time and an assertion that never runs is not one.

Two limits, both accepted:

- empty-window sessions are not seeded. Their directory sits next to `globalStorage`, where there is no `state.vscdb`, and an empty window's own storage hash is not something we can map back with any confidence
- VS Code flushes on `onWillSaveState`, so a chat archived seconds before the pane first reads is missed until the next window

## Opening a session

There's no public API for "open this chat session". Three ways work, tried in order:

| Rung | Mechanism | Risk |
|---|---|---|
| 1 | `vscode.open` on the session URI | Public, documented. |
| 2 | `openSessionInEditorGroup` with `{ resource }` | Internal action, but no internal constants. |
| 3 | Same command with a marshalled `$mid` context | `$mid` is a `const enum` inlined at compile time. Shifts if upstream inserts a member above it. |

All three opened a real chat editor tab on 1.134.0. Rung 1 being public is the reason this isn't fragile. `openSession` reports which rung worked, so a break shows up in the log instead of silently.

Session URIs are `vscode-chat-session://local/<base64url(sessionId)>` — url-safe, unpadded, session type as the authority.

## Starting a session

Same problem as opening one, with a worse trap in it. The `+` shipped betting on `workbench.action.chat.openNewSessionEditor.local`, and on 1.135.0 that id is not registered.

`ChatSessionsContribution._registerCommands` registers `openNewSessionEditor.${type}` once per *contributed* session type — the live suffixes are `copilotcli`, `copilot-cloud-agent` and `agent-host-copilotcli`. `local` is a `SessionType` member rather than a contribution, so there is no registration to find. Grep the bundle for `openNewSessionEditor` and you find the template literal and call it confirmed; only a live registration check catches this, which is why the spike walks this ladder too.

What runs instead:

| Rung | Mechanism | Risk |
|---|---|---|
| 1 | `newLocalChat`, then `openInEditor` | Two internal ids, and the only rung that lands an editor tab. |
| 2 | `newChat` | Generic. Clears the current widget instead of adding a tab. |

`newLocalChat` declares `precondition: chat.location == panel`, which turns out to be irrelevant: `registerAction2` puts the bare `run()` into the commands registry, and the precondition is consulted for menus and keybindings alone. Its no-widget branch opens the chat view and calls `startNewLocalSession`, so it works with chat docked anywhere.

That leaves the session in the view, and this extension puts everything else in an editor tab. `openInEditor` — "Move Chat into Editor Area" — moves the focused widget across. Rung 1 swallows a failure from that second half deliberately: the session exists as soon as the first half resolves, so falling through would only make a second one. A move that quietly stops working shows up as the spike's `no-op` verdict.

## Deleting a session

`agentSession.delete`, and the argument shape is not optional trivia.

`BaseAgentSessionAction.run` handles three cases:

```
marshalled ($mid: 25)  →  resolve each resource through the sessions model
plain object           →  use it as-is
nothing resolved       →  fall back to whatever is focused in the native viewer
```

That third line is the trap. A marshalled resource that doesn't resolve — an empty-window session, a session from another workspace — drops to zero results and the action deletes **whatever the native sessions viewer happens to have focused instead**. For an open that's a shrug. For a delete it's someone else's chat.

So delete passes a bare `{ providerType: 'local', resource }`. `providerType: 'local'` is what routes it down the local branch that clears the widget and removes the history entry, and the plain-object path never consults the model, so the fallback can't fire.

Downstream, `ChatSessionStore.internalDeleteSession` returns early on an id that isn't in its index, which is exactly why unlinking the file directly is wrong — the index entry survives and points at nothing.

The command resolves whether the user confirmed or cancelled, so `fs.existsSync` on the session file afterwards is the only real evidence. That result goes to the log, and the metadata is only dropped when the file actually went.

## Renaming a session, where VS Code can see it

A title kept in extension state is drawn over the list and nothing else. The editor tab's label comes from `ChatEditorInput.getName()`:

```js
getName() {
  if (this.model?.title) return this.model.hasCustomTitle ? this.model.title : truncate(this.model.title);
  if (this._sessionResource) {
    const session = this.chatService.getSession(this._sessionResource);
    if (session?.title) return session.title;
    const stored = this.chatService.getSessionTitle(this._sessionResource);
    if (stored?.trim()) return stored;
  }
  …
}
```

Every branch reads the chat model or the chat service. `Tab.label` is readonly in the shipped `vscode.d.ts` and `ChatSession` appears in it nowhere, so there is no seam. Reopening the tab does not help either — the input is reconstructed and calls the same getter.

What *does* update the tab is `chatService.setChatSessionTitle`, and `_trackModelChanges()` fires `_onDidChangeLabel` on every model change, so a rename lands live on an open tab. Four things call it:

| Caller | Reachable from an extension |
|---|---|
| `agentSession.rename` | Yes — a registered Action2 id |
| the `/rename` slash command | No. Registered with the chat slash-command registry, not the commands registry |
| the agent-host `session/titleChanged` sync | No, and it is not the local path anyway |
| `ChatEditor.setInput`, restoring `title.preferred` | No. Only fires for a session locked to a coding agent |

So `agentSession.rename` it is, and the argument shape does the work again. It extends the same `BaseAgentSessionAction` as the delete above, so a plain object is used as-is:

```js
async runWithSessions(sessions, accessor) {
  const item = sessions.at(0);
  const typed = await quickInput.input({ prompt: …, value: item.label });
  typed && (isAgentHost(item) ? … : chatService.setChatSessionTitle(item.resource, typed));
}
```

`item.label` is read straight off the object we passed, so sending `{ providerType: 'local', resource, label }` opens VS Code's own rename box **prefilled with the Chat Tags title**. `isAgentHost` is `Jc(providerType)`, false for `local`, so it takes the `setChatSessionTitle` branch.

There is no way to skip the box. The value comes from a quick input, not from an argument, and a quick input is an HTML input rather than a Monaco editor, so the `type` command doesn't reach it either.

Adopting the result is the same problem delete has: the command resolves whether the box was confirmed or dismissed. So the session file decides. `setChatSessionTitle` calls `setCustomTitle` only when the model is loaded, and the save that writes `customTitle` is on the workbench's own schedule — so the rename lands a few refreshes later rather than immediately, and never at all for a chat that isn't open. `pendingRename` holds the pre-rename title for a minute and `adoptRename` drops our copy the moment the file disagrees with it.

`state.vscdb` is not a way round the last part. `chat.ChatSessionStore.index` does carry `{sessionId, title, lastMessageDate, lastResponseState, …}` per session, and `_chatSessionStore.setSessionTitle` patches it even for a closed chat. But it is a much bigger value than the archive array, and the byte scan in `archiveSeed.ts` recovered no complete copy at all from the 25-session workspace here — every hit ran off the end of its page into unrelated bytes. The eleven smaller workspaces it could read lag their session files by days. Its `lastResponseState` is no use for turn state either: only terminal values ever reach it, 21 ones and 6 threes across every index that parsed.

## Finding the last exchange

A session file reaches 50 MB. The model sees about 1 KB of it. Getting that 1 KB out is the whole problem.

Response parts stream in as separate records *after* the request that owns them, so the last request is nowhere near the end of the file. Measured across 45 sessions:

| | |
|---|---|
| Last request append, distance from EOF | 5 KB – 4.1 MB |

Read the tail and you get responses with no message attached. So the reader makes one forward pass that decodes the first 256 bytes of each line and remembers byte offsets, then re-reads only the handful of records worth parsing. One response record hit 431 KB in the wild — nothing gets parsed that wasn't chosen first.

Measured across 23 real sessions, 97 MB:

| | |
|---|---|
| Scan time | 61 ms for all 23 |
| Slowest single session | 16 ms for 48 MB |
| User message recovered | 16 of 23 |
| Assistant prose recovered | 12 of 23 |
| Failures | 0 |

Three things had to be thrown out. `@agent Try Again` writes a real request record carrying no intent whatsoever, and it was the newest request in eight of those 23 sessions — the reader walks back up to ten records looking for something a person actually typed. Terminal notifications arrive as ordinary requests and `isSystemInitiated` is set on some and not others, so the text gets trusted, not the flag. And bare acknowledgements are real messages that say nothing about state — two sessions ended on `cool`.

The walk-back used to fall back to the newest record when nothing substantive turned up, which reinstated the exact boilerplate it had just walked past: five of 23 sessions were sending `Last request: @agent Try Again`. There is no fallback now, which is the whole reason the recovered figure is 16 rather than 22. A missing last request beats a misleading one — `buildStatusPrompt` omits the line and the assistant's last message carries the weight.

### Redaction

Session files carry things that were never meant to travel. One session held a live Vaultwarden token in its tool activity and a password as its last request, and both would have gone to the model provider verbatim.

`redact()` in `subtitleText.ts` masks the shapes that are unambiguously credentials. It runs on the **assembled prompt**, not field by field, so a field added later cannot quietly bypass it. It is deliberately small — a stop on the obvious cases, not a scanner — and `npm run probe:exchange -- --prompt` is what proves it against real sessions rather than invented ones.

Assistant prose is the part with no `kind` discriminator at all — a bare serialised `MarkdownString` sitting among `toolInvocationSerialized` and `thinking` parts. A turn that ends on tool calls has no prose of its own, which is why 12 of 23 is the real number and not a bug. When an index has none the reader falls back to the previous one; the last sentence the assistant wrote still describes where the session is.

Reaching the fifth opening message is not the cheap end of the file it sounds like. Response records sit between request appends, so the fifth request landed anywhere from 0.1% to 98.5% of the way through. The scan stops the moment it has enough, which is the difference between reading 68 KB and reading 50 MB.

| | |
|---|---|
| Opening messages recovered | 23 of 23 |
| Opening scan time | 87 ms over 85 MB |

## A new chat is invisible until it is used

The + button starts a chat, and the row does not appear until the first message lands. That is not the button failing — VS Code holds an untouched chat in memory and writes no session file at all.

Measured on a live window: after clicking +, the newest `requestCount: 0` file on disk was 47 hours old. Nothing had been written. Send one message and the file appears carrying one request, the watcher fires, and the row shows up.

Two filters would hide it even if the file existed. `listSessions` drops sessions with no requests and no title, and the native list hides those too — 27 of 53 files on one machine.

So the pane cannot show an unsaved chat, and a placeholder row would be worse: with no session id it could not be opened, categorised, or reconciled against the real file when it lands. Instead `adoptNewSession` remembers which ids existed when + was pressed and hands the selection to the first unrecognised one that turns up, inside a five minute grace window. Opening anything by hand cancels it, because that settles what the user is actually looking at.

**The pane cannot read editor focus.** A chat session editor reaches the tabs API as `TabInputKind.Unknown`, so `tab.input` is `undefined` and carries no session URI. Selection is therefore whatever this extension opened itself, which is the same thing in practice.

## Why a webview, not a tree view

A `TreeView` cannot do what this needs. `TreeItem` has no height or multiline property, `TreeViewOptions` exposes only four fields, and no workbench setting changes tree row height. Rows are nailed to ~22px on a single line.

The built-in Chat list runs at `ITEM_HEIGHT = 54` because `agentSessionsViewer.ts` is workbench code with its own list delegate. Extensions don't get that.

So the view is a `WebviewViewProvider`. Rows are 54px, two lines, with a category stripe and a low-alpha wash of the same colour across the whole row — the shaded block that started this whole thing.

What it costs: keyboard navigation, selection and accessibility are hand-built rather than free. Interactions deliberately go through native quick picks instead of HTML menus, which keeps them keyboard accessible without reimplementing a menu system from scratch.

## Collapsible category groups

Collapse state lives in `TagStore.collapsedGroups` (`src/model/categories.ts`), one flat `string[]` in globalState — the same "global, not per-webview" home as every other piece of category state (colour, name). Real categories use their own `id`; "Uncategorised" and "Archived" have no `Category` behind them, so they get fixed sentinel strings (`'uncategorised'`, `'archived'`). No collision is possible — real ids come out of `makeId()` as `cat_<random>`. A flat array of ids handling both cases turned out simpler than the alternative floated when this was scoped (`Category.collapsed` plus a second mechanism for the two pseudo-groups) — that would be two mechanisms for one job instead of one.

Collapsed groups are left out of the DOM entirely in `media/view.js`'s `render()`, not hidden with CSS. `render()` already does `root.textContent = ''` and rebuilds everything from scratch on every call — there is no transition to preserve either way, and keeping collapsed rows out of the DOM means `focusOffset()`'s `.row`/`.group` query is correct for free instead of needing to filter out `display:none` elements.

That full-teardown render is exactly what makes a focusable heading tricky. Toggling a group by keyboard destroys the very `<li>` that has focus, and nothing refocuses its replacement by default — first pass through this shipped with that bug. The fix: `render()` reads `document.activeElement.dataset.groupId` before tearing the DOM down, then looks up the rebuilt header by that id afterward and refocuses it. `focusOffset()` also had to start treating `.group` headers as navigable stops alongside `.row`s, or a focused header made `document.activeElement` invisible to the row query and every arrow press degenerated to "jump to row 0."

One more non-obvious interaction: the "scroll the selection into view" check (`if (selectedId && selectedId !== revealedId)`, further down `render()`) only re-fires when the *selected session* changes, not when a group's visibility changes. Re-expanding a group holding the selected session would otherwise bring its row back into the DOM without ever scrolling to it. The header's toggle handler resets `revealedId = null` when it's about to expand a group containing `selectedId`, so the existing reveal logic runs again on the next render.

**Verified in a standalone browser harness only** (`view.css`/`view.js` served statically with `acquireVsCodeApi` stubbed and a fake extension-host round-trip for `toggleGroupCollapsed`), not in a live VS Code Extension Development Host window — confirmed collapse/expand, chevron rotation, focus restoration, arrow-key traversal across headers, and the reveal-on-expand fix all work against the real compiled `view.js`, but VS Code's own webview host, theming, and screen-reader behavior were never exercised.

## Reordering categories

One array is the order everywhere. `TagStore.categories` drives the groups when grouping is on and the category list in every row menu, so there is no second ordering to keep in step — reorder the array and both follow. That was already true; what was missing was any way to change it.

**A move names a gap, not an index.** `moveCategory(id, beforeId?)` puts a category in front of another one, with `beforeId` absent meaning the end of the list. The pane's copy of the list can be a repaint behind a create or a delete, and an index resolved against a list that has since changed length lands somewhere other than the gap the drop line was drawn in. An anchor id either still names that gap or names nothing, and nothing means the end — which is also where a drop below the last row lands anyway. `probe:order` covers both stale directions: an anchor deleted mid-drag, and a category created mid-drag.

**A move that changes nothing writes nothing.** Most drags end where they started. Writing anyway fires `onDidChange`, which reposts and rebuilds the list under a pointer that has only just been let go of. The store compares the new array against the old one before it writes, and the probe counts emitter fires to prove it.

### The drag itself

Pointer events, not HTML5 drag-and-drop. `draggable="true"` on the row breaks mouse selection inside the name input sitting next to the grip, and the drop line has to be drawn by hand either way — so the handle takes a `pointerdown`, captures the pointer, and `dropAnchor()` walks the rows comparing `clientY` against each midpoint.

The row being dragged stays in that scan rather than being skipped. It still occupies its slot on screen, so the gaps the pointer is measured against are the ones the user can see. `isNoOpDrop()` then suppresses the line for the two positions the row is already in — on itself, and in front of the row that already follows it — so a line only ever appears where letting go actually moves something.

One case that only turned up when it was tested: **a click on the handle is not a drop at the end.** With no `pointermove`, the anchor is still `null`, and `null` means "the end of the list" — so a plain click sent a category to the bottom. The anchor now only counts once the pointer has been somewhere to be measured.

`render()` is held off while a drag is in flight, the same way it is held off mid-subtitle-edit — a repaint would rebuild the row the captured pointer is holding. Both routes out of a drag repaint on the way, so nothing stays stale.

### Keyboard

↑ and ↓ on a focused handle, which send the same "in front of that one" the drop line does rather than doing their own arithmetic. `preventDefault` and `stopPropagation` run before the bounds check, deliberately: the pane's global arrow keys walk the session list, and a handle at either end of the list leaking its arrow key would throw focus out of the panel entirely.

A keyboard move repaints the panel, which destroys the handle that has focus — the same trap group headings hit. `render()` reads the focused grip's category id before the teardown, the same line that already reads the focused group's, and `restoreGripFocus()` hands it back afterwards. Without it, the second ↓ in a run has nothing focused left to act on.

**Verified in the browser harness, not in a live VS Code window.** A real mouse drag through the harness emitted the right move; the drop-line placement, the no-op suppression, the escape and click-only exits, every keyboard case and the focus restoration were driven with scripted pointer and key events against the real compiled `view.js`. Reversing the stored order and rebuilding the harness confirmed both the group headings and the row menu follow it. VS Code's own webview host and screen-reader behaviour were not exercised.

## Dragging a chat into another group

The list is one flat run of `<li>`s — headings and rows in draw order — so a group owns everything from its own heading down to the next one. `groupUnder()` walks that run and returns the heading owning the first node whose bottom is past the pointer, which handles the pointer being on a heading, on a row, above the list or below the last row without any of them being special cases.

**The whole group lights up, not a line between two rows.** A chat goes *into* a category; where it lands inside one is the sort order's call, not the drop's. So there is no insertion point to draw, and a line would promise a precision the drop does not have.

**The tint is an overlay, not a background.** A row's background is already carrying its category wash, or its hover state, or its selection — three different things, and `color-mix` on top of any of them lands somewhere different each time. `.row[data-drop-into]::after` composites over whatever is there, so the drop target reads the same in all three.

Three places are not drop targets, and none of them highlights: the archived block (archiving is not a category, and it has its own menu entry), an archived row being dragged (it would land in a category it is not shown in), and the group the chat is already in. The `groupId` comparison folds the last one in with the pseudo-groups — a row with no `data-category` counts as `'uncategorised'`, and no real id can collide with that because they all come out of `makeId()` as `cat_<random>`.

### Not stealing the click

A row opens the chat when you click it, which is the whole point of the row, so a drag has to be able to prove it was not one. Two guards:

**A press only becomes a drag past 4px of travel.** Below that nothing happens at all — no capture, no chip, no listeners removed from anything — and the row's own click handler runs exactly as it did before.

**The click after a drop is swallowed.** The browser sends one whether or not you meant it, and over a heading that click would fold the group away — so the drop installs a one-shot capture-phase listener on the document and takes it back off on the next turn of the event loop, whether or not a click ever arrives.

### Why the listeners are on the document

`pointermove`, `pointerup` and `pointercancel` all go on the document rather than the row. A press that flicks straight off the row would otherwise never see its own `pointerup`, and the listeners would leak.

The pointer is captured, but **only once the drag is real** — not at `pointerdown`. Capturing retargets the compatibility mouse events too, and double-clicking a title to edit it goes through those. Capture is also wrapped in a `try`, because losing it costs the drag nothing inside the pane, which is where it happens, and is not worth taking the press down over.

### Autoscroll

A group off the bottom of the pane cannot be reached by the pointer alone, and a list long enough to want grouping is long enough to need this. A `requestAnimationFrame` loop reads the last known pointer position each frame and scrolls when it is within 36px of an edge. The repaint after each scroll is the part that is easy to miss: the rows have moved under a pointer that has not, so the drop target has changed even though nothing was moved.

### Empty categories

A category with no chats in it draws no group, so there is nowhere to drop one to put the first chat in it. That is deliberate rather than overlooked — revealing empty headings mid-drag would move the list under the pointer, which is worse than the dead end it fixes. The `⋯` menu assigns a category without needing one on screen.

**Verified in the browser harness, not in a live VS Code window.** Real mouse drags emitted the right assignment and left no state behind; a real click still opened the chat. Scripted pointer events covered every branch: onto a heading, onto a row in another group, onto the group it is already in, onto Uncategorised, onto Archived, escaped mid-drag, pressed without moving, moved under the threshold, and a row in an ungrouped list carrying no drag at all. The autoscroll was watched running the harness to the bottom of a 3,200px list. VS Code's own webview host and screen-reader behaviour were not exercised.

There is no probe for this one. Everything it decides — which group the pointer is in, whether that group can take the chat, how far to scroll — lives in `media/view.js` and reaches nothing a node script can require. What it ends up sending is `setCategory`, which is the same message the `⋯` menu has always sent.

## Icons

One source logo, three derivatives, built by `scripts/build-icons.ps1`:

| File | Size | Used for |
|---|---|---|
| `chat-tags.png` | 640 | The source. Not packaged. |
| `media/logo.png` | 640 | Repo and README. Not packaged. |
| `media/icon.png` | 256 | Marketplace listing |
| `media/activity.png` | 128 | Activity bar |

**The activity bar throws your colours away.** `toCompositeBarActionItem` in the workbench bundle builds a `-webkit-mask` rule for any container icon contributed as a file path, so only the alpha channel survives and the whole thing renders in one theme colour. Hand it the full-colour logo and you get a solid blob.

So the bar gets a version whose alpha traces the black linework and drops the gradient — the frames, the brim and the mouth stay, the lenses and face become holes. The script also writes `dev/activity-preview.png`, which composites that mask in white at 24px, 48px and 128px, because 24px is too small to judge any other way.

The source has a stray 25%-alpha purple line down column 535, full height, left behind by whatever drew it. Every derivative repairs it by interpolating the neighbouring columns. Fix it upstream and the repair becomes a no-op.

```bash
powershell -File scripts/build-icons.ps1
```

## Verifying without launching anything

Everything that doesn't need `vscode` is kept free of it on purpose, so it can be exercised from plain node against this machine's real session files.

The read model, URI round-trips and both sort orders:

```bash
npm run probe
```

The subtitle input — the last-exchange reader over every session on the machine, plus the answer-cleanup cases. `--verbose` prints what each session yields, `--prompt` prints what the model would actually be sent:

```bash
npm run probe:exchange
```

What the archive seed would take from VS Code's own store, across every workspace on the machine, plus the stale-page assertion:

```bash
npm run probe:archive
```

A forked session's giant single-line header, built as fixtures rather than depending on a fork existing on this machine — the big-header fallback, the adversarial content inside it, and that a small or genuinely corrupt header is left on the strict path untouched:

```bash
npm run probe:fork-header
```

What the tail scan reads a turn as, also from fixtures, because the two states worth checking cannot be found lying around on a disk — a chat is only parked on a confirmation while it is parked, and the burst of stale `value:4` records a reopened session emits is the thing most likely to be mistaken for one:

```bash
npm run probe:turn
```

What reordering a category does to the list, from a stubbed memento — the two directions a move can go, the four ways it can change nothing, and a pane a repaint behind the store:

```bash
npm run probe:order
```

The webview, outside VS Code. Inlines the real `media/view.css` and `media/view.js` into a two-theme harness:

```bash
node scripts/build-preview.mjs
```

The harness mirrors the provider's sort, because the provider sorts before posting and the view only groups. Change one and change the other, or the preview lies to you.

The README shot, six panes across both themes with every config surface open:

```bash
node scripts/build-screenshot.mjs
```

It renders the real `view.css` and `view.js` through headless Chrome rather than a hand-drawn mock, so the picture can't drift from what the extension actually paints. Both builders take their display text from `dev/screenshot-content.json` — edit that, not the scripts.

Two things it has to work around. Every pane runs its own copy of `view.js`, but `closePopovers()` and the document click listener are global, so an open menu gets torn down by the next pane that mounts — each one is lifted out as a static clone and put back at the end. And those clones live on `<body>`, outside any `.pane`, so they carry the theme variables themselves or they paint with no background at all.

## Permission level

Every session file carries the level its picker is set to. `inputState.permissionLevel` is in the `kind:0` header on all 61 sessions here, so `readFirstLine` already has it, and moving the picker mid-session writes `{"kind":1,"k":["inputState","permissionLevel"]}` — the same record shape as `inputText`, picked up in the pass `deltaScan` was already making. Neither costs a byte of extra I/O.

The delta half is not optional. Reading the header alone finds one non-default session out of 62; the patches take that to seven, because most of them were switched after the session started.

| Level | Picker calls it | Shown as |
|---|---|---|
| `default` | Default | Nothing. 55 of 62 sessions here, and a pill on every row is a pill nobody reads. |
| `assisted` | Assisted permissions | A quiet outlined pill. |
| `autoApprove` | **Allow all** | An amber pill. |
| `autopilot` | Autopilot (Preview) | An amber pill. |
| anything else | — | The raw value, in the quiet style. |

Labels come from the workbench's own strings, resolved out of `nls.messages.json` rather than guessed. `autoApprove` is the one that catches people: the picker calls it **Allow all**, so a pill reading "Auto-approve" would disagree with the thing the user actually clicked.

The loud/quiet split does **not** come from the `elevated` flag — `c7o()` sets that on all three non-default levels. It comes from the risk map beside it, which scores `assisted` 1 and the other two 2. That matches what they do: assisted puts an LLM judge in front of every tool call and only auto-runs what the judge approves, while the other two auto-approve everything.

That last row is deliberate. An unrecognised level is kept verbatim rather than folded into `default`, so a level added upstream shows up as an unfamiliar pill instead of silently reading as the safe one. The legacy spellings `manual` and `allowAll` are mapped, matching the workbench's own migration.

**The pill is what the next request will run as, not what past ones ran as.** One session here sits at `autopilot` while its only completed request ran at `default` — the picker moved afterwards. Per-request history lives at `requests[].modeInfo.permissionLevel`, and only 10 of 177 request records put it inside the 2 KB prefix cap: median offset 3227 bytes, worst 114 KB. Reading it for the list means reading whole request payloads, which is the exact thing the cap exists to prevent. If it is ever wanted, it belongs in `sessionContent.ts` on demand.

`npm run probe` prints the distribution, so a parse that stops finding levels is visible without opening VS Code.

### What the pill deliberately does not cover

The picker is one of several ways a session ends up auto-approving things, and it is the only one that reaches disk. Asked and answered, so nobody re-derives it:

| Action | Lands in | Readable |
|---|---|---|
| Picker → Allow all / Autopilot / Assisted | `inputState.permissionLevel` in the session file | Yes — this is the pill |
| **Allow All Commands in this Session** | `terminalChatService._sessionAutoApprovalEnabled`, an in-memory `Map` | No |
| **Allow `git …` in this Session** | `_sessionAutoApproveRules`, same story | No |
| Allow … in this Workspace / Always Allow | the `chat.tools.terminal.autoApprove` setting | Yes, but it is global rather than per-session |
| **Enable Auto Approve…** | `chat.tools.terminal.autoApprove.warningAccepted`, `StorageScope.APPLICATION` | By inspection, yes. Not from an extension, and one value for the whole install — see below |

The two session-scoped ones are in-memory only and go when the window reloads. That is deliberate on the workbench's part: `terminalChat.toolSessionMappings` is persisted through `_storageService.store` a few lines above them in the same class, and these two are not.

There is a trace after the event, and it is **one-way — do not build on it**. The confirmation writes its outcome into the request payload as `autoApproveInfo`, so `"All commands will be auto approved for this session"` is greppable, 13 occurrences across 8 sessions here. Nothing records the state being turned off:

- the Disable link runs `setChatSessionAutoApproval(resource, false)`, which only deletes a key from an in-memory `Map`
- tool invocations are appended and never rewritten. Across all 62 session files the only `kind:1` patches are token counts, `modelState`, `result`, `elapsedMs`, `followups`, `copilotCredits`, `outputBuffer`, `responseMarkdownInfo`, `contentReferences`, the `inputState` fields and `customTitle`. `autoApproveInfo` is not among them
- no retraction-shaped string appears in any session file
- the usual way out is a window reload, which clears the map and writes nothing

Reading the state back from later invocations does not save it. One session here has 94 terminal invocations after the marker and 78 session-approval hits, and that gap is explained equally well by commands matching a settings rule or being denied. A badge built on this would keep accusing a session you disabled weeks ago, with no way to clear it, which is worse than showing nothing.

The settings levers are the two-way ones: `chat.tools.terminal.enableAutoApprove` and the `chat.tools.terminal.autoApprove` rules are real configuration, readable live and reflecting an edit in both directions. They are window and user/workspace scoped, so they belong in the settings panel rather than on a row.

### Detecting live session approval

The one route the pill cannot see is "Allow All Commands in this Session", and on a machine where policy blocks the elevated picker levels it is the only route left. `ChatToolsAutoApprove: false` makes `t_e()` return false so the picker levels do nothing, while `ChatToolsTerminalEnableAutoApprove` stays true — and the session path checks only the latter:

```js
if (configurationService.getValue("chat.tools.terminal.enableAutoApprove") === true
    && e.chatSessionResource
    && terminalChatService.hasChatSessionAutoApproval(e.chatSessionResource)) { … }
```

`sessionLive.ts` reads it out of the file instead of the unreachable Map. Three things make that work:

**The marker is a command id, not a sentence.** `workbench.action.terminal.chat.disableSessionAutoApproval` is baked into the `autoApproveInfo` of every command that button auto-approves. The English text beside it is an nls entry and changes with the display language; the id does not. It appears in exactly the 8 sessions here that used the button and none of the other 54.

**Liveness comes from the activation baseline.** The workbench's map is per-window and the extension host restarts with the window, so anything written before this process started belongs to a window that is gone. The tracker records each file's size on the first pass without reading it, and only bytes appended after that can set the flag.

**The off-edge is an absence.** Clicking Disable writes nothing, but the next terminal command then records no marker, so a `run_in_terminal` with no marker ahead of it clears the flag. Both edges are observable inside one window's life. Of the 8 sessions here, 5 end approved and 3 end stopped, so the machine flips both ways on real data.

Two details the implementation depends on, both measured rather than assumed. The marker sits *before* the toolId of its own invocation — the interleaving reads `MMTMMT…`, two markers per command — so a toolId closes a window and is judged on what preceded it. And a single appended record holds up to 170 terminal invocations here, which is why the scan is an ordered pass over bytes rather than anything line-shaped.

Cost is the size of the delta, not the session: files are append-only, so the tracker keeps a byte offset and only advances it to a record boundary, leaving a half-written line to be re-read. Median append is 70 bytes, p90 12 KB, p99 317 KB, with one 23 MB outlier. Nothing is parsed and no content is extracted — it is a fixed-string search for two ids.

**That offset has to be counted in bytes.** The scan searches the raw buffer rather than a decoded string, and the reason is the offset it reports rather than the search itself. Decode first and every index becomes a character count, which runs short of the byte offset by one for each extra byte of every multi-byte character in the range — 28 of the 62 sessions here carry enough non-ASCII for that, the worst of them short by 15 KB across 50 MB. The next scan then resumes mid-record, short of where the last one stopped, and a resume that lands between a marker and the command it approved sees that command with no marker ahead of it, which clears the flag on a session still approving. Both patterns are ASCII, so a byte search finds exactly what a text search finds, and the index it yields is already a seek position.

Known limits, all accepted:

- clicking Disable and running nothing further leaves the pill up until the next command or a reload. It over-warns, which is the right direction for a safety badge
- a session approved in another window flags here too. It genuinely is auto-approving, just not in this window's map
- with no policy in the way, an elevated picker level filters the session analyzer out entirely (`Si = it ? analyzers.filter(z => !(z instanceof ZEe)) : analyzers`), so the marker never appears. The permission pill covers that case, which is why the two indicators are complementary rather than redundant

`npm run probe` reports the distribution. It scans from the top rather than from a baseline, so it reports history rather than liveness — enough to prove the marker still parses out of real files. It also replays every marker-carrying session as seven appends, resuming each time from the offset the previous scan returned, and asserts that each of those offsets sits immediately after a newline. The assertion is the half that bites. A drifting offset only flips a verdict when it happens to land between a marker and its command, so the replay on its own passed for a while against offsets that were wrong on 28 of the 62 files here.

### Retrieving warningAccepted anyway

It can be read, read-only, two ways — worth writing down because "you can't get it" is wrong and someone will find it:

| Path | What is there |
|---|---|
| `globalStorage/state.vscdb` | the SQLite table leaf stores the key immediately followed by its value, so a byte scan finds `…warningAccepted` then `true` |
| `sync/globalState/lastSyncglobalState.json` | plain JSON: `{"version":1,"value":"true","scope":0}` |

Neither belongs in the extension, and the reason is the value rather than the file. It is application-scoped, so every row in the list reads the same thing and it cannot tell one session from another — a badge that says the same word about all 600 of your chats is wallpaper. The archive seed does now read `state.vscdb`, so the file itself is no longer the objection; what still applies there applies here too, that a byte scan of a live database is at the mercy of page moves and a `-wal` that may hold a newer value. The sync file exists only with Settings Sync switched on and caches the last sync rather than the present.

There is a trap in searching session files for the string. It matches chats that merely *discuss* the flag. Two sessions here contain it: one has 32 hits and genuine approval markers, the other has a single hit inside a PowerShell command typed while researching it and no approval anywhere. The string tracks who typed the flag name, not the state — the per-session evidence is `autoApproveInfo`, and that is the one-way trace above.

`enableAutoApprove` is **not** a readable stand-in for `warningAccepted`, tempting as it looks. Whether the terminal tool may auto-approve is an `AND` of three things — the tool being eligible, `enableAutoApprove === true`, and `warningAccepted` — and only the middle one is reachable from an extension. The config-change listener runs one way: setting `enableAutoApprove` to anything but `true` deletes `warningAccepted`, and nothing sets it. So `false` proves auto-approve is off, while `true` proves nothing at all. Since the setting is registered `default: true`, `true` is also what almost every machine reports. The negative is provable and the positive never is, which is the wrong way round for a warning.

## Turn state

Whether a chat is working, waiting on you, or finished. The workbench knows exactly — `ChatModel` carries `requestInProgress`, `hasActiveRequest` and `requestNeedsInput` as observables, and its agents status bar badges them as **in progress** and **needs input** — but all three live in memory behind `IChatService`, and nothing projects them out. The one place they surface as data is the voice agent's `get_session_info` tool dispatcher, which is an internal switch rather than anything registered with `vscode.lm`.

So it comes off the file, from four record shapes.

### The records

A turn opens with a bare append to the requests array and closes when its result is written:

```
{"kind":2,"k":["requests"],"v":[…]}                     turn N opens
{"kind":1,"k":["requests",N,"result"],"v":{…}}          turn N closes
{"kind":1,"k":["requests",N,"modelState"],"v":{"value":X}}
```

`modelState` is `ChatResponseModel._modelState`, and the values are pinned by the workbench's own accessors — `isComplete` is `value !== 0 && value !== 4`, `isCanceled` is `value === 2`, and the pending-confirmation observer does `_modelState.set({value: 4})` on the way in and `{value: 0}` on the way out:

| value | meaning |
|---|---|
| 0 | running |
| 1 | completed |
| 2 | cancelled |
| 3 | errored |
| 4 | parked on a confirmation — `requestNeedsInput` |

**Only the patch log carries 0 and 4.** `toJSON()` rewrites both to `{value: 2, completedAt: now}`, so anything reading a serialised session sees every unfinished turn as cancelled. Across the sessions here the log holds 47 fours and 30 zeros; the headers hold none.

There is no other route to "waiting". A tool call sitting on an approval prompt writes nothing of its own — all 15,417 `toolInvocationSerialized` parts on this machine are `isComplete: true`, so the invocation only reaches disk once it has already run.

### The state machine

Every turn on disk has the same shape:

```
APPEND   [N:modelState{4}  N:modelState{0}]*   N:result   N:modelState{1|2|3}
```

so the scan arms on an append, disarms on a result or a terminal state, and only lets a `modelState` speak while armed.

That guard is not tidiness. **Reopening an old session re-emits `value:4` for turns that closed hours ago** — `isPendingConfirmation` reads `!isUsed` on confirmation parts, and a "Continue to iterate?" widget nobody ever clicked stays unused forever. The largest session here emitted seven of them in one burst on reload, plus a re-written result for an older index. Every one of them lands *after* its own result, which is the only thing separating them from a live confirmation, and the arming rule is what throws them out.

### Byte needles, not a parse

The scan shares `scanTail` with the auto-approval reading — one pass over the appended bytes, five fixed strings, nothing decoded. That is the same argument the approval section makes about byte offsets, and it now carries a second reading on the same offsets.

Three of the needles are new:

```
{"kind":2,"k":["requests"],
,"result"],"v":
,"modelState"],"v":{"value":
```

None can appear inside a payload, because every quote in a JSON string is escaped and all three carry bare ones. That is an argument, so `npm run probe` measures it instead: it counts each needle raw and again from a parsed pass over record heads, across every session on the machine. Currently 208 appends, 192 results and 264 model states, all three agreeing exactly over 132 MB.

The model state is the one needle whose meaning is the byte *after* it, which makes it the one a chunk boundary can cut in half. A match whose digit falls off the end of the chunk is dropped rather than guessed at, and `scannedTo` is left alone so the overlap finds the whole thing next pass. `probe:turn` places a record so its digit is the first byte of chunk two and checks the answer survives; removing the guard fails exactly that assertion and nothing else.

### Live, versus merely open

A turn stays open forever if the window that opened it went away — the result that would have closed it never gets written. Fifteen sessions on this disk are sitting like that, and `npm run probe` prints the youngest, currently sixty hours stale.

So `sessionsView` only reads a turn as live when the file has also moved inside `chatTags.recentMinutes`. That knob rather than `activeSeconds`, because a single long tool call can leave a genuinely working chat silent for minutes and a row that stops pulsing halfway through a build is worse than one that keeps going a little long.

### What the seed does and doesn't buy

The approval reading baselines at activation and reads nothing behind it, because the workbench's approval map is per-window. Turn state is the opposite: a turn open when the extension host started is a fact about the window we are in.

So the first pass reads the last 256 KB of each file and keeps only the turn state out of it — the offset still lands at the end, so those history bytes never reach the approval reading. Truncation can only ever make the machine say less: starting mid-file leaves it unarmed, and unarmed means unknown, which is the behaviour there was before any of this.

## Navigation spike

Set `CHAT_TAGS_SPIKE_OUT` to a file path and the extension walks both ladders headlessly, writes a JSON report and closes the window.

```bash
CHAT_TAGS_SPIKE_OUT=/tmp/spike.json code --extensionDevelopmentPath="D:\Code\vscode-chat-tags" --new-window
```

Give it the absolute path. With VS Code already running, the CLI hands your arguments to that instance and a relative `--extensionDevelopmentPath=.` resolves against its working directory rather than yours — the report then comes from whichever copy of the extension is installed, which reads as a clean run and tells you nothing about your build. The give-away is a report missing keys your source writes. A forwarded launch can drop `--folder-uri` too, so check `workspaceSource` in the report before believing a run covered workspace sessions.

Every rung is judged on whether an editor tab actually appeared. A command that doesn't throw hasn't necessarily done anything, and this is the whole reason the spike exists.

The new-chat ladder needs a second measure, because only its first rung lands a tab:

| Verdict | Meaning |
|---|---|
| `opened` | A tab appeared — the evidence the open rungs are held to. |
| `reachable` | The ids exist and invoking them didn't throw. All a panel-only rung can show from out here. |
| `no-op` | Resolved and left nothing behind. The silent break this file exists for. |
| `threw` | Registered, and rejected the call. |
| `missing` | An id has gone. The report lists the registered ids sharing its prefix, since a rename is likelier than a deletion. |

The verdict is read off the top rung alone. `newSession` stops at the first command that doesn't throw, so a rung 1 that resolves and does nothing reports success while the fallbacks below it never run.

## Still open

Activity decay works, but `chatTags.activeSeconds` and `chatTags.recentMinutes` were picked by eye rather than by watching real usage. If a row reads as "active" when it plainly isn't, that's the knob. `recentMinutes` now does a second job as the cutoff between a turn in flight and one a dead window left open, and that side of it has three orders of magnitude of headroom on this machine — so if the two uses ever want different numbers, this is the one to split.

The rename route has been read out of the 1.135.0 bundle and not yet watched in a live window. The argument shape, the prefill and the branch it takes are all verified against the shipped code; that the box appears where it should and the tab relabels behind it is still an inference.

## House rules

- Comment the **why**, never the what. If the function name says it, don't.
- Lowercase comments, one line each, no docstring blocks.
- Section headers use the em-dash ruler: `// ── section name ─────────────────`
- Name the specific constraint: `// the iconic puts data-track-affiliation on the card div itself`, not `// check the element type`.
- Verify, don't assert. Anything non-obvious gets checked against the shipped `vscode.d.ts`, the minified workbench bundle, or a live run — and the README or this file records what was found, so nobody re-derives it in six months.
- When something has only been checked in the harness and not in VS Code, say so out loud rather than letting a green harness pass for a green product.
