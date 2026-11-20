/**
 * What's thin in a role or past life. No AI: these are plain checks, so
 * they're cheap, predictable, and an agent driving `ojs` can rely on them.
 * Dig (AI) turns the gaps into questions.
 */
import { findSection, sectionBullets, type Bullet, type PastLifeFile, type RoleFile } from "./role-file.ts";

export type GapKind =
  | "empty-section"
  | "project-without-outcome"
  | "no-numbers"
  | "vague-wording"
  | "skill-not-shown"
  | "to-confirm"
  | "still-to-ask";

export interface Gap {
  kind: GapKind;
  section?: string;
  subheading?: string;
  /** The bullet or skill the gap is about, when there is one. */
  detail?: string;
  message: string;
}

export interface Depth {
  bullets: number;
  projects: number;
  projectsWithOutcome: number;
  bulletsWithNumbers: number;
  stories: number;
  hardMoments: number;
  toConfirm: number;
  stillToAsk: number;
}

export interface GapReport {
  depth: Depth;
  gaps: Gap[];
}

const ROLE_CORE = ["Context", "What I owned", "Projects", "Achievements", "Hard moments", "Stories"];
const PAST_LIFE_CORE = ["What I did", "Transferable skills", "Stories", "Trade knowledge"];
const META = new Set(["to confirm", "still to ask"]);

const VAGUE = /^(worked on|helped( with| to)?|responsible for|involved in|assisted( with)?|participated in|contributed to|exposure to|duties included)\b/i;
const OUTCOME = /\b(outcome|result|impact|so that|which meant|led to|saved|cut|reduced|increased|grew|improved)\b/i;
// A number that isn't just a year on its own.
const NUMBER = /(\d+(\.\d+)?\s?(%|k|m|x|×|hours?|hrs?|days?|weeks?|minutes?|mins?|people|users|customers|£|\$|€))|([£$€]\s?\d)|(\b(?!(19|20)\d{2}\b)\d+(\.\d+)?\b)/i;

function bulletsIn(doc: RoleFile | PastLifeFile, heading: string): Bullet[] {
  const s = findSection(doc, heading);
  return s ? sectionBullets(s) : [];
}

function hasContent(doc: RoleFile | PastLifeFile, heading: string): boolean {
  const s = findSection(doc, heading);
  return Boolean(s && s.raw.split("\n").some((l) => l.trim() !== ""));
}

export function findGaps(doc: RoleFile | PastLifeFile): GapReport {
  const gaps: Gap[] = [];
  const isRole = doc.kind === "role";

  const bankBullets = doc.sections
    .filter((s) => !META.has(s.heading.trim().toLowerCase()))
    .flatMap((s) => sectionBullets(s).map((b) => ({ ...b, section: s.heading })));
  const toConfirm = bulletsIn(doc, "To confirm");
  const stillToAsk = bulletsIn(doc, "Still to ask");

  for (const h of isRole ? ROLE_CORE : PAST_LIFE_CORE) {
    if (!hasContent(doc, h)) gaps.push({ kind: "empty-section", section: h, message: `Nothing under "${h}" yet.` });
  }

  let projects = 0;
  let projectsWithOutcome = 0;
  if (isRole) {
    const byProject = new Map<string, Bullet[]>();
    for (const b of bulletsIn(doc, "Projects")) {
      if (!b.subheading) continue;
      byProject.set(b.subheading, [...(byProject.get(b.subheading) ?? []), b]);
    }
    // Projects with a heading but no bullets count too.
    const raw = findSection(doc, "Projects")?.raw ?? "";
    for (const m of raw.matchAll(/^### +(.+?)\s*$/gm)) if (!byProject.has(m[1]!)) byProject.set(m[1]!, []);
    projects = byProject.size;
    for (const [name, bs] of byProject) {
      if (bs.some((b) => OUTCOME.test(b.text))) projectsWithOutcome++;
      else gaps.push({ kind: "project-without-outcome", section: "Projects", subheading: name, message: `"${name}" has no outcome: what changed because of it?` });
    }
  }

  const withNumbers = bankBullets.filter((b) => NUMBER.test(b.text)).length;
  if (bankBullets.length > 0 && withNumbers === 0) {
    gaps.push({ kind: "no-numbers", message: "No numbers anywhere: scale, money, time, people, before and after." });
  }

  for (const b of bankBullets) {
    if (VAGUE.test(b.text)) {
      gaps.push({
        kind: "vague-wording",
        section: b.section,
        ...(b.subheading ? { subheading: b.subheading } : {}),
        detail: b.text,
        message: `Vague: "${b.text}". What exactly did you do?`,
      });
    }
  }

  if (isRole) {
    const body = doc.sections.filter((s) => !META.has(s.heading.trim().toLowerCase())).map((s) => s.raw).join("\n").toLowerCase();
    for (const skill of doc.frontMatter.skills) {
      if (!body.includes(skill.toLowerCase())) {
        gaps.push({ kind: "skill-not-shown", detail: skill, message: `${skill} is listed but never shown in use.` });
      }
    }
  }

  for (const b of toConfirm) gaps.push({ kind: "to-confirm", section: "To confirm", detail: b.text, message: `Confirm or reject: "${b.text}"` });
  for (const b of stillToAsk) gaps.push({ kind: "still-to-ask", section: "Still to ask", detail: b.text, message: b.text });

  return {
    depth: {
      bullets: bankBullets.length,
      projects,
      projectsWithOutcome,
      bulletsWithNumbers: withNumbers,
      stories: bulletsIn(doc, "Stories").length,
      hardMoments: isRole ? bulletsIn(doc, "Hard moments").length : 0,
      toConfirm: toConfirm.length,
      stillToAsk: stillToAsk.length,
    },
    gaps,
  };
}
