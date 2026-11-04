// Sanity checks on imported ballot data, so a PDF layout change fails the
// import loudly instead of shipping a half-empty ballot.
import { readFile } from "node:fs/promises";

const ROOT = new URL("../../", import.meta.url);
const read = async (rel) => JSON.parse(await readFile(new URL(rel, ROOT), "utf8"));
const problems = [];

function checkContests(file, contests, { min }) {
  if (contests.length < min) problems.push(`${file}: only ${contests.length} contests (expected at least ${min})`);
  const ids = new Set();
  for (const c of contests) {
    if (ids.has(c.id)) problems.push(`${file}: duplicate contest id ${c.id}`);
    ids.add(c.id);
    if (!c.office || !c.scope || !(c.voteFor >= 1)) problems.push(`${file}: malformed contest ${c.id}`);
    for (const k of c.candidates || []) {
      if (!k.name || k.name.length < 3 || /\d{3}|@/.test(k.name)) problems.push(`${file}: odd candidate name "${k.name}" in ${c.id}`);
    }
  }
}

const index = await read("data/ballots/index.json");
for (const [st, info] of Object.entries(index.states)) {
  const dir = `data/ballots/${st}/${info.election}`;
  if (info.statewide) {
    const s = await read(`${dir}/state.json`);
    checkContests(`${dir}/state.json`, s.contests, { min: st === "MI" ? 150 : 5 });
    if (st === "MI") {
      for (const id of ["mi-governor", "mi-sos", "mi-ag", "us-senate", "us-house-1", "us-house-13", "mi-senate-38", "mi-house-110", "mi-supreme-court"]) {
        const c = s.contests.find((x) => x.id === id);
        if (!c) problems.push(`MI: missing ${id}`);
        else if (c.candidates.length < 2 && id !== "mi-supreme-court") problems.push(`MI: ${id} has ${c.candidates.length} candidates`);
      }
      const gov = s.contests.find((x) => x.id === "mi-governor");
      if (gov && !gov.candidates.every((c) => c.runningMate)) problems.push("MI: governor candidates missing running mates");
    }
  }
  for (const c of info.counties) {
    const f = `${dir}/county/${c.fips}.json`;
    const d = await read(f);
    checkContests(f, d.contests, { min: 3 });
  }
}
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log("ballot data OK");
