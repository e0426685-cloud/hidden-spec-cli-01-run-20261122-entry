// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A file as lines: its line break, whether it ends with one, and its lines. (SPEC.md section 3.) */
interface FileLines {
  lines: string[];
  br: string;
  endsWithBreak: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', endsWithBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let endsWithBreak = false;
  if (text.endsWith(br)) {
    endsWithBreak = true;
    parts.pop();
  }
  return { lines: parts, br, endsWithBreak };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.endsWithBreak ? f.br : '');
}

/** One line of a replacement: a context line (written as the file's own line) or a new line. */
interface NewLine {
  text: string;
  ctx: boolean;
  oPos: number;
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** A line as a tier reads it: tier 0 exact, tier 1 trailing whitespace off, tier 2 both ends off. */
function tierLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trimEndWs(s);
  return trimBothWs(s);
}

/** Every 0-based position where O occurs in lines at a tier, searching from `from`. */
function findOccurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length - from) return out;
  const on = o.map((l) => tierLine(l, tier));
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (tierLine(lines[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; strict: 0 only) at which O occurs, with its positions. */
function firstTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/**
 * N as it is written: a context line is the file's own matched line, never the patch's; at tier 2 every other
 * line is re-indented from O's first line's leading whitespace to the file's first matched line's.
 */
function buildNewLines(n: NewLine[], fileLines: string[], at: number, oLines: string[], tier: number): string[] {
  const out: string[] = [];
  if (tier === 2) {
    const fLead = leadingWs(fileLines[at] ?? '');
    const pLead = leadingWs(oLines[0] ?? '');
    for (const item of n) {
      if (item.ctx) {
        out.push(fileLines[at + item.oPos]!);
        continue;
      }
      const t = item.text;
      if (t.trim() !== '' && t.startsWith(pLead)) out.push(fLead + t.slice(pLead.length));
      else out.push(t);
    }
    return out;
  }
  for (const item of n) {
    if (item.ctx) out.push(fileLines[at + item.oPos]!);
    else out.push(item.text);
  }
  return out;
}

/** What run() needs from a parser: the edits, and the moves they made, for the `R` output lines. */
interface ParseCtx {
  strict: boolean;
  moves: Array<[string, string]>;
}

/**
 * Apply one unified hunk to a file's lines: O (context and `-` lines) replaced by N (context and `+` lines),
 * taking the occurrence nearest to A - 1 + d; when O is empty, N is inserted after the first A + d lines.
 * Returns the change in line count. Throws Fail('no-match', path) when O is nowhere at any tier.
 */
function applyHunk(
  f: FileLines,
  oLines: string[],
  nLines: NewLine[],
  a: number,
  d: number,
  strict: boolean,
  path: string,
  bsAfterLastAdded: boolean,
): number {
  if (oLines.length > 0) {
    const found = firstTier(f.lines, oLines, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = a - 1 + d;
    let at = found.occ[0]!;
    let bestDist = Math.abs(at - target);
    for (const cand of found.occ) {
      const dist = Math.abs(cand - target);
      if (dist < bestDist) {
        at = cand;
        bestDist = dist;
      }
    }
    const runsToEnd = at + oLines.length === f.lines.length;
    const built = buildNewLines(nLines, f.lines, at, oLines, found.tier);
    f.lines.splice(at, oLines.length, ...built);
    if (runsToEnd) f.endsWithBreak = !bsAfterLastAdded;
    return built.length - oLines.length;
  }
  const oldLen = f.lines.length;
  const pos = Math.max(0, Math.min(a + d, oldLen));
  const built = nLines.map((item) => item.text);
  f.lines.splice(pos, 0, ...built);
  if (pos === oldLen) f.endsWithBreak = !bsAfterLastAdded;
  return built.length;
}

/**
 * Apply one V4A chunk to a file's lines, searching from the cursor: the chunk takes the first occurrence of O
 * at or after the cursor, at the first tier with one (an end-of-file chunk only one that ends at the file's
 * last line); when O is empty, N is inserted at the cursor, or at the end of the file for an end-of-file chunk.
 * Returns the cursor: just after the lines written. Throws Fail('no-match', path).
 */
function applyVChunk(
  f: FileLines,
  oLines: string[],
  nLines: NewLine[],
  cursor: number,
  eof: boolean,
  strict: boolean,
  path: string,
): number {
  if (oLines.length > 0) {
    const tiers = strict ? [0] : [0, 1, 2];
    let tier = -1;
    let at = -1;
    for (const t of tiers) {
      const occ = findOccurrences(f.lines, oLines, t, cursor);
      const good = eof ? occ.filter((i) => i + oLines.length === f.lines.length) : occ;
      if (good.length > 0) {
        tier = t;
        at = good[0]!;
        break;
      }
    }
    if (tier < 0) throw new Fail('no-match', path);
    const built = buildNewLines(nLines, f.lines, at, oLines, tier);
    f.lines.splice(at, oLines.length, ...built);
    return at + built.length;
  }
  const pos = eof ? f.lines.length : cursor;
  const built = nLines.map((item) => item.text);
  f.lines.splice(pos, 0, ...built);
  return pos + built.length;
}

/** One body line of a unified hunk or a V4A chunk. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

/** A `--- ` / `+++ ` path: text after the four characters, up to the first tab, spaces removed. */
function dashPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

/** `diff --git a/<X> b/<Y>`, or null when the line is not of that form. */
function diffGitPaths(line: string): [string, string] | null {
  if (!line.startsWith('diff --git a/')) return null;
  const rest = line.slice('diff --git a/'.length);
  const sep = rest.indexOf(' b/');
  if (sep < 0) return null;
  const x = rest.slice(0, sep);
  const y = rest.slice(sep + 3).replace(/[ \t]+$/, '');
  if (x === '' || y === '') return null;
  return [x, y];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Whether a line can be part of a hunk body: ` `, `-`, `+`, `\` or empty. */
function isBodyLine(l: string): boolean {
  return l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\';
}

/** A unified section's hunks applied to a file's lines, in order. */
function applyHunks(f: FileLines, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const oLines: string[] = [];
    const nLines: NewLine[] = [];
    for (const bl of h.body) {
      if (bl.kind === 'ctx') {
        oLines.push(bl.text);
        nLines.push({ text: bl.text, ctx: true, oPos: oLines.length - 1 });
      } else if (bl.kind === 'old') oLines.push(bl.text);
      else if (bl.kind === 'new') nLines.push({ text: bl.text, ctx: false, oPos: -1 });
    }
    let lastAdded = -1;
    for (let k = 0; k < h.body.length; k += 1) {
      if (h.body[k]!.kind === 'ctx' || h.body[k]!.kind === 'new') lastAdded = k;
    }
    const bsAfter = lastAdded >= 0 && h.body[lastAdded + 1]?.kind === 'bs';
    d += applyHunk(f, oLines, nLines, h.a, d, strict, path, bsAfter);
  }
}

/** Parse a unified diff patch into its sections' edits (SPEC.md section 6). */
function parseUnified(lines: string[], ctx: ParseCtx): Edit[] {
  const sections: UniSection[] = [];
  const n = lines.length;
  let i = 0;

  const newSection = (diffOld: string | null, diffNew: string | null): UniSection => {
    const s: UniSection = { oldPath: null, newPath: null, creation: false, deletion: false, hunks: [] };
    s.oldPath = diffOld;
    s.newPath = diffNew;
    sections.push(s);
    return s;
  };

  // State: 'outside' (no section yet), 'header' (in a section, before its first hunk),
  // 'between' (in a section, after at least one hunk).
  let state: 'outside' | 'header' | 'between' = 'outside';
  let cur: UniSection | null = null;
  let diffOld: string | null = null;
  let diffNew: string | null = null;
  let dashOld: string | null = null;
  let dashNew: string | null = null;
  let dashSeen = false;
  let renOld: string | null = null;
  let renNew: string | null = null;

  const finishSection = (): void => {
    if (cur === null) return;
    cur.oldPath = dashSeen ? dashOld : renOld ?? diffOld;
    cur.newPath = dashSeen ? dashNew : renNew ?? diffNew;
    cur = null;
  };

  const startDiffSection = (line: string, at: number): void => {
    const paths = diffGitPaths(line);
    if (paths === null) throw new Exit2(`error: parse ${at + 1}`);
    finishSection();
    diffOld = paths[0];
    diffNew = paths[1];
    dashOld = null;
    dashNew = null;
    dashSeen = false;
    renOld = null;
    renNew = null;
    cur = newSection(null, null);
    state = 'header';
  };

  const startDashSection = (at: number): void => {
    // lines[at] is `--- ` and lines[at + 1] starts with `+++ `.
    finishSection();
    diffOld = null;
    diffNew = null;
    dashOld = null;
    dashNew = null;
    dashSeen = false;
    renOld = null;
    renNew = null;
    cur = newSection(null, null);
    state = 'header';
    dashOld = dashPath(lines[at]!);
    dashNew = dashPath(lines[at + 1]!);
    dashSeen = true;
    i = at + 2;
  };

  const parseHunkBody = (at: number): Hunk => {
    // lines[at] is a valid hunk header; returns the hunk and advances i past its body.
    const m = HUNK_RE.exec(lines[at]!)!;
    const hunk: Hunk = { a: Number(m[1]), body: [] };
    let j = at + 1;
    while (j < n) {
      const l = lines[j]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      if (!isBodyLine(l)) break;
      if (l === '') hunk.body.push({ kind: 'ctx', text: '' });
      else if (l[0] === ' ') hunk.body.push({ kind: 'ctx', text: l.slice(1) });
      else if (l[0] === '-') hunk.body.push({ kind: 'old', text: l.slice(1) });
      else if (l[0] === '+') hunk.body.push({ kind: 'new', text: l.slice(1) });
      else hunk.body.push({ kind: 'bs', text: l.slice(1) });
      j += 1;
    }
    while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.kind === 'ctx' && hunk.body[hunk.body.length - 1]!.text === '' && lines[j - 1] === '') {
      // Empty lines at the end of a body are not part of it: drop trailing empty context lines that
      // came from truly empty patch lines. A ` ` line (space only) is not empty, so it stays.
      hunk.body.pop();
      j -= 1;
    }
    i = j;
    return hunk;
  };

  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      startDiffSection(line, i);
      i += 1;
      continue;
    }
    if (state === 'outside') {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startDashSection(i);
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (state === 'header') {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          // The section's own header pair: it does not start a new section.
          dashOld = dashPath(line);
          dashNew = dashPath(lines[i + 1]!);
          dashSeen = true;
          i += 2;
          continue;
        }
        // Not followed by a `+++ ` line: a parse error naming the line after it.
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) {
        renOld = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        renNew = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur!.creation = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur!.deletion = true;
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        if (!HUNK_RE.test(line)) throw new Exit2(`error: parse ${i + 1}`);
        cur!.hunks.push(parseHunkBody(i));
        state = 'between';
        continue;
      }
      i += 1;
      continue;
    }
    // state === 'between': after at least one hunk, a `--- ` line followed by a `+++ ` line
    // starts a new section; other lines are prose, unless they open another hunk.
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startDashSection(i);
      continue;
    }
    if (line.startsWith('@@')) {
      if (!HUNK_RE.test(line)) throw new Exit2(`error: parse ${i + 1}`);
      cur!.hunks.push(parseHunkBody(i));
      continue;
    }
    i += 1;
  }
  finishSection();
  if (sections.length === 0) throw new Exit2('error: parse 1');

  return sections.map((sec) => {
    const oldPath = sec.oldPath;
    const newPath = sec.newPath;
    return (tree: Tree): void => {
      if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (newPath !== null && newPath !== oldPath && !safe(newPath)) throw new Fail('unsafe', newPath);
      if (oldPath === null || sec.creation) {
        // Creation: the new path does not exist; the file is the `+` lines of all its hunks.
        const target = newPath ?? '';
        if (target === '') throw new Fail('unsafe', target);
        if (tree.get(target) !== null) throw new Fail('exists', target);
        const plus: string[] = [];
        let endsWithBreak = true;
        let lastPlusBs = false;
        let sawPlus = false;
        for (const h of sec.hunks) {
          for (let k = 0; k < h.body.length; k += 1) {
            const bl = h.body[k]!;
            if (bl.kind === 'new') {
              plus.push(bl.text);
              sawPlus = true;
              lastPlusBs = h.body[k + 1]?.kind === 'bs';
            }
          }
        }
        if (sawPlus) endsWithBreak = !lastPlusBs;
        tree.now.set(target, plus.length === 0 ? '' : `${plus.join('\n')}${endsWithBreak ? '\n' : ''}`);
        return;
      }
      if (newPath === null || sec.deletion) {
        // Deletion: the old path exists; its hunks are not read.
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
        return;
      }
      if (oldPath !== newPath) {
        // Move: hunks apply to the old file's lines; the result is written at the new path.
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const f = splitFile(before);
        applyHunks(f, sec.hunks, ctx.strict, oldPath);
        tree.now.set(oldPath, null);
        tree.now.set(newPath, joinFile(f));
        ctx.moves.push([oldPath, newPath]);
        return;
      }
      // Change of the one path.
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      const f = splitFile(before);
      applyHunks(f, sec.hunks, ctx.strict, oldPath);
      tree.now.set(oldPath, joinFile(f));
    };
  });
}

/** One SEARCH/REPLACE block's edit (SPEC.md section 7). */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = firstTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const nLines: NewLine[] = newLines.map((text) => ({ text, ctx: false, oPos: -1 }));
    const built = buildNewLines(nLines, f.lines, at, oldLines, found.tier);
    f.lines.splice(at, oldLines.length, ...built);
    tree.now.set(path, joinFile(f));
  };
}

/** Parse SEARCH/REPLACE blocks into their edits (SPEC.md section 7). */
function parseSearchReplace(lines: string[], ctx: ParseCtx): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!;
      if (blank(t)) continue;
      const trimmed = t.trim();
      if (trimmed.startsWith('```')) continue;
      path = trimmed;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = searchLine + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = sep + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(srEdit(path, lines.slice(searchLine + 1, sep), lines.slice(sep + 1, rep), ctx.strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

/** A V4A Update File section's chunks applied to a file's lines, with the cursor. */
function applyVChunks(
  f: FileLines,
  chunks: VChunk[],
  strict: boolean,
  path: string,
): void {
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      const tiers = strict ? [0] : [0, 1, 2];
      let found = -1;
      for (const t of tiers) {
        for (let k = cursor; k < f.lines.length; k += 1) {
          if (tierLine(f.lines[k]!, t) === tierLine(ch.anchor, t)) {
            found = k;
            break;
          }
        }
        if (found >= 0) break;
      }
      if (found < 0) throw new Fail('no-match', path);
      cursor = found + 1;
    }
    const oLines: string[] = [];
    const nLines: NewLine[] = [];
    for (const bl of ch.body) {
      if (bl.kind === 'ctx') {
        oLines.push(bl.text);
        nLines.push({ text: bl.text, ctx: true, oPos: oLines.length - 1 });
      } else if (bl.kind === 'old') oLines.push(bl.text);
      else if (bl.kind === 'new') nLines.push({ text: bl.text, ctx: false, oPos: -1 });
    }
    cursor = applyVChunk(f, oLines, nLines, cursor, ch.eof, strict, path);
  }
}

/** Parse a V4A patch into its sections' edits (SPEC.md section 8). */
function parseV4a(lines: string[], ctx: ParseCtx): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i += 1;
    if (i >= last) break;
    const head = lines[i]!;
    const headNum = i + 1;
    if (head.startsWith('*** Add File: ') || head.startsWith('*** Delete File: ') || head.startsWith('*** Update File: ')) {
      const kind = head.startsWith('*** Add') ? 'add' : head.startsWith('*** Delete') ? 'delete' : 'update';
      const path = head.slice(head.indexOf(': ') + 2).trim();
      // The section's lines run to the next section start or `*** End Patch`; blank lines at
      // the end of the section are not part of it.
      let j = i + 1;
      while (j < last) {
        const l = lines[j]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        j += 1;
      }
      const raw: Array<{ text: string; num: number }> = [];
      for (let k = i + 1; k < j; k += 1) raw.push({ text: lines[k]!, num: k + 1 });
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      i = j;

      if (kind === 'add') {
        const fileLines: string[] = [];
        for (const item of raw) {
          if (item.text.startsWith('+')) fileLines.push(item.text.slice(1));
          else if (item.text === '') fileLines.push('');
          else throw new Exit2(`error: parse ${item.num}`);
        }
        edits.push(((p, fl) => (tree: Tree): void => {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (tree.get(p) !== null) throw new Fail('exists', p);
          tree.now.set(p, fl.length === 0 ? '' : `${fl.join('\n')}\n`);
        })(path, fileLines));
        continue;
      }
      if (kind === 'delete') {
        if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.num}`);
        edits.push(((p) => (tree: Tree): void => {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (tree.get(p) === null) throw new Fail('missing', p);
          tree.now.set(p, null);
        })(path));
        continue;
      }
      // Update File: an optional `*** Move to:` first, then chunks.
      let moveTo: string | null = null;
      let idx = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const closeChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (; idx < raw.length; idx += 1) {
        const item = raw[idx]!;
        const t = item.text;
        if (t === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${item.num}`);
          cur.eof = true;
          closeChunk();
          continue;
        }
        if (t.startsWith('@@')) {
          closeChunk();
          const anchor = t.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          continue;
        }
        if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${item.num}`);
            cur = { anchor: null, body: [], eof: false };
          }
          if (t === '') cur.body.push({ kind: 'ctx', text: '' });
          else if (t[0] === ' ') cur.body.push({ kind: 'ctx', text: t.slice(1) });
          else if (t[0] === '-') cur.body.push({ kind: 'old', text: t.slice(1) });
          else cur.body.push({ kind: 'new', text: t.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${item.num}`);
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headNum}`);
      edits.push(((p, m, chs) => (tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (m !== null && !safe(m)) throw new Fail('unsafe', m);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (m !== null && tree.get(m) !== null) throw new Fail('exists', m);
        const f = splitFile(before);
        applyVChunks(f, chs, ctx.strict, p);
        const text = joinFile(f);
        if (m !== null) {
          tree.now.set(p, null);
          tree.now.set(m, text);
          ctx.moves.push([p, m]);
        } else {
          tree.now.set(p, text);
        }
      })(path, moveTo, chunks));
      continue;
    }
    throw new Exit2(`error: parse ${headNum}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Array<[string, string]> = [];
  const pctx: ParseCtx = { strict, moves };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, pctx);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, pctx);
    else edits = parseV4a(lines, pctx);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  // A move that succeeded reports as one `R <old> -> <new>` line, sorted by <new>, replacing that pair's
  // `D` and `A` lines; it only counts when the old path existed before and not after, and the new path
  // did not exist before and does after.
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) !== null && tree.original(newP) === null && tree.now.get(oldP) === null && tree.now.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort(byBytes)) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byBytes(a.key, b.key));
  const out: string[] = rows.map((r) => r.line);
  if (!check) {
    // Deletions first: a deleted path may be the parent directory of a path a move creates.
    for (const p of [...tree.now.keys()]) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()].sort(byBytes)) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
