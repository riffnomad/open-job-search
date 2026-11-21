import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, parseProfileYaml, ProfileLoadError } from "../src/profile/load.ts";
import { ProfileFileError } from "../src/profile/role-file.ts";

const fixtures = join(import.meta.dir, "fixtures");
const dirs: string[] = [];
async function tempProfile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ojs-profile-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const role = (employer: string, start: string, end?: string) =>
  `---\nemployer: ${employer}\npositions:\n  - { title: Engineer, start: ${start}${end ? `, end: ${end}` : ""} }\n---\n\n## Context\n`;

describe("profile.yaml", () => {
  test("an empty file is a valid, empty profile", () => {
    const p = parseProfileYaml("");
    expect(p.version).toBe(1);
    expect(p.eligibility.workAuthorization).toEqual([]);
  });

  test("reads the full synthetic profile with defaults filled", async () => {
    const p = parseProfileYaml(await Bun.file(join(fixtures, "profile.yaml")).text());
    expect(p.basics.name).toBe("Sam Example");
    expect(p.languages[1]).toEqual({ language: "Spanish", level: "conversational" });
    expect(p.eligibility.workAuthorization.map((w) => w.status)).toEqual(["settled", "citizen"]);
    expect(p.eligibility.securityClearance[0]).toEqual({ country: "UK", level: "BPSS", active: true });
    expect(p.eligibility.noticePeriod).toBe("3 months");
  });

  test("readable errors", () => {
    expect(() => parseProfileYaml("basics: [")).toThrow(ProfileFileError);
    expect(() => parseProfileYaml("basics: [")).toThrow(/profile.yaml: not valid YAML/);
    expect(() => parseProfileYaml("languages:\n  - { language: French, level: amazing }")).toThrow(/level/);
    expect(() => parseProfileYaml("eligibility:\n  workAuthorization:\n    - { country: UK, status: maybe }")).toThrow(/status/);
    expect(() => parseProfileYaml("basics:\n  email: not-an-email")).toThrow(/email/);
  });
});

describe("loadProfile", () => {
  test("a missing directory loads as an empty profile", async () => {
    const p = await loadProfile(join(await tempProfile(), "nope"));
    expect(p.exists).toBe(false);
    expect(p.roles).toEqual([]);
    expect(p.pastLives).toEqual([]);
    expect(p.writingSamples).toEqual([]);
  });

  test("loads yaml, roles newest first, past lives and writing samples", async () => {
    const root = await tempProfile();
    const dir = join(root, "data", "sam", "profile");
    const samples = join(root, "documents", "sam", "writing-samples");
    await mkdir(dir, { recursive: true });
    await mkdir(samples, { recursive: true });
    await copyFile(join(fixtures, "profile.yaml"), join(dir, "profile.yaml"));
    await mkdir(join(dir, "roles"));
    await mkdir(join(dir, "past-lives"));
    await copyFile(join(fixtures, "role-acme.md"), join(dir, "roles", "2019-06-acme-logistics.md"));
    await writeFile(join(dir, "roles", "2023-09-northwind.md"), role("Northwind", "2023-09"));
    await writeFile(join(dir, "roles", "2014-01-old-co.md"), role("Old Co", "2014-01", "2016-05"));
    await writeFile(join(dir, "roles", "notes.txt"), "ignored");
    await writeFile(join(dir, "past-lives", "hospitality.md"), "---\nfield: Hospitality\n---\n");
    await writeFile(join(samples, "cover-letter.txt"), "Dear…");
    await writeFile(join(samples, ".DS_Store"), "");
    await writeFile(join(samples, "README.md"), "explains the folder");

    const p = await loadProfile(dir);
    expect(p.exists).toBe(true);
    expect(p.data.basics.name).toBe("Sam Example");
    expect(p.roles.map((r) => r.doc.frontMatter.employer)).toEqual(["Northwind", "Acme Logistics", "Old Co"]);
    expect(p.roles[1]!.file).toBe("roles/2019-06-acme-logistics.md");
    expect(p.pastLives[0]!.doc.frontMatter.field).toBe("Hospitality");
    expect(p.writingSamples).toEqual(["cover-letter.txt"]);
  });

  test("reports every broken file at once", async () => {
    const dir = await tempProfile();
    await writeFile(join(dir, "profile.yaml"), "languages:\n  - { language: French, level: amazing }");
    await mkdir(join(dir, "roles"));
    await writeFile(join(dir, "roles", "a.md"), "no front matter");
    await writeFile(join(dir, "roles", "b.md"), role("Fine", "2020-01"));
    await writeFile(join(dir, "roles", "c.md"), "---\nemployer: X\npositions: [{ title: T, start: 2020-13 }]\n---\n");
    try {
      await loadProfile(dir);
      throw new Error("expected an error");
    } catch (err) {
      expect(err).toBeInstanceOf(ProfileLoadError);
      const problems = (err as ProfileLoadError).problems;
      expect(problems).toHaveLength(3);
      expect(problems[0]).toStartWith("profile.yaml:");
      expect(problems[1]).toStartWith("roles/a.md:");
      expect(problems[2]).toStartWith("roles/c.md:");
      expect((err as Error).message).toContain("3 problems");
    }
  });
});
