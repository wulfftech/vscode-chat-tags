# Changelog

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
