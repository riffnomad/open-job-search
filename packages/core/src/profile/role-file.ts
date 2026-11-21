/**
 * Role and past-life files: Markdown with YAML front matter.
 *
 * The user owns these files and may edit them by hand, so parsing is
 * round-trip safe: `renderProfileFile(parseProfileFile(text))` returns the
 * same text, and the only way the tool changes a body is by appending
 * bullets (`appendBullets`). Unknown headings and free prose are kept.
 */
import { parse as parseYaml, stringify as stringifyYaml, YAMLParseError } from "yaml";
import { z } from "zod";
import { PartialDate } from "./dates.ts";

const yearMonth = PartialDate;

export const ROLE_TYPES = [
  "full-time",
  "part-time",
  "contract",
  "freelance",
  "internship",
  "apprenticeship",
  "volunteer",
  "project",
  "other",
] as const;

export const RoleFrontMatter = z.looseObject({
  employer: z.string().min(1),
  positions: z
    .array(
      z.object({
        title: z.string().min(1),
        start: yearMonth,
        end: yearMonth.optional(),
      }),
    )
    .min(1, "needs at least one position (title and start date)"),
  location: z.string().optional(),
  type: z.enum(ROLE_TYPES).optional(), // only when known; never assumed
  industry: z.string().optional(),
  skills: z.array(z.string()).default([]),
});
export type RoleFrontMatter = z.infer<typeof RoleFrontMatter>;

export const PastLifeFrontMatter = z.looseObject({
  field: z.string().min(1),
  roles: z
    .array(
      z.object({
        title: z.string().min(1),
        employer: z.string().optional(),
        period: z.string().optional(),
      }),
    )
    .default([]),
  skills: z.array(z.string()).optional(),
});
export type PastLifeFrontMatter = z.infer<typeof PastLifeFrontMatter>;

export const ROLE_SECTIONS = [
  "Context",
  "What I owned",
  "Projects",
  "Achievements",
  "Hard moments",
  "People and leadership",
  "Skills in depth",
  "Stories",
  "To confirm",
  "Still to ask",
] as const;

export const PAST_LIFE_SECTIONS = [
  "What I did",
  "Transferable skills",
  "Stories",
  "Trade knowledge",
  "To confirm",
  "Still to ask",
] as const;

export type FileKind = "role" | "past-life";

export type Source =
  | { kind: "cv" }
  | { kind: "linkedin" }
  | { kind: "you" }
  | { kind: "dig"; date: string }
  | { kind: "inferred"; from: string };

export interface Section {
  heading: string;
  /** The heading line exactly as written, without the newline. */
  headingLine: string;
  /** Everything after the heading line up to the next `## ` heading. */
  raw: string;
}

export interface ProfileFile<F> {
  kind: FileKind;
  frontMatter: F;
  /** Front matter YAML exactly as written (between the `---` lines). */
  frontMatterRaw: string;
  /** Text between the front matter and the first `## ` heading. */
  preamble: string;
  sections: Section[];
}

export type RoleFile = ProfileFile<RoleFrontMatter> & { kind: "role" };
export type PastLifeFile = ProfileFile<PastLifeFrontMatter> & { kind: "past-life" };

/** YAML reads an empty field (`salary:`) as null. Treat it as missing. */
export function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((v) => v !== null).map(dropNulls);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, dropNulls(v)]),
    );
  }
  return value;
}

export interface Bullet {
  text: string;
  source: Source;
  /** The `### ` heading the bullet sits under, if any (e.g. a project name). */
  subheading?: string;
  /** Which position at this employer the bullet belongs to, when the role has several. Written as `[cv, as <title>]`. */
  position?: string;
}

export class ProfileFileError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "ProfileFileError";
  }
}

const FENCE = /^\s*(```|~~~)/;
const H2 = /^## +(.+?)\s*#*\s*$/;
const H3 = /^### +(.+?)\s*#*\s*$/;
const BULLET = /^[-*+] +(.*)$/;
const TAG = /\s*\[(cv|linkedin|you|dig (\d{4}-\d{2}-\d{2})|inferred from ([^\]]+?))(?:, as ([^\]]+))?\]\s*$/;

export function parseProfileFile(kind: "role", text: string, file?: string): RoleFile;
export function parseProfileFile(kind: "past-life", text: string, file?: string): PastLifeFile;
export function parseProfileFile(kind: FileKind, text: string, file = "(profile file)"): ProfileFile<unknown> {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new ProfileFileError(file, "must start with front matter (a line with ---, the YAML fields, then ---)");
  }
  const close = normalized.indexOf("\n---\n", 3);
  const closeAtEnd = normalized.endsWith("\n---") ? normalized.length - 3 : -1;
  const end = close !== -1 ? close + 1 : closeAtEnd;
  if (end === -1) throw new ProfileFileError(file, "front matter is not closed with a --- line");

  const frontMatterRaw = normalized.slice(4, end);
  let data: unknown;
  try {
    data = parseYaml(frontMatterRaw) ?? {};
  } catch (err) {
    const msg = err instanceof YAMLParseError ? err.message.split("\n")[0]!.replace(/:\s*$/, "") : String(err);
    throw new ProfileFileError(file, `front matter is not valid YAML: ${msg}`);
  }
  const schema = kind === "role" ? RoleFrontMatter : PastLifeFrontMatter;
  const result = schema.safeParse(dropNulls(data));
  if (!result.success) {
    throw new ProfileFileError(file, `front matter is invalid:\n${z.prettifyError(result.error)}`);
  }

  const rest = normalized.slice(Math.min(end + 4, normalized.length));
  const { preamble, sections } = splitSections(rest);
  return { kind, frontMatter: result.data, frontMatterRaw, preamble, sections };
}

function splitSections(body: string): { preamble: string; sections: Section[] } {
  const lines = body.split("\n");
  const sections: Section[] = [];
  const preamble: string[] = [];
  let current: { heading: string; headingLine: string; lines: string[] } | undefined;
  let inFence = false;

  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;
    const h2 = !inFence ? H2.exec(line) : null;
    if (h2) {
      if (current) sections.push(finish(current));
      current = { heading: h2[1]!, headingLine: line, lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) sections.push(finish(current));
  // Re-joining with "\n" restores the newlines split() removed, except the
  // one between a block and the next heading, which belongs to the block.
  const pre = current ? (preamble.length ? preamble.join("\n") + "\n" : "") : preamble.join("\n");
  return { preamble: pre, sections };
}

function finish(s: { heading: string; headingLine: string; lines: string[] }): Section {
  return { heading: s.heading, headingLine: s.headingLine, raw: s.lines.join("\n") };
}

export function renderProfileFile(doc: ProfileFile<unknown>): string {
  const parts = [`---\n${doc.frontMatterRaw}---\n`, doc.preamble];
  doc.sections.forEach((s, i) => {
    parts.push(`${s.headingLine}\n${s.raw}`);
    if (i < doc.sections.length - 1) parts.push("\n");
  });
  return parts.join("");
}

/** Replace the front matter, re-serialising it. The body is untouched. */
export function withFrontMatter<D extends ProfileFile<unknown>>(doc: D, frontMatter: D["frontMatter"]): D {
  return { ...doc, frontMatter, frontMatterRaw: stringifyYaml(frontMatter) };
}

export function findSection(doc: ProfileFile<unknown>, heading: string): Section | undefined {
  const want = heading.trim().toLowerCase();
  return doc.sections.find((s) => s.heading.trim().toLowerCase() === want);
}

function sourceFromMatch(m: RegExpExecArray | null): Source {
  if (!m) return { kind: "you" };
  if (m[2]) return { kind: "dig", date: m[2] };
  if (m[3]) return { kind: "inferred", from: m[3].trim() };
  return { kind: m[1] as "cv" | "linkedin" | "you" };
}

/** Parse a tag like `cv`, `dig 2026-11-21` or `inferred from cv`. Unknown or missing means `you`. */
export function parseSource(tag: string | undefined): Source {
  return tag ? sourceFromMatch(TAG.exec(` [${tag}]`)) : { kind: "you" };
}

/**
 * Find the position a bullet belongs to, by title: exact match (ignoring case
 * and spacing) first, then a title that contains `ref`, if only one does.
 * Returns the title as written in the front matter, or undefined.
 */
export function matchPosition(titles: string[], ref: string): string | undefined {
  const n = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
  const want = n(ref);
  if (!want) return undefined;
  const exact = titles.find((t) => n(t) === want);
  if (exact) return exact;
  const partial = titles.filter((t) => n(t).includes(want));
  return partial.length === 1 ? partial[0] : undefined;
}

/** The tag at the end of a bullet: the source, plus the position when there is one. */
export function formatTag(source: Source, position?: string): string {
  const tag = formatSource(source);
  const pos = position?.replace(/[\[\]]/g, "").replace(/\s+/g, " ").trim();
  return pos ? `${tag.slice(0, -1)}, as ${pos}]` : tag;
}

export function formatSource(source: Source): string {
  switch (source.kind) {
    case "dig":
      return `[dig ${source.date}]`;
    case "inferred":
      return `[inferred from ${source.from}]`;
    default:
      return `[${source.kind}]`;
  }
}

/** Bullets in a section, with their source tag and `### ` subheading. Prose lines are skipped. */
export function sectionBullets(section: Section): Bullet[] {
  const bullets: Bullet[] = [];
  let sub: string | undefined;
  let current: string[] | undefined;
  let currentSub: string | undefined;
  let inFence = false;

  const flush = () => {
    if (!current) return;
    const joined = current.join(" ").replace(/\s+/g, " ").trim();
    const m = TAG.exec(joined);
    const text = m ? joined.slice(0, m.index).trim() : joined;
    const source = sourceFromMatch(m);
    const position = m?.[4]?.trim();
    if (text) bullets.push({ text, source, ...(currentSub ? { subheading: currentSub } : {}), ...(position ? { position } : {}) });
    current = undefined;
  };

  for (const line of section.raw.split("\n")) {
    if (FENCE.test(line)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h3 = H3.exec(line);
    const b = BULLET.exec(line);
    if (h3) {
      flush();
      sub = h3[1];
    } else if (b) {
      flush();
      current = [b[1]!];
      currentSub = sub;
    } else if (current && /^\s+\S/.test(line)) {
      current.push(line.trim());
    } else {
      flush();
    }
  }
  flush();
  return bullets;
}

function bulletLine(b: { text: string; source: Source; position?: string }): string {
  const text = b.text.replace(/\s+/g, " ").trim().replace(TAG, "");
  if (!text) throw new Error("bullet text is empty");
  return `- ${text} ${formatTag(b.source, b.position)}`;
}

/**
 * Append bullets to a section (optionally under a `### ` subheading).
 * Creates the section, in canonical order, if it doesn't exist. Every other
 * byte of the file is preserved.
 */
export function appendBullets<D extends ProfileFile<unknown>>(
  doc: D,
  heading: string,
  bullets: { text: string; source: Source; position?: string }[],
  opts: { subheading?: string } = {},
): D {
  if (bullets.length === 0) return doc;
  const newLines = bullets.map(bulletLine);
  const sections = doc.sections.slice();
  let idx = sections.findIndex((s) => s.heading.trim().toLowerCase() === heading.trim().toLowerCase());

  if (idx === -1) {
    const order: readonly string[] = doc.kind === "role" ? ROLE_SECTIONS : PAST_LIFE_SECTIONS;
    const rank = (h: string) => {
      const i = order.findIndex((o) => o.toLowerCase() === h.trim().toLowerCase());
      return i === -1 ? Number.POSITIVE_INFINITY : i;
    };
    const myRank = rank(heading);
    // Right after the nearest canonical section that comes before it, so it
    // sits next to its neighbour even when the user added custom sections.
    let insertAt = -1;
    sections.forEach((s, i) => {
      if (rank(s.heading) < myRank) insertAt = i + 1;
    });
    if (insertAt === -1) {
      insertAt = sections.findIndex((s) => Number.isFinite(rank(s.heading)));
      if (insertAt === -1) insertAt = sections.length;
    }
    const body = opts.subheading ? `### ${opts.subheading}\n${newLines.join("\n")}\n` : `${newLines.join("\n")}\n`;
    sections.splice(insertAt, 0, { heading, headingLine: `## ${heading}`, raw: body });
    let preamble = doc.preamble;
    if (sections.length === 1 && preamble && !preamble.endsWith("\n")) preamble += "\n";
    return { ...doc, preamble, sections };
  }

  const section = sections[idx]!;
  sections[idx] = { ...section, raw: insertIntoRaw(section.raw, newLines, opts.subheading) };
  return { ...doc, sections };
}

function insertIntoRaw(raw: string, newLines: string[], subheading?: string): string {
  const lines = raw.split("\n");
  let from = 0;
  let to = lines.length; // exclusive end of the block we append into

  if (subheading) {
    const want = subheading.trim().toLowerCase();
    let inFence = false;
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      if (FENCE.test(lines[i]!)) inFence = !inFence;
      const h3 = !inFence ? H3.exec(lines[i]!) : null;
      if (h3) {
        if (start !== -1) {
          to = i;
          break;
        }
        if (h3[1]!.trim().toLowerCase() === want) start = i;
      }
    }
    if (start === -1) {
      // New subsection at the end of the section.
      const block = [`### ${subheading}`, ...newLines];
      return insertAfterLastContent(lines, 0, lines.length, block, true);
    }
    from = start;
  }
  return insertAfterLastContent(lines, from, to, newLines, false);
}

function insertAfterLastContent(lines: string[], from: number, to: number, block: string[], separate: boolean): string {
  let last = to - 1;
  while (last >= from && lines[last]!.trim() === "") last--;
  const out = lines.slice();
  if (last < from) {
    // Empty block: keep one blank line after the heading if the template had one.
    const at = from + (lines[from]?.trim() === "" && from + 1 < to ? 1 : 0);
    out.splice(at, 0, ...block);
    if (to === lines.length && out[out.length - 1] !== "") out.push("");
    return out.join("\n");
  }
  out.splice(last + 1, 0, ...(separate ? ["", ...block] : block));
  if (to === lines.length && out[out.length - 1] !== "") out.push("");
  return out.join("\n");
}

/** A new file with the standard headings, ready to be filled. */
export function newProfileFile(kind: "role", frontMatter: RoleFrontMatter): RoleFile;
export function newProfileFile(kind: "past-life", frontMatter: PastLifeFrontMatter): PastLifeFile;
export function newProfileFile(kind: FileKind, frontMatter: RoleFrontMatter | PastLifeFrontMatter): ProfileFile<unknown> {
  const headings = kind === "role" ? ROLE_SECTIONS : PAST_LIFE_SECTIONS;
  return {
    kind,
    frontMatter,
    frontMatterRaw: stringifyYaml(frontMatter),
    preamble: "\n",
    sections: headings.map((h) => ({
      heading: h,
      headingLine: `## ${h}`,
      raw: "",
    })),
  };
}

export function slugify(text: string): string {
  return (
    text
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}

/** `2021-03-acme-logistics.md`: earliest position start + employer. */
export function roleFileName(fm: RoleFrontMatter): string {
  const start = fm.positions.map((p) => p.start).sort()[0]!;
  return `${start}-${slugify(fm.employer)}.md`;
}

export function pastLifeFileName(fm: PastLifeFrontMatter): string {
  return `${slugify(fm.field)}.md`;
}
