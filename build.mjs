import * as esbuild from 'esbuild';
import { copyFileSync, cpSync, mkdirSync } from 'node:fs';

await esbuild.build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  outfile: 'dist/extension.js',
  minify: true,
});

// pdf.js is copied into media/ as is and loaded directly by the webview
mkdirSync('media/pdfjs', { recursive: true });
for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
  copyFileSync(`node_modules/pdfjs-dist/build/${f}`, `media/pdfjs/${f}`);
}
// CMaps: CJK fonts embedded by character collection (Adobe-GB1 etc.), such as fandol, need them to display; pdf.js reads them on demand
cpSync('node_modules/pdfjs-dist/cmaps', 'media/pdfjs/cmaps', { recursive: true });
// Standard fonts: Latin fonts not embedded in figure PDFs (Helvetica, Times, ...) are displayed with these, also read on demand
cpSync('node_modules/pdfjs-dist/standard_fonts', 'media/pdfjs/standard_fonts', { recursive: true });
// pdf.js is Apache-2.0; the licence has to accompany redistribution
copyFileSync('node_modules/pdfjs-dist/LICENSE', 'media/pdfjs/LICENSE');
