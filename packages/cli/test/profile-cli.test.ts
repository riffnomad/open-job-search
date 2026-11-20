// The --json output is a contract: agents (via the skill) drive ojs with it.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "ojs-cli-"));
afterAll(() => rm(home, { recursive: true, force: true }));
const entry = join(import.meta.dir, "../src/index.ts");

function ojs(...args: string[]): { code: number; json: any; stderr: string } {
  const p = Bun.spawnSync(["bun", entry, ...args, "--json"], { env: { ...process.env, OJS_HOME: home } });
  const stdout = p.stdout.toString();
  return { code: p.exitCode, json: stdout.trim() ? JSON.parse(stdout) : undefined, stderr: p.stderr.toString() };
}

describe("ojs profile --json", () => {
  test("empty profile", () => {
    const r = ojs("profile");
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ exists: false, roles: [], pastLives: [] });
  });

  test("add, add-bullets, gaps, show", () => {
    expect(ojs("profile", "add", "role", "--employer", "Acme Logistics", "--title", "Engineer", "--start", "2019-06").json).toMatchObject({
      file: "roles/2019-06-acme-logistics.md",
    });
    const added = ojs("profile", "add-bullets", "acme", "--section", "Projects", "--sub", "Route planning", "--source", "dig 2026-11-22", "--text", "Cut planning from 40 to 3 minutes.", "--text", "Used by 30 depots.");
    expect(added.json).toEqual({
      file: "roles/2019-06-acme-logistics.md",
      section: "Projects",
      subheading: "Route planning",
      lines: ["- Cut planning from 40 to 3 minutes. [dig 2026-11-22]", "- Used by 30 depots. [dig 2026-11-22]"],
      written: true,
    });
    const gaps = ojs("profile", "gaps", "acme").json;
    expect(gaps.depth).toMatchObject({ bullets: 2, projects: 1, projectsWithOutcome: 1, bulletsWithNumbers: 2 });
    expect(gaps.gaps.map((g: { kind: string }) => g.kind)).not.toContain("project-without-outcome");
    const shown = ojs("profile", "show", "acme").json;
    const projects = shown.sections.find((s: { heading: string }) => s.heading === "Projects");
    expect(projects.bullets[0]).toEqual({ text: "Cut planning from 40 to 3 minutes.", source: { kind: "dig", date: "2026-11-22" }, subheading: "Route planning" });
  });

  test("errors are JSON with a non-zero exit", () => {
    const r = ojs("profile", "add-bullets", "acme", "--section", "Achievements", "--source", "inferred", "--text", "Led the team");
    expect(r.code).toBe(1);
    expect(r.json.error).toMatch(/To confirm/);
    expect(ojs("profile", "show", "globex").json.error).toMatch(/no role or past life matches/);
  });
});

describe("ojs profile import --json", () => {
  test("preview, write, then nothing new; with a stand-in provider", async () => {
    const { writeFile, chmod } = await import("node:fs/promises");
    const extracted = {
      basics: { name: "Riley Test", links: [] },
      roles: [
        {
          employer: "Umbrella Ltd",
          positions: [{ title: "Barista", start: "2016", end: "2018" }],
          skills: [],
          context: [],
          owned: ["Opened the shop on weekdays."],
          achievements: [],
          projects: [],
          inferred: ["Probably handled cash, as a shop opener"],
        },
      ],
      education: [],
      certifications: [],
      languages: [],
    };
    const script = join(home, "fake-ai.sh");
    await writeFile(script, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${JSON.stringify(extracted)}'\n`);
    await chmod(script, 0o755);
    expect(ojs("providers", "add", "fake", "--type", "agent-cli", "--command", script).code).toBe(0);
    const cv = join(home, "riley.md");
    await writeFile(cv, "# Riley Test\nBarista at Umbrella Ltd, 2016-2018. Opened the shop on weekdays.\n");

    const preview = ojs("profile", "import", cv, "--provider", "fake", "--dry-run");
    expect(preview.code).toBe(0);
    expect(preview.json).toMatchObject({ provider: "fake", written: false, skipped: [] });
    expect(preview.json.files[0]).toMatchObject({ file: "roles/2016-umbrella-ltd.md", action: "create" });

    const unconfirmed = ojs("profile", "import", cv, "--provider", "fake");
    expect(unconfirmed.json.written).toBe(false); // --json never writes without --yes

    const written = ojs("profile", "import", cv, "--provider", "fake", "--yes");
    expect(written.json).toMatchObject({ written: true, profileYaml: ["basics.name"] });
    expect(written.json.kept).toMatch(/^sources\/\d{4}-\d{2}-\d{2}-riley\.md$/);
    const shown = ojs("profile", "show", "umbrella").json;
    const confirm = shown.sections.find((s: { heading: string }) => s.heading === "To confirm");
    expect(confirm.bullets[0]).toEqual({ text: "Probably handled cash, as a shop opener", source: { kind: "inferred", from: "cv" } });

    expect(ojs("profile", "import", cv, "--provider", "fake", "--yes").json).toMatchObject({ written: false, files: [] });
  });
});
