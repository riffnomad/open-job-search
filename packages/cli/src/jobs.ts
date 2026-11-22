import {
  activePerson,
  activeSearch,
  BOARD_SOURCES,
  boardSource,
  type BoardResult,
  groupJobs,
  type Job,
  judgeTitles,
  type JobGroup,
  knownCalls,
  loadConfig,
  type Pay,
  resolveProvider,
  parseSavedCalls,
  saveCalls,
  searchDir,
  SEARCH_SOURCES,
  searchSource,
  type SearchQuery,
  type SearchResult,
  SourceError,
  sourceForLink,
  type Level,
  LEVELS,
  type TitleCall,
  searchIds,
  titlesEmpty,
  titlesFor,
  type Titles,
} from "@ojs/core";

type Out = (human: string, data: unknown) => void;

export const JOBS_HELP = `Jobs (fetching job ads from the sources):
  jobs sources                    The hiring systems we can read and the job boards we can search
  jobs fetch <source> <board>     Every job on one company's board, e.g. \`jobs fetch greenhouse acme\`
  jobs fetch <link>               The same, from a link to the board (job-boards.greenhouse.io/acme)
                                  The same job posted for several places is shown once. When the search
                                  has titles, each job title is judged against them: the same kind of job
                                  as a core, related or open title, or a different job, with the level the
                                  title shows as a hint (it never hides a job). Verdicts are remembered;
                                  --judge has your AI judge titles not seen before.
                                  --all also shows different and ruled-out jobs, --limit <n> caps the list,
                                  --full adds the ad text. Without titles: the newest 20.
  jobs search <job board> [words] Search a job board across many companies, e.g. \`jobs search adzuna "data engineer"\`
                                  Without words, searches for each of the search's core titles.
                                  --where <place> near a place, --country <code> for boards split by
                                  country (gb, us…). Jobs are judged and shown as with fetch.
  jobs judge --yaml "<list>"      Save verdicts: [{title: "<ad title>", verdict: core|related|open|different,
                                  level: same|below|above|unclear, of: "<their title>", why: "…"}]
                                  --by person for corrections the person made (kept when titles change)
`;

interface Flags {
  all?: boolean;
  where?: string;
  country?: string;
  full?: boolean;
  limit?: string;
  judge?: boolean;
  json?: boolean;
  provider?: string;
  yaml?: string;
  by?: string;
}

type Tag = TitleCall["verdict"] | "unjudged";
const ORDER: Record<Tag, number> = { core: 0, related: 1, open: 2, unjudged: 3, different: 4, excluded: 5 };
/** Shown without --all. */
const SHOWN = new Set<Tag>(["core", "related", "open", "unjudged"]);
const LABEL: Record<Tag, string> = { core: "core", related: "related", open: "open", unjudged: "not judged", different: "different", excluded: "ruled out" };
const LEVEL_ORDER: Record<Level, number> = { same: 0, unclear: 1, above: 2, below: 3 };
const LEVEL_TEXT: Record<Level, string> = { same: "same level", unclear: "level not in the title", above: "title says a level above", below: "title says a level below" };
/** Jobs listed when there are no titles to narrow them and no --limit. */
const DEFAULT_LIMIT = 20;

function payText(p: Pay): string {
  const n = (x: number) => x.toLocaleString("en-GB", { maximumFractionDigits: 0 });
  const range = p.min != null && p.max != null && p.min !== p.max ? `${n(p.min)}–${n(p.max)}` : n((p.min ?? p.max)!);
  return `${p.currency} ${range}${p.period ? ` ${p.period === "hour" ? "an" : "a"} ${p.period}` : ""}`;
}

/**
 * Every pay range of a job as one line: ranges in the same currency and
 * period are merged into their overall spread (a job posted for 300 shops
 * pays 13–22 an hour, not "16 and 32 more").
 */
function payLine(pay: Pay[]): string {
  const groups = new Map<string, Pay[]>();
  for (const p of pay) {
    const k = `${p.currency}|${p.period ?? ""}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  return [...groups.values()]
    .map((ps) => {
      const nums = ps.flatMap((p) => [p.min, p.max]).filter((x): x is number => x != null);
      const text = payText({ currency: ps[0]!.currency, period: ps[0]!.period, min: Math.min(...nums), max: Math.max(...nums) });
      return ps.length > 1 ? `${text} (${ps.length} ranges)` : text;
    })
    .join("; ");
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

type Shown = JobGroup & { tag?: Tag; match?: TitleCall };

function groupLines(g: Shown, full = false, company = false, label = ""): string[] {
  const m = g.match;
  const tag = g.tag ? LABEL[g.tag] : "";
  const notes = [m?.level && m.level !== "same" ? LEVEL_TEXT[m.level] : "", m?.verdict === "open" ? `if ${m.if ?? "its condition holds"}` : "", m?.verdict === "excluded" ? `"${m.word}"` : ""].filter(Boolean);
  const extra = notes.length ? `  (${notes.join("; ")})` : "";
  const why = m?.why && m.by !== "rule" && g.tag !== "different" ? m.why : "";
  const places = g.locations.length > 3 ? `${g.locations.slice(0, 3).join("; ")} and ${g.locations.length - 3} more` : g.locations.join("; ");
  const pay = payLine(g.pay);
  const facts = [company ? g.company : "", places || "no location given", pay, g.postedAt ? `posted ${g.postedAt.slice(0, 10)}` : "", label ? `via ${label}` : ""].filter(Boolean);
  const ads = g.jobs.length > 1 ? `  (and ${g.jobs.length - 1} more ad${g.jobs.length > 2 ? "s" : ""} for other places)` : "";
  const pad = "".padEnd(12);
  const text = full ? (g.jobs[0]!.description ?? "(the ad has no text in this source)").split("\n").map((l) => (l ? `${pad}  ${l}` : "")) : [];
  return [`${tag.padEnd(12)}${g.title}${extra}`, ...(why ? [`${pad}${why}${m?.by === "person" ? " (you said)" : ""}`] : []), `${pad}${facts.join(" · ")}`, `${pad}${g.jobs[0]!.url}${ads}`, ...(text.length ? ["", ...text] : [])];
}

async function fetchCommand(args: string[], f: Flags, out: Out): Promise<void> {
  const [first, second] = args;
  if (!first) throw new SourceError(`usage: ojs jobs fetch <source> <board>, or ojs jobs fetch <link>. Sources: ${Object.keys(BOARD_SOURCES).join(", ")}`);
  let source;
  let board: string | undefined;
  if (BOARD_SOURCES[first.toLowerCase()]) {
    source = boardSource(first);
    if (!second) throw new SourceError(`which board? Give ${source.boardHint}.`);
    board = source.parseBoard(second, { named: true });
    if (!board) throw new SourceError(`"${second}" isn't a ${source.name} board. Give ${source.boardHint}.`);
  } else {
    const hit = sourceForLink(first);
    if (!hit) throw new SourceError(`"${first}" isn't a source or a link we can read. Sources: ${Object.keys(BOARD_SOURCES).join(", ")}`);
    ({ source, board } = hit);
  }
  const limit = parseLimit(f);
  const started = performance.now();
  const result: BoardResult = await source.fetchBoard(board);
  const ms = Math.round(performance.now() - started);
  const ads = result.jobs.length;
  return showJobs(
    {
      heading: `${result.company} on ${source.name}`,
      jobs: result.jobs,
      ms,
      fetchedAt: result.fetchedAt,
      notes: result.totalAds ? [`Only the newest ${ads.toLocaleString("en-GB")} of ${result.totalAds.toLocaleString("en-GB")} ads were read: ${source.name} lists too many to read them all.`] : [],
      empty: "No jobs like theirs on this board.",
      data: { source: result.source, board: result.board, company: result.company, ...(result.totalAds ? { totalAds: result.totalAds } : {}) },
    },
    limit,
    f,
    out,
  );
}

function parseLimit(f: Flags): number | undefined {
  const limit = f.limit ? Number.parseInt(f.limit, 10) : undefined;
  if (limit !== undefined && !(limit > 0)) throw new SourceError("--limit takes a number above 0");
  return limit;
}

/** What a fetch or a search read, ready to judge and show. */
interface Read {
  /** "Acme on Greenhouse", or "Adzuna (gb): \"data engineer\" near Leeds". */
  heading: string;
  jobs: Job[];
  ms: number;
  fetchedAt: string;
  /** Lines under the heading: what wasn't read, what a board couldn't do. */
  notes: string[];
  /** Said when titles hide every job. */
  empty: string;
  /** The credit the source's terms ask for, shown with its jobs. */
  credit?: string;
  /** Shown on every job, for sources whose terms want each ad labelled. */
  creditEach?: string;
  /** Jobs from many companies (a job board), so each job names its company. */
  manyCompanies?: boolean;
  /** Fields that lead the JSON output. */
  data: Record<string, unknown>;
}

/** Groups, judges and shows jobs, the same for a company's board and a job board's search. */
async function showJobs(r: Read, limit: number | undefined, f: Flags, out: Out): Promise<void> {
  const st = await searchTitles();
  const has = "titles" in st;
  const grouped = groupJobs(r.jobs);
  let judging: { stored: number; rule: number; judged: number; unjudged: string[]; by?: string } | undefined;
  let calls = new Map<string, TitleCall>();
  if (has) {
    const titles = grouped.map((g) => g.title);
    const dir = searchDir();
    let j = await knownCalls(titles, st.titles, dir);
    if (f.judge && j.unjudged.length) {
      const provider = resolveProvider(await loadConfig(), f.provider, process.env, { light: true });
      if (!f.json) process.stderr.write(`Judging ${j.unjudged.length} new title${j.unjudged.length === 1 ? "" : "s"} with ${provider.id}…\n`);
      j = await judgeTitles(titles, st.titles, dir, provider, { onProgress: f.json ? undefined : (d, t) => process.stderr.write(`  ${d}/${t}\n`) });
      judging = { ...j.counts, unjudged: j.unjudged, by: provider.id };
    } else judging = { ...j.counts, unjudged: j.unjudged };
    calls = j.calls;
  }
  const groups: Shown[] = grouped.map((g) => {
    if (!has) return g;
    const m = calls.get(g.title);
    return { ...g, tag: m ? m.verdict : "unjudged", ...(m ? { match: m } : {}) };
  });
  const lvl = (g: Shown) => (g.match?.level ? LEVEL_ORDER[g.match.level] : 9);
  groups.sort((a, b) => (has ? ORDER[a.tag!] - ORDER[b.tag!] || lvl(a) - lvl(b) : 0) || (b.postedAt ?? "").localeCompare(a.postedAt ?? ""));

  const counts = has ? Object.fromEntries((Object.keys(ORDER) as Tag[]).map((k) => [k, groups.filter((g) => g.tag === k).length])) as Record<Tag, number> : undefined;
  const levels = has ? Object.fromEntries(LEVELS.map((l) => [l, groups.filter((g) => SHOWN.has(g.tag!) && g.match?.level === l).length])) as Record<Level, number> : undefined;
  const chosen = has && !f.all ? groups.filter((g) => SHOWN.has(g.tag!)) : groups;
  const cap = limit ?? (has || f.all ? undefined : DEFAULT_LIMIT);
  const shown = cap ? chosen.slice(0, cap) : chosen;

  const ads = r.jobs.length;
  const human: string[] = [
    `${r.heading}: ${groups.length} job${groups.length === 1 ? "" : "s"}${ads !== groups.length ? ` (${ads} ads: some jobs are posted once per place)` : ""}, ${(r.ms / 1000).toFixed(1)}s`,
    ...r.notes,
  ];
  if (has && counts) {
    human.push(`Against ${st.person}'s "${st.search}" titles: ${(Object.keys(ORDER) as Tag[]).filter((k) => counts[k]).map((k) => `${counts[k]} ${LABEL[k]}`).join(" · ")}`);
    if (levels && LEVELS.some((l) => levels[l])) human.push(`Level by title alone (a hint; the ad decides): ${LEVELS.filter((l) => levels[l]).map((l) => `${levels[l]} ${l === "same" ? "same" : l === "unclear" ? "not shown" : l}`).join(" · ")}`);
    if (judging) {
      const parts = [judging.stored && `${judging.stored} remembered`, judging.rule && `${judging.rule} certain from the lists`, judging.judged && `${judging.judged} just judged by ${judging.by}`].filter(Boolean);
      if (parts.length) human.push(`Titles: ${parts.join(", ")}.`);
      if (judging.unjudged.length) human.push(`${judging.unjudged.length} title${judging.unjudged.length === 1 ? "" : "s"} not judged yet: add --judge to have your AI judge them (it's remembered after).`);
    }
  } else human.push(`Not matched against any titles: ${(st as { why: string }).why}.`);
  if (shown.length) human.push("", ...shown.flatMap((g) => [...groupLines(g, f.full, r.manyCompanies, r.creditEach), ""]));
  else if (has) human.push("", r.empty);
  const hidden = groups.length - shown.length;
  if (hidden > 0) human.push(has && !f.all ? `${hidden} more that are different jobs or ruled out: --all shows them.` : `${hidden} more: --all shows every job, or --limit <n>.`);
  if (r.credit) human.push(r.credit);
  human.push(`\nFetched ${r.fetchedAt}. Nothing is saved yet.`);

  out(human.join("\n").trimEnd(), {
    ...r.data,
    fetchedAt: r.fetchedAt,
    total: groups.length,
    ads,
    ...(r.credit ? { credit: r.credit } : {}),
    titlesFrom: has ? { person: st.person, search: st.search } : null,
    ...(has ? {} : { notMatchedBecause: (st as { why: string }).why }),
    ...(counts ? { counts, levels } : {}),
    ...(judging ? { titles: { remembered: judging.stored, certain: judging.rule, judgedNow: judging.judged, unjudged: judging.unjudged } } : {}),
    shown: shown.length,
    jobs: shown.map((g) => (f.full ? g : { ...g, jobs: g.jobs.map(({ description, ...rest }) => rest) })),
  });
}


/** Most queries one search runs when it searches for each core title, so a long list doesn't use up a board's daily allowance. */
const MAX_QUERIES = 5;

async function searchCommand(args: string[], f: Flags, out: Out): Promise<void> {
  const [id, ...words] = args;
  const boards = Object.keys(SEARCH_SOURCES).join(", ") || "none yet";
  if (!id) throw new SourceError(`usage: ojs jobs search <job board> [words] [--where <place>] [--country <code>]. Job boards: ${boards}`);
  const source = searchSource(id);
  const limit = parseLimit(f);

  // Each board explains its own missing keys (USAJOBS also wants the email the key was asked for with).

  const country = f.country?.trim().toLowerCase();
  if (country && source.countries && !source.countries.includes(country)) throw new SourceError(`${source.name} doesn't cover "${country}". Countries: ${source.countries.join(", ")}`);

  const notes: string[] = [];
  if (country && !source.countries) notes.push(`${source.name} isn't split by country, so --country was left out.`);
  const where = f.where?.trim() || undefined;
  if (where && !source.places) notes.push(`${source.name} can't search by place, so --where was left out: check each job's location.`);

  const what = words.join(" ").trim();
  let queries: string[];
  if (what) queries = [what];
  else {
    const st = await searchTitles();
    if (!("titles" in st) || !st.titles.core.length)
      throw new SourceError(`what should we look for? Give words (ojs jobs search ${source.id} "data engineer"), or add core titles to the search (${"titles" in st ? "step 3: `ojs search titles`" : st.why}).`);
    queries = st.titles.core.slice(0, MAX_QUERIES);
    if (st.titles.core.length > MAX_QUERIES) notes.push(`Searched for the first ${MAX_QUERIES} of ${st.titles.core.length} core titles; give words to search for another.`);
  }

  // Boards split by country search the first one they list unless told otherwise.
  const inCountry = source.countries ? (country ?? source.countries[0]) : undefined;
  const base: Omit<SearchQuery, "what"> = { ...(where && source.places ? { where } : {}), ...(inCountry ? { country: inCountry } : {}) };
  const started = performance.now();
  const results: SearchResult[] = [];
  for (const q of queries) results.push(await source.search({ ...base, what: q }, { env: process.env }));
  const ms = Math.round(performance.now() - started);

  // The same ad can match several titles: keep it once.
  const jobs = new Map<string, Job>();
  for (const r of results) for (const j of r.jobs) if (!jobs.has(j.id)) jobs.set(j.id, j);
  const n = (x: number) => x.toLocaleString("en-GB");
  for (const r of results) {
    if (!r.totalAds) continue;
    // A board that searches finds every match; one we search ourselves only knows what we read of it.
    if (source.places) notes.push(`${source.name} has ${n(r.totalAds)} matches for "${r.query.what}"; only the first ${n(r.jobs.length)} were read. Narrower words or a place find the rest.`);
    else notes.push(`${n(r.totalAds)} of the ads we read from ${source.name} match "${r.query.what}"; only the first ${n(r.jobs.length)} were kept. Narrower words find fewer.`);
  }

  const looked = queries.map((q) => `"${q}"`).join(", ");
  return showJobs(
    {
      heading: `${source.name}${base.country ? ` (${base.country})` : ""}: ${looked}${base.where ? ` near ${base.where}` : ""}`,
      jobs: [...jobs.values()],
      ms,
      fetchedAt: results[results.length - 1]?.fetchedAt ?? new Date().toISOString(),
      notes,
      empty: "None of these are jobs like theirs.",
      manyCompanies: true,
      ...(source.credit ? { credit: source.credit } : {}),
      ...(source.creditEach ? { creditEach: source.creditEach } : {}),
      data: { source: source.id, queries: results.map((r) => ({ ...r.query, read: r.jobs.length, ...(r.totalAds ? { totalAds: r.totalAds } : {}) })) },
    },
    limit,
    f,
    out,
  );
}

async function judgeCommand(f: Flags, out: Out): Promise<void> {
  if (!f.yaml) throw new SourceError('usage: ojs jobs judge --yaml "[{title: …, verdict: …, of: …, why: …}]" [--by person]');
  const by = f.by ?? "ai";
  if (by !== "ai" && by !== "person") throw new SourceError("--by takes ai or person");
  const st = await searchTitles();
  if (!("titles" in st)) throw new SourceError(`nothing to judge against: ${st.why}`);
  const n = await saveCalls(parseSavedCalls(f.yaml), st.titles, searchDir(), by);
  out(`Saved ${n} verdict${n === 1 ? "" : "s"} for ${st.person}'s "${st.search}" search${by === "person" ? " (yours: kept even when the titles change)" : ""}.`, { saved: n, by, search: st.search });
}

export async function jobsCommand(rest: string[], f: Flags, out: Out): Promise<void> {
  const [sub, ...args] = rest;
  switch (sub) {
    case "fetch":
      return fetchCommand(args, f, out);
    case "search":
      return searchCommand(args, f, out);
    case "judge":
      return judgeCommand(f, out);
    case "sources":
    case undefined: {
      const list = Object.values(BOARD_SOURCES).map((s) => ({ id: s.id, name: s.name, board: s.boardHint }));
      const boards = Object.values(SEARCH_SOURCES).map((s) => ({
        id: s.id,
        name: s.name,
        covers: s.covers,
        places: s.places,
        ...(s.countries ? { countries: s.countries } : {}),
        ...(s.keys ? { keys: s.keys.env, keysReady: s.keys.env.every((n) => process.env[n]), signup: s.keys.signup, ...(s.keys.cost ? { keyCost: s.keys.cost } : {}) } : {}),
      }));
      const width = Math.max(...[...list, ...boards].map((s) => s.id.length)) + 2;
      const lines = ["Hiring systems we can read, one company at a time:", ...list.map((s) => `  ${s.id.padEnd(width)}${s.board}`), "", "Fetch one: ojs jobs fetch <source> <board>"];
      if (boards.length) {
        const key = (b: (typeof boards)[number]) => (b.keys ? (b.keysReady ? " (key set)" : ` (needs a ${b.keyCost ? `key, ${b.keyCost}` : "free key"}: ${b.keys.join(", ")})`) : "");
        lines.push("", "Job boards we can search, across many companies:", ...boards.map((b) => `  ${b.id.padEnd(width)}${b.covers}${key(b)}`), "", 'Search one: ojs jobs search <job board> "<words>" [--where <place>]');
      }
      return out(lines.join("\n"), { sources: list, jobBoards: boards });
    }
    default:
      throw new SourceError(`unknown subcommand "jobs ${sub}". Run \`ojs help\`.`);
  }
}
