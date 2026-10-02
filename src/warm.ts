import { spawn, execFileSync, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Prewarming: start a tectonic process ahead of time, let it read the preamble (packages and fonts loaded) and wait just before \begin{document}.
// When a file changes, the body is handed to it and typesetting continues, saving the preamble load on every build.
//
// Tectonic has no way to pause, so a named pipe is used:
// a stand-in for the main file is placed in a temp directory, containing the original preamble followed by two \input's:
//   tw-gate.tex is a named pipe; TeX blocks when opening it until someone opens the write end -- this is where it waits;
//   tw-body.tex is the body, written just before release, so it is always the latest content.
// The body is padded with as many comment lines as the preamble has lines, so line numbers match the original file and neither errors nor SyncTeX need translating.

export const SHIM_PREFIX = 'tectonic-watch-shim-';
export const GATE = 'tw-gate.tex';
export const BODY = 'tw-body.tex';

const BEGIN_DOC = '\\begin{document}';
const BEGIN_DOC_RE = /^[^%]*?\\begin\{document\}/;
// Output that is specific to prewarmed builds and does not affect the result:
// a pipe cannot seek, and tectonic reports that as an "error" once;
// the source directory is passed as a search path, search paths refuse absolute paths, so every probe for a non-existent font file during font lookup adds a warning
const NOISE = [
  /^error: input seek failed$/,
  /^caused by: Illegal seek/,
  /^warning: open of input .+ failed$/,
  /^caused by: access to the path .+ is forbidden$/,
];
const isNoise = (line: string) => NOISE.some(re => re.test(line.trim()));

export interface WarmSpec {
  main: string;            // the real main file
  exe: string;
  args: string[];          // full arguments for running inside the stand-in directory
  env: NodeJS.ProcessEnv;
  deps: string[];          // local files read during the preamble; if they change, the prewarmed process is stale
}

export interface Split { preamble: string; wrapper: string; body: string }

// Split the main file at \begin{document} into preamble and body. Read and written as bytes (latin1), whatever the file encoding
export function splitMain(text: string): Split | undefined {
  const lines = text.split('\n');
  const k = lines.findIndex(l => BEGIN_DOC_RE.test(l));
  if (k < 0) return undefined;
  const col = lines[k].indexOf(BEGIN_DOC);
  const head = lines.slice(0, k).map(l => l + '\n').join('') + lines[k].slice(0, col);
  // Use the primitive \input (\@@input in LaTeX): no file hooks, and the pipe is not opened an extra time to check that the file exists
  const input = '\\csname @@input\\endcsname ';
  return {
    preamble: head,
    wrapper: `${head}${input}${GATE} ${input}${BODY} \n`,
    body: '%\n'.repeat(k) + ' '.repeat(col) + lines[k].slice(col) + '\n' + lines.slice(k + 1).join('\n'),
  };
}

function stat(file: string): string {
  try {
    const s = fs.statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return '';
  }
}

export class Standby {
  exited = false;
  released = false;
  private pending = '';
  private sink: ((s: string) => void) | undefined;
  private buffered: string[] = [];
  private poll: NodeJS.Timeout | undefined;
  private readonly depStats: string;

  constructor(
    readonly proc: ChildProcess, readonly dir: string, readonly sig: string,
    readonly preamble: string, private deps: string[],
  ) {
    this.depStats = this.statDeps();
    const onData = (b: Buffer) => this.feed(b.toString());
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('error', () => this.finish());
    proc.on('close', () => this.finish());
  }

  private statDeps(): string {
    return this.deps.map(stat).join('|');
  }

  depsUnchanged(): boolean {
    return this.statDeps() === this.depStats;
  }

  // Forward output line by line, dropping the harmless noise caused by the pipe
  private feed(s: string) {
    this.pending += s;
    const cut = this.pending.lastIndexOf('\n') + 1;
    if (!cut) return;
    const whole = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    this.emit(whole.split('\n').filter(l => !isNoise(l)).join('\n'));
  }

  private emit(s: string) {
    if (!s) return;
    if (this.sink) this.sink(s);
    else this.buffered.push(s);
  }

  // Attach a consumer; output collected before release is delivered first
  attach(sink: (s: string) => void) {
    this.sink = sink;
    for (const s of this.buffered.splice(0)) sink(s);
  }

  // Release: write the body, then open the write end of the pipe.
  // Opened non-blocking: it fails (ENXIO) while the process has not reached the pipe yet, so retry every few milliseconds.
  // Keep going until the process exits, because tectonic stops at the pipe again when it reruns TeX (cross-references changed)
  release(body: string) {
    if (this.exited) return;
    fs.writeFileSync(path.join(this.dir, BODY), body, 'latin1');
    this.released = true;
    const gate = path.join(this.dir, GATE);
    const open = () => {
      try {
        fs.closeSync(fs.openSync(gate, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
      } catch { /* no reader yet */ }
    };
    open();
    this.poll = setInterval(open, 5);
  }

  kill() {
    if (!this.exited) this.proc.kill();
  }

  private finish() {
    if (this.exited) return;
    this.exited = true;
    clearInterval(this.poll);
    if (!isNoise(this.pending)) this.emit(this.pending);
    this.pending = '';
    fs.rm(this.dir, { recursive: true, force: true }, () => { /* if it cannot be removed, the sweep at next startup will get it */ });
  }
}

export class Warm {
  private slots = new Map<string, Standby>();
  readonly supported = process.platform !== 'win32'; // needs named pipes

  constructor() {
    if (this.supported) sweep();
  }

  private sig(spec: WarmSpec): string {
    return JSON.stringify([spec.exe, spec.args, spec.env.SOURCE_DATE_EPOCH, spec.env.PATH]);
  }

  private usable(s: Standby | undefined, spec: WarmSpec, split: Split): s is Standby {
    return !!s && !s.exited && s.sig === this.sig(spec) && s.preamble === split.preamble && s.depsUnchanged();
  }

  private read(spec: WarmSpec): Split | undefined {
    try {
      return splitMain(fs.readFileSync(spec.main, 'latin1'));
    } catch {
      return undefined;
    }
  }

  // Have a prewarmed process ready; leave an existing usable one alone
  park(key: string, spec: WarmSpec) {
    if (!this.supported) return;
    const split = this.read(spec);
    const cur = this.slots.get(key);
    if (split && this.usable(cur, spec, split)) return;
    this.drop(key);
    if (!split) return;
    let dir = '';
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), SHIM_PREFIX));
      fs.writeFileSync(path.join(dir, path.basename(spec.main)), split.wrapper, 'latin1');
      execFileSync('mkfifo', [path.join(dir, GATE)]);
      const proc = spawn(spec.exe, spec.args, { cwd: dir, env: spec.env });
      // Record the pids so that processes left behind by a crashed extension host are cleaned up at next startup
      fs.writeFileSync(path.join(dir, 'owner'), `${process.pid} ${proc.pid ?? 0}`);
      this.slots.set(key, new Standby(proc, dir, this.sig(spec), split.preamble, spec.deps));
    } catch {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Take the prewarmed process and release it. Returns undefined when the preamble or a file it read has changed, or the process has already exited (e.g. an error in the preamble); the caller then builds from scratch
  take(key: string, spec: WarmSpec): Standby | undefined {
    const s = this.slots.get(key);
    if (!s) return undefined;
    this.slots.delete(key);
    const split = this.read(spec);
    if (!split || !this.usable(s, spec, split)) {
      s.kill();
      return undefined;
    }
    try {
      s.release(split.body);
    } catch {
      s.kill();
      return undefined;
    }
    return s;
  }

  drop(key: string) {
    this.slots.get(key)?.kill();
    this.slots.delete(key);
  }

  // Keep only those matching the predicate; kill the rest
  keepOnly(pred: (key: string) => boolean) {
    for (const key of [...this.slots.keys()]) if (!pred(key)) this.drop(key);
  }

  dispose() {
    this.keepOnly(() => false);
  }
}

// Remove stand-in directories and processes parked at the pipe that a previous abnormal exit left behind
function sweep() {
  let names: string[];
  try {
    names = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(SHIM_PREFIX));
  } catch {
    return;
  }
  for (const name of names) {
    const dir = path.join(os.tmpdir(), name);
    try {
      const [owner, child] = fs.readFileSync(path.join(dir, 'owner'), 'utf8').split(' ').map(Number);
      if (alive(owner)) continue; // another window is using it
      if (child && alive(child) && /tectonic/.test(execFileSync('ps', ['-p', String(child), '-o', 'comm='], { encoding: 'utf8' }))) {
        process.kill(child);
      }
    } catch {
      // No owner file: creation was interrupted, or another window is creating it right now
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs < 60_000) continue;
      } catch {
        continue;
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function alive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
