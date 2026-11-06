// Imports official candidate lists into data/elections/<STATE>/<DATE>/official/.
//
// Each election folder has an election.json naming its sources. For every source
// ("unit": the statewide list, or one county's list) this downloads the file and,
// only if its fingerprint changed, rewrites:
//   official/<unit>/source.json        where it came from, sha256, our copy, Internet Archive copy
//   official/<unit>/contests.jsonl     one contest per line
//   official/<unit>/candidacies.jsonl  one candidate-in-a-contest per line
//   official/<unit>/proposals.jsonl    local ballot questions (if any)
// A source that fails to download or parse leaves its last good files untouched.
//
// Usage: node tools/import/run.mjs [STATE ...]
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fetchPdf, slug } from "./lib/pdf.mjs";
import { importSos } from "./mi-sos.mjs";
import { importCounty } from "./mi-county.mjs";

const ROOT = new URL("../../", import.meta.url);
const FORMATS = { "mi-sos": importSos, "mi-county": importCounty };
const at = (rel) => new URL(rel, ROOT);
const readJson = async (rel, fallback) => { try { return JSON.parse(await readFile(at(rel), "utf8")); } catch { return fallback; } };
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");

/** Ask the Internet Archive to keep a copy, then look up the newest copy it has.
 *  Best effort: a slow or refused save never fails the import. */
async function archive(url) {
  const UA = { "User-Agent": "BallotBuddy-importer (+https://github.com/josfire18/ballot-buddy)" };
  try {
    const res = await fetch(`https://web.archive.org/save/${url}`, { redirect: "manual", signal: AbortSignal.timeout(120_000), headers: UA });
    const loc = res.headers.get("location") || res.headers.get("content-location");
    console.log(`  archive save: HTTP ${res.status}${loc ? ` -> ${loc}` : ""}`);
    if (loc && /\/web\/\d{14}/.test(loc)) return new URL(loc, "https://web.archive.org").href;
  } catch (e) { console.log(`  archive save failed: ${e.message}`); }
  try {
    const j = await (await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(30_000), headers: UA })).json();
    const snap = j?.archived_snapshots?.closest;
    if (snap?.available && snap.url) return snap.url.replace(/^http:/, "https:");
    console.log("  no archived copy found yet");
  } catch (e) { console.log(`  archive lookup failed: ${e.message}`); }
  return null;
}

async function writeUnit(dir, unit, meta, data) {
  const base = `${dir}/official/${unit}`;
  await rm(at(base + "/"), { recursive: true, force: true });
  await mkdir(at(base + "/"), { recursive: true });
  const contests = [], candidacies = [];
  for (const { candidates = [], ...c } of data.contests) {
    contests.push({ ...c, source: unit });
    candidates.forEach((k, i) => candidacies.push({ id: `${c.id}/${slug(k.name)}`, contest: c.id, order: i + 1, ...k }));
  }
  await writeFile(at(`${base}/source.json`), JSON.stringify({ id: unit, ...meta }, null, 1) + "\n");
  await writeFile(at(`${base}/contests.jsonl`), jsonl(contests));
  await writeFile(at(`${base}/candidacies.jsonl`), jsonl(candidacies));
  if (data.proposals?.length) await writeFile(at(`${base}/proposals.jsonl`), jsonl(data.proposals.map((p) => ({ ...p, source: unit }))));
  return { contests: contests.length, candidacies: candidacies.length };
}

// Every official file is also kept as an attachment on the "sources" GitHub Release,
// named by its fingerprint. The workflow uploads dist/sources/*; the URL is predictable.
const REPO = process.env.GITHUB_REPOSITORY || "josfire18/ballot-buddy";
const copyUrl = (sha256) => `https://github.com/${REPO}/releases/download/sources/${sha256}.pdf`;

async function runSource(dir, unit, cfg) {
  const pdf = await fetchPdf(cfg.url);
  const sha256 = createHash("sha256").update(pdf).digest("hex");
  await mkdir(at("dist/sources/"), { recursive: true });
  await writeFile(at(`dist/sources/${sha256}.pdf`), pdf);
  const prev = await readJson(`${dir}/official/${unit}/source.json`, null);
  if (prev?.sha256 === sha256) {
    const next = { ...prev, copy: copyUrl(sha256) };
    if (!prev.archived) next.archived = (await archive(cfg.url)) || null; // retry until the Internet Archive has one
    if (JSON.stringify(next) !== JSON.stringify(prev)) await writeFile(at(`${dir}/official/${unit}/source.json`), JSON.stringify(next, null, 1) + "\n");
    return `${unit}: unchanged`;
  }
  const data = await FORMATS[cfg.format](pdf, cfg);
  const meta = {
    title: data.source.title, url: cfg.url, format: cfg.format, sha256,
    retrieved: new Date().toISOString().slice(0, 10),
    copy: copyUrl(sha256),
    archived: (await archive(cfg.url)) || null,
  };
  const n = await writeUnit(dir, unit, meta, data);
  return `${unit}: ${n.contests} contests, ${n.candidacies} candidacies`;
}

const want = process.argv.slice(2).map((s) => s.toUpperCase());
const failures = [];
for (const st of (await readdir(at("data/elections/"))).filter((s) => !want.length || want.includes(s))) {
  for (const date of await readdir(at(`data/elections/${st}/`))) {
    const dir = `data/elections/${st}/${date}`;
    const el = await readJson(`${dir}/election.json`, null);
    if (!el) continue;
    const units = [];
    if (el.statewide) units.push(["state", el.statewide]);
    for (const c of el.counties || []) units.push([`county-${c.fips}`, c]);
    for (const [unit, cfg] of units) {
      try { console.log(`${el.id} ${await runSource(dir, unit, cfg)}`); }
      catch (e) { failures.push(`${el.id} ${unit}: ${e.message}`); }
    }
  }
}
if (failures.length) { console.error("Failures (last good data kept):\n" + failures.join("\n")); process.exitCode = 1; }
