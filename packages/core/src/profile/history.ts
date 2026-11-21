/**
 * One readable log of every change to the profile: data/profile/history.md.
 *
 * Each write appends an entry with a unified diff of just what changed, so the
 * log stays small (most changes are a line or two) and any change can be
 * reversed. Undo checks the file still has the lines it expects before
 * touching it, and is logged like any other change.
 *
 *   ## #12 · 2026-11-21 09:41:05 · dig · roles/2019-06-acme-logistics.md
 *
 *   ```diff
 *   @@ -84,1 +84,2 @@ ## People and leadership
 *    - Helped the 3 people... [dig 2026-11-21]
 *   +- Supported the people who stayed through the process. [dig 2026-11-21]
 *   ```
 *
 * Diff lines always start with a space, + or -, so a ``` or ## inside a
 * profile file can never break the log's own structure.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const HISTORY_FILE = "history.md";

const HEADER = "# Profile history\n\nEvery change to your profile, newest last. `ojs profile undo` reverses the latest one.\n";

export type DiffLine = { op: " " | "+" | "-"; text: string };
export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Nearest heading above the change, for reading only. */
  heading?: string;
  lines: DiffLine[];
}

export interface HistoryEntry {
  n: number;
  when: string;
  action: string;
  file: string;
  /** The file didn't exist before this change. */
  created: boolean;
  /** The file was deleted by this change. */
  deleted: boolean;
  hunks: Hunk[];
}

const CONTEXT = 2;
const MAX_CELLS = 4_000_000;

/** Line-level diff (LCS). Small files, so the simple DP is plenty. */
export function diffLines(before: string, after: string): Hunk[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (before === after) return [];

  // Trim the common start and end; the DP only runs on the middle.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);

  const ops: DiffLine[] = a.slice(0, pre).map((text) => ({ op: " ", text }));
  if (am.length * bm.length > MAX_CELLS) {
    ops.push(...am.map((text) => ({ op: "-" as const, text })), ...bm.map((text) => ({ op: "+" as const, text })));
  } else {
    const n = am.length;
    const m = bm.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = am[i] === bm[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) {
        ops.push({ op: " ", text: am[i]! });
        i++;
        j++;
      } else if (i < n && (j === m || dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
        ops.push({ op: "-", text: am[i]! });
        i++;
      } else {
        ops.push({ op: "+", text: bm[j]! });
        j++;
      }
    }
  }
  ops.push(...a.slice(a.length - suf).map((text) => ({ op: " " as const, text })));

  // Group changes into hunks with a little context.
  const hunks: Hunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  const pos: { old: number; new: number }[] = ops.map((o) => {
    const p = { old: oldLine, new: newLine };
    if (o.op !== "+") oldLine++;
    if (o.op !== "-") newLine++;
    return p;
  });
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.op === " ") {
      k++;
      continue;
    }
    let start = Math.max(0, k - CONTEXT);
    let end = k;
    // Extend while the next change is close enough to share context.
    for (;;) {
      while (end < ops.length && ops[end]!.op !== " ") end++;
      let gap = end;
      while (gap < ops.length && ops[gap]!.op === " " && gap - end < CONTEXT * 2) gap++;
      if (gap < ops.length && ops[gap]!.op !== " ") end = gap;
      else break;
    }
    end = Math.min(ops.length, end + CONTEXT);
    const lines = ops.slice(start, end);
    const first = pos[start]!;
    const hunk: Hunk = {
      oldStart: first.old,
      oldCount: lines.filter((l) => l.op !== "+").length,
      newStart: first.new,
      newCount: lines.filter((l) => l.op !== "-").length,
      lines,
    };
    for (let h = start - 1 + CONTEXT; h >= 0; h--) {
      const t = ops[h]!.op !== "+" ? ops[h]!.text : undefined;
      if (t && /^#{1,3} /.test(t)) {
        hunk.heading = t;
        break;
      }
    }
    hunks.push(hunk);
    k = end;
  }
  return hunks;
}

function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
}

export function formatEntry(e: Omit<HistoryEntry, "hunks"> & { hunks: Hunk[] }): string {
  const flag = e.created ? " (new file)" : e.deleted ? " (deleted)" : "";
  const body = e.hunks
    .map((h) => [`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@${h.heading ? ` ${h.heading}` : ""}`, ...h.lines.map((l) => `${l.op}${l.text}`)].join("\n"))
    .join("\n");
  return `\n## #${e.n} · ${e.when} · ${e.action} · ${e.file}${flag}\n\n\`\`\`diff\n${body}\n\`\`\`\n`;
}

const ENTRY = /^## #(\d+) · (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) · (.+) · (\S+?)( \(new file\)| \(deleted\))?$/;
const HUNK = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@(?: (.*))?$/;

export function parseHistory(text: string): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  let cur: HistoryEntry | undefined;
  let hunk: Hunk | undefined;
  let inFence = false;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (!inFence) {
      const m = ENTRY.exec(line);
      if (m) {
        cur = { n: Number(m[1]), when: m[2]!, action: m[3]!, file: m[4]!, created: m[5] === " (new file)", deleted: m[5] === " (deleted)", hunks: [] };
        out.push(cur);
        hunk = undefined;
      } else if (cur && line.startsWith("```")) inFence = true;
      continue;
    }
    if (line === "```") {
      inFence = false;
      continue;
    }
    const h = HUNK.exec(line);
    if (h && cur) {
      hunk = { oldStart: +h[1]!, oldCount: +h[2]!, newStart: +h[3]!, newCount: +h[4]!, ...(h[5] ? { heading: h[5] } : {}), lines: [] };
      cur.hunks.push(hunk);
    } else if (hunk) {
      // An empty line is an empty context line whose leading space got trimmed.
      const op = (line[0] ?? " ") as DiffLine["op"];
      hunk.lines.push({ op: op === "+" || op === "-" ? op : " ", text: line.slice(1) });
    }
  }
  return out;
}

export async function readHistory(dir: string): Promise<HistoryEntry[]> {
  try {
    return parseHistory(await readFile(join(dir, HISTORY_FILE), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Log a change. `before` null means the file is new; `after` null means it was
 * deleted. Returns the entry number, or undefined when nothing changed.
 */
export async function recordChange(
  dir: string,
  file: string,
  before: string | null,
  after: string | null,
  action: string,
  now = new Date(),
): Promise<number | undefined> {
  if (before === after) return undefined;
  const hunks = diffLines(before ?? "", after ?? "");
  if (!hunks.length) return undefined;
  const path = join(dir, HISTORY_FILE);
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch {
    // first entry
  }
  const entries = parseHistory(existing);
  const n = (entries.at(-1)?.n ?? 0) + 1;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const text = formatEntry({ n, when: stamp(now), action: action.replace(/\s+/g, " ").trim(), file, created: before === null, deleted: after === null, hunks });
  await appendFile(path, (existing ? "" : HEADER) + text, { mode: 0o600 });
  return n;
}

export class UndoError extends Error {
  override name = "UndoError";
}

/** Reverse a change on the file's current text. Throws if the file no longer has the lines the change made. */
export function reverseEntry(entry: HistoryEntry, current: string | null): string | null {
  if (entry.created) {
    const made = entry.hunks.flatMap((h) => h.lines.filter((l) => l.op !== "-").map((l) => l.text)).join("\n");
    if (current !== made) throw new UndoError(`${entry.file} has changed since #${entry.n} created it, so it can't be removed safely.`);
    return null;
  }
  if (current === null) {
    if (!entry.deleted) throw new UndoError(`${entry.file} no longer exists.`);
    return entry.hunks.flatMap((h) => h.lines.filter((l) => l.op !== "+").map((l) => l.text)).join("\n");
  }
  const lines = current.split("\n");
  // Bottom-up, so earlier positions stay valid.
  for (const h of [...entry.hunks].sort((x, y) => y.newStart - x.newStart)) {
    const want = h.lines.filter((l) => l.op !== "-").map((l) => l.text);
    const put = h.lines.filter((l) => l.op !== "+").map((l) => l.text);
    const at = (i: number) => want.every((t, k) => lines[i + k] === t);
    let idx = h.newCount === 0 ? h.newStart : h.newStart - 1;
    if (!at(idx)) {
      const found: number[] = [];
      for (let i = 0; i + want.length <= lines.length; i++) if (at(i)) found.push(i);
      if (found.length !== 1) throw new UndoError(`${entry.file} has changed since #${entry.n} where it touched it${h.heading ? ` (${h.heading})` : ""}, so it can't be reversed safely.`);
      idx = found[0]!;
    }
    lines.splice(idx, want.length, ...put);
  }
  return lines.join("\n");
}

/** The latest change that isn't an undo and hasn't been undone. */
export function undoTarget(entries: HistoryEntry[], n?: number): HistoryEntry {
  const undone = new Set(entries.flatMap((e) => /^undo #(\d+)$/.exec(e.action)?.[1] ?? []).map(Number));
  if (n !== undefined) {
    const e = entries.find((x) => x.n === n);
    if (!e) throw new UndoError(`there's no change #${n} in the history.`);
    if (/^undo #/.test(e.action)) throw new UndoError(`#${n} is itself an undo. Undo the change it reversed again instead.`);
    if (undone.has(n)) throw new UndoError(`#${n} has already been undone.`);
    return e;
  }
  const e = [...entries].reverse().find((x) => !/^undo #/.test(x.action) && !undone.has(x.n));
  if (!e) throw new UndoError("nothing to undo.");
  return e;
}
