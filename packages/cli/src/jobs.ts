import {
  activePerson,
  activeSearch,
  BOARD_SOURCES,
  boardSource,
  type BoardResult,
  groupJobs,
  type JobGroup,
  matchTitle,
  type Pay,
  SourceError,
  sourceForLink,
  type TitleMatch,
  searchIds,
  titlesEmpty,
  titlesFor,
  type Titles,
} from "@ojs/core";

type Out = (human: string, data: unknown) => void;

export const JOBS_HELP = `Jobs (fetching job ads from the sources):
  jobs sources                    The hiring systems we can read
  jobs fetch <source> <board>     Every job on one company's board, e.g. \`jobs fetch greenhouse acme\`
  jobs fetch <link>               The same, from a link to the board (job-boards.greenhouse.io/acme)
                                  The same job posted for several places is shown once. When the search
                                  has titles, shows the jobs whose titles match; otherwise the newest 20.
                                  --all shows every job, --limit <n> caps the list, --full adds the ad text
`;

interface Flags {
  all?: boolean;
  full?: boolean;
  limit?: string;
}

const ORDER: Record<TitleMatch["match"], number> = { core: 0, related: 1, open: 2, none: 3, excluded: 4 };
const MATCHED = new Set<TitleMatch["match"]>(["core", "related", "open"]);
/** Jobs listed when there are no titles to narrow them and no --limit. */
const DEFAULT_LIMIT = 20;

function payText(p: Pay): string {
  const n = (x: number) => x.toLocaleString("en-GB", { maximumFractionDigits: 0 });
  const range = p.min != null && p.max != null && p.min !== p.max ? `${n(p.min)}–${n(p.max)}` : n((p.min ?? p.max)!);
  return `${p.currency} ${range}${p.period ? ` a ${p.period}` : ""}`;
}

type SearchTitles = { person: string; search: string; titles: Titles } | { why: string };

/** The active search's titles, or why there are none to use. */
async function searchTitles(): Promise<SearchTitles> {
  let person: string;
  try {
    person = activePerson();
  } catch {
    return { why: "no one is set up in this workspace" };
  }
  let search: string | undefined;
  try {
    search = activeSearch(undefined, person);
  } catch {
    search = undefined;
  }
  if (!search) {
    const n = searchIds(undefined, person).length;
    return { why: n ? `${person} has ${n} searches and none is chosen (\`ojs search use <name>\`, or --search)` : `${person} has no search yet` };
  }
  const v = await titlesFor();
  if (titlesEmpty(v.titles)) return { why: `${person}'s "${search}" search has no titles yet (step 3: \`ojs search titles\`)` };
  return { person, search, titles: v.titles };
}

type Shown = JobGroup & { match?: TitleMatch };

function groupLines(g: Shown): string[] {
  const m = g.match;
  const tag = m ? (m.match === "excluded" ? "ruled out" : m.match === "none" ? "" : m.match) : "";
  const extra = m?.match === "open" ? `  (if ${m.if})` : m?.match === "excluded" ? `  ("${m.word}")` : "";
  const places = g.locations.length > 3 ? `${g.locations.slice(0, 3).join("; ")} and ${g.locations.length - 3} more` : g.locations.join("; ");
  const pay = g.pay.length ? payText(g.pay[0]!) + (g.pay.length > 1 ? ` (+${g.pay.length - 1} more ranges)` : "") : "";
  const facts = [places || "no location given", pay, g.postedAt ? `posted ${g.postedAt.slice(0, 10)}` : ""].filter(Boolean);
  const ads = g.jobs.length > 1 ? `  (and ${g.jobs.length - 1} more ad${g.jobs.length > 2 ? "s" : ""} for other places)` : "";
  const pad = "".padEnd(10);
  return [`${tag.padEnd(10)}${g.title}${extra}`, `${pad}${facts.join(" · ")}`, `${pad}${g.jobs[0]!.url}${ads}`];
}

async function fetchCommand(args: string[], f: Flags, out: Out): Promise<void> {
  const [first, second] = args;
  if (!first) throw new SourceError(`usage: ojs jobs fetch <source> <board>, or ojs jobs fetch <link>. Sources: ${Object.keys(BOARD_SOURCES).join(", ")}`);
  let source;
  let board: string | undefined;
  if (BOARD_SOURCES[first.toLowerCase()]) {
    source = boardSource(first);
    if (!second) throw new SourceError(`which board? Give ${source.boardHint}.`);
    board = source.parseBoard(second);
    if (!board) throw new SourceError(`"${second}" isn't a ${source.name} board. Give ${source.boardHint}.`);
  } else {
    const hit = sourceForLink(first);
    if (!hit) throw new SourceError(`"${first}" isn't a source or a link we can read. Sources: ${Object.keys(BOARD_SOURCES).join(", ")}`);
    ({ source, board } = hit);
  }
  const limit = f.limit ? Number.parseInt(f.limit, 10) : undefined;
  if (limit !== undefined && !(limit > 0)) throw new SourceError("--limit takes a number above 0");

  const started = performance.now();
  const result: BoardResult = await source.fetchBoard(board);
  const ms = Math.round(performance.now() - started);

  const st = await searchTitles();
  const has = "titles" in st;
  const groups: Shown[] = groupJobs(result.jobs).map((g) => ({ ...g, ...(has ? { match: matchTitle(g.title, st.titles) } : {}) }));
  groups.sort((a, b) => (has ? ORDER[a.match!.match] - ORDER[b.match!.match] : 0) || (b.postedAt ?? "").localeCompare(a.postedAt ?? ""));

  const counts = has ? Object.fromEntries(Object.keys(ORDER).map((k) => [k, groups.filter((g) => g.match!.match === k).length])) : undefined;
  const chosen = has && !f.all ? groups.filter((g) => MATCHED.has(g.match!.match)) : groups;
  const cap = limit ?? (has || f.all ? undefined : DEFAULT_LIMIT);
  const shown = cap ? chosen.slice(0, cap) : chosen;

  const ads = result.jobs.length;
  const human: string[] = [
    `${result.company} on ${source.name}: ${groups.length} job${groups.length === 1 ? "" : "s"}${ads !== groups.length ? ` (${ads} ads: some jobs are posted once per place)` : ""}, ${(ms / 1000).toFixed(1)}s`,
  ];
  if (has && counts) human.push(`Titles from ${st.person}'s "${st.search}" search: ${counts.core} core · ${counts.related} related · ${counts.open} open · ${counts.excluded} ruled out · ${counts.none} other`);
  else human.push(`Not matched against any titles: ${(st as { why: string }).why}.`);
  if (shown.length) human.push("", ...shown.flatMap((g) => [...groupLines(g), ""]));
  else if (has) human.push("", "No titles matched.");
  const hidden = groups.length - shown.length;
  if (hidden > 0) human.push(has && !f.all ? `${hidden} more whose titles didn't match: --all shows them.` : `${hidden} more: --all shows every job, or --limit <n>.`);
  human.push(`\nFetched ${result.fetchedAt}. Nothing is saved yet.`);

  out(human.join("\n").trimEnd(), {
    source: result.source,
    board: result.board,
    company: result.company,
    fetchedAt: result.fetchedAt,
    total: groups.length,
    ads,
    titlesFrom: has ? { person: st.person, search: st.search } : null,
    ...(has ? {} : { notMatchedBecause: (st as { why: string }).why }),
    ...(counts ? { counts } : {}),
    shown: shown.length,
    jobs: shown.map((g) => (f.full ? g : { ...g, jobs: g.jobs.map(({ description, ...rest }) => rest) })),
  });
}

export async function jobsCommand(rest: string[], f: Flags, out: Out): Promise<void> {
  const [sub, ...args] = rest;
  switch (sub) {
    case "fetch":
      return fetchCommand(args, f, out);
    case "sources":
    case undefined: {
      const list = Object.values(BOARD_SOURCES).map((s) => ({ id: s.id, name: s.name, board: s.boardHint }));
      return out(["Hiring systems we can read:", ...list.map((s) => `  ${s.id.padEnd(14)} ${s.board}`), "", "Fetch one: ojs jobs fetch <source> <board>"].join("\n"), { sources: list });
    }
    default:
      throw new SourceError(`unknown subcommand "jobs ${sub}". Run \`ojs help\`.`);
  }
}
