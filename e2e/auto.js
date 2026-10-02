const vscode = require('vscode'); const fs = require('fs'); const path = require('path'); const cp = require('child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));
exports.run = async () => {
  const res = { steps: {} };
  try { await main(res); } catch (e) { res.error = String((e && e.stack) || e); }
  fs.writeFileSync(process.env.TW_OUT, JSON.stringify(res, null, 1));
};
async function main(res) {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const mainPath = path.join(root, 'main.tex'), pdf = path.join(root, 'main.pdf');
  const api = await vscode.extensions.getExtension('zhenwang-bit.tectonic-watch').activate();
  const log = () => api.output();
  const labels = from => [...log().slice(from).matchAll(/^\[[^\]]+\] ([^:]+): /gm)].map(m => m[1]);
  const mtime = () => { try { return fs.statSync(pdf).mtimeMs; } catch { return 0; } };
  const quiet = async (ms = 4500) => { let last = log().length, t = Date.now(); while (Date.now() - t < ms) { await sleep(50); if (log().length !== last) { last = log().length; t = Date.now(); } } };
  res.autoSave = vscode.workspace.getConfiguration('files').get('autoSave') + ' ' + vscode.workspace.getConfiguration('files').get('autoSaveDelay');
  const doc = await vscode.workspace.openTextDocument(mainPath); const ed = await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand('tectonicWatch.start');
  const t = Date.now(); while (!mtime() && Date.now() - t < 60000) await sleep(50); await quiet();
  const line = doc.getText().split('\n').findIndex(l => l.includes('Marker sentence here') || l.includes('again.'));
  // Simulate typing: no explicit save, autosave triggers the builds
  const type = async (n, gap) => { for (let i = 0; i < n; i++) { await ed.edit(b => b.insert(new vscode.Position(line, 0), 'a')); await sleep(gap); } };
  for (const [n, gap] of [[1, 0], [10, 60], [10, 200], [25, 120]]) {
    const from = log().length, m0 = mtime(), t0 = Date.now();
    await type(n, gap); const tEnd = Date.now();
    let ms = -1; while (Date.now() - tEnd < 15000) { if (mtime() > m0 && !doc.isDirty) { ms = Date.now() - tEnd; break; } await sleep(5); }
    await quiet();
    const built = fs.readFileSync(mainPath, 'utf8') === doc.getText();
    res.steps[`type ${n} keys, ${gap}ms apart`] = { dirtyAfter: doc.isDirty, pdfUpdatedMsAfterLastKey: ms, mtimeAdvanced: mtime() > m0, builds: labels(from).length, lastBuilds: labels(from).slice(-3), diskMatchesEditor: built, tail: log().slice(-200).split('\n').slice(-3).join(' / ') };
  }
  res.procs = cp.execSync(`ps -axo command | grep '[t]ectonic --synctex' | grep -c '${root}' || true`).toString().trim();
  await vscode.commands.executeCommand('tectonicWatch.stop');
}
