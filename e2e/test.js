const vscode = require('vscode'); const fs = require('fs'); const path = require('path'); const cp = require('child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));
exports.run = async () => {
  const res = { kind: process.env.TW_KIND, steps: {} };
  try { await main(res); } catch (e) { res.error = String((e && e.stack) || e); }
  fs.writeFileSync(process.env.TW_OUT, JSON.stringify(res, null, 1));
};
async function main(res) {
  const kind = process.env.TW_KIND;
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const outdir = process.env.TW_OUTDIR || '';
  const mainName = process.env.TW_MAINNAME || 'main.tex';
  const mainPath = path.join(root, mainName), pdf = path.join(root, outdir, mainName.replace(/\.tex$/, '.pdf'));
  const marker = process.env.TW_MARKER || (kind.startsWith('ctex') ? 'The \\soh{} again' : 'Marker sentence here');
  const api = await vscode.extensions.getExtension('zhenwang-bit.tectonic-watch').activate();
  // Draft fonts are the default: when comparing with the command line, it has to read the extension's draft config too
  const refDraft = process.env.TW_REF_DRAFT ? ['-Z', 'search-path=' + path.join(vscode.extensions.getExtension('zhenwang-bit.tectonic-watch').extensionPath, 'draft')] : [];
  const log = () => (api && api.output ? api.output() : '');
  const labels = from => [...log().slice(from).matchAll(/^\[[^\]]+\] ([^:]+): /gm)].map(m => m[1]);
  const mtime = () => { try { return fs.statSync(pdf).mtimeMs; } catch { return 0; } };
  const waitFor = async (fn, ms, what) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(5); } throw new Error('timeout: ' + what + '\n' + log().slice(-1500)); };
  // Output quiet for ms milliseconds: this round of builds (settling passes and the after-idle final build included) is over
  const quiet = async (ms = 4500) => { let last = log().length, t = Date.now(); while (Date.now() - t < ms) { await sleep(50); if (log().length !== last) { last = log().length; t = Date.now(); } } };
  const read = f => fs.readFileSync(path.join(root, f), 'utf8');
  const edit = (f, fn) => fs.writeFileSync(path.join(root, f), fn(read(f)));
  // Change a file and time until the PDF is updated
  const timed = async (how, f, fn, cursorLine) => {
    const from = log().length, m0 = mtime(), t0 = Date.now();
    if (how === 'fs') edit(f, fn);
    else {
      // Earlier steps edited the file on disk and the editor's copy may be behind, in which case saving reports a conflict; reload from disk first
      const doc = await vscode.workspace.openTextDocument(path.join(root, f));
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('workbench.action.files.revert');
      if (cursorLine !== undefined) vscode.window.activeTextEditor.selection = new vscode.Selection(cursorLine, 0, cursorLine, 0);
      const we = new vscode.WorkspaceEdit();
      we.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), fn(doc.getText()));
      const applied = await vscode.workspace.applyEdit(we); const saved = await doc.save();
      if (!applied || !saved) throw new Error(`edit applied=${applied} saved=${saved}`);
    }
    await waitFor(() => mtime() > m0, 20000, 'pdf update after ' + how);
    const ms = Date.now() - t0;
    await quiet();
    return { ms, builds: labels(from) };
  };
  let n = 0; const bump = s => s.replace(marker, marker + ' x' + (++n));

  const doc = await vscode.workspace.openTextDocument(mainPath); await vscode.window.showTextDocument(doc);
  let from = log().length;
  await vscode.commands.executeCommand('tectonicWatch.start');
  await waitFor(() => mtime() > 0, 60000, 'first pdf'); await quiet();
  res.steps.start = { builds: labels(from) };

  res.steps.externalEdit = [await timed('fs', mainName, bump), await timed('fs', mainName, bump), await timed('fs', mainName, bump)];
  // After-build sync: first differing line for an external edit, cursor line for a save in the editor
  const markerLine = () => read(mainName).split('\n').findIndex(l => l.includes(marker));
  const fwd = () => { const f = api.lastForward && api.lastForward(); return f ? { file: path.basename(f.file), line: f.line, page: f.page } : null; };
  res.steps.syncAfterExternalEdit = { expectedLine: markerLine(), got: fwd() };
  res.steps.saveInEditor = [await timed('save', mainName, bump, 30), await timed('save', mainName, bump, markerLine())];
  res.steps.syncAfterSave = { expectedLine: markerLine(), got: fwd() };
  if (process.env.TW_BASE) return;
  res.steps.subfile = await timed('fs', 'sections/intro.tex', s => s + 'More text.\n');
  res.steps.syncAfterSubfileEdit = { expectedLine: read('sections/intro.tex').split('\n').findIndex(l => l.includes('More text')), got: fwd() };

  // Two changes in a row, 150 ms apart
  { const f = log().length, m0 = mtime(); edit('main.tex', bump); await sleep(150); const t0 = Date.now(); edit('main.tex', bump);
    const want = read('main.tex'); await sleep(30);
    await waitFor(() => mtime() > m0 && labels(f).length >= 2, 20000, 'rapid'); const ms = Date.now() - t0; await quiet();
    res.steps.rapid = { msFromSecondEdit: ms, builds: labels(f) }; }

  // An error in the body
  { const lines = read('main.tex').split('\n'); const at = lines.findIndex(l => l.includes(marker));
    edit('main.tex', s => s.replace(marker, '\\undefinedcmdx ' + marker));
    const uri = vscode.Uri.file(mainPath);
    const d = await waitFor(() => vscode.languages.getDiagnostics(uri).find(x => x.severity === 0), 20000, 'diagnostic');
    res.steps.bodyError = { expectedLine: at, gotLine: d.range.start.line, msg: d.message };
    edit('main.tex', s => s.replace('\\undefinedcmdx ', ''));
    await waitFor(() => !vscode.languages.getDiagnostics(uri).some(x => x.severity === 0), 20000, 'diagnostic cleared'); await quiet(); }
  // An error in a sub-file
  { edit('sections/intro.tex', s => s + '\\undefinedcmdy\n'); const at = read('sections/intro.tex').split('\n').findIndex(l => l.includes('undefinedcmdy'));
    const uri = vscode.Uri.file(path.join(root, 'sections/intro.tex'));
    const d = await waitFor(() => vscode.languages.getDiagnostics(uri).find(x => x.severity === 0), 20000, 'sub diagnostic');
    res.steps.subError = { expectedLine: at, gotLine: d.range.start.line, msg: d.message };
    edit('sections/intro.tex', s => s.replace('\\undefinedcmdy\n', '')); await sleep(300); await quiet(); }

  // New citation and changed title: result first, then settle automatically; finally compare with a from-scratch command-line build
  res.steps.newCite = await timed('fs', 'main.tex', s => s.replace(marker, marker + ' \\cite{b2021}'));
  res.steps.newTitle = await timed('fs', 'main.tex', s => s.replace(/\\section\{([^}]*)\}/, '\\section{Changed title $1}'));
  { const ref = root + '-ref'; fs.rmSync(ref, { recursive: true, force: true }); fs.cpSync(root, ref, { recursive: true });
    for (const f of fs.readdirSync(ref)) if (/^main\.(aux|toc|out|bbl|blg|log|pdf|synctex\.gz)$/.test(f)) fs.rmSync(path.join(ref, f));
    if (outdir) { fs.rmSync(path.join(ref, outdir), { recursive: true, force: true }); fs.mkdirSync(path.join(ref, outdir)); }
    const d = new Date(); d.setHours(0, 0, 0, 0);
    const env = { ...process.env, PATH: process.env.PATH + ':/opt/homebrew/bin', SOURCE_DATE_EPOCH: String(Math.floor(d.getTime() / 1000)) };
    for (let i = 0; i < 3; i++) cp.execFileSync('tectonic', ['--synctex', '--keep-logs', '--keep-intermediates', ...refDraft, ...(outdir ? ['-Z', 'search-path=' + path.join(ref, outdir), '--outdir', outdir] : []), 'main.tex'], { cwd: ref, env, stdio: 'ignore' });
    res.steps.matchesColdFullBuild = fs.readFileSync(pdf).equals(fs.readFileSync(path.join(ref, outdir, 'main.pdf')));
    res.steps.synctexInputs = cp.execSync(`gunzip -c '${path.join(root, outdir, 'main.synctex.gz')}' | grep -a '^Input:[0-9]*:.' | grep -c shim || true`).toString().trim() + ' shim paths in synctex'; }

  // Preamble edit: the prewarmed process cannot be used this once; it recovers afterwards
  res.steps.preambleEdit = await timed('fs', 'main.tex', s => s.replace('\\title{', '\\title{New '));
  res.steps.afterPreambleEdit = await timed('fs', mainName, bump);

  // Edit a file the preamble reads: the prewarmed process has read the old content and must be discarded; the result must equal a from-scratch build
  if (fs.existsSync(path.join(root, 'macros.tex'))) {
    res.steps.preambleDepEdit = await timed('fs', 'macros.tex', s => s.replace('state of health', 'STATE OF HEALTH'));
    const ref = root + '-ref2'; fs.rmSync(ref, { recursive: true, force: true }); fs.cpSync(root, ref, { recursive: true });
    for (const f of fs.readdirSync(ref)) if (/^main\.(aux|toc|out|bbl|blg|log|pdf|synctex\.gz)$/.test(f)) fs.rmSync(path.join(ref, f));
    const d = new Date(); d.setHours(0, 0, 0, 0);
    const env = { ...process.env, PATH: process.env.PATH + ':/opt/homebrew/bin', SOURCE_DATE_EPOCH: String(Math.floor(d.getTime() / 1000)) };
    for (let i = 0; i < 3; i++) cp.execFileSync('tectonic', ['--synctex', '--keep-logs', '--keep-intermediates', ...refDraft, 'main.tex'], { cwd: ref, env, stdio: 'ignore' });
    res.steps.preambleDepMatchesCold = fs.readFileSync(pdf).equals(fs.readFileSync(path.join(ref, 'main.pdf')));
    res.steps.afterPreambleDepEdit = await timed('fs', mainName, bump);
  }

  const count = () => cp.execSync(`ps -axo command | grep '[t]ectonic --synctex' | grep -c '${root}' || true`).toString().trim();
  await sleep(1500); res.steps.standbyProcesses = count();
  await vscode.commands.executeCommand('tectonicWatch.stop'); await sleep(600);
  res.steps.processesAfterStop = count();
}
