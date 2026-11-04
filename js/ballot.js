// Official ballot data (data/ballots/**, built by tools/import from election
// officials' candidate lists) and the rules for which contests appear for a place.
// This is the source of truth for WHO is on the ballot; Wikipedia is only used
// afterwards to add endorsements, forecasts and bios.

const cache = new Map();
async function getJson(url) {
  if (!cache.has(url)) cache.set(url, fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  return cache.get(url);
}

/** "Battle Creek city" / "Bedford charter township" / "Battle Creek Public Schools" → comparable key */
export function jkey(s) {
  return String(s || "").toLowerCase().replace(/\(.*?\)/g, " ")
    .replace(/\b(charter township|township|city|village|cdp)\s*$/, "")
    .replace(/\b(community school district|public school district|school district|area school system|school system|community schools|public schools|area schools|schools|school|community college)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

const kindOf = (name) => (/ city$/i.test(name) ? "city" : / village$/i.test(name) ? "village" : / township$/i.test(name) ? "township" : "other");

/**
 * Load every contest on the ballot for this place.
 * returns null when we have no official data for the state (caller falls back to Wikipedia).
 */
export async function loadBallot(where, stateAbbr, V) {
  const index = await getJson(`data/ballots/index.json?v=${V}`);
  const info = index?.states?.[stateAbbr];
  if (!info) return null;
  const dir = `data/ballots/${stateAbbr}/${info.election}`;
  const d = where.districts, J = d.jurisdictions || { counties: [], places: [], cousubs: [], schools: [] };
  const stateFile = info.statewide ? await getJson(`${dir}/state.json?v=${V}`) : null;

  const counties = J.counties.map((c) => ({ ...c, fips: c.geoid, cname: String(c.name || "").replace(/ County$/, "") }));
  const countyFiles = (await Promise.all(counties.map(async (c) => {
    const known = info.counties.find((k) => k.fips === c.fips);
    if (!known) return null;
    const f = await getJson(`${dir}/county/${c.fips}.json?v=${V}`);
    return f ? { ...f, share: c.share, fips: c.fips } : null;
  }))).filter(Boolean);

  // Every municipality / school district this place touches, with its share of the area.
  const munis = [...J.places, ...J.cousubs].map((p) => ({ kind: kindOf(p.name), key: jkey(p.name), name: p.name, share: +p.share || 0 }));
  const muniShare = (kind, name) => Math.max(0, ...munis.filter((m) => m.kind === kind && m.key === jkey(name)).map((m) => m.share));
  const schools = J.schools.map((s) => ({ key: jkey(s.name), name: s.name, share: +s.share || 0 }));
  const schoolShare = (name) => Math.max(0, ...schools.filter((s) => s.key === jkey(name)).map((s) => s.share));
  const listShare = (arr, n) => (arr.find((x) => x.number === n)?.share ?? 0);
  const courts = new Set(countyFiles.flatMap((f) => f.contests.filter((c) => c.court).map((c) => JSON.stringify(c.court))));

  function collegeShare(rule) {
    if (!rule) return 0;
    const inList = (list) => Math.max(0, ...munis.filter((m) => (m.kind === "township" || m.kind === "city") && list.some((n) => jkey(n) === m.key)).map((m) => m.share));
    if (rule.townships) return inList(rule.townships);
    if (rule.exceptTownships) return Math.max(0, 1 - inList(rule.exceptTownships));
    return 1;
  }

  /** How much of the place this contest covers: 0 = not on your ballot, 1 = everywhere here. */
  function coverage(scope, file) {
    if (scope.unmapped) return 0;
    if (scope.state) return 1;
    if (scope.cd) return scope.cd === where.cd ? 1 : 0;
    if (scope.sldu) return listShare(d.stateSenate, scope.sldu);
    if (scope.sldl) return listShare(d.stateHouse, scope.sldl);
    if (scope.countyName) return Math.max(0, ...counties.filter((c) => jkey(c.cname) === jkey(scope.countyName)).map((c) => +c.share || 0));
    if (scope.coa || scope.circuit || scope.districtCourt) return 0; // shown from the county list instead, which knows its courts
    let s = file ? file.share : 1;
    if (scope.city) s = Math.min(s, muniShare("city", scope.city));
    if (scope.village) s = Math.min(s, muniShare("village", scope.village));
    if (scope.township) s = Math.min(s, muniShare("township", scope.township));
    if (scope.school) s = Math.min(s, schoolShare(scope.school));
    if (scope.college) s = Math.min(s, collegeShare(file?.county?.colleges?.[scope.college]));
    return s;
  }

  const out = [], pickers = new Map();
  const add = (c, file, srcInfo) => {
    let cov = coverage(c.scope, file);
    if (cov < 0.02) return;
    const candidates = (c.candidates || []).filter((k) => !k.status);
    const contest = { ...c, candidates, coverage: Math.min(1, cov), source: srcInfo, countyFips: file?.fips || null };
    if (c.scope.ward || c.scope.commissionDistrict) {
      const key = c.scope.ward ? `ward:${jkey(c.where)}` : `commission:${file?.fips}`;
      const p = pickers.get(key) || { key, kind: c.scope.ward ? "ward" : "commission", where: c.where, options: [], map: file?.county?.wardMaps?.[c.scope.city || c.scope.village || c.scope.township] || null };
      p.options.push(c.scope.ward || c.scope.commissionDistrict);
      pickers.set(key, p);
      contest.picker = { key, value: c.scope.ward || c.scope.commissionDistrict };
    }
    if (c.scope.school && schools.filter((s) => s.share >= 0.02).length > 1) {
      const key = "school";
      const p = pickers.get(key) || { key, kind: "school", where: "school district", options: [] };
      if (!p.options.includes(c.where)) p.options.push(c.where);
      pickers.set(key, p);
      contest.picker = { key, value: c.where };
    }
    out.push(contest);
  };

  if (stateFile) for (const c of stateFile.contests) add(c, null, stateFile.source);
  for (const f of countyFiles) for (const c of f.contests) add(c, f, f.source);
  const proposals = countyFiles.flatMap((f) => (f.proposals || []).map((p) => ({ ...p, coverage: coverage(p.scope, f), source: f.source }))).filter((p) => p.coverage >= 0.02);

  const ORDER = ["federal", "state", "legislative", "board", "judicial", "county", "city", "township", "village", "college", "school", "other"];
  out.sort((a, b) => ORDER.indexOf(a.level) - ORDER.indexOf(b.level));
  for (const p of pickers.values()) p.options.sort((a, b) => (typeof a === "number" ? a - b : String(a).localeCompare(String(b))));

  const covered = new Set(countyFiles.map((f) => f.fips));
  return {
    election: info.electionName, contests: out, proposals, pickers: [...pickers.values()],
    counties: counties.map((c) => ({ ...c, covered: covered.has(c.fips), resultsUrl: countyFiles.find((f) => f.fips === c.fips)?.county?.resultsUrl || null })),
    hasCourts: courts.size > 0,
  };
}
