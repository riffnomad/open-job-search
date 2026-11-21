import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findGaps, skillShown } from "../src/profile/gaps.ts";
import { loadProfile, parseProfileYaml } from "../src/profile/load.ts";
import { newProfileFile, parseProfileFile } from "../src/profile/role-file.ts";
import { readHistory } from "../src/profile/history.ts";
import { addBullets, createEntry, ensureProfileYaml, findEntryFile, PROFILE_YAML_TEMPLATE, ProfileError, resolveEntry } from "../src/profile/store.ts";

const fixtures = join(import.meta.dir, "fixtures");
const dirs: string[] = [];
async function temp(): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "ojs-store-")), "profile");
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(join(d, ".."), { recursive: true, force: true })));
});
const mode = async (p: string) => (await stat(p)).mode & 0o777;
const dig = { kind: "dig", date: "2026-11-22" } as const;

describe("createEntry", () => {
  test("creates a role file from front matter, private, with every heading", async () => {
    const dir = await temp();
    const { file } = await createEntry("role", { employer: "Northwind Ltd", positions: [{ title: "Barista", start: "2015-04" }] }, dir);
    expect(file).toBe("roles/2015-04-northwind-ltd.md");
    expect(await mode(join(dir, file))).toBe(0o600);
    expect(await mode(dir)).toBe(0o700);
    expect(await mode(join(dir, "history.md"))).toBe(0o600);
    expect((await readHistory(dir)).map((e) => [e.n, e.action, e.file, e.created])).toEqual([[1, "create", file, true]]);
    const doc = parseProfileFile("role", await readFile(join(dir, file), "utf8"));
    expect(doc.sections).toHaveLength(10);
  });

  test("past lives, and refusing duplicates or bad input", async () => {
    const dir = await temp();
    expect((await createEntry("past-life", { field: "Hospitality", roles: [{ title: "Bartender" }] }, dir)).file).toBe("past-lives/hospitality.md");
    await expect(createEntry("past-life", { field: "Hospitality" }, dir)).rejects.toThrow(/already exists/);
    await expect(createEntry("role", { employer: "X", positions: [{ title: "T", start: "May 2020" }] }, dir)).rejects.toThrow(/positions.0.start/);
  });
});

describe("addBullets", () => {
  async function withAcme() {
    const dir = await temp();
    await mkdir(join(dir, "roles"), { recursive: true });
    await copyFile(join(fixtures, "role-acme.md"), join(dir, "roles", "2019-06-acme-logistics.md"));
    return dir;
  }

  test("appends, logs the change in history.md, and keeps the file private", async () => {
    const dir = await withAcme();
    const before = await readFile(join(dir, "roles/2019-06-acme-logistics.md"), "utf8");
    const res = await addBullets("acme", { section: "Projects", subheading: "Depot dashboard", texts: ["Used daily by 40 depot managers."], source: dig }, dir);
    expect(res).toEqual({
      file: "roles/2019-06-acme-logistics.md",
      section: "Projects",
      subheading: "Depot dashboard",
      lines: ["- Used daily by 40 depot managers. [dig 2026-11-22]"],
      written: true,
    });
    const after = await readFile(join(dir, res.file), "utf8");
    expect(after).toContain("- Built the first dashboard for depot managers. [cv]\n- Used daily by 40 depot managers. [dig 2026-11-22]\n");
    expect(after.replace("- Used daily by 40 depot managers. [dig 2026-11-22]\n", "")).toBe(before);
    expect(await mode(join(dir, res.file))).toBe(0o600);
    const [entry, ...rest] = await readHistory(dir);
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ n: 1, action: "dig", file: res.file, created: false });
    expect(entry!.hunks.flatMap((h) => h.lines.filter((l) => l.op !== " "))).toEqual([{ op: "+", text: "- Used daily by 40 depot managers. [dig 2026-11-22]" }]);
    expect((await readdir(join(dir, "roles"))).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  test("dry run changes nothing", async () => {
    const dir = await withAcme();
    const before = await readFile(join(dir, "roles/2019-06-acme-logistics.md"), "utf8");
    const res = await addBullets("2019-06-acme-logistics", { section: "Stories", texts: ["A story."], source: { kind: "you" }, dryRun: true }, dir);
    expect(res.written).toBe(false);
    expect(res.lines).toEqual(["- A story. [you]"]);
    expect(await readFile(join(dir, "roles/2019-06-acme-logistics.md"), "utf8")).toBe(before);
    expect(await readHistory(dir)).toEqual([]);
  });

  test("guesses can only go under To confirm", async () => {
    const dir = await withAcme();
    await expect(addBullets("acme", { section: "Achievements", texts: ["Led the team."], source: { kind: "inferred", from: "cv" } }, dir)).rejects.toThrow(ProfileError);
    const ok = await addBullets("acme", { section: "To confirm", texts: ["Led the team."], source: { kind: "inferred", from: "cv" } }, dir);
    expect(ok.lines).toEqual(["- Led the team. [inferred from cv]"]);
  });

  test("rejects empty text", async () => {
    const dir = await withAcme();
    await expect(addBullets("acme", { section: "Stories", texts: ["  "], source: dig }, dir)).rejects.toThrow(/nothing to add/);
  });
});

describe("resolveEntry", () => {
  test("by file name, path, or part of the employer or field", async () => {
    const dir = await temp();
    await createEntry("role", { employer: "Acme Logistics", positions: [{ title: "Dev", start: "2019-06" }] }, dir);
    await createEntry("role", { employer: "Acme Foods", positions: [{ title: "Chef", start: "2012-01" }] }, dir);
    await createEntry("past-life", { field: "Carpentry" }, dir);
    const p = await loadProfile(dir);
    expect(resolveEntry(p, "2019-06-acme-logistics").file).toBe("roles/2019-06-acme-logistics.md");
    expect(resolveEntry(p, "roles/2012-01-acme-foods.md").file).toBe("roles/2012-01-acme-foods.md");
    expect(resolveEntry(p, "Acme Foods").file).toBe("roles/2012-01-acme-foods.md");
    expect(resolveEntry(p, "carp").kind).toBe("past-life");
    expect(() => resolveEntry(p, "acme")).toThrow(/more than one/);
    expect(() => resolveEntry(p, "globex")).toThrow(/no role or past life matches/);
  });
});

describe("findEntryFile", () => {
  test("finds files by name even when another file is broken", async () => {
    const dir = await temp();
    await createEntry("role", { employer: "Acme Logistics", positions: [{ title: "Dev", start: "2019-06" }] }, dir);
    await writeFile(join(dir, "profile.yaml"), "basics: [");
    await writeFile(join(dir, "roles", "2001-01-broken.md"), "not a role file");
    expect(await findEntryFile("acme", dir)).toBe("roles/2019-06-acme-logistics.md");
    expect(await findEntryFile("2001-01-broken", dir)).toBe("roles/2001-01-broken.md");
    await expect(findEntryFile("globex", dir)).rejects.toThrow(/no role or past life file matches/);
  });
});

describe("profile.yaml template", () => {
  test("is valid as written, and created only once", async () => {
    expect(parseProfileYaml(PROFILE_YAML_TEMPLATE).version).toBe(1);
    const dir = await temp();
    const path = await ensureProfileYaml(dir);
    expect(await mode(path)).toBe(0o600);
    await writeFile(path, "version: 1\nbasics: { name: Kept }\n");
    await ensureProfileYaml(dir);
    expect(await readFile(path, "utf8")).toContain("Kept");
  });
});

describe("findGaps", () => {
  test("on the synthetic role", async () => {
    const doc = parseProfileFile("role", await readFile(join(fixtures, "role-acme.md"), "utf8"));
    const { depth, gaps } = findGaps(doc);
    expect(depth).toEqual({ bullets: 3, projects: 2, projectsWithOutcome: 1, bulletsWithNumbers: 2, stories: 0, hardMoments: 0, toConfirm: 1, stillToAsk: 1 });
    const kinds = gaps.map((g) => `${g.kind}:${g.section ?? ""}:${g.subheading ?? g.detail ?? ""}`);
    expect(kinds).toEqual([
      "empty-section:What I owned:",
      "empty-section:Achievements:",
      "empty-section:Hard moments:",
      "empty-section:Stories:",
      "project-without-outcome:Projects:Depot dashboard",
      "skill-not-shown::TypeScript",
      "skill-not-shown::PostgreSQL",
      "to-confirm:To confirm:Probably mentored the two junior engineers.",
      "still-to-ask:Still to ask:What happened after the 2022 outage?",
    ]);
  });

  test("vague wording and no numbers; years don't count as numbers", () => {
    let doc = newProfileFile("role", { employer: "X", positions: [{ title: "T", start: "2020-01" }], type: "full-time", skills: [] });
    doc = { ...doc, sections: doc.sections.map((s) => (s.heading === "What I owned" ? { ...s, raw: "- Worked on the billing system in 2021.\n- Responsible for releases.\n- Helped the people made redundant with references, stayed in touch with them, and more.\n" } : s)) };
    const { gaps, depth } = findGaps(doc);
    expect(depth.bulletsWithNumbers).toBe(0);
    expect(gaps.filter((g) => g.kind === "vague-wording").map((g) => g.detail)).toEqual(["Worked on the billing system in 2021.", "Responsible for releases."]);
    expect(gaps.some((g) => g.kind === "no-numbers")).toBe(true);
  });

  test("past lives use their own sections", () => {
    const { gaps } = findGaps(newProfileFile("past-life", { field: "Hospitality", roles: [] }));
    expect(gaps.map((g) => g.section)).toEqual(["What I did", "Transferable skills", "Stories", "Trade knowledge"]);
  });

  test("a skill counts if any part of it shows: SAML / SSO, Anthropic/Claude, Stripe integration", () => {
    const body = "Added single sign-on (SAML) to the app. Switched the team to Claude. Built an integration with Stripe.";
    expect(skillShown("SAML / SSO", body)).toBe(true);
    expect(skillShown("Anthropic/Claude", body)).toBe(true);
    expect(skillShown("Stripe integration", body)).toBe(true);
    expect(skillShown("Kafka", body)).toBe(false);
    expect(skillShown("Go", "Going well")).toBe(false);
    expect(skillShown("C++", "Wrote C++ daily")).toBe(true);
  });

  test("outcomes in plain words count", () => {
    let doc = newProfileFile("role", { employer: "X", positions: [{ title: "T", start: "2020-01" }], skills: [] });
    const raw = "### Route planning\n- Used by every depot now.\n\n### Warehouse app\n- Shipped the scanner, after the pilot.\n";
    doc = { ...doc, sections: doc.sections.map((s) => (s.heading === "Projects" ? { ...s, raw } : s)) };
    const missing = findGaps(doc).gaps.filter((g) => g.kind === "project-without-outcome").map((g) => g.subheading);
    expect(missing).toEqual(["Warehouse app"]);
  });
});


describe("addBullets with a position", () => {
  test("matches part of a title, tags the line, and rejects unknown positions", async () => {
    const dir = await temp();
    await createEntry("role", { employer: "Acme", positions: [{ title: "Engineer", start: "2019-01" }, { title: "Team Lead, Payments", start: "2021-01" }] }, dir);
    const res = await addBullets("acme", { section: "What I owned", texts: ["Ran the team."], source: { kind: "dig", date: "2026-11-21" }, position: "team lead" }, dir);
    expect(res.position).toBe("Team Lead, Payments");
    expect(res.lines).toEqual(["- Ran the team. [dig 2026-11-21, as Team Lead, Payments]"]);
    expect(await readFile(join(dir, res.file), "utf8")).toContain("- Ran the team. [dig 2026-11-21, as Team Lead, Payments]");
    expect(addBullets("acme", { section: "What I owned", texts: ["x"], source: { kind: "cv" }, position: "CTO" }, dir)).rejects.toThrow(ProfileError);
  });
});
