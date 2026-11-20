import { AGENT_CLI_PRESETS, configPath, loadConfig, which } from "@ojs/core";

/**
 * Local web app. Binds to 127.0.0.1 only: it reads personal data and must
 * never be reachable from the network.
 *
 * Placeholder until the first features land; the API mirrors the CLI so both
 * stay thin layers over @ojs/core.
 */
const port = Number(process.env.OJS_PORT ?? 4717);

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>open-job-search</title>
<style>
  :root { color-scheme: light dark; --fg: #1b1b1f; --bg: #fafaf7; --muted: #6b6b73; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ececf1; --bg: #16161a; --muted: #9a9aa3; } }
  body { font: 16px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); max-width: 40rem; margin: 3rem auto; padding: 0 1rem; }
  code { font-size: .9em; } .muted { color: var(--muted); } li { margin: .25rem 0; }
</style>
</head>
<body>
<h1>open-job-search</h1>
<p class="muted">Local web app. Early skeleton: features arrive here as they land in the core.</p>
<h2>Providers</h2>
<ul id="providers"><li class="muted">Loading…</li></ul>
<script>
fetch("/api/providers").then(r => r.json()).then(d => {
  const ul = document.getElementById("providers");
  ul.innerHTML = "";
  if (!d.configured.length) ul.innerHTML = '<li>None configured. Run <code>ojs init</code>.</li>';
  for (const p of d.configured) {
    const li = document.createElement("li");
    li.textContent = (p.default ? "★ " : "") + p.id + " (" + p.type + ")";
    ul.appendChild(li);
  }
});
</script>
</body>
</html>`;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (pathname === "/api/health") return Response.json({ ok: true, configPath: configPath() });
    if (pathname === "/api/providers") {
      const config = await loadConfig();
      return Response.json({
        configured: Object.entries(config.providers).map(([id, c]) => ({ id, type: c.type, default: id === config.defaultProvider })),
        agentClis: Object.entries(AGENT_CLI_PRESETS).map(([preset, p]) => ({ preset, installed: Boolean(which(p.command)) })),
      });
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`open-job-search web: http://${server.hostname}:${server.port}`);
