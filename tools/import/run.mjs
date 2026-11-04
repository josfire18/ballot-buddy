// Rebuilds data/ballots/** from the official sources listed in data/sources/*.json.
// Usage: node tools/import/run.mjs [STATE ...]
// Runs in GitHub Actions (.github/workflows/import-ballots.yml) on a schedule, so the
// site's data refreshes itself; a run only commits when an official list changed.
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { fetchPdf } from "./lib/pdf.mjs";
import { importSos } from "./mi-sos.mjs";
import { importCounty } from "./mi-county.mjs";

const ROOT = new URL("../../", import.meta.url);
const FORMATS = { "mi-sos": importSos, "mi-county": importCounty };

async function writeJson(rel, obj) {
  const url = new URL(rel, ROOT);
  await mkdir(new URL(".", url), { recursive: true });
  await writeFile(url, JSON.stringify(obj, null, 1) + "\n");
  console.log("wrote", rel);
}

async function readJson(rel, fallback) { try { return JSON.parse(await readFile(new URL(rel, ROOT), "utf8")); } catch { return fallback; } }

async function runState(file) {
  const src = JSON.parse(await readFile(new URL(`data/sources/${file}`, ROOT), "utf8"));
  const dir = `data/ballots/${src.state}/${src.election}`;
  const failures = [];

  if (src.statewide) {
    try {
      const data = await FORMATS[src.statewide.format](await fetchPdf(src.statewide.url), src.statewide);
      await writeJson(`${dir}/state.json`, { schema: 1, state: src.state, election: src.election, electionName: src.electionName, ...data });
      console.log(`  ${data.contests.length} statewide/district contests, ${data.contests.reduce((a, c) => a + c.candidates.length, 0)} candidates`);
    } catch (e) { failures.push(`statewide: ${e.message}`); }
  }
  const counties = [];
  for (const c of src.counties || []) {
    try {
      const data = await FORMATS[c.format](await fetchPdf(c.url), c);
      const { url, format, ...config } = c;
      await writeJson(`${dir}/county/${c.fips}.json`, { schema: 1, state: src.state, election: src.election, county: config, ...data });
      console.log(`  ${c.name}: ${data.contests.length} local contests, ${data.proposals.length} local proposals`);
      counties.push({ fips: c.fips, name: c.name });
    } catch (e) {
      failures.push(`${c.name}: ${e.message}`);
      const prev = await readJson(`${dir}/county/${c.fips}.json`, null);
      if (prev) counties.push({ fips: c.fips, name: c.name, stale: true }); // keep last good copy
    }
  }
  return { state: src.state, election: src.election, electionName: src.electionName, statewide: !!src.statewide, counties, failures };
}

const want = process.argv.slice(2).map((s) => s.toUpperCase());
const files = (await readdir(new URL("data/sources/", ROOT))).filter((f) => f.endsWith(".json") && (!want.length || want.includes(f.replace(".json", ""))));
const index = await readJson("data/ballots/index.json", { schema: 1, states: {} });
let failed = [];
for (const f of files) {
  const r = await runState(f);
  index.states[r.state] = { election: r.election, electionName: r.electionName, statewide: r.statewide, counties: r.counties };
  failed = failed.concat(r.failures.map((x) => `${r.state} ${x}`));
}
await writeJson("data/ballots/index.json", index);
if (failed.length) { console.error("Failures:\n" + failed.join("\n")); process.exitCode = 1; }
