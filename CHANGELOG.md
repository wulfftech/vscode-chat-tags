# Changelog

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
