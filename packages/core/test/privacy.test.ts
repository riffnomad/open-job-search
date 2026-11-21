import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addedLines, findPrivate, privateTerms } from "../src/privacy.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("privacy guard", () => {
  test("collects names, employers, email and phone from every profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "ojs-privacy-"));
    roots.push(root);
    const p = join(root, "data", "riley", "profile");
    await mkdir(join(p, "roles"), { recursive: true });
    await writeFile(join(root, "data", "riley", "person.json"), '{"version":1,"name":"Riley Quinton"}');
    await writeFile(join(p, "profile.yaml"), "basics:\n  name: Riley Quinton\n  email: riley@example.org\n  phone: +44 7700 900123\n");
    await writeFile(join(p, "roles", "2020-01-umbrella-pharma-ltd.md"), "---\nemployer: Umbrella Pharma Ltd\n---\n");
    await mkdir(join(root, "data", "cache"), { recursive: true }); // not a person: ignored
    const terms = await privateTerms({ OJS_ROOT: root });
    expect(terms).toEqual(expect.arrayContaining(["Riley Quinton", "Riley", "Quinton", "riley@example.org", "447700900123", "Umbrella Pharma Ltd", "Umbrella", "Pharma", "umbrella-pharma-ltd"]));
    expect(terms).not.toContain("Ltd");

    const diff = "+++ b/skills/x.md\n@@ -3,0 +4,2 @@\n+Ask about their time at Umbrella.\n+Nothing personal here, umbrellas are fine.\n";
    expect(findPrivate(addedLines(diff), terms)).toEqual([{ term: "Umbrella", where: "skills/x.md:4", text: "Ask about their time at Umbrella." }]);
  });

  test("no profiles, nothing to check", async () => {
    expect(await privateTerms({ OJS_ROOT: join(tmpdir(), "ojs-nothing-here") })).toEqual([]);
    expect(findPrivate([{ where: "a", text: "anything" }], [])).toEqual([]);
  });
});
