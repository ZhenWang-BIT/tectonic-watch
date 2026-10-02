import * as pdfjsLib from './pdfjs/pdf.min.mjs';

const vscode = acquireVsCodeApi();
const scroller = document.getElementById('scroller');
const pageInfo = document.getElementById('page-info');
const banner = document.getElementById('banner');
const GAP = 12; // gap between pages; keep in sync with viewer.css

// A worker cannot be started from a resource URI inside a webview; fetch the script and turn it into a blob URL
const { worker: workerUrl, cmaps: cMapUrl, fonts: standardFontDataUrl } =
  document.querySelector('script[data-worker]').dataset;
const workerSrc = await (await fetch(workerUrl)).text();
pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(
  URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' })), { type: 'module' });

let doc = null;          // current PDFDocumentProxy
let sizes = [];          // [width, height] of each page at scale=1, in PDF points
let latest = null;       // latest { doc, sizes } received; may not be on screen yet
let pagesEl = document.getElementById('pages');
let zoom = 'fit';        // 'fit' or a number
let scale = 1;
let observer = null;
let loadSeq = 0;
let busy = 0;            // loads/layouts in progress; sync requests are held meanwhile
let pendingForward = null;
let layoutWidth = 0;     // available width at the last layout
const tasks = new Map(); // page element -> render task in progress

function computeScale(sz) {
  if (zoom !== 'fit') return zoom;
  const maxW = Math.max(...sz.map(s => s[0]));
  return Math.max(0.2, (scroller.clientWidth - 2 * GAP) / maxW);
}

// Which page the top of the viewport is on, and the relative position within it
function anchor() {
  const top = scroller.scrollTop;
  for (const el of pagesEl.children) {
    if (el.offsetTop + el.offsetHeight > top) {
      return { page: +el.dataset.page, frac: (top - el.offsetTop) / el.offsetHeight };
    }
  }
  return { page: 1, frac: 0 };
}

function makePageEl(i, sz, sc) {
  const el = document.createElement('div');
  el.className = 'page';
  el.dataset.page = i;
  el.style.width = `${Math.floor(sz[i - 1][0] * sc)}px`;
  el.style.height = `${Math.floor(sz[i - 1][1] * sc)}px`;
  // The pdf.js text layer derives font sizes and dimensions from these CSS variables
  el.style.setProperty('--total-scale-factor', sc);
  el.style.setProperty('--scale-round-x', '1px');
  el.style.setProperty('--scale-round-y', '1px');
  return el;
}

async function renderPage(d, i, el, sc) {
  if (el.querySelector('canvas') || tasks.has(el)) return;
  const job = { cancelled: false, render: null, text: null };
  tasks.set(el, job);
  try {
    const page = await d.getPage(i);
    if (job.cancelled) return;
    const dpr = window.devicePixelRatio || 1;
    const vp = page.getViewport({ scale: sc * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    job.render = page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp });
    await job.render.promise;
    if (job.cancelled) return;
    el.appendChild(canvas);

    // Transparent text layer: selectable for copying, and found by Cmd+F
    const textDiv = document.createElement('div');
    textDiv.className = 'textLayer';
    job.text = new pdfjsLib.TextLayer({
      textContentSource: page.streamTextContent(),
      container: textDiv,
      viewport: page.getViewport({ scale: sc }),
    });
    await job.text.render();
    if (job.cancelled) return;
    el.appendChild(textDiv);
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException' && !job.cancelled) console.error(e);
  } finally {
    if (tasks.get(el) === job) tasks.delete(el);
  }
}

function freePage(el) {
  const job = tasks.get(el);
  if (job) {
    job.cancelled = true;
    job.render?.cancel();
    job.text?.cancel();
    tasks.delete(el);
  }
  el.querySelector('canvas')?.remove();
  el.querySelector('.textLayer')?.remove();
}

function observe() {
  observer?.disconnect();
  // Pre-render two screens above and below the viewport; pages further away release their canvas and text layer to save memory
  observer = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) renderPage(doc, +e.target.dataset.page, e.target, scale);
      else freePage(e.target);
    }
  }, { root: scroller, rootMargin: '200% 0px' });
  for (const el of pagesEl.children) observer.observe(el);
}

// Rebuild the pages for a new document or zoom; draw the pages around the anchor first and then swap, to avoid a white flash
async function layout(newDoc, newSizes) {
  busy++;
  try {
    await doLayout(newDoc, newSizes);
  } finally {
    busy--;
  }
  if (!busy && pendingForward && doc) {
    const m = pendingForward;
    pendingForward = null;
    applyForward(m);
  }
}

async function doLayout(newDoc, newSizes) {
  const seq = ++loadSeq;
  const a = pagesEl.children.length ? anchor() : { page: 1, frac: 0 };
  const oldDoc = doc;
  const width = scroller.clientWidth;
  const sc = computeScale(newSizes);

  const fresh = document.createElement('div');
  fresh.id = 'pages';
  const els = [];
  for (let i = 1; i <= newSizes.length; i++) els.push(fresh.appendChild(makePageEl(i, newSizes, sc)));
  const p = Math.min(a.page, newSizes.length);
  const first = Math.max(1, p - 1);
  const last = Math.min(newSizes.length, p + 2);
  const pre = els.slice(first - 1, last);
  await Promise.all(pre.map((el, k) => renderPage(newDoc, first + k, el, sc)));
  if (seq !== loadSeq) { // a newer version or zoom arrived meanwhile; drop this one
    pre.forEach(freePage);
    if (newDoc !== doc && newDoc !== latest?.doc) destroyDoc(newDoc);
    return;
  }

  for (const el of pagesEl.children) freePage(el);
  pagesEl.replaceWith(fresh);
  pagesEl = fresh;
  doc = newDoc;
  sizes = newSizes;
  scale = sc;
  layoutWidth = width;
  const target = els[p - 1];
  scroller.scrollTop = target.offsetTop + a.frac * target.offsetHeight;
  observe();
  updatePageInfo();
  if (oldDoc && oldDoc !== newDoc) destroyDoc(oldDoc);
}

// Since pdf.js 6 the document object has no destroy(); release it through the loadingTask
function destroyDoc(d) {
  (d.loadingTask ?? d).destroy?.();
}

function toBytes(d) {
  if (d instanceof Uint8Array) return d;
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  if (Array.isArray(d?.data)) return Uint8Array.from(d.data); // {type:'Buffer', data:[...]}
  return Uint8Array.from(Object.values(d));
}

async function load(data) {
  // Font data (CMaps) is fetched on the main thread: the worker starts from a blob URL and may be blocked from reading webview resources cross-origin
  const newDoc = await pdfjsLib.getDocument({
    data: toBytes(data), isEvalSupported: false, cMapUrl, standardFontDataUrl, useWorkerFetch: false,
  }).promise;
  const newSizes = [];
  for (let i = 1; i <= newDoc.numPages; i++) {
    const vp = (await newDoc.getPage(i)).getViewport({ scale: 1 });
    newSizes.push([vp.width, vp.height]);
  }
  latest = { doc: newDoc, sizes: newSizes };
  await layout(newDoc, newSizes);
}

// Loading the PDF itself (parsing, reading page sizes) counts as busy too
async function loadTracked(data) {
  busy++;
  try {
    await load(data);
  } finally {
    busy--;
  }
}

function updatePageInfo() {
  if (!doc) return;
  const mid = scroller.scrollTop + scroller.clientHeight / 3;
  let cur = 1;
  for (const el of pagesEl.children) {
    if (el.offsetTop <= mid) cur = +el.dataset.page; else break;
  }
  pageInfo.textContent = `${cur} / ${doc.numPages}`;
}

function setZoom(z) {
  zoom = z;
  if (latest) layout(latest.doc, latest.sizes);
}

// Source -> PDF: scroll to the target (one third from the top of the viewport) and highlight it briefly
function applyForward(m) {
  const el = pagesEl.children[m.page - 1];
  if (!el) return;
  const top = el.offsetTop + m.y * scale;
  // After-build sync: do nothing when the change is already in view, so the preview does not jump on every build
  if (m.soft && top >= scroller.scrollTop && top + m.h * scale <= scroller.scrollTop + scroller.clientHeight) return;
  scroller.scrollTop = top - scroller.clientHeight / 3;
  const left = el.offsetLeft + m.x * scale;
  if (left < scroller.scrollLeft || left > scroller.scrollLeft + scroller.clientWidth - 40) {
    scroller.scrollLeft = left - 20;
  }
  document.querySelectorAll('.sync-mark').forEach(n => n.remove());
  const mark = document.createElement('div');
  mark.className = 'sync-mark';
  mark.style.left = `${m.x * scale - 3}px`;
  mark.style.top = `${m.y * scale - 2}px`;
  mark.style.width = `${m.w * scale + 6}px`;
  mark.style.height = `${m.h * scale + 4}px`;
  el.appendChild(mark);
  mark.addEventListener('animationend', () => mark.remove());
}

let bannerTimer;
function showBanner(msg, ok) {
  banner.textContent = msg;
  banner.className = ok ? 'ok' : 'fail';
  banner.hidden = false;
  clearTimeout(bannerTimer);
  if (ok) bannerTimer = setTimeout(() => { banner.hidden = true; }, 1500);
}

document.getElementById('zoom-in').onclick = () => setZoom(+(scale * 1.2).toFixed(3));
document.getElementById('zoom-out').onclick = () => setZoom(+(scale / 1.2).toFixed(3));
document.getElementById('fit').onclick = () => setZoom('fit');
scroller.addEventListener('scroll', updatePageInfo, { passive: true });

// Trackpad pinch and Cmd+wheel zoom: merge the stream of events and redraw once they pause
let wheelZoom = null;
let wheelTimer;
scroller.addEventListener('wheel', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  wheelZoom = (wheelZoom ?? scale) * (e.deltaY < 0 ? 1.1 : 1 / 1.1);
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => {
    setZoom(+Math.min(8, Math.max(0.2, wheelZoom)).toFixed(3));
    wheelZoom = null;
  }, 120);
}, { passive: false });

// PDF -> source: Cmd (Ctrl on Windows/Linux) + click, or double-click
function reverseSync(e) {
  const el = e.target.closest('.page');
  if (!el) return;
  e.preventDefault();
  const r = el.getBoundingClientRect();
  vscode.postMessage({
    type: 'reverse',
    page: +el.dataset.page,
    x: (e.clientX - r.left) / scale,
    y: (e.clientY - r.top) / scale,
    ...clickedText(e.clientX, e.clientY),
  });
}
scroller.addEventListener('click', e => {
  if (e.metaKey || e.ctrlKey) reverseSync(e);
});
scroller.addEventListener('dblclick', reverseSync);

// The run of text under the click and the index of the clicked character in it; SyncTeX only locates the line,
// and the extension uses this text to find the word within the source line. Returns an empty object when the click is not on text
function clickedText(x, y) {
  const caret = document.caretRangeFromPoint(x, y);
  const node = caret?.startContainer;
  if (node?.nodeType !== Node.TEXT_NODE || !node.parentElement?.closest('.textLayer')) return {};
  // The caret falls between characters; the clicked one may be before or after it, so check whose box contains the click
  const probe = document.createRange();
  for (const i of [caret.startOffset, caret.startOffset - 1]) {
    if (i < 0 || i >= node.length) continue;
    probe.setStart(node, i);
    probe.setEnd(node, i + 1);
    const b = probe.getBoundingClientRect();
    if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return { text: node.data, offset: i };
  }
  return {};
}

// Re-layout for "fit width" only when the width really changed (dragging the split, resizing the window);
// the notification ResizeObserver fires when it starts observing, and height changes, are ignored
let resizeTimer;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (latest && zoom === 'fit' && scroller.clientWidth !== layoutWidth) layout(latest.doc, latest.sizes);
  }, 150);
}).observe(scroller);

window.addEventListener('message', async ({ data: m }) => {
  if (m.type === 'load') {
    vscode.setState({ pdf: m.pdf, main: m.main });
    try {
      await loadTracked(m.data);
      banner.hidden = true;
    } catch (e) {
      showBanner(`Failed to parse the PDF: ${e.message}`, false);
    }
    if (!busy && pendingForward && doc) {
      const f = pendingForward;
      pendingForward = null;
      applyForward(f);
    }
  } else if (m.type === 'mode') {
    document.getElementById('draft-tag').hidden = !m.draft;
  } else if (m.type === 'unchanged') {
    banner.hidden = true;
  } else if (m.type === 'forward') {
    if (!doc || busy) pendingForward = m;
    else applyForward(m);
  } else if (m.type === 'status') {
    showBanner(m.msg, m.ok);
  }
});

vscode.postMessage({ type: 'ready' });
