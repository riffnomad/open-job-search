import { type CompanyPay, lookUpPay, type PayAnswer, SourceError } from "@ojs/core";

type Out = (human: string, data: unknown) => void;

export const PAY_HELP = `Pay (what a role pays, from levels.fyi):
  pay <role> --where <place>      The median yearly total pay for the role there, e.g. \`pay "software engineer" --where London\`
  pay <role> --where <place> --company <name> [--company <name>…]
                                  Pay by level at up to five companies: median, 10th and 90th percentile,
                                  average base, stock and bonus. In US dollars, from pay people added
                                  themselves. Outside about 40 big tech companies, levels.fyi shows it only
                                  to people signed in to it. One question at a time: its terms forbid bulk use
`;

interface Flags {
  where?: string;
  company?: string[];
}

const usd = (n: number | undefined) => (n == null ? "?" : `$${n.toLocaleString("en-US")}`);

function companyLines(c: CompanyPay): string[] {
  const head = c.company && c.company.toLowerCase() !== c.asked.toLowerCase() ? `${c.company} (for "${c.asked}")` : (c.company ?? c.asked);
  if (!c.levels.length) return [`  ${head}: ${c.note ?? "no data"}`];
  return [
    `  ${head}`,
    ...c.levels.map((l) => {
      const name = l.alsoCalled ? `${l.level} (${l.alsoCalled})` : l.level;
      const split = [l.averageBase != null ? `base ${usd(l.averageBase)}` : "", l.averageStockPerYear ? `stock ${usd(l.averageStockPerYear)}` : "", l.averageBonus ? `bonus ${usd(l.averageBonus)}` : ""].filter(Boolean);
      return `    ${name.padEnd(28)} median ${usd(l.median)}, 10th–90th ${usd(l.p10)}–${usd(l.p90)}${split.length ? `; average ${split.join(", ")}` : ""}`;
    }),
  ];
}

function human(a: PayAnswer): string {
  const lines = [`${a.role.name} in ${a.place.name}: yearly total pay (base, stock and bonus), in US dollars`, ""];
  if (a.companies) lines.push(...a.companies.flatMap(companyLines));
  else {
    lines.push(a.median == null ? "  Too few people have added their pay there to say." : `  Median ${usd(a.median)}, all levels together${a.window ? `, over ${a.window}` : ""}.`);
    if (a.levelAsked)
      lines.push("", `  This isn't for "${a.levelAsked}" alone: levels.fyi's free data can't narrow a median by level.`, `  For pay by level, name companies: --company <name> (up to five).`);
  }
  lines.push("", "From pay people added to levels.fyi themselves. Ads and offers can differ.", a.credit);
  return lines.join("\n");
}

export async function payCommand(args: string[], f: Flags, out: Out): Promise<void> {
  const role = args.join(" ").trim();
  if (!role || !f.where?.trim()) throw new SourceError('usage: ojs pay <role> --where <place> [--company <name>…], e.g. ojs pay "software engineer" --where London');
  const answer = await lookUpPay({ role, where: f.where, ...(f.company?.length ? { companies: f.company } : {}) });
  out(human(answer), answer);
}
