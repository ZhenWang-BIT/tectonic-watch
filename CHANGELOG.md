# Changelog

## 0.2.0

First public release.

- Jump from the PDF to the exact word in the source (double-click or Cmd/Ctrl+click), not just the line.
- Start/stop button in the editor title; the extension no longer starts by itself (`tectonicWatch.autoStart` restores that).
- Prewarming: a tectonic process reads the preamble ahead of time and waits, so a change only typesets the body.
- Change-triggered builds run TeX once and settle automatically when cross-references, table of contents or bibliography change.
- A save in VS Code builds immediately, without waiting for the file watcher.
- After a build the preview scrolls to the change (`tectonicWatch.syncAfterBuild`).
- ctex documents are built with the fandol fonts only by default; rebuilding with the document fonts after idle is optional (`tectonicWatch.finalBuild`).
- Draft-font PDFs use the lowest compression level.
- The preview is re-sent the PDF when its page reloads (e.g. after being moved to its own window).

## 0.1.0

Initial version: watch tex files, build with tectonic, preview inside VS Code with SyncTeX jumps and draft fonts.
