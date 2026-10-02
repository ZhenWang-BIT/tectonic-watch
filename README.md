# Tectonic Watch

Write LaTeX in VS Code: every time a file changes on disk it is built with [tectonic](https://tectonic-typesetting.github.io), and the PDF refreshes in place in a preview next to the editor.

It does three things only: build, preview, and jump between source and PDF. No completion, snippets or linting. The extension code is about 32 KB; its only dependency is pdf.js (with the CJK character maps it reads on demand, the package is about 2 MB).

## Status

This is a personal tool that I use daily, published as is.

- **Verified only on macOS (Apple Silicon) with tectonic 0.17.0.** Linux should work but the prewarming path has not been run there. On Windows prewarming is disabled automatically and the rest is untested.
- **Prewarming relies on tectonic behaviour that is not documented**: blocking on a named pipe, a failed seek on that pipe being non-fatal, and the semantics of `--reruns 0`. A tectonic update may break it. If builds start failing, set `"tectonicWatch.prewarm": false`.
- **The draft-font switch relies on a ctex internal variable** and may silently stop working after a ctex update. `"tectonicWatch.draftFonts": false` turns it off.
- **For ctex documents the PDF written to disk is not in the document's fonts by default.** It is built with the fandol fonts at a low compression level, because that is several times faster. See [Draft fonts](#draft-fonts) for how to get the document's own fonts.

## Why not LaTeX Workshop

- **It does not only react to saves in VS Code.** It watches files on disk. A save in VS Code, an AI tool such as Claude Code editing files, a script rewriting them, `git checkout` -- all trigger a build.
- **Light.** No TeX Live; tectonic downloads packages on demand.
- **Refreshing does not interrupt reading.** The new version is drawn first and then swapped in, at the same page and position.
- **Fast.** A prewarmed tectonic process and single-pass builds bring a 20-30 page paper down to 0.3-0.7 s from save to PDF. See [Build speed](#build-speed).

## Install

1. Install tectonic:

   ```bash
   brew install tectonic        # macOS
   ```

   For other systems see the [tectonic install guide](https://tectonic-typesetting.github.io/en-US/install.html).

2. Install the extension. Download the `.vsix` from the [releases page](https://github.com/ZhenWang-BIT/tectonic-watch/releases), or build it yourself (see [Development](#development)), then:

   ```bash
   code --install-extension tectonic-watch-0.2.0.vsix
   ```

   and run `Developer: Reload Window` in VS Code.

3. If LaTeX Workshop is installed, consider disabling it so that it does not also build on save and take the same keybinding:

   ```bash
   code --disable-extension james-yu.latex-workshop
   ```

## Quick start

1. Open a folder containing `.tex` files in VS Code.
2. Open a tex file and click the start button (▷) at the top right of the editor. The extension builds once, opens the PDF preview beside the editor, and starts watching for changes.
3. From then on the preview refreshes on every change.

The extension does not start by itself: after opening a project the status bar shows `Tectonic: stopped`, and building and watching begin only once you click start. To start automatically when a project is opened, set `"tectonicWatch.autoStart": true`. If the preview was open when the window was closed, it is restored with the window and watching continues.

After a successful build the preview scrolls to the place you just changed and highlights it. For a save in the editor that is the cursor line; for a file changed by an external tool (an AI tool, say) it is the first changed line. The preview does not move when the change is already in view. Turn this off with `"tectonicWatch.syncAfterBuild": false`.

The status bar shows the build state: `Building`, `Built` or `Draft fonts` (hover for the time taken), `Build failed`. Click it to see the full build output.

When a build fails, the preview keeps the previous PDF and shows a red notice at the top. Errors and warnings go to the Problems panel (Cmd+Shift+M); clicking one jumps to the offending line, including lines in sub-files.

## In the preview

| Action | Effect |
|---|---|
| Double-click, or Cmd+click (Ctrl+click on Windows/Linux) | Jump to the clicked word in the source and select it |
| Select text | It can be copied |
| Cmd+F | Search the text of the preview |
| Cmd+wheel, trackpad pinch | Zoom |
| `−` `Fit width` `+` at the top right | Zoom; the page number is on the right |

The toolbar at the top right is translucent until the mouse moves over it.

How jumping to a word works: SyncTeX data only records line numbers, so the extension takes the run of PDF text under the click and matches it against that source line (and the three lines either side) to find the column. Text produced by macros, equations, running heads and cross-reference numbers has no identical text in the source; in those cases the cursor lands next to the nearest word that does match, or at the start of the line.

## In the editor

| Action | Effect |
|---|---|
| Cmd+Alt+J (Ctrl+Alt+J on Windows/Linux), or "Show Current Line in PDF" in the context menu | The preview scrolls to the position of the cursor line and flashes a yellow highlight |
| Edit and save | After the build the preview scrolls to the change and highlights it, unless it is already in view |
| Start button (▷) at the top right of a tex editor | Start: build once, open the preview, watch for changes |
| Preview icon and stop button (□) at the top right, once started | Open the PDF preview; stop watching |

Type `Tectonic` in the command palette (Cmd+Shift+P):

| Command | What it does |
|---|---|
| Tectonic: Build Now (full build with the document fonts) | One full build with the document's own fonts, not the draft fonts |
| Tectonic: Start Watching and Preview | Same as the start button |
| Tectonic: Stop Watching | Same as the stop button; the preview stays but no longer refreshes |
| Tectonic: Start/Stop Watching | Toggles between the two, handy for a keybinding |
| Tectonic: Open PDF Preview | Opens the preview; builds first if there is no PDF yet |
| Tectonic: Show Current Line in PDF | Same as Cmd+Alt+J |
| Tectonic: Show Build Output | The full output of tectonic |

Note: clicking a `.pdf` file in the explorer opens VS Code's default PDF viewer (or another PDF extension), not this extension's preview.

## Multi-file projects

The main file to build is chosen in this order:

1. `tectonicWatch.mainFile` in the settings.
2. If the changed sub-file starts with `% !TEX root = ../main.tex`, the file it names.
3. If the changed file itself contains `\documentclass`, that file.
4. The main file built last time.
5. The main file that contains the changed file: the changed file is under the main file's directory, or was `\input` by it.

A line like this at the top of each sub-file is recommended:

```latex
% !TEX root = ../main.tex
```

**Which changes trigger a build:** every file under the main file's directory; files outside it that the main file `\input`s; `.bib`, `.sty` and `.cls` files in the same workspace (a shared `../refs.bib`, for example). Changes that do not affect the output, such as editing a comment, are built too, but the preview is not refreshed when the PDF is unchanged. Writes that do not change the content (re-saving, `touch`) do not trigger a build.

## Output directory

Output goes next to the main file by default. To put it in `build/`, add this to the project's `.vscode/settings.json`:

```json
{
  "tectonicWatch.extraArgs": ["--outdir", "build"]
}
```

The directory is created if it does not exist. The PDF, SyncTeX data, log and `.aux` are all written there.

## Build speed

Time from an edit to the new PDF on screen = debounce (100 ms by default; skipped for a save in VS Code) + the tectonic build + rendering in the preview (about 0.1 s). The build dominates, and this is what the extension does about it:

- **Prewarming** (`tectonicWatch.prewarm`, on by default). Every build reloads packages and fonts; an empty ctex document alone takes 0.4-0.5 s. The extension starts a tectonic process ahead of time, lets it read the preamble and wait just before `\begin{document}`; when a file changes, the body is handed to it and typesetting continues.
- **Running TeX once** (`tectonicWatch.reuseAux`, on by default). A change-triggered build reuses the previous `.aux`, runs a single pass and shows the result right away. For documents with a bibliography tectonic runs two passes every time by default. If the single pass changes intermediate files such as `.aux`, `.toc` or `.bbl` (a new citation, a changed heading), the extension runs further passes automatically until they stop changing, so the final result equals a full run.
- **A new change interrupts the old build.** If files change during a build, it is killed and a new one starts from the latest content.
- **No build when the content is unchanged; no refresh when the PDF is unchanged.**

Measured time from a save in VS Code to the new PDF being written (M1 Max, all documents with a bibliography):

| Document | Plain tectonic build | This extension |
|---|---|---|
| 19-page Chinese paper (ctex, two columns, 10 PDF figures) | 2.7 s | 0.7 s |
| 32-page Chinese document (ctex, no figures) | 1.3 s | 0.4 s |
| 18-page English document (article) | 0.6 s | 0.27 s |

A file changed by an external tool (not through a save in VS Code) takes about 0.15 s more, for the file watcher and the debounce.

Details of prewarming:

- When the preamble changes, or a file the preamble reads (`.sty`, `.cls`, files `\input` in the preamble), the prewarmed process is discarded, that one build runs from scratch, and things return to normal afterwards.
- A prewarmed process takes memory, so it only exists while it is useful. One stays resident while you edit, about 200-230 MB. Roughly 190 MB of that is the XeTeX engine itself (internal arrays allocated at a fixed size at startup, plus the LaTeX format file), independent of the document; an empty document costs the same.
- For a ctex document with `finalBuild` on there is a second one for the after-idle final build, loading the system fonts, at about 900 MB. The Chinese fonts shipped with macOS are large font collections (Songti 64 MB, Kaiti 101 MB), and tectonic reads the whole file into memory once for every face it uses (regular, bold, ...). It is prepared when a draft build finishes and not replaced once the final build has used it. It does not exist with the default settings.
- After 5 minutes without changes (`tectonicWatch.prewarmIdleMinutes`) all of them are released; they are prepared again as soon as you type in a tex file, usually in time for the save.
- To turn it off altogether, set `"tectonicWatch.prewarm": false`.
- It needs named pipes, so macOS and Linux only; on Windows builds simply run from scratch. Projects using `-Z shell-escape` are not prewarmed.
- The mechanism is described at the top of `src/warm.ts`. It can only wait at one place, `\begin{document}`; the body is still typeset from the start every time, so the longer the document, the smaller the share saved.

### Draft fonts

**Draft fonts (on by default): ctex documents are built with the fandol fonts.** The Chinese system fonts on macOS (`fontset=mac` in `ctexart`) are font collections of tens to over a hundred MB. Every build has to locate and load them, and subset them when writing the PDF, which is slow and memory-hungry. fandol is the open-source Chinese font family that ships with TeX and is far smaller. The 19-page paper above, one build from scratch:

| Fonts | Build | Process memory |
|---|---|---|
| `fontset=mac` (Songti, Kaiti, Heiti and other system fonts) | 6.3 s | about 900 MB |
| `fontset=fandol` | 1.2 s | about 220 MB |

So by default the extension uses fandol only: both the preview and the PDF written to disk are in fandol, and the preview shows a yellow `Draft fonts` tag at the top right.

**The document does not need to change.** When building, the extension lets tectonic find its own `ctexopts.cfg` first, which switches ctex's `fontset` to fandol. Running tectonic yourself in a terminal is unaffected and still uses the fonts the document asks for. This only applies to ctex documents (`ctexart`, `ctexbook`, `\usepackage{ctex}` and so on); documents that do not use ctex, or already use fandol, are recognised automatically.

**When you need the document's own fonts**, there are two ways:

- Run "Tectonic: Build Now" for one full build with the document fonts. The next change goes back to fandol.
- Set `"tectonicWatch.finalBuild": true`: 3 seconds after you stop editing (`tectonicWatch.finalBuildDelayMs`) the document is rebuilt with its own fonts, the preview switches to the final result and the tag disappears. The price is the time and memory in the table above: while you type continuously there is one more prewarmed process of about 900 MB.

The glyph shapes differ between the two font sets, but CJK characters are all full-width squares, so the layout moves very little; page breaks differ by a line or two in a few places at most.

fandol only covers common characters. Rarer ones, such as some characters used in personal names, are often missing and show as a box or blank in the PDF. Missing characters are listed in the Problems panel. With `finalBuild` on, a missing character triggers an immediate rebuild with the document fonts.

Draft-font PDFs also use the lowest compression level. For documents with many figures most of the PDF generation time goes into compression: for the paper above this step drops from 0.9 s to 0.3 s, and the file is about 10% larger. Builds with the document fonts keep the default compression.

To not use fandol at all, set `"tectonicWatch.draftFonts": false`; every build then uses the document fonts.

**Skipping slow parts in draft builds.** During a draft build the extension defines the macro `\TectonicWatchDraft`; it does not exist in final builds or command-line builds. A document can use it to switch to something faster in drafts, for example pre-rendered figure PDFs instead of typesetting TikZ:

```latex
\newcommand{\figbody}[1]{%
  \ifdefined\TectonicWatchDraft
    \IfFileExists{build/figs-draft/#1.pdf}
      {\includegraphics{build/figs-draft/#1.pdf}}
      {\input{figs/#1.tex}}%
  \else
    \input{figs/#1.tex}%
  \fi}
```

The pre-rendered PDFs must be built with the same font size and line spacing as the text (`standalone` class, `border=0pt`) so that they have the same dimensions as the typeset figures and the page breaks agree. Measured on a 15-page document with 6 TikZ figures, the draft build drops from 0.75 s to 0.58 s. If a figure's source changes and its PDF is not regenerated, the draft shows the old figure.

**Building as you type.** Let VS Code save automatically shortly after you stop typing, and that triggers the build. In the settings:

```json
"[latex]": {
  "files.autoSave": "afterDelay"
},
"files.autoSaveDelay": 300
```

This saves 0.3 s after you stop typing, and the result is on screen in under a second.

**It cannot be as instant as Markdown.** A Markdown preview only turns text into a web page, which takes milliseconds. LaTeX re-typesets the whole document and writes a PDF every time. Prewarming only removes the loading of packages and fonts; the body cannot be continued from the point of the change (that would need changes to the TeX engine itself), so about 0.3-0.4 s for a 20-30 page document is the floor for this approach.

## Settings

| Setting | Default | Description |
|---|---|---|
| `tectonicWatch.autoStart` | `false` | Start automatically when a project containing tex files is opened. Off by default; use the start button at the top right |
| `tectonicWatch.enable` | `true` | Once started, watch and build automatically. Projects with their own build flow can turn this off in workspace settings; the manual commands still work |
| `tectonicWatch.mainFile` | `""` | Path of the main file, relative to the workspace root. When empty, the rules under "Multi-file projects" apply |
| `tectonicWatch.tectonicPath` | `"tectonic"` | Path of the tectonic executable |
| `tectonicWatch.extraArgs` | `[]` | Extra arguments for tectonic, e.g. `["--outdir", "build"]` |
| `tectonicWatch.debounceMs` | `100` | Milliseconds to wait after a file change before building, to merge bursts of changes. A save in VS Code builds immediately |
| `tectonicWatch.autoOpenPreview` | `true` | Open the preview after the first successful build once started |
| `tectonicWatch.reuseAux` | `true` | Keep the previous `.aux` and other intermediates; change-triggered builds run TeX once and further passes follow automatically when the intermediates change |
| `tectonicWatch.prewarm` | `true` | Start a tectonic process ahead of time that reads the preamble and waits, so a change only typesets the body. macOS and Linux only |
| `tectonicWatch.prewarmIdleMinutes` | `5` | Release the prewarmed process after this many minutes without changes; it is prepared again when you type. 0 means never |
| `tectonicWatch.draftFonts` | `true` | Build with the fandol fonts (ctex documents only; the document is not modified) |
| `tectonicWatch.finalBuild` | `false` | Rebuild with the document's own fonts once editing stops. System CJK fonts are slow and memory-hungry, so this is off by default |
| `tectonicWatch.finalBuildDelayMs` | `3000` | With `finalBuild` on, milliseconds without edits before rebuilding with the document fonts |
| `tectonicWatch.syncAfterBuild` | `true` | Scroll the preview to the change after a successful build; no movement when it is already in view |
| `tectonicWatch.stableTimestamp` | `true` | Pin the timestamps in the PDF to midnight today, see below |

### About `stableTimestamp`

tectonic writes the current time into the PDF on every build, so two builds of unchanged content are not identical and the extension could not tell that the PDF is unchanged and needs no refresh. With this option on, the extension sets `SOURCE_DATE_EPOCH` to midnight today when building, and within a day unchanged content gives a byte-identical PDF.

Side effects: the creation and modification times in the PDF metadata are 00:00 today, and `\time` in a document yields 0. `\today` is unaffected. If you already set the `SOURCE_DATE_EPOCH` environment variable yourself, yours is used. Turn the option off if you do not want this optimisation; the preview then refreshes after every build.

## Remote projects (Remote-SSH)

When a project on a server is opened through Remote-SSH, the extension runs on the server side and so does the build; the preview is shown locally as usual. tectonic has to be installed on the server. This setup has not been tested with prewarming.

The extension adds `/opt/homebrew/bin`, `/usr/local/bin` and `~/.cargo/bin` to the search path. If tectonic lives elsewhere, set `tectonicWatch.tectonicPath`.

## Troubleshooting

**tectonic is not found.** The extension shows a notification. Once it is installed, change a file again; if it is in a non-standard location, set `tectonicWatch.tectonicPath`.

**The PDF does not update.**
- Look at the status bar: does it say `Tectonic: stopped` (click the start button at the top right) or `Build failed`?
- Does the changed file belong to the current main file? Add `% !TEX root = ...` at the top of the sub-file.
- Do the project settings contain `"tectonicWatch.enable": false`?

**A template or example file with `\documentclass` in the directory gets built on its own, leaving a failed `.log` beside it.** A `standalone` template for building figures separately, for instance. The extension treats any file containing `\documentclass` as a main file. Name the main file in the project's `.vscode/settings.json`:

```json
{ "tectonicWatch.mainFile": "paper/main.tex" }
```

After that, changing the template only triggers a build of the main file.

**Strange build errors, especially after removing a reference or changing packages.** Delete the `.aux` files in the output directory and build again. This is a general hazard of reusing LaTeX's intermediate files; `tectonicWatch.reuseAux` can also be turned off.

**Builds fail after updating tectonic, or behave oddly only inside the extension.** Set `"tectonicWatch.prewarm": false` and try again; see [Status](#status).

**Cmd+Alt+J does nothing, or a LaTeX Workshop error pops up.** Both extensions use the same keybinding; disable LaTeX Workshop. "Show Current Line in PDF" in the context menu is unaffected.

**Cmd+F does not find text on later pages.** To save memory the preview only keeps the text of pages within about two screens of the current position, and that is the range searched. Scroll near the place first, then search.

**The log contains `accessing absolute path ... build may not be reproducible` warnings.** tectonic is telling you that system fonts are used and may not exist on another machine. The build result is not affected.

## Development

```bash
npm install
npm run package     # type check + bundle, produces tectonic-watch-0.2.0.vsix
code --install-extension tectonic-watch-0.2.0.vsix --force
```

Run `Developer: Reload Window` in VS Code afterwards for it to take effect.

The end-to-end tests run in a separate VS Code instance (temporary profile, your own settings are untouched). A window pops up, and each scenario takes a minute or two. They assume macOS with VS Code in `/Applications`:

```bash
npm run build
e2e/run.sh ctex       # also ctex-final, en, en-out, autosave, idle; see the top of e2e/run.sh
```

`ctex`, `ctex-final`, `en` and `en-out` compare the PDF built by the extension byte for byte with a from-scratch command-line build.

| File | Contents |
|---|---|
| `src/extension.ts` | File watching, build scheduling, diagnostics, the preview panel, the jump commands |
| `src/synctex.ts` | Parses `.synctex.gz` for jumps in both directions between source and PDF. tectonic ships no `synctex` command-line tool, so the file is parsed directly |
| `src/warm.ts` | Prewarming: tectonic reads the preamble, then waits at a named pipe until a change releases it |
| `src/locate.ts` | For PDF-to-source jumps, matches text near the line SyncTeX reports to find the exact word |
| `media/viewer.js`, `media/viewer.css` | The preview page: pdf.js rendering, text layer, zoom, sync highlight |
| `draft/ctexopts.cfg` | Switches ctex to the fandol fonts in draft builds |
| `e2e/` | End-to-end test scripts and the documents they use |
| `build.mjs` | Bundles the extension with esbuild and copies pdf.js with its CMaps and standard font data into `media/pdfjs/` |

## License

Extension code: MIT.

The bundled [pdf.js](https://github.com/mozilla/pdf.js) (`media/pdfjs/`, and the text layer styles excerpted in `media/viewer.css`) is under the Apache License 2.0.
