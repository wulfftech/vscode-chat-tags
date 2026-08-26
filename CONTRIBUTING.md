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

## Opening a session

There's no public API for "open this chat session". Three ways work, tried in order:

| Rung | Mechanism | Risk |
|---|---|---|
| 1 | `vscode.open` on the session URI | Public, documented. |
| 2 | `openSessionInEditorGroup` with `{ resource }` | Internal action, but no internal constants. |
| 3 | Same command with a marshalled `$mid` context | `$mid` is a `const enum` inlined at compile time. Shifts if upstream inserts a member above it. |

All three opened a real chat editor tab on 1.134.0. Rung 1 being public is the reason this isn't fragile. `openSession` reports which rung worked, so a break shows up in the log instead of silently.

Session URIs are `vscode-chat-session://local/<base64url(sessionId)>` — url-safe, unpadded, session type as the authority.

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
| User message recovered | 22 of 23 |
| Assistant prose recovered | 12 of 23 |
| Failures | 0 |

Two things had to be thrown out. `@agent Try Again` writes a real request record carrying no intent whatsoever, and it was the newest request in eight of those 23 sessions — the reader walks back up to ten records looking for something a person actually typed. Terminal notifications arrive as ordinary requests and `isSystemInitiated` is set on some and not others, so the text gets trusted, not the flag.

Assistant prose is the part with no `kind` discriminator at all — a bare serialised `MarkdownString` sitting among `toolInvocationSerialized` and `thinking` parts. A turn that ends on tool calls has no prose of its own, which is why 12 of 23 is the real number and not a bug. When an index has none the reader falls back to the previous one; the last sentence the assistant wrote still describes where the session is.

Reaching the fifth opening message is not the cheap end of the file it sounds like. Response records sit between request appends, so the fifth request landed anywhere from 0.1% to 98.5% of the way through. The scan stops the moment it has enough, which is the difference between reading 68 KB and reading 50 MB.

| | |
|---|---|
| Opening messages recovered | 23 of 23 |
| Opening scan time | 87 ms over 85 MB |

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

## Navigation spike

Set `CHAT_TAGS_SPIKE_OUT` to a file path and the extension runs all three open rungs headlessly, writes a JSON report and closes the window.

Each rung is judged on whether an editor tab actually appeared. A command that doesn't throw hasn't necessarily done anything, and this is the whole reason the spike exists.

## Still open

Activity decay works, but `chatTags.activeSeconds` and `chatTags.recentMinutes` were picked by eye rather than by watching real usage. If a row reads as "active" when it plainly isn't, that's the knob.

## House rules

- Comment the **why**, never the what. If the function name says it, don't.
- Lowercase comments, one line each, no docstring blocks.
- Section headers use the em-dash ruler: `// ── section name ─────────────────`
- Name the specific constraint: `// the iconic puts data-track-affiliation on the card div itself`, not `// check the element type`.
- Verify, don't assert. Anything non-obvious gets checked against the shipped `vscode.d.ts`, the minified workbench bundle, or a live run — and the README or this file records what was found, so nobody re-derives it in six months.
- When something has only been checked in the harness and not in VS Code, say so out loud rather than letting a green harness pass for a green product.
