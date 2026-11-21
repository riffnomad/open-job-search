import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activePerson, PersonError, profileDir, searchDir } from "../src/paths.ts";
import { addPerson, addSearch, listPeople, migrateLegacy } from "../src/people.ts";
import { readHistory } from "../src/profile/history.ts";
import { parseProfileYaml } from "../src/profile/load.ts";
import { loadSearch } from "../src/search.ts";

const roots: string[] = [];
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "ojs-people-"));
  roots.push(root);
  return { OJS_ROOT: root } as Record<string, string | undefined>;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("people", () => {
  test("no one, one, then two: who's active", async () => {
    const env = await workspace();
    expect(() => activePerson(env)).toThrow(/ojs person add/);
    await addPerson("Sam", env);
    expect(activePerson(env)).toBe("sam");
    expect(profileDir(env)).toBe(join(env.OJS_ROOT!, "data", "sam", "profile"));
    expect(existsSync(join(env.OJS_ROOT!, "documents", "sam", "writing-samples"))).toBe(true);
    await addPerson("Alex Kim", env);
    expect(activePerson(env)).toBe("alex-kim");
    expect(activePerson({ ...env, OJS_PERSON: "sam" })).toBe("sam");
    await expect(addPerson("sam", env)).rejects.toThrow(PersonError);
    expect((await listPeople(env)).map((p) => [p.id, p.name, p.active])).toEqual([["alex-kim", "Alex Kim", true], ["sam", "Sam", false]]);
  });

  test("searches: none, then the newest is active", async () => {
    const env = await workspace();
    await addPerson("Sam", env);
    expect(() => searchDir(env)).toThrow(/no job search yet/);
    await addSearch("Software engineering", { targetRoles: ["Backend engineer"] }, env);
    await addSearch("Product management", {}, env);
    expect(searchDir(env)).toMatch(/searches\/product-management$/);
    const s = await loadSearch(searchDir({ ...env, OJS_SEARCH: "software-engineering" }));
    expect(s).toMatchObject({ name: "Software engineering", targetRoles: ["Backend engineer"], locations: [] });
  });
});

describe("migrate", () => {
  test("moves an old profile into a person's folders; filled-in preferences become a search", async () => {
    const env = await workspace();
    const root = env.OJS_ROOT!;
    await mkdir(join(root, "data", "profile", "roles"), { recursive: true });
    await mkdir(join(root, "data", "cache"), { recursive: true });
    await mkdir(join(root, "documents", "writing-samples"), { recursive: true });
    await writeFile(join(root, "documents", "README.md"), "readme");
    await writeFile(join(root, "documents", "cv.pdf"), "cv");
    await writeFile(join(root, "data", "flow.json"), '{"version":1,"done":{"experience":"2026-11-21T10:00:00.000Z"}}');
    await writeFile(join(root, "data", "config.json"), "{}");
    await writeFile(
      join(root, "data", "profile", "profile.yaml"),
      "# Your profile\nversion: 1\nbasics:\n  name: Sam # you\neligibility:\n  workAuthorization: []\npositioning:\n  - { name: Backend, targetTitles: [Staff Engineer], theyBuy: Reliability }\npreferences:\n  targetRoles: [Senior Backend Engineer]\n  locations: [London]\n  noticePeriod: 3 months\n  dealBreakers: []\n",
    );
    expect(() => activePerson(env)).toThrow(/ojs person migrate/);
    await expect(addPerson("Sam", env)).rejects.toThrow(/migrate/);

    const r = await migrateLegacy("Sam", env);
    expect(r.moved.map((m) => m.to).sort()).toEqual(["data/sam/cache", "data/sam/flow.json", "data/sam/profile", "documents/sam/cv.pdf", "documents/sam/writing-samples"]);
    expect(existsSync(join(root, "documents", "README.md"))).toBe(true);
    expect(existsSync(join(root, "data", "config.json"))).toBe(true);
    expect(activePerson(env)).toBe("sam");

    const yaml = await readFile(join(root, "data", "sam", "profile", "profile.yaml"), "utf8");
    expect(yaml).not.toMatch(/preferences|positioning/);
    expect(yaml).toContain("name: Sam # you");
    expect(parseProfileYaml(yaml).eligibility.noticePeriod).toBe("3 months");
    expect((await readHistory(join(root, "data", "sam", "profile"))).at(-1)!.action).toMatch(/^migrate/);

    expect(r.search?.id).toBe("senior-backend-engineer");
    const s = await loadSearch(searchDir(env));
    expect(s).toMatchObject({ targetRoles: ["Senior Backend Engineer", "Staff Engineer"], locations: ["London"], angle: { theyBuy: "Reliability" } });
    await expect(migrateLegacy("Sam", env)).rejects.toThrow(/nothing to migrate/);
  });
});
