import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  addBullets,
  applyImport,
  extractCvCached,
  extractText,
  keepSource,
  loadConfig,
  planImport,
  resolveProvider,
  tidy,
  type ImportPlan,
  createEntry,
  ensureProfileYaml,
  findEntryFile,
  findGaps,
  loadProfile,
  parseSource,
  PROFILE_FILE,
  ProfileError,
  profileDir,
  renderProfileFile,
  resolveEntry,
  sectionBullets,
  snapshot,
  type Profile,
  type ProfileEntry,
  type Source,
} from "@ojs/core";

export interface ProfileFlags {
  json: boolean;
  provider?: string;
  paste?: boolean;
  yes?: boolean;
  employer?: string;
  title?: string;
  start?: string;
  end?: string;
  type?: string;
  location?: string;
  industry?: string;
  field?: string;
  "front-matter"?: string;
  section?: string;
  sub?: string;
  source?: string;
  text?: string[];
  "dry-run"?: boolean;
}

type Out = (human: string, data: unknown) => void;

export const PROFILE_HELP = `Profile commands:
  profile [show] [role]       Overview, or one role / past life in full
  profile gaps [role]         What's missing: outcomes, numbers, hard moments, open questions
  profile add role            New role file: --employer --title --start YYYY-MM [--end] [--type] [--location] [--industry]
  profile add past-life       New past life: --field "Hospitality" [--title "Bartender"]
  profile add-bullets <role>  Append to a role: --section <heading> [--sub <project>] --source <s> --text "..." [--text ...] [--dry-run]
                              sources: cv | linkedin | dig | you | inferred (inferred only under "To confirm")
  profile edit [role]         Open in $EDITOR (no role: profile.yaml), then check it
  profile import <file>       Seed role files from a CV (PDF, DOCX, MD, TXT) using your AI provider
                              --paste (CV text on stdin)  --dry-run (preview only)  -y, --yes (write without asking)
`;

const today = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD

function sourceFrom(raw: string | undefined): Source {
  const s = (raw ?? "").trim();
  if (!s) throw new ProfileError("--source is required: cv | linkedin | dig | you | inferred");
  if (s === "dig") return { kind: "dig", date: today() };
  if (s === "inferred") return { kind: "inferred", from: "ai" };
  const parsed = parseSource(s);
  if (parsed.kind === "you" && s !== "you") throw new ProfileError(`unknown source "${s}": use cv | linkedin | dig | you | inferred`);
  return parsed;
}

function label(e: ProfileEntry): string {
  return e.kind === "role" ? e.doc.frontMatter.employer : e.doc.frontMatter.field;
}

function period(e: ProfileEntry): string {
  if (e.kind === "past-life") return e.doc.frontMatter.roles.map((r) => r.period).filter(Boolean).join(", ");
  const ps = e.doc.frontMatter.positions;
  const start = ps.map((p) => p.start).sort()[0]!;
  const end = ps.some((p) => !p.end) ? "now" : ps.map((p) => p.end!).sort().at(-1)!;
  return `${start} – ${end}`;
}

function titles(e: ProfileEntry): string {
  return e.kind === "role"
    ? e.doc.frontMatter.positions.map((p) => p.title).join(" → ")
    : e.doc.frontMatter.roles.map((r) => r.title).join(", ");
}

function entryJson(e: ProfileEntry, full: boolean) {
  const report = findGaps(e.doc);
  return {
    file: e.file,
    kind: e.kind,
    frontMatter: e.doc.frontMatter,
    depth: report.depth,
    gapCount: report.gaps.length,
    ...(full
      ? { sections: e.doc.sections.map((s) => ({ heading: s.heading, bullets: sectionBullets(s), text: s.raw.trim() })) }
      : {}),
  };
}

function depthLine(e: ProfileEntry): string {
  const { depth, gaps } = findGaps(e.doc);
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const parts = [n(depth.bullets, "bullet")];
  if (e.kind === "role") parts.push(n(depth.projects, "project"));
  parts.push(n(gaps.length, "gap"));
  return parts.join(" · ");
}

function overview(p: Profile): string {
  const b = p.data.basics;
  const who = [b.name, b.headline, b.location].filter(Boolean).join(" · ");
  const lines = [`Profile: ${p.dir}`];
  if (who) lines.push("", who);
  const roles = p.roles.map((r) => ({ kind: "role" as const, ...r }));
  const lives = p.pastLives.map((r) => ({ kind: "past-life" as const, ...r }));
  if (!p.exists && roles.length === 0 && lives.length === 0) {
    return [
      `No profile yet in ${p.dir}.`,
      "",
      "Start with a role:",
      '  ojs profile add role --employer "Acme" --title "Engineer" --start 2021-03',
      "or set your details and preferences:",
      "  ojs profile edit",
    ].join("\n");
  }
  lines.push("", "Roles:");
  if (roles.length === 0) lines.push("  none yet. `ojs profile add role`");
  for (const r of roles) lines.push(`  ${period(r).padEnd(19)} ${label(r).padEnd(24)} ${titles(r)}\n  ${"".padEnd(19)} ${depthLine(r)}   (${r.file})`);
  lines.push("", "Past lives:");
  if (lives.length === 0) lines.push("  none yet. `ojs profile add past-life --field ...`");
  for (const l of lives) lines.push(`  ${label(l).padEnd(24)} ${titles(l)}   ${depthLine(l)}   (${l.file})`);
  lines.push("", `Writing samples: ${p.writingSamples.length}`, "", "Next: `ojs profile gaps` to see what to dig into.");
  return lines.join("\n");
}

async function show(ref: string | undefined, out: Out): Promise<void> {
  const p = await loadProfile();
  if (ref) {
    const e = resolveEntry(p, ref);
    return out(renderProfileFile(e.doc), entryJson(e, true));
  }
  out(overview(p), {
    dir: p.dir,
    exists: p.exists,
    data: p.data,
    roles: p.roles.map((r) => entryJson({ kind: "role", ...r }, false)),
    pastLives: p.pastLives.map((l) => entryJson({ kind: "past-life", ...l }, false)),
    writingSamples: p.writingSamples,
  });
}

async function gaps(ref: string | undefined, out: Out): Promise<void> {
  const p = await loadProfile();
  const list: ProfileEntry[] = ref
    ? [resolveEntry(p, ref)]
    : [...p.roles.map((r) => ({ kind: "role" as const, ...r })), ...p.pastLives.map((l) => ({ kind: "past-life" as const, ...l }))];
  const reports = list.map((e) => ({ file: e.file, kind: e.kind, name: label(e), ...findGaps(e.doc) }));
  const human = reports.length
    ? reports
        .map((r) => [`${r.name}  (${r.file})`, ...(r.gaps.length ? r.gaps.map((g) => `  - ${g.message}`) : ["  Nothing obvious missing. Dig deeper for stories."])].join("\n"))
        .join("\n\n")
    : "No roles or past lives yet. `ojs profile add role` to start.";
  out(human, ref ? reports[0] : reports);
}

async function add(what: string | undefined, f: ProfileFlags, out: Out): Promise<void> {
  let frontMatter: unknown;
  if (f["front-matter"]) {
    try {
      frontMatter = JSON.parse(f["front-matter"]);
    } catch {
      throw new ProfileError("--front-matter must be JSON");
    }
  }
  if (what === "role") {
    frontMatter ??= {
      employer: f.employer,
      positions: [{ title: f.title, start: f.start, ...(f.end ? { end: f.end } : {}) }],
      ...(f.type ? { type: f.type } : {}),
      ...(f.location ? { location: f.location } : {}),
      ...(f.industry ? { industry: f.industry } : {}),
    };
  } else if (what === "past-life") {
    frontMatter ??= { field: f.field, roles: f.title ? [{ title: f.title }] : [] };
  } else {
    throw new ProfileError("usage: ojs profile add role|past-life [options]. See `ojs help`.");
  }
  const { file } = await createEntry(what, frontMatter);
  out(`Created ${join(profileDir(), file)}\nNext: \`ojs profile gaps ${file.split("/")[1]!.replace(/\.md$/, "")}\` or \`ojs profile edit ${file.split("/")[1]!.replace(/\.md$/, "")}\``, { file, path: join(profileDir(), file) });
}

async function addBulletsCmd(ref: string | undefined, f: ProfileFlags, out: Out): Promise<void> {
  if (!ref) throw new ProfileError('usage: ojs profile add-bullets <role> --section <heading> --source <s> --text "..."');
  if (!f.section) throw new ProfileError("--section is required, e.g. --section Projects");
  const res = await addBullets(ref, {
    section: f.section,
    ...(f.sub ? { subheading: f.sub } : {}),
    texts: f.text ?? [],
    source: sourceFrom(f.source),
    dryRun: Boolean(f["dry-run"]),
  });
  const where = `${res.file} › ${res.section}${res.subheading ? ` › ${res.subheading}` : ""}`;
  out(`${res.written ? "Added to" : "Would add to"} ${where}:\n${res.lines.map((l) => `  ${l}`).join("\n")}`, res);
}

async function edit(ref: string | undefined, f: ProfileFlags, out: Out): Promise<void> {
  if (f.json) throw new ProfileError("edit opens your editor, so it has no --json form. Use add-bullets to write from scripts.");
  const dir = profileDir();
  let rel = PROFILE_FILE;
  if (ref) rel = await findEntryFile(ref, dir);
  else await ensureProfileYaml(dir);

  const snap = await snapshot(dir, rel);
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  const [cmd, ...args] = editor.split(/\s+/);
  const result = spawnSync(cmd!, [...args, join(dir, rel)], { stdio: "inherit" });
  if (result.error) throw new ProfileError(`couldn't start your editor (${editor}): ${result.error.message}. Set $EDITOR.`);

  try {
    await loadProfile(dir);
    out(`Saved ${rel}. It checks out.`, { file: rel, ok: true });
  } catch (err) {
    const restore = snap ? `\nYour previous version is saved at ${snap}` : "";
    throw new ProfileError(`${(err as Error).message}\n\nFix it with \`ojs profile edit${ref ? ` ${ref}` : ""}\`.${restore}`);
  }
}

function planSummary(plan: ImportPlan): string {
  const lines: string[] = [];
  const creates = plan.files.filter((f) => f.action === "create");
  const updates = plan.files.filter((f) => f.action === "update");
  const confirmCount = (f: ImportPlan["files"][number]) => f.added.filter((a) => a.startsWith("To confirm:")).length;
  const describe = (f: ImportPlan["files"][number]) => {
    const toConfirm = confirmCount(f);
    const bullets = f.added.length - toConfirm;
    const parts = [`${bullets} bullet${bullets === 1 ? "" : "s"}`];
    if (toConfirm) parts.push(`${toConfirm} to confirm`);
    if (f.frontMatterChanges.length) parts.push(f.frontMatterChanges.join(", "));
    return `  ${f.file.padEnd(44)} ${parts.join(" · ")}`;
  };
  if (creates.length) lines.push("New role files:", ...creates.map(describe));
  if (updates.length) lines.push(...(lines.length ? [""] : []), "Adding to existing roles:", ...updates.map(describe));
  if (plan.profileYaml) lines.push(...(lines.length ? [""] : []), `profile.yaml: ${plan.profileYaml.filled.join(", ")}`);
  if (plan.skipped.length) lines.push(...(lines.length ? [""] : []), "Couldn't import:", ...plan.skipped.map((s) => `  ${s.what}: ${s.reason}`));
  if (!plan.files.length && !plan.profileYaml) lines.unshift("Nothing new: everything in this CV is already in your profile.");
  return lines.join("\n");
}

async function importCmd(file: string | undefined, f: ProfileFlags, out: Out): Promise<void> {
  const say = (msg: string) => {
    if (!f.json) console.error(msg);
  };
  let text: string;
  let label: string;
  let sourceRef: { path: string } | { text: string; name: string };
  if (f.paste) {
    text = tidy(await new Response(process.stdin as unknown as ReadableStream).text());
    if (!text) throw new ProfileError("nothing on stdin. Pipe or paste your CV text, e.g. `pbpaste | ojs profile import --paste`");
    label = "pasted text";
    sourceRef = { text, name: "pasted" };
  } else {
    if (!file) throw new ProfileError("usage: ojs profile import <cv.pdf|cv.docx|cv.md> [--dry-run] [--yes], or --paste");
    if ((await stat(file).catch(() => undefined))?.isDirectory()) {
      throw new ProfileError("importing a LinkedIn export folder isn't built yet. Import your CV file for now.");
    }
    const r = await extractText(file);
    text = r.text;
    label = basename(file);
    sourceRef = { path: file };
    say(`Read ${label}${r.pages ? ` (${r.pages} page${r.pages === 1 ? "" : "s"})` : ""} with ${r.method}.`);
    for (const w of r.warnings) say(`  note: ${w}`);
  }

  const provider = resolveProvider(await loadConfig(), f.provider);
  say(`Sending ${text.length.toLocaleString("en-GB")} characters to ${provider.id} to pull out your roles. This can take a minute.`);
  const { extracted, cached } = await extractCvCached(provider, text);
  if (cached) say("(Using the result from last time for this exact text and provider.)");

  const dir = profileDir();
  const profile = await loadProfile(dir);
  const yamlText = profile.exists ? await readFile(join(dir, PROFILE_FILE), "utf8") : undefined;
  const plan = planImport(profile, extracted, { kind: "cv" }, yamlText);
  const nothing = !plan.files.length && !plan.profileYaml;
  const summary = planSummary(plan);
  const data = (written: boolean) => ({
    source: label,
    provider: provider.id,
    written,
    files: plan.files.map(({ text: _t, ...rest }) => rest),
    profileYaml: plan.profileYaml?.filled ?? [],
    skipped: plan.skipped,
  });

  if (nothing || f["dry-run"]) return out(summary + (nothing ? "" : "\n\nPreview only. Run again without --dry-run to write."), data(false));

  let go = Boolean(f.yes);
  if (!go && !f.paste && !f.json && process.stdin.isTTY) {
    console.log(summary + "\n");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("Write these? [Y/n] ")).trim().toLowerCase();
    rl.close();
    go = answer === "" || answer === "y" || answer === "yes";
    if (!go) return out("Nothing written.", data(false));
  } else if (!go) {
    return out(`${summary}\n\nNothing written yet. Run again with --yes to write (the AI result is cached, so it's instant).`, data(false));
  }

  await applyImport(dir, plan);
  const kept = await keepSource(dir, sourceRef);
  const next = plan.files[0] ? `\nNext: \`ojs profile gaps\` to see what to dig into.` : "";
  out(`${f.json || !process.stdin.isTTY || f.yes ? summary + "\n\n" : ""}Written. A copy of the source is in ${kept}.${next}`, { ...data(true), kept });
}

export async function profileCommand(rest: string[], f: ProfileFlags, out: Out): Promise<void> {
  const [sub, ...args] = rest;
  switch (sub) {
    case undefined:
    case "show":
      return show(args[0], out);
    case "gaps":
      return gaps(args[0], out);
    case "add":
      return add(args[0], f, out);
    case "add-bullets":
      return addBulletsCmd(args[0], f, out);
    case "edit":
      return edit(args[0], f, out);
    case "import":
      return importCmd(args[0], f, out);
    default:
      // `ojs profile acme` reads naturally as "show acme".
      return show(sub, out);
  }
}
