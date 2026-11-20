import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendBullets,
  findSection,
  newProfileFile,
  parseProfileFile,
  parseSource,
  pastLifeFileName,
  ProfileFileError,
  renderProfileFile,
  roleFileName,
  sectionBullets,
  withFrontMatter,
} from "../src/profile/role-file.ts";

const fixture = readFileSync(join(import.meta.dir, "fixtures/role-acme.md"), "utf8");
const today = { kind: "dig", date: "2026-11-22" } as const;

describe("parse and render", () => {
  test("round-trips a hand-edited file byte for byte", () => {
    expect(renderProfileFile(parseProfileFile("role", fixture))).toBe(fixture);
  });

  test("round-trips edge shapes", () => {
    const shapes = [
      "---\nemployer: A\npositions: [{ title: T, start: 2020-01 }]\n---\n",
      "---\nemployer: A\npositions: [{ title: T, start: 2020-01 }]\n---\n## Context\nx\n",
      "---\nemployer: A\npositions: [{ title: T, start: 2020-01 }]\n---\nintro only, no headings",
      "---\nemployer: A\npositions: [{ title: T, start: 2020-01 }]\n---\n\n## A\n\n\n## B\nno trailing newline",
    ];
    for (const s of shapes) expect(renderProfileFile(parseProfileFile("role", s))).toBe(s);
  });

  test("reads front matter, keeping unknown fields", () => {
    const doc = parseProfileFile("role", fixture);
    expect(doc.frontMatter.employer).toBe("Acme Logistics");
    expect(doc.frontMatter.positions).toHaveLength(2);
    expect(doc.frontMatter.type).toBeUndefined();
    expect((doc.frontMatter as Record<string, unknown>).team_size).toBe(8);
  });

  test("ignores ## inside code blocks", () => {
    const doc = parseProfileFile("role", fixture);
    expect(doc.sections.map((s) => s.heading)).toEqual(["Context", "Projects", "Things my manager said", "To confirm", "Still to ask"]);
  });

  test("bullets carry source, subheading and wrapped lines", () => {
    const projects = sectionBullets(findSection(parseProfileFile("role", fixture), "projects")!);
    expect(projects).toEqual([
      { text: "Problem: planning took 40 minutes per depot every morning.", source: { kind: "dig", date: "2026-11-21" }, subheading: "Rebuilt route planning" },
      { text: "Outcome: down to 3 minutes; drivers left an hour earlier.", source: { kind: "dig", date: "2026-11-21" }, subheading: "Rebuilt route planning" },
      { text: "Built the first dashboard for depot managers.", source: { kind: "cv" }, subheading: "Depot dashboard" },
    ]);
    const confirm = sectionBullets(findSection(parseProfileFile("role", fixture), "To confirm")!);
    expect(confirm[0]!.source).toEqual({ kind: "inferred", from: "cv" });
    const ask = sectionBullets(findSection(parseProfileFile("role", fixture), "Still to ask")!);
    expect(ask[0]!.source).toEqual({ kind: "you" });
  });

  test("parseSource", () => {
    expect(parseSource("linkedin")).toEqual({ kind: "linkedin" });
    expect(parseSource("dig 2026-01-02")).toEqual({ kind: "dig", date: "2026-01-02" });
    expect(parseSource("whatever")).toEqual({ kind: "you" });
    expect(parseSource(undefined)).toEqual({ kind: "you" });
  });
});

describe("errors name the file and the problem", () => {
  const cases: [string, string, RegExp][] = [
    ["no front matter", "## Context\n", /must start with front matter/],
    ["unclosed", "---\nemployer: A\n", /not closed/],
    ["bad yaml", "---\nemployer: [A\n---\n", /not valid YAML/],
    ["missing employer", "---\npositions: [{ title: T, start: 2020-01 }]\n---\n", /employer/],
    ["bad date", "---\nemployer: A\npositions: [{ title: T, start: March 2020 }]\n---\n", /YYYY-MM/],
    ["no positions", "---\nemployer: A\npositions: []\n---\n", /at least one position/],
  ];
  for (const [name, text, msg] of cases) {
    test(name, () => {
      try {
        parseProfileFile("role", text, "roles/x.md");
        throw new Error("expected an error");
      } catch (err) {
        expect(err).toBeInstanceOf(ProfileFileError);
        expect((err as Error).message).toStartWith("roles/x.md: ");
        expect((err as Error).message).toMatch(msg);
      }
    });
  }
});

describe("appendBullets", () => {
  const doc = () => parseProfileFile("role", fixture);
  const added = (before: string, after: string) => {
    // Everything in `before` must survive in order; return only the new lines.
    const a = before.split("\n");
    const b = after.split("\n");
    const out: string[] = [];
    let i = 0;
    for (const line of b) {
      if (i < a.length && line === a[i]) i++;
      else out.push(line);
    }
    expect(i).toBe(a.length);
    return out.filter((l) => l !== "");
  };

  test("adds to an existing subsection, keeping every other line", () => {
    const after = renderProfileFile(appendBullets(doc(), "Projects", [{ text: "Cut fuel cost 12%.", source: today }], { subheading: "Rebuilt route planning" }));
    expect(added(fixture, after)).toEqual(["- Cut fuel cost 12%. [dig 2026-11-22]"]);
    const bullets = sectionBullets(findSection(parseProfileFile("role", after), "Projects")!);
    expect(bullets[2]).toEqual({ text: "Cut fuel cost 12%.", source: today, subheading: "Rebuilt route planning" });
  });

  test("creates a new subsection at the end of the section", () => {
    const after = renderProfileFile(appendBullets(doc(), "Projects", [{ text: "Moved to Postgres 15.", source: today }], { subheading: "Database upgrade" }));
    expect(added(fixture, after)).toEqual(["### Database upgrade", "- Moved to Postgres 15. [dig 2026-11-22]"]);
    expect(after).toContain("- Built the first dashboard for depot managers. [cv]\n\n### Database upgrade\n- Moved to Postgres 15. [dig 2026-11-22]\n\n## Things my manager said");
  });

  test("appends to the last section", () => {
    const after = renderProfileFile(appendBullets(doc(), "still to ask", [{ text: "Who took over the dashboard?", source: today }]));
    expect(after.endsWith("- What happened after the 2022 outage?\n- Who took over the dashboard? [dig 2026-11-22]\n")).toBe(true);
  });

  test("creates a missing section in canonical order", () => {
    const after = appendBullets(doc(), "Hard moments", [{ text: "The 2022 outage.", source: { kind: "you" } }]);
    expect(after.sections.map((s) => s.heading)).toEqual(["Context", "Projects", "Hard moments", "Things my manager said", "To confirm", "Still to ask"]);
    const text = renderProfileFile(after);
    expect(added(fixture, text)).toEqual(["## Hard moments", "- The 2022 outage. [you]"]);
    expect(renderProfileFile(parseProfileFile("role", text))).toBe(text);
  });

  test("a stray tag in the text isn't duplicated, and newlines are flattened", () => {
    const after = renderProfileFile(appendBullets(doc(), "Context", [{ text: "Two\nlines [cv]", source: today }]));
    expect(after).toContain("- Two lines [dig 2026-11-22]\n");
  });

  test("rejects empty bullets", () => {
    expect(() => appendBullets(doc(), "Context", [{ text: "  ", source: today }])).toThrow(/empty/);
  });
});

describe("templates and names", () => {
  test("a new role file has every heading and parses back", () => {
    const fm = { employer: "Northwind Ltd", positions: [{ title: "Barista", start: "2015-04" }], type: "part-time" as const, skills: [] };
    const text = renderProfileFile(newProfileFile("role", fm));
    expect(text).toContain("## Context\n\n## What I owned\n");
    expect(text.endsWith("## Still to ask\n")).toBe(true);
    const back = parseProfileFile("role", text);
    expect(back.frontMatter.employer).toBe("Northwind Ltd");
    expect(back.sections).toHaveLength(10);
    const filled = renderProfileFile(appendBullets(back, "Context", [{ text: "Busy city-centre café.", source: { kind: "you" } }]));
    expect(filled).toContain("## Context\n- Busy city-centre café. [you]\n\n## What I owned\n");
  });

  test("past-life files", () => {
    const text = renderProfileFile(newProfileFile("past-life", { field: "Hospitality", roles: [{ title: "Bartender", period: "early 20s" }] }));
    const doc = parseProfileFile("past-life", text);
    expect(doc.sections.map((s) => s.heading)).toEqual(["What I did", "Transferable skills", "Stories", "Trade knowledge", "To confirm", "Still to ask"]);
    expect(pastLifeFileName(doc.frontMatter)).toBe("hospitality.md");
    expect(() => parseProfileFile("past-life", "---\nroles: []\n---\n")).toThrow(/field/);
  });

  test("file names use the earliest start date and a slug", () => {
    const fm = parseProfileFile("role", fixture).frontMatter;
    expect(roleFileName(fm)).toBe("2019-06-acme-logistics.md");
    expect(roleFileName({ ...fm, employer: "Café Société & Co." })).toBe("2019-06-cafe-societe-co.md");
  });

  test("withFrontMatter changes only the front matter", () => {
    const doc = parseProfileFile("role", fixture);
    const text = renderProfileFile(withFrontMatter(doc, { ...doc.frontMatter, industry: "parcel delivery" }));
    expect(text).toContain("industry: parcel delivery");
    expect(text.slice(text.indexOf("\n---\n"))).toBe(fixture.slice(fixture.indexOf("\n---\n")));
  });
});
