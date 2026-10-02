import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { SHIM_PREFIX } from './warm';

// SyncTeX parser. Tectonic ships no synctex command-line tool, so .synctex(.gz) is read directly.
// Coordinates are converted to PDF points (bp), origin at the top-left of the page, y pointing down.

const VBOX = 1, HBOX = 2, VOID = 3, LEAF = 4;

// Record format: <type><tag>,<line>[,<col>]:<x>,<y>[:<W>[,<H>,<D>]]
const REC_RE = /^.(\d+),(-?\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/;

export interface SyncRect { page: number; x: number; y: number; w: number; h: number }
export interface SyncSource { file: string; line: number }

export class SyncData {
  readonly inputs = new Map<number, string>();
  // Stored column-wise to avoid hundreds of thousands of small objects
  kind: number[] = []; tag: number[] = []; line: number[] = []; page: number[] = [];
  x: number[] = []; y: number[] = []; w: number[] = []; h: number[] = []; d: number[] = [];
  parent: number[] = [];
  readonly pageRange = new Map<number, [number, number]>();

  // Source -> PDF: the line box of the first text produced by this line (adjacent lines are merged)
  forward(file: string, line: number): SyncRect | undefined {
    const tags = new Set<number>();
    for (const [t, f] of this.inputs) if (samePath(f, file)) tags.add(t);
    if (tags.size === 0) return undefined;

    // The line produced no output (blank line, comment): try nearby lines, later ones first
    for (let delta = 0; delta <= 30; delta++) {
      for (const ln of delta === 0 ? [line] : [line + delta, line - delta]) {
        const hit = this.rectForLine(tags, ln);
        if (hit) return hit;
      }
    }
    return undefined;
  }

  private rectForLine(tags: Set<number>, ln: number): SyncRect | undefined {
    let page = Infinity;
    const leaves: number[] = [];
    const boxes: number[] = [];
    for (let i = 0; i < this.kind.length; i++) {
      if (this.line[i] !== ln || !tags.has(this.tag[i]) || this.page[i] > page) continue;
      if (this.page[i] < page) { page = this.page[i]; leaves.length = 0; boxes.length = 0; }
      (this.kind[i] === LEAF ? leaves : boxes).push(i);
    }
    if (page === Infinity) return undefined;

    // Prefer the line box containing the text records; if the box is too tall (a vertical box around a whole paragraph) fall back to a small box near the point
    const rects: [number, number, number, number][] = [];
    const seen = new Set<number>();
    for (const i of leaves.length ? leaves : boxes) {
      const p = this.kind[i] === LEAF ? this.parent[i] : i;
      if (p >= 0 && this.kind[p] !== VBOX && this.h[p] + this.d[p] < 40) {
        if (seen.has(p)) continue;
        seen.add(p);
        rects.push([this.x[p], this.y[p] - this.h[p], this.w[p], this.h[p] + this.d[p]]);
      } else {
        rects.push([this.x[i], this.y[i] - 8, Math.max(this.w[i], 20), 10]);
      }
    }
    // Take the topmost cluster of adjacent lines, so that output of the same source line elsewhere on the page (macro expansion) is not all boxed together
    rects.sort((a, b) => a[1] - b[1]);
    let [x0, y0, w0, h0] = rects[0];
    let x1 = x0 + w0, y1 = y0 + h0;
    for (const [x, y, w, h] of rects.slice(1)) {
      if (y > y1 + 6 || y1 - y0 > 150) break; // about a dozen lines at most
      x0 = Math.min(x0, x); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
    }
    return { page, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // PDF -> source: find the smallest line box containing the point, then the nearest text record in it
  reverse(page: number, px: number, py: number): SyncSource | undefined {
    const range = this.pageRange.get(page);
    if (!range) return undefined;
    const [s, e] = range;
    const known = (i: number) => this.inputs.has(this.tag[i]);

    let best = -1, bestArea = Infinity;
    for (let i = s; i < e; i++) {
      const k = this.kind[i];
      if (k !== HBOX && k !== VOID) continue;
      const x = this.x[i], y = this.y[i];
      if (px < x || px > x + this.w[i] || py < y - this.h[i] || py > y + this.d[i]) continue;
      const area = this.w[i] * (this.h[i] + this.d[i]);
      if (area < bestArea && known(i)) { best = i; bestArea = area; }
    }

    let leaf = -1;
    if (best >= 0) {
      // Prefer the nearest record to the left of the point (the start of the word under the cursor), else the nearest to the right
      let left = -Infinity, right = Infinity;
      for (let i = s; i < e; i++) {
        if (this.kind[i] !== LEAF || this.parent[i] !== best || !known(i)) continue;
        const x = this.x[i];
        if (x <= px && x > left) { left = x; leaf = i; }
      }
      if (leaf < 0) {
        for (let i = s; i < e; i++) {
          if (this.kind[i] !== LEAF || this.parent[i] !== best || !known(i)) continue;
          if (this.x[i] < right) { right = this.x[i]; leaf = i; }
        }
      }
      if (leaf < 0) leaf = best;
    } else {
      // The point is in no line box (margins etc.): take the nearest text record on the page, weighting vertical distance more
      let bestDist = Infinity;
      for (let i = s; i < e; i++) {
        if (this.kind[i] !== LEAF || !known(i)) continue;
        const dist = 3 * Math.abs(this.y[i] - py) + Math.abs(this.x[i] - px);
        if (dist < bestDist) { bestDist = dist; leaf = i; }
      }
    }
    if (leaf < 0) return undefined;
    return { file: this.inputs.get(this.tag[leaf])!, line: this.line[leaf] };
  }
}

function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  // macOS/Windows file systems are case-insensitive by default
  return process.platform !== 'linux' && a.toLowerCase() === b.toLowerCase();
}

// mainPath: in a prewarmed build the main file is read from a stand-in in a temp directory (see warm.ts); line numbers match, the path is mapped back to the main file
export function parseSynctex(text: string, baseDir: string, mainPath?: string): SyncData {
  const sd = new SyncData();
  let unit = 1, mag = 1000, xOff = 0, yOff = 0;
  let f = 0; // sp -> bp factor, known once Content is reached
  let page = 0, pageStart = 0;
  const stack: number[] = [];

  let pos = 0;
  while (pos < text.length) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = text.length;
    const ln = text.slice(pos, end);
    pos = end + 1;
    if (!ln) continue;
    const c = ln[0];

    if (c === '(' || c === '[' || c === 'h' || c === 'v' || c === 'k' || c === 'g' || c === '$' || c === 'x') {
      const m = REC_RE.exec(ln);
      if (!m) continue;
      const i = sd.kind.length;
      const box = c === '(' || c === '[';
      sd.kind.push(c === '[' ? VBOX : c === '(' ? HBOX : c === 'h' || c === 'v' ? VOID : LEAF);
      sd.tag.push(+m[1]);
      sd.line.push(+m[2]);
      sd.page.push(page);
      sd.x.push(+m[3] * f + xOff);
      sd.y.push(+m[4] * f + yOff);
      sd.w.push(m[5] ? +m[5] * f : 0);
      sd.h.push(m[6] ? +m[6] * f : 0);
      sd.d.push(m[7] ? +m[7] * f : 0);
      sd.parent.push(stack.length ? stack[stack.length - 1] : -1);
      if (box) stack.push(i);
    } else if (c === ')' || c === ']') {
      stack.pop();
    } else if (c === '{') {
      page = parseInt(ln.slice(1), 10);
      pageStart = sd.kind.length;
      stack.length = 0;
    } else if (c === '}') {
      sd.pageRange.set(page, [pageStart, sd.kind.length]);
    } else if (ln.startsWith('Input:')) {
      const m = /^Input:(\d+):(.*)$/.exec(ln);
      if (m && m[2]) {
        const file = path.resolve(baseDir, m[2]);
        const shim = mainPath && file.split(/[\\/]/).some(seg => seg.startsWith(SHIM_PREFIX));
        sd.inputs.set(+m[1], shim ? mainPath : file);
      }
    } else if (ln.startsWith('Unit:')) {
      unit = parseFloat(ln.slice(5)) || 1;
    } else if (ln.startsWith('Magnification:')) {
      mag = parseFloat(ln.slice(14)) || 1000;
    } else if (ln.startsWith('X Offset:')) {
      xOff = parseFloat(ln.slice(9)) || 0;
    } else if (ln.startsWith('Y Offset:')) {
      yOff = parseFloat(ln.slice(9)) || 0;
    } else if (ln.startsWith('Content:')) {
      f = unit * (mag / 1000) / 65536 * (72 / 72.27);
      xOff *= f;
      yOff *= f;
    }
  }
  return sd;
}

// Cached by modification time; parsed only when a jump actually needs it.
// srcDir is the working directory of the build; relative paths in the synctex file are resolved against it
let cache: { file: string; mtime: number; data: SyncData } | undefined;

export function loadSynctex(pdfPath: string, srcDir: string, mainPath?: string): SyncData | undefined {
  const base = pdfPath.replace(/\.pdf$/i, '');
  for (const file of [base + '.synctex.gz', base + '.synctex']) {
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { continue; }
    if (cache && cache.file === file && cache.mtime === st.mtimeMs) return cache.data;
    let buf = fs.readFileSync(file);
    if (file.endsWith('.gz')) buf = zlib.gunzipSync(buf);
    const data = parseSynctex(buf.toString('utf8'), srcDir, mainPath);
    cache = { file, mtime: st.mtimeMs, data };
    return data;
  }
  return undefined;
}
