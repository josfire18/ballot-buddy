import { searchPlaces, districtsForPlace, districtsForPoint, STATES } from "./geo.js";
import { houseRace, statewideRace, statewideRaceSpecs, summary, normName } from "./wiki.js";
import { profile, score, curatedFor } from "./match.js";

// ---------- tiny helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const safeUrl = (u) => (/^https:\/\//i.test(u || "") ? esc(u) : "#");
const PARTY = { D: "Democrat", R: "Republican", L: "Libertarian", G: "Green", I: "Independent", O: "Other" };
const STORE_KEY = "bb:v1";

function load() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; } }
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {} }
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 2400); }
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

let ISSUES, PRESETS, ENDORSERS, CURATED = null;
const state = Object.assign({ answers: {}, importance: {}, dealbreakers: {}, picks: {}, preset: null }, load());
let shared = null; // read-only ballot someone shared
const races = new Map(); // id -> race data (with profiles)

// ---------- boot ----------
init().catch((e) => { console.error(e); $("#where-status").textContent = "Something went wrong loading the app. Refresh to try again."; });

async function init() {
  const [issues, endorsers] = await Promise.all([fetch("data/issues.json").then((r) => r.json()), fetch("data/endorsers.json").then((r) => r.json())]);
  ISSUES = issues.issues; PRESETS = issues.partyPresets; ENDORSERS = endorsers.endorsers;
  countdown();
  wireSearch();
  wireBallot();
  readShared();
  if (state.where) await applyWhere(state.where, { restoring: true });
}

function countdown() {
  const days = Math.ceil((new Date("2026-11-03T07:00:00-05:00") - Date.now()) / 86400000);
  const el = $("#election-date");
  if (days > 1) el.textContent = `Election Day is in ${days} days`;
  else if (days === 1) el.textContent = "Election Day is tomorrow";
  else if (days === 0) el.textContent = "Today is Election Day";
}

// ---------- step 1: where ----------
function wireSearch() {
  const input = $("#place-input"), list = $("#place-results"), status = $("#where-status");
  let items = [], active = -1, seq = 0;
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); active = -1; };
  const render = () => {
    list.innerHTML = items.map((p, i) => `<li role="option" id="opt-${i}" aria-selected="${i === active}" data-i="${i}"><span>${esc(p.label)}</span><span class="sub">${esc(p.sub)}</span></li>`).join("");
    list.hidden = !items.length; input.setAttribute("aria-expanded", String(!!items.length));
    if (active >= 0) input.setAttribute("aria-activedescendant", `opt-${active}`); else input.removeAttribute("aria-activedescendant");
  };
  const run = async (text, pickFirst = false) => {
    const my = ++seq;
    if (text.trim().length < 2) { items = []; render(); return; }
    status.classList.remove("error"); status.textContent = "Searching…";
    try {
      const found = await searchPlaces(text);
      if (my !== seq) return;
      items = found; active = found.length ? 0 : -1;
      status.textContent = found.length ? "" : "No match. Try the city or township name as it appears on your tax bill, or your ZIP code.";
      if (pickFirst && found.length === 1) { choose(found[0]); return; }
      render();
    } catch (e) {
      if (my !== seq) return;
      status.classList.add("error"); status.textContent = "Couldn't reach the Census Bureau's map service. Check your connection and try again.";
    }
  };
  const choose = (p) => { close(); input.value = p.kind === "zcta" ? p.label : `${p.label}, ${p.sub}`; pickPlace(p); };
  input.addEventListener("input", debounce(() => run(input.value), 300));
  input.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "ArrowDown") { active = Math.min(items.length - 1, active + 1); render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = Math.max(0, active - 1); render(); e.preventDefault(); }
    else if (e.key === "Escape") close();
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); choose(items[active]); }
  });
  list.addEventListener("click", (e) => { const li = e.target.closest("li"); if (li) choose(items[+li.dataset.i]); });
  $("#search-form").addEventListener("submit", (e) => { e.preventDefault(); if (!list.hidden && active >= 0) choose(items[active]); else run(input.value, true); });
  document.addEventListener("click", (e) => { if (!e.target.closest(".search, .results")) close(); });

  $("#use-location").addEventListener("click", () => {
    if (!navigator.geolocation) { status.textContent = "This browser can't share its location. Search for your city instead."; return; }
    status.classList.remove("error"); status.textContent = "Getting your location…";
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const d = await districtsForPoint(pos.coords.latitude, pos.coords.longitude);
        await applyWhere({ label: "Your current location", sub: STATES[d.state]?.[1] || "", exact: true, districts: d, cd: d.congressional[0].number });
      } catch (e) { status.classList.add("error"); status.textContent = e.message; }
    }, () => { status.classList.add("error"); status.textContent = "Location permission was declined. Search for your city or ZIP instead."; }, { enableHighAccuracy: true, timeout: 15000 });
  });
}

async function pickPlace(p) {
  const status = $("#where-status");
  status.classList.remove("error"); status.textContent = `Finding the districts for ${p.label}…`;
  try {
    const d = await districtsForPlace(p);
    await applyWhere({ label: p.label, sub: p.kind === "zcta" ? STATES[d.state]?.[1] : p.sub, exact: false, districts: d, cd: d.congressional[0].number });
  } catch (e) { status.classList.add("error"); status.textContent = e.message; }
}

async function applyWhere(where, { restoring = false } = {}) {
  const stateChanged = state.where?.districts?.state !== where.districts.state;
  state.where = where; save();
  $("#where-status").textContent = "";
  const abbr = STATES[where.districts.state]?.[0];
  CURATED = abbr ? await fetch(`data/curated/${abbr}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null;
  if (CURATED?.sampleBallotUrl) $("#sample-ballot-link").href = CURATED.sampleBallotUrl;
  renderWhere();
  $("#step-what").hidden = false; $("#step-races").hidden = false; $("#step-ballot").hidden = false; $("#ballot-bar").hidden = false;
  renderQuiz();
  if (stateChanged || !races.size || restoring) races.clear();
  await loadRaces();
  if (!restoring) $("#step-what").scrollIntoView({ block: "start" });
}

function renderWhere() {
  const w = state.where, d = w.districts, cds = d.congressional;
  const pct = (s) => `${Math.round(s * 100)}%`;
  const chip = (label) => `<li class="tag">${esc(label)}</li>`;
  const list = [
    ...cds.filter((c) => c.number === w.cd).map((c) => chip(c.number ? `U.S. House District ${c.number}` : "U.S. House at-large")),
    ...(d.stateSenate.length === 1 ? [chip(`State Senate District ${d.stateSenate[0].number}`)] : []),
    ...(d.stateHouse.length === 1 ? [chip(`State House District ${d.stateHouse[0].number}`)] : []),
  ];
  let split = "";
  if (cds.length > 1) {
    split = `<div class="split-note"><strong>${esc(w.label)} is split between ${cds.length} congressional districts.</strong> Pick yours, or use your exact location above.
      <div class="choices" role="group" aria-label="Choose your congressional district">${cds.map((c) => `<button type="button" class="chip-btn" data-cd="${esc(c.number)}" aria-pressed="${c.number === w.cd}">District ${esc(c.number)} <span class="race-meta">(${pct(+c.share || 0)} of the area)</span></button>`).join("")}</div></div>`;
  }
  $("#where-summary").innerHTML = `<div class="where-card"><h3>${esc(w.label)}${w.sub ? `, <span class="race-meta">${esc(w.sub)}</span>` : ""}</h3>
    <ul class="districts">${list.join("")}</ul>${split}
    ${CURATED ? "" : `<p class="help">We don't have hand-checked stances for ${esc(STATES[d.state]?.[1] || "this state")} yet. Positions below come from endorsements and party, and are marked that way.</p>`}</div>`;
  $("#where-summary").querySelectorAll("[data-cd]").forEach((b) => b.addEventListener("click", async () => {
    state.where.cd = +b.dataset.cd; save(); renderWhere();
    races.delete([...races.keys()].find((k) => k.startsWith("us-house")));
    await loadRaces();
  }));
}

// ---------- step 2: quiz ----------
const SCALE = [[-2, "Strongly disagree"], [-1, "Disagree"], [0, "Neutral"], [1, "Agree"], [2, "Strongly agree"]];
function renderQuiz() {
  document.querySelectorAll("[data-preset]").forEach((b) => {
    b.setAttribute("aria-pressed", String(state.preset === b.dataset.preset));
    b.onclick = () => {
      state.preset = b.dataset.preset;
      state.answers = { ...(PRESETS[b.dataset.preset] || {}) };
      save(); renderQuiz(); rerankAll();
      toast(b.dataset.preset === "I" ? "Answers cleared." : "Filled in. Change anything you disagree with.");
    };
  });
  $("#quiz").innerHTML = ISSUES.map((q) => {
    const a = state.answers[q.id];
    return `<li class="q" data-issue="${q.id}">
      <div class="q-head"><p class="q-text" id="q-${q.id}">${esc(q.statement)}</p>
        <button type="button" class="star" data-star aria-pressed="${state.importance[q.id] === 2}" aria-label="This matters a lot to me" title="Matters a lot to me">★</button></div>
      <p class="q-help">${esc(q.help)}</p>
      <div class="scale" role="group" aria-labelledby="q-${q.id}">
        ${SCALE.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${a === v}">${l}</button>`).join("")}
        <button type="button" class="skip-btn" data-v="skip" aria-pressed="${a === undefined || a === null}">Skip</button>
      </div>
      <label class="race-meta" style="display:flex;gap:8px;align-items:center;margin-top:10px">
        <input type="checkbox" data-deal ${state.dealbreakers[q.id] ? "checked" : ""} ${a ? "" : "disabled"}> Dealbreaker: flag anyone on the other side of this
      </label>
    </li>`;
  }).join("");
  $("#quiz").querySelectorAll(".q").forEach((li) => {
    const id = li.dataset.issue;
    li.querySelectorAll("[data-v]").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.v === "skip") delete state.answers[id]; else state.answers[id] = +b.dataset.v;
      if (!state.answers[id]) delete state.dealbreakers[id];
      save(); renderQuiz(); rerankAll();
      li.querySelector(`[data-v="${b.dataset.v}"]`); // focus kept by re-render below
      $(`.q[data-issue="${id}"] [data-v="${b.dataset.v}"]`)?.focus();
    }));
    li.querySelector("[data-star]").addEventListener("click", () => {
      state.importance[id] = state.importance[id] === 2 ? 1 : 2; save(); renderQuiz(); rerankAll();
      $(`.q[data-issue="${id}"] [data-star]`)?.focus();
    });
    li.querySelector("[data-deal]").addEventListener("change", (e) => {
      if (e.target.checked) state.dealbreakers[id] = true; else delete state.dealbreakers[id];
      save(); rerankAll();
    });
  });
}

// ---------- step 3: races ----------
async function loadRaces() {
  const wrap = $("#races");
  const d = state.where.districts, stateName = STATES[d.state]?.[1];
  const specs = [...statewideRaceSpecs(stateName), { id: "us-house", office: "U.S. House", house: true }];
  // Order: Senate, Governor, House, SoS, AG, extras, proposals
  const order = ["us-senate", "us-senate-special", "governor", "us-house", "sos", "ag"];
  specs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  wrap.innerHTML = specs.map((s) => `<article class="race" id="race-${s.id}" aria-busy="true"><div class="race-head"><h3>${esc(s.office)}</h3></div><p class="race-loading">Loading candidates…</p></article>`).join("")
    + (CURATED?.extraRaces || []).map((r) => `<article class="race" id="race-${esc(r.id)}"></article>`).join("")
    + (CURATED?.proposals || []).map((p) => `<article class="race" id="race-${esc(p.id)}"></article>`).join("");

  (CURATED?.extraRaces || []).forEach(renderExtraRace);
  (CURATED?.proposals || []).forEach(renderProposal);

  await Promise.all(specs.map(async (s) => {
    const el = $(`#race-${s.id}`);
    try {
      const race = s.house ? await houseRace(stateName, state.where.cd) : await statewideRace(s.id, s.office, s.titles);
      if (!race || !race.candidates.length) {
        if (s.house) el.innerHTML = `<div class="race-head"><h3>U.S. House</h3></div><p class="race-note">Couldn't find this district's candidates on Wikipedia. Check your <a href="${safeUrl(CURATED?.sampleBallotUrl || "https://www.vote411.org/ballot")}" rel="noopener">sample ballot</a>.</p>`;
        else el.remove();
        return;
      }
      if (s.house) { race.id = `us-house-${state.where.cd}`; el.id = `race-${race.id}`; }
      race.candidates = race.candidates.map((c) => ({ ...c, curated: curatedFor(CURATED, c.name) }));
      races.set(race.id, race);
      renderRace(race, el);
    } catch (e) {
      console.error(e);
      el.innerHTML = `<div class="race-head"><h3>${esc(s.office)}</h3></div><p class="race-note">Couldn't load this race right now. <button type="button" class="linklike" data-retry>Try again</button></p>`;
      el.querySelector("[data-retry]").onclick = () => loadRaces();
    } finally { el.removeAttribute("aria-busy"); updateBallot(); }
  }));
  updateBallot();
}

function endorsementsFor(race, c) {
  const e = race.endorsements || {};
  const key = normName(c.name);
  if (e[key]) return e[key];
  const last = key.split(" ").pop();
  const k = Object.keys(e).find((k) => k.split(" ").pop() === last && k[0] === key[0]);
  return k ? e[k] : [];
}

function profiles(race) {
  return race.candidates.map((c) => {
    const prof = profile(c, { curated: c.curated, endorsementsFor: endorsementsFor(race, c), endorsers: ENDORSERS, partyPresets: PRESETS });
    const sc = score(prof, state.answers, state.importance);
    const deal = Object.keys(state.dealbreakers).filter((iss) => {
      const u = state.answers[iss], s = prof.stances[iss];
      return u && s && Math.sign(s.value) !== 0 && Math.sign(s.value) !== Math.sign(u) && Math.abs(s.value) >= 1;
    }).map((iss) => ({ issue: iss, basis: prof.stances[iss].basis }));
    return { c, prof, sc, deal };
  });
}

function rank(list) {
  const major = (p) => (p.c.party === "D" || p.c.party === "R" ? 1 : 0);
  const hardDeal = (p) => p.deal.some((d) => d.basis !== "party") ? 1 : 0;
  return list.sort((a, b) => hardDeal(a) - hardDeal(b) || (b.sc?.pct ?? -1) - (a.sc?.pct ?? -1) || major(b) - major(a));
}

const issueById = (id) => ISSUES.find((i) => i.id === id);
const labelFor = (issue, v) => issueById(issue)?.labels?.[String(v)] || "";
function relation(issue, v) {
  const u = state.answers[issue];
  if (u === undefined || u === null || u === 0 || v === 0) return "";
  return Math.sign(u) === Math.sign(v) ? "agree" : "disagree";
}

function renderRace(race, el) {
  const list = rank(profiles(race));
  const answered = Object.keys(state.answers).length > 0;
  const topPct = list[0]?.sc?.pct;
  const pick = state.picks[race.id];
  const ratings = race.ratings?.length ? `<span class="race-meta">Forecast: ${esc(race.ratings[0].rating)} (${esc(race.ratings[0].source)})</span>` : "";
  el.innerHTML = `
    <div class="race-head"><h3>${esc(race.office)}</h3>${ratings}</div>
    ${!answered ? `<p class="race-note">Answer a few questions in step 2 to see match scores.</p>` : ""}
    <ul class="cands">${list.map((p, idx) => candRow(race, p, idx === 0 && answered && topPct != null && !p.deal.some((d) => d.basis !== "party"), pick)).join("")}</ul>
    <div class="compare-toggle"><button type="button" class="linklike" data-compare aria-expanded="false">Compare side by side</button></div>
    <div class="compare-wrap" hidden>${compareTable(list)}</div>
    <p class="race-note" style="padding-bottom:12px">Candidates and endorsements: <a href="${safeUrl(race.source.url)}" rel="noopener">${esc(race.source.title)}</a> on Wikipedia.</p>`;
  el.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => {
    const name = b.dataset.pick;
    state.picks[race.id] = state.picks[race.id]?.name === name ? undefined : { name, office: race.office, party: b.dataset.party };
    if (!state.picks[race.id]) delete state.picks[race.id];
    save(); renderRace(race, el); updateBallot();
    el.querySelector(`[data-pick="${CSS.escape(name)}"]`)?.focus();
    if (state.picks[race.id]) toast(`Added ${name} to your ballot.`);
  }));
  el.querySelector("[data-compare]").addEventListener("click", (e) => {
    const w = el.querySelector(".compare-wrap"); w.hidden = !w.hidden;
    e.target.setAttribute("aria-expanded", String(!w.hidden)); e.target.textContent = w.hidden ? "Compare side by side" : "Hide comparison";
  });
  el.querySelectorAll("details.more").forEach((d) => d.addEventListener("toggle", () => d.open && fillBio(d), { once: true }));
}

function candRow(race, { c, prof, sc, deal }, isTop, pick) {
  const picked = pick?.name === c.name;
  const pct = sc?.pct;
  const band = pct == null ? "" : pct >= 70 ? "" : pct >= 50 ? "mid" : "low";
  // Badges: issues the person answered first (most important first), else strongest stances.
  // Badges only show what's actually known (record or endorsements); party guesses stay in the details.
  const dealIssues = new Set(deal.map((d) => d.issue));
  const entries = Object.entries(prof.stances).filter(([iss, s]) => s.basis !== "party" && !dealIssues.has(iss));
  const scoreIssue = ([iss, s]) => (state.answers[iss] !== undefined ? 10 : 0) + (state.importance[iss] === 2 ? 5 : 0) + (state.dealbreakers[iss] ? 20 : 0) + Math.abs(s.value) + (s.basis === "record" ? 3 : s.basis === "endorsement" ? 1 : -5);
  const badges = entries.filter(([, s]) => s.value !== 0 || s.basis === "record").sort((a, b) => scoreIssue(b) - scoreIssue(a)).slice(0, 4);
  const dealHtml = deal.map((d) => {
    const s = prof.stances[d.issue];
    return `<li class="verdict disagree" title="${esc(s.summary)}">⚠ Dealbreaker for you: ${esc(labelFor(d.issue, s.value))}${d.basis === "party" ? " (assumed from party)" : ""}</li>`;
  }).join("");
  return `<li class="cand">
    <div class="cand-row">
      <button type="button" class="oval-btn" data-pick="${esc(c.name)}" data-party="${esc(c.party)}" aria-pressed="${picked}" aria-label="${picked ? "Remove" : "Pick"} ${esc(c.name)} for ${esc(race.office)}"><span class="oval"></span></button>
      <div>
        <div class="cand-name">${esc(c.name)}</div>
        <div class="cand-sub"><span class="party party-${esc(c.party)}">${esc(c.partyLabel && c.party === "O" ? c.partyLabel : PARTY[c.party])}</span>
          ${c.incumbent ? "<span>Incumbent</span>" : ""}${c.runningMate || c.curated?.running_mate ? `<span>with ${esc(c.runningMate || c.curated.running_mate)}</span>` : ""}
          ${isTop ? `<span class="top-pick">Your closest match</span>` : ""}</div>
      </div>
      ${pct != null ? `<div class="match ${band}" aria-label="${pct}% match"><div class="match-pct">${pct}%</div><div class="match-bar"><i style="width:${pct}%"></i></div><div class="match-sub">${sc.byRecord ? `${sc.byRecord} on record` : "estimated"}</div></div>` : `<div></div>`}
    </div>
    <ul class="verdicts">${dealHtml}${!badges.length && !deal.length && (c.party === "D" || c.party === "R") ? `<li class="verdict"><i class="basis basis-party"></i>No record found yet; tap below for typical ${c.party === "D" ? "Democratic" : "Republican"} positions</li>` : ""}${badges.map(([iss, s]) => `<li class="verdict ${relation(iss, s.value)}" title="${esc(s.summary)}"><i class="basis basis-${s.basis}"></i>${esc(labelFor(iss, s.value))}</li>`).join("")}</ul>
    <details class="more" data-link="${esc(c.link || "")}" data-name="${esc(c.name)}">
      <summary>Where ${esc(c.name.split(" ").slice(-1)[0])} stands</summary>
      <div class="more-body">
        <div class="bio" data-bio>${c.curated?.blurb ? `<p>${esc(c.curated.blurb)}</p>` : ""}</div>
        <ul class="stance-list">${ISSUES.map((q) => {
          const s = prof.stances[q.id];
          if (!s) return `<li class="stance"><span class="stance-issue"><i class="basis" style="opacity:.3"></i>${esc(q.short)}</span><span class="stance-text"><span>No record found.</span></span></li>`;
          return `<li class="stance ${relation(q.id, s.value)}"><span class="stance-issue"><i class="basis basis-${s.basis}"></i>${esc(q.short)}</span><span class="stance-text"><strong>${esc(labelFor(q.id, s.value))}</strong><span>${esc(s.summary)}</span></span></li>`;
        }).join("")}</ul>
        ${prof.tags.length ? `<h4>Endorsed by</h4><ul class="tags">${prof.tags.map((t) => `<li class="tag" title="${esc(t.examples.join(", "))}">${esc(t.label)}${t.examples.length > 1 || t.examples[0] !== t.label ? `: ${esc(t.examples.slice(0, 3).join(", "))}` : ""}</li>`).join("")}</ul>` : ""}
        ${c.curated?.sources?.length ? `<h4>Sources</h4><ul class="sources">${c.curated.sources.map((s) => `<li><a href="${safeUrl(s.url)}" rel="noopener">${esc(s.title)}</a></li>`).join("")}</ul>` : ""}
      </div>
    </details>
  </li>`;
}

async function fillBio(details) {
  const link = details.dataset.link; const box = details.querySelector("[data-bio]");
  if (!link || box.dataset.done) return;
  box.dataset.done = "1";
  const s = await summary(link);
  if (!s?.extract) return;
  const curatedText = box.innerHTML;
  box.innerHTML = `${s.thumb && /^https:\/\/upload\.wikimedia\.org\//.test(s.thumb) ? `<img src="${esc(s.thumb)}" alt="" loading="lazy">` : ""}<div>${curatedText}<p${curatedText ? ' style="margin-top:8px;color:var(--ink-2)"' : ""}>${esc(s.extract.length > 420 ? s.extract.slice(0, 417).replace(/\s\S*$/, "") + "…" : s.extract)} <a href="${safeUrl(s.url)}" rel="noopener">Wikipedia</a></p></div>`;
}

function compareTable(list) {
  const cols = list.slice(0, 4);
  return `<table class="compare"><thead><tr><th scope="col">Issue</th>${cols.map((p) => `<th scope="col"><span class="party party-${esc(p.c.party)}">${esc(p.c.name)}</span></th>`).join("")}</tr></thead><tbody>
    ${ISSUES.map((q) => `<tr><th scope="row">${esc(q.short)}${state.importance[q.id] === 2 ? " ★" : ""}</th>${cols.map((p) => {
      const s = p.prof.stances[q.id];
      if (!s) return `<td class="unknown">Unknown</td>`;
      return `<td class="${relation(q.id, s.value)}" title="${esc(s.summary)}"><i class="basis basis-${s.basis}"></i>${esc(labelFor(q.id, s.value))}</td>`;
    }).join("")}</tr>`).join("")}</tbody></table>`;
}

function rerankAll() { races.forEach((race) => { const el = $(`#race-${race.id}`); if (el) renderRace(race, el); }); }

// Curated non-Wikipedia races (Supreme Court, boards)
function renderExtraRace(r) {
  const el = $(`#race-${r.id}`);
  if (r.kind === "info") {
    el.innerHTML = `<div class="race-head"><h3>${esc(r.office)}</h3></div><p class="race-note" style="padding-bottom:14px">${esc(r.note)} <a href="${safeUrl(r.link.url)}" rel="noopener">${esc(r.link.title)}</a>.</p>`;
    return;
  }
  const picks = state.picks[r.id]?.names || [];
  el.innerHTML = `<div class="race-head"><h3>${esc(r.office)}</h3><span class="race-meta">Vote for up to ${r.voteFor}</span></div>
    <p class="race-note">${esc(r.note)}</p>
    <ul class="cands">${r.candidates.map((c) => {
      const picked = picks.includes(c.name);
      return `<li class="cand"><div class="cand-row">
        <button type="button" class="oval-btn" data-multi="${esc(c.name)}" aria-pressed="${picked}" aria-label="${picked ? "Remove" : "Pick"} ${esc(c.name)}"><span class="oval"></span></button>
        <div><div class="cand-name">${esc(c.name)}</div><div class="cand-sub"><span class="party party-${esc(c.party)}">${esc(c.partyNote || PARTY[c.party])}</span>${c.incumbent ? "<span>Incumbent</span>" : ""}</div>
        ${c.blurb ? `<p class="race-meta" style="margin:6px 0 0">${esc(c.blurb)}</p>` : ""}</div><div></div></div></li>`;
    }).join("")}</ul>
    ${r.sources?.length ? `<p class="race-note" style="padding-bottom:12px">Sources: ${r.sources.map((s) => `<a href="${safeUrl(s.url)}" rel="noopener">${esc(s.title)}</a>`).join("; ")}</p>` : ""}`;
  el.querySelectorAll("[data-multi]").forEach((b) => b.addEventListener("click", () => {
    const cur = new Set(state.picks[r.id]?.names || []);
    const n = b.dataset.multi;
    if (cur.has(n)) cur.delete(n);
    else { if (cur.size >= r.voteFor) { toast(`You can pick up to ${r.voteFor} here. Remove one first.`); return; } cur.add(n); }
    if (cur.size) state.picks[r.id] = { names: [...cur], office: r.office }; else delete state.picks[r.id];
    save(); renderExtraRace(r); updateBallot();
    $(`#race-${r.id} [data-multi="${CSS.escape(n)}"]`)?.focus();
  }));
}

function renderProposal(p) {
  const el = $(`#race-${p.id}`);
  const pick = state.picks[p.id]?.name;
  const side = (v, title, text) => `<div class="prop-side">
      <button type="button" class="oval-btn" data-yn="${v}" aria-pressed="${pick === v}" aria-label="Vote ${v} on ${esc(p.title)}"><span class="oval"></span></button>
      <div><strong>${title}</strong><p>${esc(text)}</p><p style="margin-top:6px"><em>Backed by: ${esc(p.lean[v.toLowerCase()])}</em></p></div></div>`;
  el.innerHTML = `<div class="race-head"><h3>${esc(p.title)}</h3><span class="race-meta">Statewide proposal</span></div>
    <p class="prop-q">${esc(p.question)}</p>
    <div class="prop-choice">${side("Yes", "Yes", p.yes)}${side("No", "No", p.no)}</div>
    <p class="race-note" style="padding-bottom:12px">Sources: ${p.sources.map((s) => `<a href="${safeUrl(s.url)}" rel="noopener">${esc(s.title)}</a>`).join("; ")}</p>`;
  el.querySelectorAll("[data-yn]").forEach((b) => b.addEventListener("click", () => {
    if (state.picks[p.id]?.name === b.dataset.yn) delete state.picks[p.id];
    else state.picks[p.id] = { name: b.dataset.yn, office: p.title };
    save(); renderProposal(p); updateBallot();
    $(`#race-${p.id} [data-yn="${b.dataset.yn}"]`)?.focus();
  }));
}

// ---------- my ballot ----------
function ballotRows() {
  const rows = [];
  document.querySelectorAll("#races .race").forEach((el) => {
    const id = el.id.replace(/^race-/, "");
    const h = el.querySelector("h3"); if (!h) return;
    const extra = CURATED?.extraRaces?.find((r) => r.id === id);
    if (extra?.kind === "info") return;
    rows.push({ id, office: h.textContent, pick: state.picks[id] });
  });
  return rows;
}

function updateBallot() {
  const rows = ballotRows();
  const picked = rows.filter((r) => r.pick).length;
  $("#ballot-count").textContent = `${picked} of ${rows.length} races picked`;
  $("#ballot-sheet").innerHTML = rows.length ? rows.map((r) => {
    const names = r.pick?.names || (r.pick ? [r.pick.name] : []);
    return `<div class="ballot-row"><div class="ballot-office">${esc(r.office)}</div>
      <div class="ballot-pick ${names.length ? "" : "empty"}">${names.length ? names.map((n) => `<span class="oval oval-filled" aria-hidden="true"></span><span>${esc(n)}${r.pick.party ? ` <span class="party party-${esc(r.pick.party)}">${esc(PARTY[r.pick.party] || "")}</span>` : ""}</span>`).join("<br>") : `<a href="#race-${esc(r.id)}">Not picked yet</a>`}</div></div>`;
  }).join("") : `<p class="race-note" style="padding:12px 16px">Your races will show up here.</p>`;
}

function wireBallot() {
  $("#print-ballot").addEventListener("click", () => window.print());
  $("#clear-ballot").addEventListener("click", () => {
    if (!Object.keys(state.picks).length) return;
    state.picks = {}; save(); rerankAll();
    (CURATED?.extraRaces || []).forEach((r) => r.kind !== "info" && renderExtraRace(r));
    (CURATED?.proposals || []).forEach(renderProposal);
    updateBallot(); toast("Picks cleared.");
  });
  $("#share-ballot").addEventListener("click", async () => {
    const payload = { v: 1, w: { label: state.where.label, sub: state.where.sub, cd: state.where.cd, d: state.where.districts }, p: state.picks };
    const enc = btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const url = `${location.origin}${location.pathname}#b=${enc}`;
    try { await navigator.clipboard.writeText(url); toast("Share link copied."); }
    catch { prompt("Copy this link:", url); }
  });
}

function readShared() {
  const m = location.hash.match(/#b=([\w-]+)/);
  if (!m) return;
  try {
    const json = JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")))));
    if (json.v !== 1 || !json.w?.d?.congressional) throw new Error("bad");
    shared = json;
    history.replaceState(null, "", location.pathname);
    const banner = document.createElement("div");
    banner.className = "shared-banner";
    banner.innerHTML = `<strong>A friend shared their ballot for ${esc(json.w.label)}.</strong>
      <p class="help" style="margin:4px 0 10px">Loading it shows their picks and replaces any picks saved in this browser.</p>
      <button type="button" class="btn btn-primary btn-small" data-load>Load their ballot</button> <button type="button" class="btn btn-quiet btn-small" data-dismiss>No thanks</button>`;
    $("#intro").append(banner);
    banner.querySelector("[data-dismiss]").onclick = () => banner.remove();
    banner.querySelector("[data-load]").onclick = async () => {
      banner.remove();
      state.picks = json.p && typeof json.p === "object" ? json.p : {};
      await applyWhere({ label: String(json.w.label), sub: String(json.w.sub || ""), exact: false, districts: json.w.d, cd: +json.w.cd });
      $("#step-ballot").scrollIntoView({ block: "start" });
    };
  } catch { history.replaceState(null, "", location.pathname); }
}
