import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  addBullets,
  applyImport,
  extractCvCached,
  ExtractedCv,
  extractedCvJsonSchema,
  ensureProfileDirs,
  ExtractError,
  extractText,
  addToDocuments,
  documentsDir,
  listDocuments,
  markImported,
  sha256File,
  type DocumentStatus,
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
  readProfileText,
  recordChange,
  correctProfile,
  planUndo,
  applyUndo,
  readHistory,
  type HistoryEntry,
  type Profile,
  type ProfileEntry,
  type Source,
} from "@ojs/core";

export interface ProfileFlags {
  json: boolean;
  provider?: string;
  paste?: boolean;
  extracted?: string;
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
  as?: string;
  source?: string;
  text?: string[];
  "dry-run"?: boolean;
  find?: string;
  replace?: string;
  remove?: boolean;
  limit?: string;
}

type Out = (human: string, data: unknown) => void;

export const PROFILE_HELP = `Profile commands:
  profile [show] [role]       Overview, or one role / past life in full
  profile gaps [role]         What's missing: outcomes, numbers, hard moments, open questions
  profile add role            New role file: --employer --title --start YYYY-MM [--end] [--type] [--location] [--industry]
  profile add past-life       New past life: --field "Hospitality" [--title "Bartender"]
  profile add-bullets <role>  Append to a role: --section <heading> [--sub <project>] [--as <position>] --source <s> --text "..." [--text ...] [--dry-run]
                              sources: cv | linkedin | dig | you | inferred (inferred only under "To confirm")
  profile edit [role]         Open in $EDITOR (no role: profile.yaml), then check it
  profile correct <role|profile> --find "exact text" (--replace "new text" | --remove) [--dry-run]
                              Change or remove something that's wrong. --remove deletes the whole line
  profile history [role] [--limit n]   Every change to your profile, newest first
  profile undo [n] [--yes]    Reverse the latest change (or change #n). Shows it first; writes with --yes
  profile import [file]       Seed role files from a CV (PDF, DOCX, MD, TXT) using your AI provider.
                              No file: imports new or changed files in documents/
                              --paste (CV text on stdin)  --dry-run (preview only)  -y, --yes (write without asking)
                              --extracted <file|->  use an extraction you made yourself (agents), no AI call
  profile text <file>         The plain text of a CV file (PDF, DOCX, MD, TXT), for agents that can't read PDFs
  profile schema              JSON schema for --extracted
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

function overview(p: Profile, docs: DocumentStatus[]): string {
  const b = p.data.basics;
  const who = [b.name, b.headline, b.location].filter(Boolean).join(" · ");
  const lines = [`Profile: ${p.dir}`];
  if (who) lines.push("", who);
  const roles = p.roles.map((r) => ({ kind: "role" as const, ...r }));
  const lives = p.pastLives.map((r) => ({ kind: "past-life" as const, ...r }));
  const pending = docs.filter((d) => d.status !== "imported");
  const pendingNote = pending.length
    ? `${pending.length} new or changed file${pending.length === 1 ? "" : "s"} in documents/ (${pending.map((d) => d.file).join(", ")}). Run \`ojs profile import\`.`
    : "";
  if (!p.exists && roles.length === 0 && lives.length === 0) {
    return [
      `No profile yet in ${p.dir}.`,
      "",
      pendingNote ||
        `Put your CV (PDF, Word, Markdown or text) in\n  ${documentsDir()}\nand run \`ojs profile import\`.`,
      "",
      "Or start by hand:",
      '  ojs profile add role --employer "Acme" --title "Engineer" --start 2021-03',
      "  ojs profile edit        (your details and preferences)",
    ].join("\n");
  }
  lines.push("", "Roles:");
  if (roles.length === 0) lines.push("  none yet. `ojs profile add role`");
  for (const r of roles) lines.push(`  ${period(r).padEnd(19)} ${label(r).padEnd(24)} ${titles(r)}\n  ${"".padEnd(19)} ${depthLine(r)}   (${r.file})`);
  lines.push("", "Past lives:");
  if (lives.length === 0) lines.push("  none yet. `ojs profile add past-life --field ...`");
  for (const l of lives) lines.push(`  ${label(l).padEnd(24)} ${titles(l)}   ${depthLine(l)}   (${l.file})`);
  lines.push("", `Writing samples: ${p.writingSamples.length}`);
  lines.push("", pendingNote || "Next: `ojs profile gaps` to see what to dig into.");
  return lines.join("\n");
}

async function show(ref: string | undefined, out: Out): Promise<void> {
  const p = await loadProfile();
  if (ref) {
    const e = resolveEntry(p, ref);
    return out(renderProfileFile(e.doc), entryJson(e, true));
  }
  const docs = await listDocuments();
  out(overview(p, docs), {
    dir: p.dir,
    exists: p.exists,
    data: p.data,
    roles: p.roles.map((r) => entryJson({ kind: "role", ...r }, false)),
    pastLives: p.pastLives.map((l) => entryJson({ kind: "past-life", ...l }, false)),
    writingSamples: p.writingSamples,
    documents: docs.map(({ file, status }) => ({ file, status })),
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
    ...(f.as ? { position: f.as } : {}),
    texts: f.text ?? [],
    source: sourceFrom(f.source),
    dryRun: Boolean(f["dry-run"]),
  });
  const where = `${res.file} › ${res.section}${res.subheading ? ` › ${res.subheading}` : ""}`;
  out(`${res.written ? "Added to" : "Would add to"} ${where}:\n${res.lines.map((l) => `  ${l}`).join("\n")}`, res);
}

async function correctCmd(ref: string | undefined, f: ProfileFlags, out: Out): Promise<void> {
  if (!ref) throw new ProfileError('usage: ojs profile correct <role|profile> --find "exact text" (--replace "new text" | --remove)');
  const res = await correctProfile(ref, {
    find: f.find ?? "",
    ...(f.replace !== undefined ? { replace: f.replace } : {}),
    remove: Boolean(f.remove),
    dryRun: Boolean(f["dry-run"]),
  });
  const show = (ls: string[], mark: string) => (ls.length ? ls.map((l) => `  ${mark} ${l}`).join("\n") : `  ${mark} (line removed)`);
  out(`${res.written ? "Changed" : "Would change"} ${res.file}:\n${show(res.before, "-")}\n${show(res.after, "+")}`, res);
}

function entryText(e: HistoryEntry): string {
  const changed = e.hunks.flatMap((h) => h.lines.filter((l) => l.op !== " ").map((l) => `    ${l.op} ${l.text}`));
  const more = changed.length > 6 ? [`    … ${changed.length - 6} more line${changed.length - 6 === 1 ? "" : "s"}`] : [];
  return [`#${e.n}  ${e.when}  ${e.action}  ${e.file}${e.created ? " (new file)" : e.deleted ? " (deleted)" : ""}`, ...changed.slice(0, 6), ...more].join("\n");
}

async function historyCmd(ref: string | undefined, f: ProfileFlags, out: Out): Promise<void> {
  const dir = profileDir();
  let entries = await readHistory(dir);
  if (ref) {
    const rel = /^profile(\.ya?ml)?$/i.test(ref) ? PROFILE_FILE : await findEntryFile(ref, dir);
    entries = entries.filter((e) => e.file === rel);
  }
  const limit = f.limit ? Math.max(1, Number(f.limit) || 20) : 20;
  const shown = entries.slice(-limit).reverse();
  out(shown.length ? shown.map(entryText).join("\n\n") : "No changes yet.", { entries: shown, total: entries.length });
}

async function undoCmd(arg: string | undefined, f: ProfileFlags, out: Out): Promise<void> {
  const n = arg ? Number(arg.replace(/^#/, "")) : undefined;
  if (arg && !Number.isInteger(n)) throw new ProfileError("usage: ojs profile undo [n] [--yes]");
  const plan = await planUndo(profileDir(), n);
  const what = plan.text === null ? `remove ${plan.entry.file}, which it created` : `put ${plan.entry.file} back as it was before`;
  if (!f.yes) {
    return out(`Undoing #${plan.entry.n} would ${what}:\n\n${entryText(plan.entry)}\n\nRun again with --yes to undo it.`, { undo: plan.entry.n, file: plan.entry.file, removesFile: plan.text === null, written: false });
  }
  const done = await applyUndo(plan);
  out(`Undid #${plan.entry.n} (${plan.entry.action}, ${plan.entry.file}). Logged as #${done}.`, { undo: plan.entry.n, file: plan.entry.file, removesFile: plan.text === null, written: true, history: done });
}

async function edit(ref: string | undefined, f: ProfileFlags, out: Out): Promise<void> {
  if (f.json) throw new ProfileError("edit opens your editor, so it has no --json form. Use add-bullets to write from scripts.");
  const dir = profileDir();
  let rel = PROFILE_FILE;
  if (ref) rel = await findEntryFile(ref, dir);
  else await ensureProfileYaml(dir);

  const before = await readProfileText(dir, rel);
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  const [cmd, ...args] = editor.split(/\s+/);
  const result = spawnSync(cmd!, [...args, join(dir, rel)], { stdio: "inherit" });
  if (result.error) throw new ProfileError(`couldn't start your editor (${editor}): ${result.error.message}. Set $EDITOR.`);
  const n = await recordChange(dir, rel, before, await readProfileText(dir, rel), "edit");
  if (n === undefined) return out(`No changes to ${rel}.`, { file: rel, ok: true, changed: false });

  try {
    await loadProfile(dir);
    out(`Saved ${rel}. It checks out. (History #${n})`, { file: rel, ok: true, changed: true, history: n });
  } catch (err) {
    throw new ProfileError(`${(err as Error).message}\n\nFix it with \`ojs profile edit${ref ? ` ${ref}` : ""}\`, or put it back with \`ojs profile undo --yes\`.`);
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

interface ImportSource {
  label: string;
  text: string;
  /** A file (inside documents/ or not) or pasted text. */
  ref: { path: string; sha256: string } | { text: string; name: string };
}

interface ImportOutcome {
  human: string;
  data: Record<string, unknown>;
}

/** Make the source part of documents/ and remember it's been imported. */
async function recordSource(src: ImportSource): Promise<string> {
  const rel = await addToDocuments(documentsDir(), src.ref);
  const sha = "sha256" in src.ref ? src.ref.sha256 : await sha256File(join(documentsDir(), rel));
  await markImported(profileDir(), rel, sha);
  return rel;
}

/** Plan one source, show it, confirm, write. Never throws for "nothing new" or "declined". */
async function importOne(
  src: ImportSource,
  f: ProfileFlags,
  ai: { provider: ReturnType<typeof resolveProvider> } | { extracted: ExtractedCv },
  say: (m: string) => void,
): Promise<ImportOutcome> {
  let extracted: ExtractedCv;
  let providerId: string;
  if ("extracted" in ai) {
    extracted = ai.extracted;
    providerId = "agent";
  } else {
    say(`Sending ${src.text.length.toLocaleString("en-GB")} characters from ${src.label} to ${ai.provider.id} to pull out your roles. This can take a minute.`);
    const r = await extractCvCached(ai.provider, src.text);
    if (r.cached) say("(Using the result from last time for this exact text and provider.)");
    extracted = r.extracted;
    providerId = ai.provider.id;
  }

  const dir = profileDir();
  const profile = await loadProfile(dir);
  const yamlText = profile.exists ? await readFile(join(dir, PROFILE_FILE), "utf8") : undefined;
  const plan = planImport(profile, extracted, { kind: "cv" }, yamlText);
  const nothing = !plan.files.length && !plan.profileYaml;
  const summary = planSummary(plan);
  const data = (written: boolean, extra: Record<string, unknown> = {}) => ({
    source: src.label,
    provider: providerId,
    written,
    files: plan.files.map(({ text: _t, ...rest }) => rest),
    profileYaml: plan.profileYaml?.filled ?? [],
    skipped: plan.skipped,
    ...extra,
  });

  if (f["dry-run"]) return { human: `${summary}${nothing ? "" : "\n\nPreview only. Run again without --dry-run to write."}`, data: data(false) };
  if (nothing) {
    // Everything in it is already in the profile: a file counts as imported.
    if ("path" in src.ref) await recordSource(src);
    return { human: summary, data: data(false) };
  }

  let go = Boolean(f.yes);
  let shown = false;
  if (!go && !f.paste && !f.json && process.stdin.isTTY) {
    console.log(summary + "\n");
    shown = true;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("Write these? [Y/n] ")).trim().toLowerCase();
    rl.close();
    go = answer === "" || answer === "y" || answer === "yes";
    if (!go) return { human: "Nothing written.", data: data(false) };
  } else if (!go) {
    return { human: `${summary}\n\nNothing written yet. Run again with --yes to write (the AI result is cached, so it's instant).`, data: data(false) };
  }

  await applyImport(dir, plan, src.label);
  const rel = await recordSource(src);
  const where = "path" in src.ref && rel !== basename(src.ref.path) ? ` Saved a copy as documents/${rel}.` : "path" in src.ref ? "" : ` Saved the text as documents/${rel}.`;
  return { human: `${shown ? "" : summary + "\n\n"}Written.${where}`, data: data(true, { document: rel }) };
}

async function importCmd(file: string | undefined, f: ProfileFlags, out: Out): Promise<void> {
  const say = (msg: string) => {
    if (!f.json) console.error(msg);
  };
  const readFileSource = async (path: string, label = basename(path)): Promise<ImportSource> => {
    if ((await stat(path).catch(() => undefined))?.isDirectory()) {
      throw new ProfileError(`${label} is a folder. Importing a LinkedIn export folder isn't built yet; import your CV file for now.`);
    }
    const r = await extractText(path);
    say(`Read ${label}${r.pages ? ` (${r.pages} page${r.pages === 1 ? "" : "s"})` : ""} with ${r.method}.`);
    for (const w of r.warnings) say(`  note: ${w}`);
    return { label, text: r.text, ref: { path, sha256: await sha256File(path) } };
  };

  const readStdin = async () => tidy(await new Response(process.stdin as unknown as ReadableStream).text());
  let pre: ExtractedCv | undefined;
  if (f.extracted) {
    if (f.paste && f.extracted === "-") throw new ProfileError("--paste and --extracted - both read stdin; pass the extraction as a file instead");
    if (!file && !f.paste) throw new ProfileError("--extracted needs the source too: ojs profile import <file> --extracted <json|->");
    const raw = f.extracted === "-" ? await readStdin() : await readFile(f.extracted, "utf8");
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new ProfileError("--extracted is not valid JSON. See `ojs profile schema` for the shape.");
    }
    const parsed = ExtractedCv.safeParse(json);
    if (!parsed.success) throw new ProfileError(`--extracted doesn't match the schema (see \`ojs profile schema\`):\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
    pre = parsed.data;
  }
  const aiFor = async () => (pre ? { extracted: pre } : { provider: resolveProvider(await loadConfig(), f.provider) });

  if (f.paste) {
    const text = await readStdin();
    if (!text) throw new ProfileError("nothing on stdin. Pipe or paste your CV text, e.g. `pbpaste | ojs profile import --paste`");
    const r = await importOne({ label: "pasted text", text, ref: { text, name: "pasted-cv" } }, f, await aiFor(), say);
    return out(r.human, r.data);
  }

  if (file) {
    const src = await readFileSource(file);
    const r = await importOne(src, f, await aiFor(), say);
    return out(r.human + (r.data.written ? "\nNext: `ojs profile gaps` to see what to dig into." : ""), r.data);
  }

  // No file: import new or changed files in documents/.
  const docsDir = documentsDir();
  const pending = (await listDocuments(docsDir)).filter((d) => d.status !== "imported");
  if (pending.length === 0) {
    return out(`Nothing new in documents/. Put your CV (PDF, Word, Markdown or text) in:\n  ${docsDir}\nthen run \`ojs profile import\` again. Or import a file directly: \`ojs profile import <file>\`.`, {
      documents: docsDir,
      results: [],
    });
  }
  const provider = resolveProvider(await loadConfig(), f.provider);
  const human: string[] = [];
  const results: Record<string, unknown>[] = [];
  for (const doc of pending) {
    say(`\n── ${doc.file}${doc.status === "changed" ? " (changed)" : ""} ──`);
    try {
      const r = await importOne(await readFileSource(join(docsDir, doc.file), doc.file), f, { provider }, say);
      human.push(`── ${doc.file} ──\n${r.human}`);
      results.push(r.data);
    } catch (err) {
      if (!(err instanceof ProfileError || err instanceof ExtractError)) throw err;
      human.push(`── ${doc.file} ──\nSkipped: ${err.message}`);
      results.push({ source: doc.file, written: false, error: err.message });
    }
  }
  const wrote = results.some((r) => r.written);
  out(human.join("\n\n") + (wrote ? "\n\nNext: `ojs profile gaps` to see what to dig into." : ""), { documents: docsDir, results });
}

async function textCmd(file: string | undefined, out: Out): Promise<void> {
  if (!file) throw new ProfileError("usage: ojs profile text <file>");
  const r = await extractText(file);
  out(r.text, { file, method: r.method, ...(r.pages ? { pages: r.pages } : {}), warnings: r.warnings, text: r.text });
}

function schemaCmd(out: Out): void {
  const schema = extractedCvJsonSchema();
  out(JSON.stringify(schema, null, 2), schema);
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
    case "correct":
      return correctCmd(args[0], f, out);
    case "history":
      return historyCmd(args[0], f, out);
    case "undo":
      return undoCmd(args[0], f, out);
    case "import":
      return importCmd(args[0], f, out);
    case "text":
      return textCmd(args[0], out);
    case "schema":
      return schemaCmd(out);
    default:
      // `ojs profile acme` reads naturally as "show acme".
      return show(sub, out);
  }
}
