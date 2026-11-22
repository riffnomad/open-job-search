import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchDir } from "../src/paths.ts";
import { addPerson, addSearch, setFit, setTitles, titlesFor } from "../src/people.ts";
import { readHistory } from "../src/profile/history.ts";
import { checkTitles, matchTitle, Titles, titlesUnexplained } from "../src/titles.ts";

const titles = Titles.parse({
  core: ["Principal Software Engineer", "Staff Engineer"],
  related: [{ title: "Platform Architect", why: "Led the platform rebuild at Acme" }, "Solutions Architect"],
  open: [{ title: "Member of Technical Staff", if: "pay at or above target", why: "Flat orgs don't use levels" }],
  exclude: ["Junior", "Intern"],
});

describe("titles", () => {
  test("the lists alone decide only exact titles and exclude words", () => {
    expect(matchTitle("staff engineer", titles)).toEqual({ match: "core", title: "Staff Engineer" });
    expect(matchTitle("Platform Architect", titles)).toEqual({ match: "related", title: "Platform Architect" });
    expect(matchTitle("Member of Technical Staff", titles)).toEqual({ match: "open", title: "Member of Technical Staff", if: "pay at or above target" });
    expect(matchTitle("Junior Staff Engineer", titles)).toEqual({ match: "excluded", word: "Junior" });
    // Whole words only: "Internal" isn't "Intern".
    expect(matchTitle("Staff Engineer, Internal Tools", titles)).toEqual({ match: "none" });
    // Not decided here: a level above, or the same level with a specialism. Judged elsewhere.
    expect(matchTitle("Senior Staff Engineer", titles)).toEqual({ match: "none" });
    expect(matchTitle("Staff Software Engineer", titles)).toEqual({ match: "none" });
  });

  test("checks lists that fight each other, and asks why", () => {
    const t = Titles.parse({ core: ["Senior Engineer", "Staff Engineer"], related: ["staff engineer"], exclude: ["Senior"] });
    expect(checkTitles(t)).toEqual([
      `"Senior" rules a title out, but it's in "Senior Engineer" (core), so that would never show.`,
      `"staff engineer" is listed twice (core and related).`,
    ]);
    expect(titlesUnexplained(titles)).toEqual(["Solutions Architect"]);
    expect(() => Titles.parse({ open: [{ title: "Member of Technical Staff" }] })).toThrow();
  });
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("saving titles", () => {
  test("each list given replaces that list, in its own place in search.yaml, logged", async () => {
    const root = await mkdtemp(join(tmpdir(), "ojs-titles-"));
    roots.push(root);
    const env = { OJS_ROOT: root } as Record<string, string | undefined>;
    await addPerson("Sam", env);
    await expect(setTitles("core: [Staff Engineer]", env)).rejects.toThrow(/no search yet/);
    await addSearch("Engineering", { targetRoles: ["Staff engineer"] }, env);
    expect(await titlesFor(env)).toMatchObject({ empty: true, targetRoles: ["Staff engineer"] });

    const r = await setTitles("{core: [Staff Engineer], related: [Platform Architect], exclude: [Junior]}", env);
    expect(r).toMatchObject({ set: ["core", "related", "exclude"], empty: false, unexplained: ["Platform Architect"] });
    await setTitles("{open: [{title: Member of Technical Staff, if: pay at or above target}], related: null}", env);
    const v = await titlesFor(env);
    expect(v.titles).toEqual({ core: ["Staff Engineer"], related: [], open: [{ title: "Member of Technical Staff", if: "pay at or above target" }], exclude: ["Junior"] });

    const yaml = await readFile(join(searchDir(env), "search.yaml"), "utf8");
    expect(yaml).toContain("# titles: set with `ojs search titles`");
    expect(yaml.indexOf("titles:\n  core:")).toBeGreaterThan(yaml.indexOf("# titles:"));
    expect(yaml.indexOf("titles:\n  core:")).toBeLessThan(yaml.indexOf("# fit:"));
    expect(yaml).not.toContain("related:");

    // A fit saved afterwards leaves the titles alone.
    await setFit({ level: "good" }, env);
    expect((await titlesFor(env)).titles.core).toEqual(["Staff Engineer"]);

    expect((await readHistory(searchDir(env))).map((e) => e.action)).toEqual(["create", "titles: core, related, exclude", "titles: open, -related", "fit"]);
    await expect(setTitles("{open: [{title: MTS}]}", env)).rejects.toThrow(/nothing was saved/);
    await expect(setTitles("{levels: [x]}", env)).rejects.toThrow(/not a title list: levels/);
  });
});
