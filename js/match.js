// Turns curated stances, endorsements and party into per-issue positions,
// then scores each candidate against the person's answers.

import { normName } from "./wiki.js?v=202610270304";

export const WEIGHT = { record: 1, endorsement: 0.5, party: 0.3 };

function matchEndorser(endorsers, item) {
  const hay = [item.link, item.name, item.text].filter(Boolean).map((s) => s.toLowerCase().trim());
  for (const e of endorsers) {
    for (const term of e.match) {
      if (hay.some((h) => h === term || (term.length > 6 && h.startsWith(term)))) return e;
    }
  }
  return null;
}

/**
 * Build a profile for one candidate.
 * returns { stances: {issue: {value, weight, basis, summary, from?}}, tags: [{label, count, examples}] }
 */
export function profile(candidate, { curated, endorsementsFor, endorsers, partyPresets }) {
  const stances = {};
  const tags = new Map();

  // 1. Endorsement signals (averaged per issue)
  const sums = {};
  for (const item of endorsementsFor || []) {
    const e = matchEndorser(endorsers, item);
    if (!e) continue;
    const t = tags.get(e.label) || { label: e.label, examples: [], kind: e.kind || "group" };
    if (!t.examples.includes(item.name) && t.examples.length < 6) t.examples.push(item.name);
    tags.set(e.label, t);
    for (const [issue, v] of Object.entries(e.signals || {})) {
      (sums[issue] ||= { total: 0, n: 0, from: new Set() });
      sums[issue].total += v; sums[issue].n += 1; sums[issue].from.add(e.label);
    }
  }
  for (const [issue, s] of Object.entries(sums)) {
    stances[issue] = {
      value: Math.max(-2, Math.min(2, Math.round(s.total / s.n))), weight: WEIGHT.endorsement, basis: "endorsement",
      summary: `Endorsed by ${[...s.from].join(", ")}.`,
    };
  }

  // 2. Party baseline for issues still unknown (D/R only)
  const preset = partyPresets[candidate.party];
  if (preset && (candidate.party === "D" || candidate.party === "R")) {
    for (const [issue, v] of Object.entries(preset)) {
      if (!stances[issue]) stances[issue] = { value: v, weight: WEIGHT.party, basis: "party", summary: `No specific record found; assumed typical ${candidate.party === "D" ? "Democratic" : "Republican"} position.` };
    }
  }

  // 3. Hand-checked record wins
  for (const [issue, [v, summary]] of Object.entries(curated?.stances || {})) {
    stances[issue] = { value: v, weight: WEIGHT.record, basis: "record", summary };
  }

  return { stances, tags: [...tags.values()] };
}

/** answers: {issue: -2..2}, importance: {issue: 1|2} */
export function score(prof, answers, importance = {}) {
  let num = 0, den = 0, byRecord = 0, counted = 0, agree = 0, disagree = 0;
  for (const [issue, u] of Object.entries(answers)) {
    if (u === null || u === undefined) continue;
    const s = prof.stances[issue];
    if (!s) continue;
    const w = (importance[issue] || 1) * s.weight;
    const a = 1 - Math.abs(u - s.value) / 4;
    num += w * a; den += w; counted++;
    if (s.basis === "record") byRecord++;
    if (Math.sign(u) !== 0 && Math.sign(u) === Math.sign(s.value)) agree++;
    else if (Math.sign(u) !== 0 && Math.sign(s.value) !== 0) disagree++;
  }
  if (!den) return null;
  return { pct: Math.round((num / den) * 100), counted, byRecord, agree, disagree, confidence: byRecord >= 4 ? "high" : counted >= 4 ? "medium" : "low" };
}

export function curatedFor(curatedState, name) {
  if (!curatedState) return null;
  const key = normName(name);
  for (const [n, c] of Object.entries(curatedState.candidates || {})) if (normName(n) === key) return c;
  return null;
}
