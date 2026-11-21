import { flowStatus, FlowError, markStepDone, reopenStep, type FlowStatus } from "@ojs/core";

type Out = (human: string, data: unknown) => void;

export const FLOW_HELP = `Flow (the path through open-job-search, one step at a time):
  flow                        Where you are: each step, what's there, what could be added
  flow done <step>            Mark the current step done (when you're happy with it) and move on
  flow reopen <step>          Go back to a step (it and the steps after it are no longer done)
`;

function render(status: FlowStatus): string {
  const lines: string[] = [];
  for (const s of status.steps) {
    const mark = s.state === "done" ? "✓" : s.state === "current" ? "→" : " ";
    lines.push(`${mark} ${s.n}. ${s.title}${s.state === "done" ? "" : s.state === "current" ? "  (you are here)" : ""}`, `     ${s.about}`);
    if (s.state !== "locked") {
      for (const p of s.progress) lines.push(`     · ${p}`);
      if (s.state === "current") for (const sug of s.suggestions) lines.push(`     + ${sug}`);
    }
  }
  if (status.complete) lines.push("", "All steps so far are done. More are coming: discovery, evaluation, applications.");
  else {
    const cur = status.steps.find((s) => s.state === "current")!;
    lines.push("", `The more you add, the better the roles we can find you. When you're happy with step ${cur.n}: \`ojs flow done ${cur.id}\`.`);
  }
  return lines.join("\n");
}

export async function flowCommand(rest: string[], out: Out): Promise<void> {
  const [sub, arg] = rest;
  switch (sub) {
    case undefined: {
      const status = await flowStatus();
      return out(render(status), status);
    }
    case "done": {
      if (!arg) throw new FlowError("usage: ojs flow done <step>");
      const status = await markStepDone(arg);
      return out(`Done.\n\n${render(status)}`, status);
    }
    case "reopen": {
      if (!arg) throw new FlowError("usage: ojs flow reopen <step>");
      const reopened = await reopenStep(arg);
      const status = await flowStatus();
      return out(`${reopened.length ? `Reopened: ${reopened.join(", ")}.` : "Nothing to reopen."}\n\n${render(status)}`, { reopened, ...status });
    }
    default:
      throw new FlowError(`unknown subcommand "flow ${sub}". Run \`ojs help\`.`);
  }
}
