// Word-level location. SyncTeX only records line numbers (the column field is always -1), so the column comes from matching text:
// the preview sends the run of PDF text under the click and the clicked character, and we look for the same text near the line SyncTeX reports.

export interface WordHit { line: number; start: number; end: number } // line is 0-based; start/end are columns within that line

const NEAR = 3; // SyncTeX can be off by a line or two inside a wrapped paragraph, so a few lines either side are searched too

const LIGATURES: Record<string, string> = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl' };
// Quotes and dashes are usually typed TeX-style in the source
const TEX_SPELLING: Record<string, string> = {
  '‘': '`', '’': "'", '“': '``', '”': "''", '–': '--', '—': '---',
};

const WORD_CHAR = /[\p{L}\p{N}]/u;
// Han, kana and Hangul are not space-delimited; a single character is enough to locate
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function plain(ch: string): string {
  if (ch === '­') return '';      // soft hyphen
  if (ch === ' ') return ' ';
  return LIGATURES[ch] ?? ch;
}

function texify(ch: string): string {
  return TEX_SPELLING[ch] ?? plain(ch);
}

// lines: the lines of the source file; line: the line SyncTeX reports (0-based);
// text: the run of PDF text under the click; offset: index of the clicked character in text (UTF-16)
export function locateWord(lines: string[], line: number, text: string, offset: number): WordHit | undefined {
  const cps = Array.from(text);
  let o = 0;
  for (let n = 0; o < cps.length && n + cps[o].length <= offset; o++) n += cps[o].length;
  if (o >= cps.length) return undefined;
  // A hyphen left by end-of-line hyphenation is not in the source
  if (cps.length > 1 && cps[cps.length - 1] === '-' && isLatin(cps[cps.length - 2])) cps.pop();
  o = Math.min(o, cps.length - 1);

  const order = [line];
  for (let d = 1; d <= NEAR; d++) order.push(line + d, line - d);
  const rows = order.filter(i => i >= 0 && i < lines.length);

  const hit = locateChar(lines, line, rows, cps, o);
  if (hit) {
    const [start, end] = wordRange(lines[hit[0]], hit[1]);
    return { line: hit[0], start, end };
  }
  // The clicked text is not in the source (macro output, equation numbers, ...): fall back to the nearest word in the same run that can be found.
  // Only the line SyncTeX reported is trusted here, not its neighbours
  for (let d = 1; d <= REACH; d++) {
    for (const i of [o - d, o + d]) {
      const near = i >= 0 && i < cps.length ? locateChar(lines, line, [line], cps, i) : undefined;
      if (!near) continue;
      const [start, end] = wordRange(lines[near[0]], near[1]);
      const col = i < o ? end : start;
      return { line: near[0], start: col, end: col };
    }
  }
  return undefined;
}

const CONTEXT = 12;// how many characters of context to match on each side at most
const REACH = 15;  // how far to fall back on each side when nothing matches

// Find the character cps[o] in the source; returns [line, column]
function locateChar(lines: string[], line: number, rows: number[], cps: string[], o: number): [number, number] | undefined {
  if (!cps[o].trim()) return undefined;
  const latin = isLatin(cps[o]);
  const cjk = CJK_CHAR.test(cps[o]);
  // Latin text must match whole words; matching part of a word lands inside other words ("ate" inside "estimate")
  let wa = o, wb = o + 1;
  if (latin) {
    while (wa > 0 && isLatin(cps[wa - 1])) wa--;
    while (wb < cps.length && isLatin(cps[wb])) wb++;
  }

  // Try contexts of different lengths. Longest first: it tells apart a word repeated on the same line;
  // shorter ones get around places where source and PDF differ (commands, line breaks, quotes)
  const spans: [number, number][] = [];
  for (let a = wa; a >= Math.max(0, wa - CONTEXT); a--) {
    for (let b = wb; b <= Math.min(cps.length, wb + CONTEXT); b++) spans.push([a, b]);
  }
  const lop = ([a, b]: [number, number]) => Math.abs((wa - a) - (b - wb));
  spans.sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]) || lop(p) - lop(q));

  // Second round, relaxed: the run may start or end in the middle of a word (end-of-line hyphenation)
  for (const relaxed of [false, true]) {
    if (relaxed && !(latin && (wa === 0 || wb === cps.length))) break;
    for (const [a, b] of spans) {
      for (const norm of [plain, texify]) {
        const pre = cps.slice(a, wa).map(norm).join('');
        const word = cps.slice(wa, wb).map(norm).join('');
        const needle = pre + word + cps.slice(wb, b).map(norm).join('');
        // A single punctuation mark occurs many times on a line and cannot locate anything by itself
        if (!word || (!latin && !cjk && needle.length < 2)) continue;
        for (const row of rows) {
          // A neighbouring line only counts with a long enough match, so we do not jump to a word that merely happens to be the same
          if (row !== line && needle.length < (latin ? 6 : 3)) continue;
          const src = lines[row];
          for (let at = src.indexOf(needle); at >= 0; at = src.indexOf(needle, at + 1)) {
            const ws = at + pre.length, we = ws + word.length;
            if (latin) {
              if (isLatinAt(src, ws - 1) && !(relaxed && wa === 0)) continue;
              if (isLatinAt(src, we) && !(relaxed && wb === cps.length)) continue;
            }
            return [row, ws + cps.slice(wa, o).map(norm).join('').length];
          }
        }
      }
    }
  }
  return undefined;
}

// Space-delimited text (letters, digits)
function isLatin(c: string): boolean {
  return WORD_CHAR.test(c) && !CJK_CHAR.test(c);
}

function isLatinAt(s: string, i: number): boolean {
  return i >= 0 && i < s.length && isLatin(s[i]);
}

// The range of the word at col. Chinese is segmented with Intl.Segmenter
function wordRange(src: string, col: number): [number, number] {
  try {
    for (const seg of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(src)) {
      if (col >= seg.index && col < seg.index + seg.segment.length) {
        if (seg.isWordLike) return [seg.index, seg.index + seg.segment.length];
        break;
      }
    }
  } catch { /* fall back to a single character when the runtime has no segmentation data */ }
  const cp = src.codePointAt(col);
  return [col, col + (cp !== undefined && cp > 0xffff ? 2 : 1)];
}
