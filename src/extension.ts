import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { loadSynctex } from './synctex';
import { locateWord } from './locate';
import { Warm, WarmSpec, Standby, BODY, GATE } from './warm';

const DOCCLASS_RE = /^[^%\n]*\\documentclass/m;
const TEX_ROOT_RE = /^\s*%\s*!\s*TeX\s+root\s*=\s*(.+?)\s*$/im;
// tectonic's diagnostic lines, e.g. "error: sec1:2: Undefined control sequence"
const DIAG_RE = /^(error|warning): (.+?):(\d+): (.*)$/;
const INSTALL_URL = 'https://tectonic-typesetting.github.io/en-US/install.html';

let output: Pick<vscode.OutputChannel, 'append' | 'appendLine' | 'show'>;
let outputTail = ''; // recent build output, read by the automated tests
let lastForward: object | undefined; // the last after-build sync message sent to the preview, read by the automated tests
let diagnostics: vscode.DiagnosticCollection;
let statusItem: vscode.StatusBarItem;
let builder: Builder;
let preview: Preview;
let draftDir = ''; // directory holding the draft-font config ctexopts.cfg (shipped with the extension)

function cfg() {
  return vscode.workspace.getConfiguration('tectonicWatch');
}

export function activate(ctx: vscode.ExtensionContext) {
  draftDir = path.join(ctx.extensionPath, 'draft');
  const channel = vscode.window.createOutputChannel('Tectonic');
  const keep = (s: string) => { outputTail = (outputTail + s).slice(-200_000); };
  output = {
    append: s => { keep(s); channel.append(s); },
    appendLine: s => { keep(s + '\n'); channel.appendLine(s); },
    show: (...a: unknown[]) => (channel.show as (...x: unknown[]) => void)(...a),
  };
  diagnostics = vscode.languages.createDiagnosticCollection('tectonic');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = 'tectonicWatch.showLog';
  preview = new Preview(ctx);
  builder = new Builder();
  statusItem.show();
  // Not started by default; the button at the top right of a tex editor starts it
  builder.setRunning(cfg().get<boolean>('autoStart', false));
  builder.initialBuild();

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{tex,bib,sty,cls}');
  watcher.onDidChange(uri => builder.onFileEvent(uri, false));
  watcher.onDidCreate(uri => builder.onFileEvent(uri, false));
  watcher.onDidDelete(uri => builder.onFileEvent(uri, true));
  // Build right away on save in VS Code, without waiting for the file watcher or the debounce;
  // the watcher event that follows is ignored because the content hash is unchanged
  const onSave = vscode.workspace.onDidSaveTextDocument(doc => {
    if (doc.uri.scheme === 'file' && /\.(tex|bib|sty|cls)$/i.test(doc.uri.fsPath)) builder.onFileEvent(doc.uri, false, true);
  });

  ctx.subscriptions.push(
    channel, diagnostics, statusItem, watcher, onSave, builder,
    // Get the prewarmed process ready as soon as typing starts (it is released after a long idle), so it is warm before the save
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.contentChanges.length && e.document.uri.scheme === 'file' && /\.tex$/i.test(e.document.uri.fsPath)) builder.onTyping();
    }),
    vscode.commands.registerCommand('tectonicWatch.build', () => builder.buildNow()),
    vscode.commands.registerCommand('tectonicWatch.start', () => builder.start()),
    vscode.commands.registerCommand('tectonicWatch.stop', () => builder.stop()),
    vscode.commands.registerCommand('tectonicWatch.toggle', () => builder.running ? builder.stop() : builder.start()),
    vscode.commands.registerCommand('tectonicWatch.preview', async () => {
      const main = await builder.resolveMain(vscode.window.activeTextEditor?.document.uri);
      if (!main) {
        vscode.window.showWarningMessage('No main file containing \\documentclass was found');
        return;
      }
      const pdf = pdfOf(main);
      if (fs.existsSync(pdf.fsPath)) {
        preview.show(pdf, main);
      } else {
        builder.buildNow(true);
      }
    }),
    vscode.commands.registerCommand('tectonicWatch.syncToPdf', () => syncToPdf()),
    vscode.commands.registerCommand('tectonicWatch.showLog', () => output.show(true)),
    vscode.window.registerWebviewPanelSerializer(Preview.viewType, {
      deserializeWebviewPanel: async (panel, state) =>
        preview.restore(panel, state as { pdf?: string; main?: string } | undefined),
    }),
  );
  return { output: () => outputTail, lastForward: () => lastForward };
}

export function deactivate() {}

// When extraArgs sets -o/--outdir, output files go there
function outDir(main: vscode.Uri): string {
  const dir = path.dirname(main.fsPath);
  const args = cfg().get<string[]>('extraArgs', []);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '-o' || a === '--outdir') && args[i + 1]) return path.resolve(dir, args[i + 1]);
    if (a.startsWith('--outdir=')) return path.resolve(dir, a.slice(9));
  }
  return dir;
}

function outFile(main: vscode.Uri, ext: string): vscode.Uri {
  return vscode.Uri.file(path.join(outDir(main), path.basename(main.fsPath).replace(/\.tex$/i, ext)));
}

function pdfOf(main: vscode.Uri): vscode.Uri {
  return outFile(main, '.pdf');
}

// First line (0-based) where two texts differ; when lines were only removed at the end, the last line of the new text
function firstDiffLine(a: string, b: string): number {
  const x = a.split('\n'), y = b.split('\n');
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return Math.min(i, y.length - 1);
}

function isUnder(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function readHead(file: string, bytes = 8192): string {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return buf.toString('utf8', 0, n);
  } catch {
    return '';
  }
}

// \documentclass is normally within the first few lines, so only the head is read
function isRoot(file: string): boolean {
  return DOCCLASS_RE.test(readHead(file));
}

// "% !TEX root = ../main.tex" at the top of a sub-file
function texRoot(file: string): vscode.Uri | undefined {
  const m = TEX_ROOT_RE.exec(readHead(file, 2048));
  if (!m) return undefined;
  let fp = path.resolve(path.dirname(file), m[1]);
  if (!path.extname(fp)) fp += '.tex';
  return fs.existsSync(fp) ? vscode.Uri.file(fp) : undefined;
}

type Status = 'idle' | 'building' | 'ok' | 'draft' | 'fail' | 'stopped';
type Mode = 'draft' | 'final';

class Builder implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private proc: ChildProcess | undefined;
  private procDone: Promise<void> = Promise.resolve();
  private seq = 0;
  private paused = true; // not started: changes are not watched
  private lastMain: vscode.Uri | undefined;
  private triggers = new Set<string>();
  private manualTrigger: vscode.Uri | undefined;
  private openPreviewAfter = false;
  private previewOpenedOnce = false;
  private warnedMissing = false;
  // Content hash last seen per file: writes that do not change the content (re-save, touch) do not trigger a build
  private hashes = new Map<string, string>();
  // The tex files each main file actually read in its last successful build; identifies \input's from outside the main file's directory
  readonly inputs = new Map<string, Set<string>>();
  // Whether draft fonts are worth it per main file: it uses ctex and does not already ask for fandol. Unknown is tried once as "worth it"
  private draftUseful = new Map<string, boolean>();
  private nextMode: Mode = 'final';
  private finalTimer: NodeJS.Timeout | undefined;
  // Prewarmed processes: preamble read, waiting for the body just before \begin{document}
  private warm = new Warm();
  // Local files each main file reads during the preamble (from the last build's log); when they change the prewarmed process is stale
  private preDeps = new Map<string, string[]>();
  // A single-pass build changed the intermediates, so another pass is needed; this counts consecutive extra passes
  private settles = 0;
  // Fingerprint of the intermediates after the last single-pass build, per main file and font mode
  private lastAux = new Map<string, string>();
  private idleTimer: NodeJS.Timeout | undefined;
  private warmIdle = false; // idle for too long; the prewarmed processes have been released
  // Content last seen per tex file, to find which line an external tool changed
  private contents = new Map<string, string>();
  // Where the latest change was; the preview scrolls here after a successful build
  private syncTarget: { file: string; line: number } | undefined;

  setStatus(s: Status, detail = '') {
    const map: Record<Status, [string, string]> = {
      idle: ['$(file-pdf) Tectonic', 'Waiting for changes'],
      building: ['$(sync~spin) Building', detail || 'Running tectonic'],
      ok: ['$(check) Built', detail],
      draft: ['$(zap) Draft fonts', detail],
      fail: ['$(error) Build failed', detail],
      stopped: ['$(circle-slash) Tectonic: stopped', 'Click the start button at the top right of a tex editor to start building and previewing'],
    };
    const [text, tip] = map[s];
    statusItem.text = text;
    statusItem.tooltip = tip + '\nClick to show the build output';
    statusItem.backgroundColor = s === 'fail'
      ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
  }

  get running() {
    return !this.paused;
  }

  // Whether the editor title shows the start or the stop button depends on the tectonicWatch.running context
  setRunning(on: boolean) {
    this.paused = !on;
    vscode.commands.executeCommand('setContext', 'tectonicWatch.running', on);
    this.setStatus(on ? 'idle' : 'stopped');
  }

  // Start: watch for changes, build once and open the preview
  async start() {
    this.setRunning(true);
    const main = await this.resolveMain(vscode.window.activeTextEditor?.document.uri);
    if (!main) {
      vscode.window.showWarningMessage('No main file containing \\documentclass was found');
      return;
    }
    const pdf = pdfOf(main);
    if (fs.existsSync(pdf.fsPath)) preview.show(pdf, main);
    this.buildNow(true, true);
  }

  // Stop: no more watching, kill the build in flight; the preview stays
  stop() {
    clearTimeout(this.timer);
    clearTimeout(this.finalTimer);
    this.seq++; // invalidates the result of the build in flight
    this.proc?.kill();
    this.triggers.clear();
    clearTimeout(this.idleTimer);
    this.warm.dispose();
    this.setRunning(false);
  }

  onFileEvent(uri: vscode.Uri, deleted: boolean, immediate = false) {
    if (this.paused || !cfg().get<boolean>('enable', true)) return;
    const fp = uri.fsPath;
    if (deleted) {
      this.hashes.delete(fp);
    } else {
      let buf: Buffer;
      try {
        buf = fs.readFileSync(fp);
      } catch {
        return;
      }
      const hash = crypto.createHash('sha1').update(buf).digest('hex');
      if (this.hashes.get(fp) === hash) return;
      this.hashes.set(fp, hash);
      if (/\.tex$/i.test(fp)) this.noteChange(fp, buf.toString('latin1'), immediate);
    }
    this.triggers.add(fp);
    clearTimeout(this.timer);
    clearTimeout(this.finalTimer);
    this.nextMode = 'draft';
    this.settles = 0;
    this.timer = setTimeout(() => this.run(), immediate ? 0 : cfg().get<number>('debounceMs', 100));
  }

  // Note where the change was: the cursor line for a save in the editor, the first differing line for an external tool
  private noteChange(fp: string, text: string, saved: boolean) {
    const prev = this.contents.get(fp);
    this.contents.set(fp, text);
    const editor = vscode.window.activeTextEditor;
    if (saved && editor?.document.uri.fsPath === fp) {
      this.syncTarget = { file: fp, line: editor.selection.active.line };
    } else if (prev !== undefined) {
      this.syncTarget = { file: fp, line: firstDiffLine(prev, text) };
    }
  }

  // auto: build the way a change does (draft fonts, single pass plus settling); otherwise a full build with the document's own fonts
  buildNow(openPreview = false, auto = false) {
    clearTimeout(this.timer);
    clearTimeout(this.finalTimer);
    this.nextMode = auto ? 'draft' : 'final';
    this.settles = 0;
    this.manualTrigger = vscode.window.activeTextEditor?.document.uri ?? this.lastMain;
    this.openPreviewAfter ||= openPreview;
    this.run();
  }

  // On opening a project, build once if the existing PDF is older than the sources.
  // No build when there is no PDF: it may be a new project, or another tool may put its output elsewhere
  async initialBuild() {
    if (this.paused || !cfg().get<boolean>('enable', true) || !vscode.workspace.workspaceFolders?.length) return;
    const main = await this.resolveMain(vscode.window.activeTextEditor?.document.uri);
    if (!main) return;
    const pdf = pdfOf(main).fsPath;
    if (!fs.existsSync(pdf)) return;
    const pdfTime = fs.statSync(pdf).mtimeMs;
    const srcs = await vscode.workspace.findFiles(
      new vscode.RelativePattern(path.dirname(main.fsPath), '**/*.{tex,bib,sty,cls}'), undefined, 500);
    if (srcs.some(f => fs.statSync(f.fsPath).mtimeMs > pdfTime)) {
      this.manualTrigger = main;
      this.nextMode = 'draft';
      this.run();
    }
  }

  // Whether a changed file belongs to this main file: under its directory, or read by its last build (an \input from outside the directory).
  // Better one build too many than one too few: with unchanged content the PDF hash is the same and the preview is not refreshed.
  // bib/sty/cls do not show up in the log; any in the same workspace count, so shared files like ../refs.bib work
  private inScope(file: string, main: vscode.Uri): boolean {
    if (file === main.fsPath || isUnder(file, path.dirname(main.fsPath))) return true;
    if (this.inputs.get(main.fsPath)?.has(file)) return true;
    if (/\.tex$/i.test(file)) return false;
    const folder = vscode.workspace.getWorkspaceFolder(main);
    return !!folder && isUnder(file, folder.uri.fsPath);
  }

  // strict is used for watcher-triggered builds: returns undefined (no build) when no main file relates to the change
  async resolveMain(trigger?: vscode.Uri, strict = false): Promise<vscode.Uri | undefined> {
    const configured = cfg().get<string>('mainFile', '').trim();
    if (configured) {
      let main: vscode.Uri | undefined;
      if (path.isAbsolute(configured)) {
        main = vscode.Uri.file(configured);
      } else {
        const root = (trigger && vscode.workspace.getWorkspaceFolder(trigger))
          ?? vscode.workspace.workspaceFolders?.[0];
        if (root) main = vscode.Uri.joinPath(root.uri, configured);
      }
      if (main && (!strict || !trigger || this.inScope(trigger.fsPath, main))) return main;
      if (main) return undefined;
    }
    if (trigger && /\.tex$/i.test(trigger.fsPath)) {
      const magic = texRoot(trigger.fsPath);
      if (magic) return magic;
      if (isRoot(trigger.fsPath)) return trigger;
    }
    if (this.lastMain && fs.existsSync(this.lastMain.fsPath)
      && (!trigger || this.inScope(trigger.fsPath, this.lastMain))) {
      return this.lastMain;
    }

    const files = await vscode.workspace.findFiles('**/*.tex', '**/{node_modules,.git}/**', 500);
    const roots = files.filter(f => isRoot(f.fsPath));
    if (roots.length === 0) return undefined;
    if (trigger) {
      // The closest main file that contains the changed file
      const owners = roots.filter(r => this.inScope(trigger.fsPath, r));
      if (owners.length) {
        owners.sort((a, b) => b.fsPath.length - a.fsPath.length);
        return owners[0];
      }
      if (strict) return undefined;
    }
    // Shallowest path first, then the one called main.tex
    const score = (f: vscode.Uri) =>
      f.fsPath.split(path.sep).length * 10 + (path.basename(f.fsPath) === 'main.tex' ? 0 : 1);
    roots.sort((a, b) => score(a) - score(b));
    return roots[0];
  }

  private async pickMain(): Promise<vscode.Uri | undefined> {
    const manual = this.manualTrigger;
    const triggers = [...this.triggers];
    this.manualTrigger = undefined;
    this.triggers.clear();
    if (manual) return this.resolveMain(manual);
    for (const t of triggers) {
      const main = await this.resolveMain(vscode.Uri.file(t), true);
      if (main) return main;
    }
    return undefined;
  }

  private async run() {
    const seq = ++this.seq;
    if (this.proc) {
      // Another change during a build: kill the old one and build the latest content as soon as possible
      output.appendLine('New change, killing the previous build');
      this.proc.kill();
    }
    await this.procDone;
    const main = await this.pickMain();
    if (seq !== this.seq) return; // a newer request arrived while waiting
    if (!main) {
      if (!this.lastMain) this.setStatus(this.paused ? 'stopped' : 'idle');
      return;
    }
    this.lastMain = main;
    // Builds triggered by a file change use draft fonts when they can and run TeX only once; manual builds and the after-idle build run the way tectonic does by default
    const auto = this.nextMode === 'draft';
    const mode: Mode = auto && this.draftWanted(main) ? 'draft' : 'final';
    const quick = auto && canQuick();
    this.nextMode = 'final';
    const dir = path.dirname(main.fsPath);
    const args = buildArgs(main, mode === 'draft', quick);
    const exe = cfg().get<string>('tectonicPath', 'tectonic');

    fs.mkdirSync(outDir(main), { recursive: true }); // tectonic does not create the output directory itself
    const before = quick ? auxState(main) : '';
    const standby = this.takeWarm(main, mode, quick);
    this.setStatus('building', mode === 'draft' ? 'Building with draft fonts' : 'Building with the document fonts');
    output.appendLine(`\n[${new Date().toLocaleTimeString()}] ${mode === 'draft' ? 'draft' : 'final'}${quick ? ', single pass' : ''}${standby ? ', prewarmed' : ''}: ${exe} ${args.join(' ')}  (cwd: ${dir})`);
    const t0 = Date.now();
    let text = '';
    let finish!: () => void;
    this.procDone = new Promise(r => { finish = r; });
    const proc = standby?.proc ?? spawn(exe, args, { cwd: dir, env: buildEnv() });
    this.proc = proc;
    const onData = (s: string) => { text += s; output.append(s); };
    if (standby) {
      standby.attach(onData);
      // Get the next one ready right away so consecutive saves benefit too
      this.parkWarm(main);
    } else {
      proc.stdout?.on('data', (b: Buffer) => onData(b.toString()));
      proc.stderr?.on('data', (b: Buffer) => onData(b.toString()));
    }

    let missing = false;
    const code: number = await new Promise(resolve => {
      proc.on('error', err => {
        missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
        onData(`Failed to start tectonic: ${err.message}\n`);
        resolve(-1);
      });
      proc.on('close', c => resolve(c ?? -1));
    });
    this.proc = undefined;
    finish();
    if (seq !== this.seq) return; // superseded by a newer build; the result is void

    if (missing) {
      this.setStatus('fail', `${exe} not found`);
      this.warnMissing(exe);
      return;
    }
    try {
      // Compare with the intermediates after the previous single-pass build in the same font mode, not with the state before this build:
      // draft and final fonts paginate differently, so page numbers in .aux differ, and alternating between the two should not count as a change
      let unsettled = false;
      if (quick && code === 0) {
        const after = auxState(main);
        const k = `${main.fsPath}\0${mode}`;
        unsettled = after !== (this.lastAux.get(k) ?? before);
        this.lastAux.set(k, after);
      }
      this.afterBuild(main, mode, code, text, dir, t0, unsettled);
    } catch (e) {
      output.appendLine(`Error while processing the build result: ${(e as Error).stack ?? e}`);
      this.setStatus(code === 0 ? 'ok' : 'fail', 'Error while processing the build result, see the output');
    }
    this.parkWarm(main);
  }

  private draftWanted(main: vscode.Uri): boolean {
    return cfg().get<boolean>('draftFonts', true) && this.draftUseful.get(main.fsPath) !== false;
  }

  private warmKey(main: vscode.Uri, mode: Mode, quick: boolean): string {
    return [main.fsPath, mode, quick].join('\0');
  }

  private warmSpec(main: vscode.Uri, mode: Mode, quick: boolean): WarmSpec {
    return {
      main: main.fsPath,
      exe: cfg().get<string>('tectonicPath', 'tectonic'),
      args: buildArgs(main, mode === 'draft', quick, true),
      env: buildEnv(),
      deps: this.preDeps.get(main.fsPath) ?? [],
    };
  }

  private takeWarm(main: vscode.Uri, mode: Mode, quick: boolean): Standby | undefined {
    if (!warmAllowed()) return undefined;
    return this.warm.take(this.warmKey(main, mode, quick), this.warmSpec(main, mode, quick));
  }

  // Have a prewarmed process ready for the next change-triggered build
  private parkWarm(main: vscode.Uri) {
    if (this.paused || !warmAllowed() || !cfg().get<boolean>('enable', true)) {
      this.warm.dispose();
      return;
    }
    const mode: Mode = this.draftWanted(main) ? 'draft' : 'final';
    const key = this.warmKey(main, mode, canQuick());
    const finalKey = this.warmKey(main, 'final', false);
    this.warm.keepOnly(k => k === key || k === finalKey);
    this.warm.park(key, this.warmSpec(main, mode, canQuick()));
    this.touchWarm();
  }

  // The one for the after-idle final build that follows a draft. It loads the document's own fonts, and system CJK fonts take a lot of memory,
  // so it is only prepared once a draft build has finished and is not replaced after use
  private parkFinal(main: vscode.Uri) {
    if (this.paused || !warmAllowed()) return;
    this.warm.park(this.warmKey(main, 'final', false), this.warmSpec(main, 'final', false));
  }

  // Release the prewarmed processes after a while without changes, so they do not hold memory for nothing
  private touchWarm() {
    this.warmIdle = false;
    clearTimeout(this.idleTimer);
    const minutes = cfg().get<number>('prewarmIdleMinutes', 5);
    if (minutes > 0) {
      this.idleTimer = setTimeout(() => {
        this.warm.dispose();
        this.warmIdle = true;
      }, minutes * 60_000);
    }
  }

  onTyping() {
    if (this.paused || !this.lastMain) return;
    if (this.warmIdle) this.parkWarm(this.lastMain);
    else if (this.idleTimer) this.touchWarm();
  }

  // unsettled: TeX ran only once and the intermediates (.aux, .toc, .bbl, ...) changed, so cross-references or the table of contents may be stale
  private afterBuild(
    main: vscode.Uri, mode: Mode, code: number, text: string, dir: string, t0: number, unsettled: boolean,
  ) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const log = parseLog(outFile(main, '.log').fsPath, dir, main.fsPath);
    if (code === 0 && log.inputs.size) this.inputs.set(main.fsPath, log.inputs);
    else this.inputs.delete(main.fsPath);
    this.preDeps.set(main.fsPath, log.preambleFiles);
    // Keep a copy of files not seen before, so that a later external edit can be diffed to find the changed line
    for (const f of [main.fsPath, ...log.inputs]) {
      if (this.contents.has(f)) continue;
      try {
        this.contents.set(f, fs.readFileSync(f, 'latin1'));
      } catch { /* unreadable: skip */ }
    }

    // The draft config only takes effect for ctex documents; when the document already uses fandol, draft equals final
    let isDraft = false;
    if (mode === 'draft') {
      const useful = log.draftActive && log.requestedFontset !== 'fandol';
      this.draftUseful.set(main.fsPath, useful);
      isDraft = useful;
    }
    // When a final build with the document's fonts follows, glyphs missing from the draft font are not a problem (the final build fixes them) and only glyphs missing from the final fonts are reported;
    // without it the preview stays in draft fonts, so missing glyphs must be reported
    const finalWanted = cfg().get<boolean>('finalBuild', false);
    const nErr = publishDiagnostics(text, dir, main, code === 0, log.warnings,
      isDraft && finalWanted ? new Map() : log.missing, log.inputs);

    // One more pass to bring cross-references, table of contents and bibliography up to date. The preview already shows this pass's result.
    // Once the intermediates stop changing the result equals a full run; at most three extra passes, in case a document never settles
    const settle = code === 0 && unsettled && this.settles < 3 && !(isDraft && finalWanted && log.missing.size);
    if (settle) {
      this.settles++;
      this.setStatus('building', 'Updating cross-references and table of contents');
      output.appendLine('Intermediate files changed, building once more to update cross-references and table of contents');
      this.manualTrigger = main;
      this.nextMode = 'draft';
      setTimeout(() => {
        // a newer change or a manual build in the meantime takes over
        if (this.manualTrigger === main && this.nextMode === 'draft') this.run();
      }, 0);
    } else if (code === 0 && isDraft && !finalWanted) {
      const nMissing = log.missing.size;
      this.setStatus('draft', `${path.basename(main.fsPath)}, ${secs}s\nBuilt with draft fonts (fandol)`
        + (nMissing ? `\nfandol lacks ${nMissing} character(s), see the Problems panel` : '')
        + '\nRun "Tectonic: Build Now" for the document\'s own fonts');
    } else if (code === 0 && isDraft) {
      // After a short idle, build again with the document's own fonts; immediately if the draft has blanks (missing glyphs)
      const delay = log.missing.size ? 0 : cfg().get<number>('finalBuildDelayMs', 3000);
      const note = log.missing.size ? `The draft font lacks ${log.missing.size} character(s), rebuilding with the document fonts` : '';
      this.setStatus('draft', `${path.basename(main.fsPath)}, ${secs}s\n`
        + (note || `Built with draft fonts (fandol); rebuilding with the document fonts after ${delay / 1000}s without edits`));
      this.finalTimer = setTimeout(() => {
        this.manualTrigger = main;
        this.nextMode = 'final';
        this.run();
      }, delay);
      this.parkFinal(main);
    } else if (code === 0) {
      const nMissing = log.missing.size;
      this.setStatus('ok', `${path.basename(main.fsPath)}, ${secs}s`
        + (nMissing ? `\nThe fonts lack ${nMissing} character(s), see the Problems panel` : ''));
    }

    if (code === 0) {
      const pdf = pdfOf(main);
      const shouldOpen = this.openPreviewAfter
        || (!this.previewOpenedOnce && cfg().get<boolean>('autoOpenPreview', true));
      this.openPreviewAfter = false;
      if (shouldOpen) {
        this.previewOpenedOnce = true;
        preview.show(pdf, main);
      } else {
        preview.reload(pdf, main);
      }
      preview.setDraft(isDraft);
      const target = this.syncTarget;
      this.syncTarget = undefined;
      if (target && cfg().get<boolean>('syncAfterBuild', true)) {
        // Computed after the PDF has been sent to the preview so the refresh is not delayed; the preview scrolls once the new PDF is drawn
        preview.afterSend(() => {
          const rect = loadSynctex(pdf.fsPath, dir, main.fsPath)?.forward(target.file, target.line + 1);
          lastForward = rect && { ...target, ...rect };
          if (rect) preview.post({ type: 'forward', soft: true, ...rect });
        });
      }
    } else {
      this.setStatus('fail', `${nErr} error(s); the preview keeps the previous PDF`);
      preview.notifyFailure(`Build failed (${nErr} error(s)); showing the previous PDF`);
    }
  }

  private async warnMissing(exe: string) {
    if (this.warnedMissing) return;
    this.warnedMissing = true;
    const hint = process.platform === 'darwin' ? 'Install it with brew install tectonic. ' : '';
    const pick = await vscode.window.showErrorMessage(
      `tectonic (${exe}) was not found. ${hint}Save again once it is installed; if it lives in a non-standard location, set tectonicWatch.tectonicPath.`,
      'Install instructions');
    if (pick) vscode.env.openExternal(vscode.Uri.parse(INSTALL_URL));
  }

  dispose() {
    clearTimeout(this.timer);
    clearTimeout(this.finalTimer);
    clearTimeout(this.idleTimer);
    this.proc?.kill();
    this.warm.dispose();
  }
}

// Running TeX once only makes sense with the .aux left by the previous build; do not interfere when the user sets the rerun count
function canQuick(): boolean {
  const extra = cfg().get<string[]>('extraArgs', []);
  return cfg().get<boolean>('reuseAux', true) && !extra.some(a => a === '-r' || a.startsWith('--reruns'));
}

// \write18 commands depend on the working directory and a prewarmed build runs in a temp directory, so such documents are not prewarmed
function warmAllowed(): boolean {
  return cfg().get<boolean>('prewarm', true)
    && !cfg().get<string[]>('extraArgs', []).some(a => a.includes('shell-escape'));
}

// quick: run TeX once (--reruns 0) and do not let tectonic rerun by itself.
// shim: for prewarming; the stand-in for the main file is built in a temp directory (see warm.ts).
//       The source directory becomes a search path, the output directory must be explicit, and relative paths in user arguments are made absolute
function buildArgs(main: vscode.Uri, draft = false, quick = false, shim = false): string[] {
  const dir = path.dirname(main.fsPath);
  const out = outDir(main);
  let extra = cfg().get<string[]>('extraArgs', []);
  const args = ['--synctex', '--keep-logs'];
  if (shim) args.push('-Z', `search-path=${dir}`);
  // Draft: let tectonic find the extension's own ctexopts.cfg first, which switches ctex's fontset to fandol without touching the document
  if (draft) args.push('-Z', `search-path=${draftDir}`);
  // Keep the previous .aux: with unchanged cross-references tectonic runs TeX once, saving about 40%; it reruns by itself when they change.
  // tectonic only looks for .aux in the source directory, so a different output directory has to be added to the search path
  if (cfg().get<boolean>('reuseAux', true)) {
    if (!extra.includes('--keep-intermediates')) args.push('--keep-intermediates');
    if (out !== dir) args.push('-Z', `search-path=${out}`);
  }
  if (quick) args.push('--reruns', '0');
  if (shim) {
    const abs: string[] = [];
    for (let i = 0; i < extra.length; i++) {
      const a = extra[i];
      if (a === '-o' || a === '--outdir') i++;
      else if (a.startsWith('--outdir=')) continue;
      else if (a.startsWith('search-path=') && extra[i - 1] === '-Z') abs.push(`search-path=${path.resolve(dir, a.slice(12))}`);
      else abs.push(a);
    }
    extra = abs;
    args.push('--outdir', out);
  }
  return [...args, ...extra, path.basename(main.fsPath)];
}

// Content fingerprint of the intermediates (.aux, .toc, .bbl, ...). Taken before and after a single-pass build; a change means another pass is needed
function auxState(main: vscode.Uri): string {
  const dir = outDir(main);
  const job = path.basename(main.fsPath).replace(/\.tex$/i, '');
  const hash = crypto.createHash('sha1');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return '';
  }
  const files = names
    .filter(n => n.startsWith(job + '.') && !/\.(pdf|log|blg|tex|xdv|synctex|gz)$/i.test(n))
    .sort().map(n => path.join(dir, n));
  // \include'd files each have their own .aux, referenced from the main .aux with \@input
  try {
    const aux = fs.readFileSync(path.join(dir, job + '.aux'), 'latin1');
    for (const m of aux.matchAll(/\\@input\{([^}]+)\}/g)) files.push(path.resolve(dir, m[1]));
  } catch { /* no .aux yet */ }
  for (const f of files) {
    try {
      hash.update(f).update(fs.readFileSync(f));
    } catch { /* unreadable: skip */ }
  }
  return hash.digest('hex');
}

function buildEnv(): NodeJS.ProcessEnv {
  // A GUI-launched VS Code on macOS may not have Homebrew on its PATH
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', path.join(process.env.HOME ?? '', '.cargo/bin')];
  const cur = (process.env.PATH ?? '').split(path.delimiter);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [...cur, ...extra.filter(p => !cur.includes(p))].join(path.delimiter),
  };
  // Pin the PDF timestamps to midnight today: within a day unchanged content gives a byte-identical PDF and the preview can skip the refresh.
  // \today is unaffected, \time becomes 0
  if (cfg().get<boolean>('stableTimestamp', true) && !env.SOURCE_DATE_EPOCH) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    env.SOURCE_DATE_EPOCH = String(Math.floor(d.getTime() / 1000));
  }
  return env;
}

function publishDiagnostics(
  text: string, dir: string, main: vscode.Uri, ok: boolean, logWarnings: LogWarning[],
  missing: Map<string, Set<string>>, inputs: Set<string>,
): number {
  diagnostics.clear();
  const byFile = new Map<string, vscode.Diagnostic[]>();
  let nErr = 0;
  let firstError = '';
  const outLines = text.split(/\r?\n/);
  for (let i = 0; i < outLines.length; i++) {
    const line = outLines[i];
    if (!firstError && line.startsWith('error: ')) firstError = line.slice(7);
    const m = DIAG_RE.exec(line);
    if (!m) continue;
    const [, sev, file, lineNo] = m;
    // The message may wrap to the next line, e.g. "warning: main.tex:6: " followed by the text on a new line
    const msg = m[4].trim() || (outLines[i + 1] ?? '').trim();
    // Missing glyphs are parsed from the log instead (the terminal shows garbled characters, and cannot tell whether the draft font caused them)
    if (!msg || msg.startsWith('Missing character')) continue;
    let fp = path.resolve(dir, file);
    // In a prewarmed build the body is read from the stand-in file; line numbers match the main file
    if (path.basename(file).replace(/\.tex$/i, '') === BODY.replace(/\.tex$/i, '')) fp = main.fsPath;
    else if (!fs.existsSync(fp) && fs.existsSync(fp + '.tex')) fp += '.tex';
    const ln = Math.max(0, parseInt(lineNo, 10) - 1);
    const d = new vscode.Diagnostic(
      new vscode.Range(ln, 0, ln, Number.MAX_SAFE_INTEGER), msg,
      sev === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
    d.source = 'tectonic';
    if (sev === 'error') nErr++;
    (byFile.get(fp) ?? byFile.set(fp, []).get(fp)!).push(d);
  }
  // tectonic does not print LaTeX warnings to the terminal; take them from the .log
  for (const w of logWarnings) {
    const list = byFile.get(w.file) ?? byFile.set(w.file, []).get(w.file)!;
    if (list.some(d => d.range.start.line === w.line && d.message === w.msg)) continue;
    const d = new vscode.Diagnostic(new vscode.Range(w.line, 0, w.line, Number.MAX_SAFE_INTEGER),
      w.msg, vscode.DiagnosticSeverity.Warning);
    d.source = 'tectonic';
    list.push(d);
  }
  // Missing glyphs: the log has no line number, so look for the character in the sources
  if (missing.size) {
    const files = [...new Set([main.fsPath, ...inputs])];
    const texts = new Map<string, string[]>();
    for (const f of files) {
      try { texts.set(f, fs.readFileSync(f, 'utf8').split(/\r?\n/)); } catch { /* unreadable: skip */ }
    }
    for (const [ch, fonts] of missing) {
      const msg = `Font ${[...fonts].join(', ')} has no glyph for "${ch}" (U+${ch.codePointAt(0)!.toString(16).toUpperCase()}); it shows as a box or blank in the PDF`;
      let found = 0;
      for (const [f, lines] of texts) {
        lines.forEach((ln, i) => {
          if (found >= 20 || ln.trimStart().startsWith('%')) return;
          let col = ln.indexOf(ch);
          while (col >= 0 && found < 20) {
            const d = new vscode.Diagnostic(new vscode.Range(i, col, i, col + ch.length), msg,
              vscode.DiagnosticSeverity.Warning);
            d.source = 'tectonic';
            (byFile.get(f) ?? byFile.set(f, []).get(f)!).push(d);
            found++;
            col = ln.indexOf(ch, col + ch.length);
          }
        });
      }
      if (!found) {
        const d = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), msg, vscode.DiagnosticSeverity.Warning);
        d.source = 'tectonic';
        (byFile.get(main.fsPath) ?? byFile.set(main.fsPath, []).get(main.fsPath)!).push(d);
      }
    }
  }
  // A failed build without any error carrying a line number: attach the first error to line 1 of the main file
  if (!ok && nErr === 0) {
    const d = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0),
      firstError || 'Build failed, see the "Tectonic" output', vscode.DiagnosticSeverity.Error);
    d.source = 'tectonic';
    byFile.set(main.fsPath, [...(byFile.get(main.fsPath) ?? []), d]);
    nErr = 1;
  }
  for (const [fp, ds] of byFile) diagnostics.set(vscode.Uri.file(fp), ds);
  return nErr;
}

// Source -> PDF: scroll the preview to the cursor line and highlight it
async function syncToPdf() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const main = await builder.resolveMain(editor.document.uri);
  if (!main) {
    vscode.window.showWarningMessage('No main file containing \\documentclass was found');
    return;
  }
  const pdf = pdfOf(main);
  const sd = loadSynctex(pdf.fsPath, path.dirname(main.fsPath), main.fsPath);
  if (!sd) {
    vscode.window.showWarningMessage('No SyncTeX data yet; build once first');
    return;
  }
  const rect = sd.forward(editor.document.uri.fsPath, editor.selection.active.line + 1);
  if (!rect) {
    vscode.window.showInformationMessage('This line has no corresponding content in the PDF');
    return;
  }
  preview.show(pdf, main);
  preview.post({ type: 'forward', ...rect });
}

// PDF -> source: open the file, go to the clicked word and select it; fall back to the start of the line when the text cannot be matched
async function syncToSource(
  pdf: vscode.Uri, main: vscode.Uri | undefined, page: number, x: number, y: number,
  text?: string, offset?: number,
) {
  const srcDir = main ? path.dirname(main.fsPath) : path.dirname(pdf.fsPath);
  const src = loadSynctex(pdf.fsPath, srcDir, main?.fsPath)?.reverse(page, x, y);
  if (!src || !fs.existsSync(src.file)) {
    vscode.window.setStatusBarMessage('SyncTeX: no source for this position', 3000);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(src.file);
  const line = Math.max(0, Math.min(src.line - 1, doc.lineCount - 1));
  let range = new vscode.Range(line, 0, line, 0);
  if (typeof text === 'string' && typeof offset === 'number') {
    const lines: string[] = [];
    for (let i = 0; i < doc.lineCount; i++) lines.push(doc.lineAt(i).text);
    const hit = locateWord(lines, line, text, offset);
    if (hit) range = new vscode.Range(hit.line, hit.start, hit.line, hit.end);
  }
  // Show it in its current column if already open, otherwise in a column other than the preview's
  const shown = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === doc.uri.fsPath);
  const column = shown?.viewColumn
    ?? vscode.window.visibleTextEditors.find(e => e.viewColumn !== preview.column)?.viewColumn
    ?? vscode.ViewColumn.One;
  const editor = await vscode.window.showTextDocument(doc, { viewColumn: column, selection: range });
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

class Preview {
  static readonly viewType = 'tectonicWatch.preview';
  private panel: vscode.WebviewPanel | undefined;
  private pdf: vscode.Uri | undefined;
  private main: vscode.Uri | undefined;
  private ready = false;
  private sentHash = '';
  private sending: Promise<void> = Promise.resolve();
  private queue: object[] = [];

  constructor(private ctx: vscode.ExtensionContext) {}

  get column() {
    return this.panel?.viewColumn;
  }

  show(pdf: vscode.Uri, main?: vscode.Uri) {
    if (this.panel) {
      if (!this.panel.visible) this.panel.reveal(undefined, true);
      this.reload(pdf, main);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      Preview.viewType, path.basename(pdf.fsPath),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true,
        localResourceRoots: [this.mediaRoot()],
      });
    this.attach(panel, pdf, main);
  }

  restore(panel: vscode.WebviewPanel, state: { pdf?: string; main?: string } | undefined) {
    if (!state?.pdf || !fs.existsSync(state.pdf)) {
      panel.dispose();
      return;
    }
    panel.webview.options = { enableScripts: true, localResourceRoots: [this.mediaRoot()] };
    this.attach(panel, vscode.Uri.file(state.pdf), state.main ? vscode.Uri.file(state.main) : undefined);
    // The preview was open when the window was last closed, so it was in use: keep watching
    if (!builder.running) {
      builder.setRunning(true);
      builder.initialBuild();
    }
  }

  reload(pdf: vscode.Uri, main?: vscode.Uri) {
    if (!this.panel) return;
    this.pdf = pdf;
    if (main) this.main = main;
    this.panel.title = path.basename(pdf.fsPath);
    if (this.ready) this.sending = this.send();
  }

  // Run after the current PDF send completes, so the preview gets the PDF before the sync request
  afterSend(fn: () => void) {
    this.sending.then(fn, fn);
  }

  // Shows the "Draft fonts" tag at the top right of the preview
  setDraft(draft: boolean) {
    this.post({ type: 'mode', draft });
  }

  notifyFailure(msg: string) {
    this.post({ type: 'status', ok: false, msg });
  }

  // Queue until the preview is ready, then send in order
  post(msg: object) {
    if (!this.panel) return;
    if (this.ready) this.panel.webview.postMessage(msg);
    else this.queue.push(msg);
  }

  private mediaRoot() {
    return vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
  }

  private attach(panel: vscode.WebviewPanel, pdf: vscode.Uri, main?: vscode.Uri) {
    this.panel = panel;
    this.pdf = pdf;
    this.main = main;
    this.ready = false;
    this.sentHash = '';
    panel.title = path.basename(pdf.fsPath);
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage(async m => {
      if (m?.type === 'ready') {
        // The preview holds sync requests that arrive before the PDF until it is drawn, so strict ordering is not needed here
        this.ready = true;
        // The preview page may have been reloaded (e.g. moved to its own window); the PDF has to be sent again
        this.sentHash = '';
        for (const q of this.queue.splice(0)) panel.webview.postMessage(q);
        this.send();
      } else if (m?.type === 'reverse' && this.pdf) {
        syncToSource(this.pdf, this.main, m.page, m.x, m.y, m.text, m.offset);
      }
    });
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
        this.ready = false;
        this.queue = [];
      }
    });
  }

  private async send() {
    const panel = this.panel;
    const pdf = this.pdf;
    if (!panel || !pdf) return;
    try {
      // Convert to a plain Uint8Array: a Node Buffer is serialised as an object the webview cannot use directly
      const data = new Uint8Array(await vscode.workspace.fs.readFile(pdf));
      const hash = crypto.createHash('sha1').update(data).update(pdf.fsPath).digest('hex');
      if (hash === this.sentHash) {
        // Unchanged content (e.g. only a comment was edited): do not transfer and redraw
        output.appendLine('PDF unchanged, preview not refreshed');
        panel.webview.postMessage({ type: 'unchanged' });
        return;
      }
      this.sentHash = hash;
      panel.webview.postMessage({ type: 'load', data, pdf: pdf.fsPath, main: this.main?.fsPath });
    } catch (e) {
      panel.webview.postMessage({ type: 'status', ok: false, msg: `Failed to read the PDF: ${(e as Error).message}` });
    }
  }

  private html(webview: vscode.Webview): string {
    const media = this.mediaRoot();
    const u = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(media, ...p)).toString();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} blob: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource}`,
      `connect-src ${webview.cspSource}`,
      `font-src ${webview.cspSource} data:`,
      `worker-src blob:`,
    ].join('; ');
    const mod = process.platform === 'darwin' ? 'Cmd' : 'Ctrl';
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${u('viewer.css')}">
</head>
<body>
<div id="toolbar">
  <button id="zoom-out" title="Zoom out">−</button>
  <button id="fit" title="Fit width">Fit width</button>
  <button id="zoom-in" title="Zoom in">+</button>
  <span id="draft-tag" hidden title="The preview uses the fandol fonts, not the fonts the document asks for">Draft fonts</span>
  <span id="page-info" title="${mod}+click or double-click the page to jump to the source"></span>
</div>
<div id="banner" hidden></div>
<div id="scroller"><div id="pages"></div></div>
<script type="module" src="${u('viewer.js')}" data-worker="${u('pdfjs', 'pdf.worker.min.mjs')}"
  data-cmaps="${u('pdfjs', 'cmaps')}/" data-fonts="${u('pdfjs', 'standard_fonts')}/"></script>
</body>
</html>`;
  }
}

interface LogWarning { file: string; line: number; msg: string }

// Parses the TeX log:
// - warnings of the form "LaTeX/Package xxx Warning: ... on input line N."
// - the tex files read during the build
// A parenthesis stack tracks the file being read: '(' followed by an existing file name pushes it, any other '(' pushes a placeholder, ')' pops.
interface ParsedLog {
  warnings: LogWarning[];
  inputs: Set<string>;
  preambleFiles: string[];           // local files read before \begin{document} (excluding the main file)
  missing: Map<string, Set<string>>; // missing character -> fonts that lack it
  draftActive: boolean;              // the draft-font config took effect (so the document uses ctex)
  requestedFontset: string;          // the fontset the document itself asks for; empty when not given
}

export function parseLog(logPath: string, dir: string, mainPath: string): ParsedLog {
  const warnings: LogWarning[] = [];
  const inputs = new Set<string>();
  const missing = new Map<string, Set<string>>();
  const preambleFiles: string[] = [];
  const result: ParsedLog = { warnings, inputs, preambleFiles, missing, draftActive: false, requestedFontset: '' };
  let inPreamble = true;
  let log: string;
  try { log = fs.readFileSync(logPath, 'utf8'); } catch { return result; }
  result.draftActive = log.includes('tectonic-watch: draft-fontset active');
  result.requestedFontset = /tectonic-watch: requested-fontset=(\S+)/.exec(log)?.[1] ?? '';
  const stack: (string | null)[] = [];
  const lines = log.split(/\r?\n/);
  const current = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i]) return stack[i]!;
    return mainPath;
  };
  const asFile = (tok: string) => {
    const fp = path.resolve(dir, tok);
    if (/\.tex$/i.test(fp) && fs.existsSync(fp)) return fp;
    if (!path.extname(fp) && fs.existsSync(fp + '.tex')) return fp + '.tex';
    return undefined;
  };
  // Local files of any extension (.sty and .cls too); distribution files are not found under the source directory and drop out naturally
  const asLocal = (tok: string) => {
    for (const fp of [path.resolve(dir, tok), path.resolve(dir, tok + '.tex')]) {
      try {
        if (fs.statSync(fp).isFile()) return fp;
      } catch { /* does not exist */ }
    }
    return undefined;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // With no .aux to read (first build), the line where LaTeX opens .aux for writing marks the boundary
    if (line.startsWith('\\openout1 = ')) inPreamble = false;
    // "Missing character: There is no X (U+9555) in font [FandolSong-Regular.otf]/OT:s..."; long lines wrap to the next line
    const mc = /^Missing character: There is no .+? \(U\+([0-9A-Fa-f]+)\) in font (.*)$/.exec(line);
    if (mc) {
      const ch = String.fromCodePoint(parseInt(mc[1], 16));
      const font = mc[2].replace(/^\[/, '').split(/[\]:]/)[0].replace(/\.(otf|ttf|ttc)$/i, '');
      (missing.get(ch) ?? missing.set(ch, new Set()).get(ch)!).add(font);
      continue;
    }
    const wm = /^(?:LaTeX|Package \S+|Class \S+) Warning: (.*)$/.exec(line);
    if (wm) {
      // A warning may wrap over several lines; continuation runs until a blank line
      let msg = wm[1];
      while (i + 1 < lines.length && lines[i + 1].trim() !== '') {
        msg += ' ' + lines[++i].replace(/^\(\S+\)\s*/, '').trim();
      }
      const lm = /on input line (\d+)\.?/.exec(msg);
      if (lm) warnings.push({ file: current(), line: parseInt(lm[1], 10) - 1, msg: msg.replace(/\s+/g, ' ').trim() });
      continue;
    }
    for (const m of line.matchAll(/\(([^\s()]*)|\)/g)) {
      if (m[0] === ')') {
        stack.pop();
      } else {
        // The first thing \begin{document} does is read .aux; in a prewarmed build the pipe is read just before that
        if (m[1] && (/\.aux$/i.test(m[1]) || path.basename(m[1]).startsWith(GATE.replace(/\.tex$/, '')))) inPreamble = false;
        const local = inPreamble && m[1] ? asLocal(m[1]) : undefined;
        if (local && local !== mainPath && !preambleFiles.includes(local)) preambleFiles.push(local);
        const fp = m[1] ? asFile(m[1]) : undefined;
        if (fp) inputs.add(fp);
        stack.push(fp ?? null);
      }
    }
  }
  return result;
}
