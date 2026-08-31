# Changelog

## 0.15.0

- A chat that is mid-answer now reads as busy instead of as unread. Every write an agent makes to its session file used to land as "something happened here", so a chat doing exactly what you asked sat there lit like it needed rescuing. It gets the one signal nothing else in the pane uses — the dot hollows to a ring and breathes — and none of the ones that mean it wants you.
- A chat parked on a confirmation says so, with a **Needs input** pill. That is VS Code's own reading, the same state behind the **Needs Input** badge on its agents status bar, taken out of the session file rather than guessed at from timing.
- Neither state is a timer. A turn is open from the moment its request is appended until its result is written, and a window closed mid-answer never writes that result — so a turn only reads as live while the file is still moving. Fifteen chats on this machine are sitting open from windows that are long gone.
- **Rename in VS Code…** on the row menu. Chat Tags titles are drawn over the list and the editor tab has never seen them, because a tab's label comes from the chat's own title and no API lets one extension relabel another's editor — reopening the tab just reads the old name back. This opens VS Code's own rename box with the Chat Tags title already filled in, so one Enter puts it where the tab, the native list and the session file all read from. The pane then drops its own copy, since the two now agree.
- Categories can be reordered. Each row in the **Categories** panel has a handle: drag it, or focus it and use ↑ and ↓, and a line shows the gap the row is about to land in. That order is the order the groups come out in when grouping is on, and the order every `⋯` menu lists them, so the categories you reach for most can sit at the top of both. It sticks between windows like the rest of a category.
- The README shot was painting the **Autopilot**, **Allow all** and **Auto-approving** pills focus-blue while the extension paints them amber. The builder was missing two theme colours the harness already had.

## 0.14.0

- A category heading can be collapsed, folding its rows out of the way until you open it again. Uncategorised and Archived collapse the same way, and it sticks between windows like every other category setting.

## 0.13.0

- A forked chat now shows up. VS Code writes a fork as one giant header line holding the whole cloned conversation, rather than the near-empty stub every other chat starts from, and once that line ran past this pane's read limit the session came back reporting no title and no messages — indistinguishable from one you'd opened and never used, so it never made the list at all. A session that still can't be read after this leaves a line in Show Log instead of vanishing without a trace.
- Chats you archived in VS Code's own chat view show as archived here. The two archives were separate stores that never reconciled — VS Code keeps its own, scoped to one workspace, and this pane keeps a flag of its own — so a machine that had done its archiving over there saw every one of those chats sitting live in the list. On a large store that is hundreds of rows you thought you had put away.
- Taking it runs one way and once per chat, so archiving or restoring something here afterwards is never undone by a later read. Nothing is written back to VS Code, which has no archive API for an extension to write to in any case.

## 0.12.1

- Fixed the pane taking the whole extension host down on a large chat history. With a few hundred sessions on disk it re-read every one of them every time a live chat wrote a line, and each read decoded megabytes of chat payload into strings just to find the end of a record. The same work now takes an eighth of the memory and an eighth of the time, and an active chat no longer sets off a fresh read of everything you own.
- Chats whose opening record runs long were reporting the wrong message count, and some were showing the wrong permission pill or none at all. One chat here claimed to hold nothing while holding seven messages, with its **Autopilot** pill missing the entire time.
- Titles containing an em-dash or an accented character come back intact instead of mangled.
- The **Auto-approving** pill stays up on a chat that is still auto-approving. It could previously clear itself while the chat carried on running commands unattended, which is the wrong way for a safety badge to fail.

## 0.12.0

- **+** opens a new chat as an editor tab again, where `chatTags.openTarget` puts a clicked one. It had been landing in the chat view instead. The command it relied on has no registration: VS Code only ever creates that id for contributed session types, and the plain local chat isn't one, so the button had been quietly falling through to a fallback since the day it shipped.
- A chat that isn't on the default permission level gets a pill beside its title — **Assisted**, **Allow all** or **Autopilot**. Nothing shows on default, because a badge on every row is wallpaper. It's read out of the session file, so it's right for chats you set months ago and haven't opened since.
- A second pill, **Auto-approving**, for a chat running commands unattended off the back of **Allow All Commands in this Session**. VS Code keeps that state nowhere at all — it lives in memory and nothing on disk says it was switched off — so this works it out from what the chat actually does. A command that ran without asking puts the pill up, the next one that had to ask takes it down.
- That second pill matters most on a locked-down machine. If policy blocks the auto-approve permission levels, that button is the only route left, and this is the only warning you get.

## 0.11.1

- A chat started from **+** takes the selection in the list as soon as it appears, so the row matches the chat you are looking at. Open something else while you type and it leaves your selection alone.
- Documented the thing that makes the **+** look broken: a new chat joins the list when you send its first message. VS Code writes nothing to disk before that, and this pane reads files off disk.

## 0.11.0

- **+** in the pane header starts a new chat, landing wherever `chatTags.openTarget` says a clicked one would.
- Credentials are masked before a prompt reaches the model provider. One real session held a live vault token in its tool activity and a password as its last request, and both were going out verbatim.
- A subtitle remembers whether it is a status line or a task line, so the automatic sweep regenerates what the session was given rather than whatever `chatTags.subtitleMode` says today.
- Boilerplate stays out of prompts. The walk-back used to fall back to the newest record when it found nothing substantive, which reinstated the `@agent Try Again` it had just skipped — five of 23 sessions were sending exactly that.
- Bare acknowledgements like `cool` join the boilerplate filter, and the status prompt gained a finished-state example so a completed session stops coming back described by its topic.
- Relicensed to GPL-3.0-or-later.

## 0.10.0

First release. Colours, categories, subtitles, archive, delete, sort and grouping, generated titles and subtitles.
