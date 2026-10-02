const vscode = require('vscode'); const fs = require('fs'); const path = require('path'); const cp = require('child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));
exports.run = async () => { const res = {}; try { await main(res); } catch (e) { res.error = String((e && e.stack) || e); } fs.writeFileSync(process.env.TW_OUT, JSON.stringify(res, null, 1)); };
async function main(res) {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath; const mainPath = path.join(root, 'main.tex'), pdf = path.join(root, 'main.pdf');
  const api = await vscode.extensions.getExtension('zhenwang-bit.tectonic-watch').activate(); const log = () => api.output();
  const labels = from => [...log().slice(from).matchAll(/^\[[^\]]+\] ([^:]+): /gm)].map(m => m[1]);
  const count = () => cp.execSync(`ps -axo rss,command | grep '[t]ectonic --synctex' | grep '${root}' | awk '{printf "%d MB; ", $1/1024}'`).toString().trim() || 'none';
  const mtime = () => { try { return fs.statSync(pdf).mtimeMs; } catch { return 0; } };
  const doc = await vscode.workspace.openTextDocument(mainPath); const ed = await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand('tectonicWatch.start');
  const t = Date.now(); while (!mtime() && Date.now() - t < 60000) await sleep(50); await sleep(2500);
  res.afterStart = count();
  let from = log().length; const line = doc.getText().split('\n').findIndex(l => l.includes('soh{} again'));
  await ed.edit(b => b.insert(new vscode.Position(line, 0), 'a')); await doc.save(); await sleep(1500);
  res.afterDraftBeforeFinal = count();
  await sleep(6000); res.afterFinal = count(); res.builds1 = labels(from);
  await sleep(15000); res.afterIdle = count();   // prewarmIdleMinutes = 0.2 -> 12 s
  from = log().length;
  await ed.edit(b => b.insert(new vscode.Position(line, 0), 'b')); await sleep(1200); res.afterTyping = count();
  const m0 = mtime(), t0 = Date.now(); await doc.save(); while (mtime() <= m0 && Date.now() - t0 < 15000) await sleep(5);
  res.saveMsAfterIdleTyping = Date.now() - t0; await sleep(300); res.builds2 = labels(from);
  await vscode.commands.executeCommand('tectonicWatch.stop'); await sleep(500); res.afterStop = count();
}
