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

`sessionApproval.ts` reads it out of the file instead of the unreachable Map. Three things make that work:

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

Neither belongs in the extension. The value is application-scoped, so every row in the list reads the same thing and it cannot tell one session from another. `state.vscdb` is the file this project already refuses to touch behind the workbench's back, and a byte scan of a live database is at the mercy of page moves and a `-wal` that may hold a newer value. The sync file exists only with Settings Sync switched on and caches the last sync rather than the present.

There is a trap in searching session files for the string. It matches chats that merely *discuss* the flag. Two sessions here contain it: one has 32 hits and genuine approval markers, the other has a single hit inside a PowerShell command typed while researching it and no approval anywhere. The string tracks who typed the flag name, not the state — the per-session evidence is `autoApproveInfo`, and that is the one-way trace above.

`enableAutoApprove` is **not** a readable stand-in for `warningAccepted`, tempting as it looks. Whether the terminal tool may auto-approve is an `AND` of three things — the tool being eligible, `enableAutoApprove === true`, and `warningAccepted` — and only the middle one is reachable from an extension. The config-change listener runs one way: setting `enableAutoApprove` to anything but `true` deletes `warningAccepted`, and nothing sets it. So `false` proves auto-approve is off, while `true` proves nothing at all. Since the setting is registered `default: true`, `true` is also what almost every machine reports. The negative is provable and the positive never is, which is the wrong way round for a warning.

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

Activity decay works, but `chatTags.activeSeconds` and `chatTags.recentMinutes` were picked by eye rather than by watching real usage. If a row reads as "active" when it plainly isn't, that's the knob.

## House rules

- Comment the **why**, never the what. If the function name says it, don't.
- Lowercase comments, one line each, no docstring blocks.
- Section headers use the em-dash ruler: `// ── section name ─────────────────`
- Name the specific constraint: `// the iconic puts data-track-affiliation on the card div itself`, not `// check the element type`.
- Verify, don't assert. Anything non-obvious gets checked against the shipped `vscode.d.ts`, the minified workbench bundle, or a live run — and the README or this file records what was found, so nobody re-derives it in six months.
- When something has only been checked in the harness and not in VS Code, say so out loud rather than letting a green harness pass for a green product.
