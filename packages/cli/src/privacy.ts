import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { addedLines, findPrivate, privateTerms } from "@ojs/core";

type Out = (human: string, data: unknown) => void;

export const PRIVACY_HELP = `Privacy (run by the git hooks in .githooks/):
  privacy check --staged      Refuse if the staged changes contain a name from anyone's profile
  privacy check --message <f> The same for a commit message
`;

export async function privacyCommand(rest: string[], f: { staged?: boolean; message?: string }, out: Out): Promise<void> {
  if (rest[0] !== "check") throw new Error("usage: ojs privacy check (--staged | --message <file>)");
  const terms = await privateTerms();
  const lines: { where: string; text: string }[] = [];
  if (f.staged) {
    const diff = spawnSync("git", ["diff", "--cached", "-U0", "--no-color", "--no-ext-diff"], { encoding: "utf8" });
    if (diff.status !== 0) throw new Error(`git diff failed: ${diff.stderr}`);
    lines.push(...addedLines(diff.stdout));
  }
  if (f.message) {
    readFileSync(f.message, "utf8")
      .split("\n")
      .forEach((text, i) => {
        if (!text.startsWith("#")) lines.push({ where: `commit message:${i + 1}`, text });
      });
  }
  const hits = findPrivate(lines, terms);
  if (!hits.length) return out(`No personal details found (checked ${lines.length} line${lines.length === 1 ? "" : "s"} against ${terms.length} name${terms.length === 1 ? "" : "s"} from the profiles in data/).`, { ok: true, hits: [] });
  out(
    [
      "Stopped: this commit contains details from a profile in data/. The repo is public, so use made-up examples (Acme, Globex, Sam) instead.",
      ...hits.map((h) => `  ${h.where}: "${h.term}" in: ${h.text}`),
    ].join("\n"),
    { ok: false, hits },
  );
  process.exitCode = 1;
}
