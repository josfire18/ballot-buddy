// Validates every data file and builds the published outputs:
//   data/ballots/**            the JSON the website reads (generated: never edit by hand)
//   dist/ballot.sqlite         the whole dataset as one SQLite database
//
// Usage: node tools/build/build.mjs [--check]   (--check validates only, writes nothing)
// Exit code 1 on any error, so a bad pull request or a broken import can't ship.
import { readFile, writeFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import Ajv from "ajv";

const ROOT = new URL("../../", import.meta.url);
const at = (rel) => new URL(rel, ROOT);
const CHECK_ONLY = process.argv.includes("--check");
const errors = [], warnings = [];

// ---------- loading + validation ----------
const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
const validators = {};
for (const f of await readdir(at("schema/"))) {
  const s = JSON.parse(await readFile(at(`schema/${f}`), "utf8"));
  validators[f.replace(".schema.json", "")] = ajv.compile(s);
}
function check(kind, rec, where) {
  if (!validators[kind](rec)) for (const e of validators[kind].errors) errors.push(`${where}: ${e.instancePath || "(record)"} ${e.message}${e.params?.additionalProperty ? ` "${e.params.additionalProperty}"` : ""}`);
  return rec;
}
async function readJsonl(rel, kind) {
  if (!existsSync(at(rel))) return [];
  const lines = (await readFile(at(rel), "utf8")).split("\n");
  const out = [];
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    try { out.push(check(kind, JSON.parse(l), `${rel}:${i + 1}`)); } catch (e) { errors.push(`${rel}:${i + 1}: not valid JSON (${e.message})`); }
  });
  return out;
}
const readJson = async (rel, kind) => check(kind, JSON.parse(await readFile(at(rel), "utf8")), rel);
const uniq = (rows, key, where) => { const s = new Set(); for (const r of rows) { if (s.has(r[key])) errors.push(`${where}: duplicate ${key} "${r[key]}"`); s.add(r[key]); } };

const normName = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, "").replace(/[^a-z ]/g, " ").replace(/\b[a-z]\b/g, "").replace(/\s+/g, " ").trim();

const ISSUES = JSON.parse(await readFile(at("data/issues.json"), "utf8")).issues;
const ISSUE_IDS = new Set(ISSUES.map((i) => i.id));
const ENDORSERS = JSON.parse(await readFile(at("data/endorsers.json"), "utf8"));

/** Open Civic Data division id for a contest, where the mapping is unambiguous. */
function ocdDivision(state, scope) {
  const base = `ocd-division/country:us/state:${state.toLowerCase()}`;
  const id = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (scope.state) return base;
  if (scope.cd) return `${base}/cd:${scope.cd}`;
  if (scope.sldu) return `${base}/sldu:${scope.sldu}`;
  if (scope.sldl) return `${base}/sldl:${scope.sldl}`;
  if (scope.city) return `${base}/place:${id(scope.city)}${scope.ward ? `/ward:${scope.ward}` : ""}`;
  return null;
}

// ---------- read everything ----------
const elections = [];
for (const st of (await readdir(at("data/elections/"))).sort()) {
  for (const date of (await readdir(at(`data/elections/${st}/`))).sort()) {
    const dir = `data/elections/${st}/${date}`;
    const el = await readJson(`${dir}/election.json`, "election");
    if (el.state !== st || el.date !== date || el.id !== `${st}-${date}`) errors.push(`${dir}/election.json: id/state/date don't match the folder`);
    const units = [];
    const unitNames = existsSync(at(`${dir}/official/`)) ? (await readdir(at(`${dir}/official/`))).sort() : [];
    for (const u of unitNames) {
      const b = `${dir}/official/${u}`;
      const unit = {
        id: u,
        source: await readJson(`${b}/source.json`, "source"),
        contests: await readJsonl(`${b}/contests.jsonl`, "contest"),
        candidacies: await readJsonl(`${b}/candidacies.jsonl`, "candidacy"),
        proposals: await readJsonl(`${b}/proposals.jsonl`, "local-proposal"),
      };
      uniq(unit.contests, "id", `${b}/contests.jsonl`);
      uniq(unit.candidacies, "id", `${b}/candidacies.jsonl`);
      const ids = new Set(unit.contests.map((c) => c.id));
      for (const k of unit.candidacies) if (!ids.has(k.contest)) errors.push(`${b}/candidacies.jsonl: "${k.id}" points to unknown contest "${k.contest}"`);
      // A list that suddenly parses to almost nothing means the PDF layout changed.
      const min = u === "state" ? 20 : 3;
      if (unit.contests.length < min) errors.push(`${b}: only ${unit.contests.length} contests (expected at least ${min}); did the source layout change?`);
      units.push(unit);
    }
    const allContests = units.flatMap((u) => u.contests);
    uniq(allContests, "id", `${dir} (all sources)`);
    if (!units.some((u) => u.id === "state") && el.statewide) warnings.push(`${dir}: statewide source configured but not imported yet`);
    for (const c of el.counties || []) if (!unitNames.includes(`county-${c.fips}`)) warnings.push(`${dir}: ${c.name} County configured but not imported yet`);
    elections.push({ ...el, dir, units });
  }
}

const research = {};
for (const st of existsSync(at("data/research/")) ? (await readdir(at("data/research/"))).sort() : []) {
  const R = `data/research/${st}`;
  const r = {
    state: JSON.parse(await readFile(at(`${R}/state.json`), "utf8")),
    people: await readJsonl(`${R}/people.jsonl`, "person"),
    notes: await readJsonl(`${R}/contest-notes.jsonl`, "contest-note"),
    proposals: await readJsonl(`${R}/proposals.jsonl`, "state-proposal"),
  };
  uniq(r.people, "id", `${R}/people.jsonl`);
  const byName = new Map();
  for (const p of r.people) {
    if (!p.id.startsWith(st.toLowerCase() + "/")) errors.push(`${R}/people.jsonl: id "${p.id}" should start with "${st.toLowerCase()}/"`);
    const k = normName(p.name);
    if (byName.has(k)) errors.push(`${R}/people.jsonl: "${p.name}" and "${byName.get(k).name}" look like the same person`);
    byName.set(k, p);
    for (const i of Object.keys(p.stances || {})) if (!ISSUE_IDS.has(i)) errors.push(`${R}/people.jsonl: ${p.id} has a stance on unknown issue "${i}" (see data/issues.json)`);
    for (const e of p.endorsedBy || []) if (!ENDORSERS[e] && !Object.values(ENDORSERS).some((x) => Array.isArray(x) && x.includes(e))) { /* free-text endorsers are allowed; only known ones affect matching */ }
    if (!p.sources?.length) warnings.push(`${R}/people.jsonl: ${p.id} has no sources`);
  }
  r.byName = byName;
  research[st] = r;
}

// ---------- cross-links ----------
for (const el of elections) {
  const r = research[el.state];
  const contestIds = new Set(el.units.flatMap((u) => u.contests.map((c) => c.id)));
  for (const n of r?.notes || []) if (!contestIds.has(n.contest)) errors.push(`data/research/${el.state}/contest-notes.jsonl: unknown contest "${n.contest}"`);
  for (const u of el.units) for (const k of u.candidacies) {
    const p = r?.byName.get(normName(k.name));
    k.person = p ? p.id : null;
  }
}
for (const [st, r] of Object.entries(research)) {
  const onBallot = new Set(elections.filter((e) => e.state === st).flatMap((e) => e.units.flatMap((u) => u.candidacies.map((k) => k.person))));
  for (const p of r.people) if (!onBallot.has(p.id)) warnings.push(`data/research/${st}/people.jsonl: ${p.id} (${p.name}) doesn't match anyone on an imported ballot`);
}

for (const w of warnings) console.warn("warning:", w);
if (errors.length) {
  console.error(`\n${errors.length} error(s):\n` + errors.slice(0, 200).join("\n"));
  process.exit(1);
}
const counts = elections.map((e) => `${e.id}: ${e.units.length} sources, ${e.units.reduce((a, u) => a + u.contests.length, 0)} contests, ${e.units.reduce((a, u) => a + u.candidacies.length, 0)} candidacies`);
console.log(`valid. ${counts.join("; ")}; research: ${Object.entries(research).map(([s, r]) => `${s} ${r.people.length} people`).join(", ")}`);
if (CHECK_ONLY) process.exit(0);

// ---------- site JSON (data/ballots) ----------
async function writeJson(rel, obj) {
  await mkdir(at(rel.replace(/[^/]+$/, "")), { recursive: true });
  await writeFile(at(rel), JSON.stringify(obj, null, 1) + "\n");
}
await rm(at("data/ballots/"), { recursive: true, force: true });
const index = { schema: 1, generated: "by tools/build/build.mjs from data/elections and data/research; do not edit", states: {} };
for (const el of elections) {
  const out = `data/ballots/${el.state}/${el.date}`;
  const withCands = (u) => u.contests.map(({ source, ...c }) => ({
    ...c, candidates: u.candidacies.filter((k) => k.contest === c.id).sort((a, b) => a.order - b.order).map(({ id, contest, order, person, ...k }) => k),
  }));
  const state = el.units.find((u) => u.id === "state");
  if (state) await writeJson(`${out}/state.json`, { schema: 1, state: el.state, election: el.date, electionName: el.name, source: { title: state.source.title, url: state.source.url }, contests: withCands(state) });
  const counties = [];
  for (const u of el.units.filter((u) => u.id.startsWith("county-"))) {
    const fips = u.id.slice(7);
    const { url, format, ...config } = (el.counties || []).find((c) => c.fips === fips) || { fips };
    await writeJson(`${out}/county/${fips}.json`, { schema: 1, state: el.state, election: el.date, county: config, source: { title: u.source.title, url: u.source.url }, contests: withCands(u), proposals: u.proposals.map(({ source, ...p }) => p) });
    counties.push({ fips, name: config.name });
  }
  const prev = index.states[el.state];
  if (!prev || prev.election < el.date) index.states[el.state] = { election: el.date, electionName: el.name, statewide: !!state, counties };
}
for (const [st, r] of Object.entries(research)) {
  const candidates = {};
  for (const p of r.people) {
    const c = { blurb: p.blurb };
    if (p.incumbent) c.incumbent = true;
    if (p.runningMate) c.running_mate = p.runningMate;
    if (p.stances) c.stances = Object.fromEntries(Object.entries(p.stances).map(([i, s]) => [i, [s.value, s.summary]]));
    if (p.endorsedBy) c.endorsedBy = p.endorsedBy;
    if (p.sources) c.sources = p.sources;
    candidates[p.name] = c;
  }
  await writeJson(`data/ballots/${st}/research.json`, {
    ...r.state, candidates, proposals: r.proposals,
    contestNotes: Object.fromEntries(r.notes.map((n) => [n.contest, n.note])),
  });
}
await writeJson("data/ballots/index.json", index);

// ---------- SQLite ----------
const { DatabaseSync } = await import("node:sqlite");
await mkdir(at("dist/"), { recursive: true });
const dbPath = new URL("dist/ballot.sqlite", ROOT).pathname;
await rm(dbPath, { force: true });
const db = new DatabaseSync(dbPath);
db.exec(`
PRAGMA journal_mode = OFF;
CREATE TABLE elections (id TEXT PRIMARY KEY, state TEXT NOT NULL, date TEXT NOT NULL, name TEXT NOT NULL);
CREATE TABLE sources (id TEXT PRIMARY KEY, election_id TEXT NOT NULL REFERENCES elections(id), title TEXT, url TEXT, sha256 TEXT, retrieved TEXT, archived_url TEXT);
CREATE TABLE contests (id TEXT PRIMARY KEY, election_id TEXT NOT NULL REFERENCES elections(id), source_id TEXT NOT NULL REFERENCES sources(id),
  office TEXT NOT NULL, level TEXT NOT NULL, jurisdiction TEXT, ocd_division TEXT, scope TEXT NOT NULL, vote_for INTEGER NOT NULL, term TEXT, partisan INTEGER, note TEXT);
CREATE TABLE people (id TEXT PRIMARY KEY, state TEXT NOT NULL, name TEXT NOT NULL, blurb TEXT, incumbent INTEGER, running_mate TEXT);
CREATE TABLE candidacies (id TEXT PRIMARY KEY, contest_id TEXT NOT NULL REFERENCES contests(id), ballot_order INTEGER, name TEXT NOT NULL,
  party TEXT, party_label TEXT, incumbent INTEGER, running_mate TEXT, status TEXT, person_id TEXT REFERENCES people(id));
CREATE TABLE issues (id TEXT PRIMARY KEY, short TEXT, statement TEXT);
CREATE TABLE stances (person_id TEXT NOT NULL REFERENCES people(id), issue_id TEXT NOT NULL REFERENCES issues(id), value INTEGER NOT NULL, summary TEXT, PRIMARY KEY (person_id, issue_id));
CREATE TABLE endorsements (person_id TEXT NOT NULL REFERENCES people(id), endorser TEXT NOT NULL);
CREATE TABLE person_sources (person_id TEXT NOT NULL REFERENCES people(id), title TEXT, url TEXT);
CREATE TABLE contest_notes (contest_id TEXT NOT NULL REFERENCES contests(id), note TEXT NOT NULL);
CREATE TABLE local_proposals (id TEXT PRIMARY KEY, election_id TEXT NOT NULL, source_id TEXT NOT NULL, title TEXT, jurisdiction TEXT, scope TEXT, text TEXT);
CREATE TABLE state_proposals (id TEXT PRIMARY KEY, state TEXT NOT NULL, title TEXT, question TEXT, yes TEXT, no TEXT);
CREATE INDEX candidacies_contest ON candidacies(contest_id);
CREATE INDEX candidacies_person ON candidacies(person_id);
CREATE INDEX contests_election ON contests(election_id, level);
CREATE VIEW ballot AS
  SELECT e.state, e.date AS election_date, c.level, c.office, c.jurisdiction, c.vote_for, k.ballot_order, k.name AS candidate,
         k.party_label AS party, COALESCE(k.incumbent, p.incumbent) AS incumbent, k.status, p.blurb, c.id AS contest_id, k.person_id
  FROM candidacies k JOIN contests c ON c.id = k.contest_id JOIN elections e ON e.id = c.election_id LEFT JOIN people p ON p.id = k.person_id
  ORDER BY e.state, c.level, c.office, k.ballot_order;
`);
const ins = (sql) => db.prepare(sql);
const b = (v) => (v == null ? null : v ? 1 : 0);
db.exec("BEGIN");
const qIssue = ins("INSERT INTO issues VALUES (?,?,?)");
for (const i of ISSUES) qIssue.run(i.id, i.short ?? null, i.statement ?? null);
const qPerson = ins("INSERT INTO people VALUES (?,?,?,?,?,?)"), qStance = ins("INSERT INTO stances VALUES (?,?,?,?)"),
  qEnd = ins("INSERT INTO endorsements VALUES (?,?)"), qPSrc = ins("INSERT INTO person_sources VALUES (?,?,?)"),
  qSProp = ins("INSERT INTO state_proposals VALUES (?,?,?,?,?,?)");
for (const [st, r] of Object.entries(research)) {
  for (const p of r.people) {
    qPerson.run(p.id, st, p.name, p.blurb, b(p.incumbent), p.runningMate ?? null);
    for (const [i, s] of Object.entries(p.stances || {})) qStance.run(p.id, i, s.value, s.summary);
    for (const e of p.endorsedBy || []) qEnd.run(p.id, e);
    for (const s of p.sources || []) qPSrc.run(p.id, s.title, s.url);
  }
  for (const pr of r.proposals) qSProp.run(pr.id, st, pr.title, pr.question, pr.yes, pr.no);
}
const qEl = ins("INSERT INTO elections VALUES (?,?,?,?)"), qSrc = ins("INSERT INTO sources VALUES (?,?,?,?,?,?,?)"),
  qC = ins("INSERT INTO contests VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"), qK = ins("INSERT INTO candidacies VALUES (?,?,?,?,?,?,?,?,?,?)"),
  qLP = ins("INSERT INTO local_proposals VALUES (?,?,?,?,?,?,?)"), qN = ins("INSERT INTO contest_notes VALUES (?,?)");
for (const el of elections) {
  qEl.run(el.id, el.state, el.date, el.name);
  for (const u of el.units) {
    const sid = `${el.id}/${u.id}`;
    qSrc.run(sid, el.id, u.source.title, u.source.url, u.source.sha256, u.source.retrieved, u.source.archived ?? null);
    for (const c of u.contests) qC.run(c.id, el.id, sid, c.office, c.level, c.where ?? null, ocdDivision(el.state, c.scope), JSON.stringify(c.scope), c.voteFor, c.term ?? null, b(c.partisan), c.note ?? null);
    for (const k of u.candidacies) qK.run(k.id, k.contest, k.order, k.name, k.party ?? null, k.partyLabel ?? null, b(k.incumbent), k.runningMate ?? null, k.status ?? null, k.person);
    for (const p of u.proposals) qLP.run(p.id, el.id, sid, p.title, p.where ?? null, JSON.stringify(p.scope), p.text);
  }
  for (const n of research[el.state]?.notes || []) qN.run(n.contest, n.note);
}
db.exec("COMMIT");
db.exec("VACUUM");
db.close();
console.log(`wrote data/ballots/ and dist/ballot.sqlite (${((await stat(dbPath)).size / 1024).toFixed(0)} KB)`);

// Release notes for the published database.
const repo = process.env.GITHUB_REPOSITORY || "josfire18/ballot-buddy";
const raw = `https://raw.githubusercontent.com/${repo}/data-dist/ballot.sqlite`;
await writeFile(at("dist/summary.md"), [
  "The whole Ballot Buddy dataset as one SQLite database, rebuilt automatically from the files in `data/` whenever they change.",
  "",
  `- **Browse it in your browser:** [Datasette Lite](https://lite.datasette.io/?url=${encodeURIComponent(raw)}#/ballot/ballot)`,
  `- **Download:** \`ballot.sqlite\` below, or ${raw}`,
  "- **Tables:** `elections`, `sources`, `contests`, `candidacies`, `people`, `stances`, `endorsements`, `person_sources`, `contest_notes`, `local_proposals`, `state_proposals`, `issues`, plus a `ballot` view.",
  "",
  "| Election | Sources | Contests | Candidacies |",
  "|---|---|---|---|",
  ...elections.map((e) => `| ${e.name} (${e.state}) | ${e.units.length} | ${e.units.reduce((a, u) => a + u.contests.length, 0)} | ${e.units.reduce((a, u) => a + u.candidacies.length, 0)} |`),
  "",
  `Researched candidate profiles: ${Object.entries(research).map(([s, r]) => `${s} ${r.people.length}`).join(", ")}.`,
  "",
  "Data license: CC BY 4.0. Official candidate lists are public records; every researched fact links its source.",
].join("\n") + "\n");
