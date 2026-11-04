# Ballot Buddy

A free, static voter guide. Pick your city, township or ZIP and it finds every race on your 2026 ballot, ranks candidates by how closely they match your views, and lets you build a printable ballot.

## How it works

| What | Where it comes from | When |
|---|---|---|
| **Who is on your ballot** | Official candidate lists from election officials, imported into `data/ballots/` (see below) | Refreshed daily by GitHub Actions |
| Your districts, county, city/township, school district | U.S. Census Bureau TIGERweb map service | Live, in the browser |
| Candidate bios, stances, endorsements | `data/curated/{STATE}.json` (hand-checked, every line sourced) | Bundled |
| Extra endorsements, race forecasts, photos | Wikipedia's public API, one request at a time | Live, cached 12 hours |

Wikipedia never decides who is on the ballot; it only adds detail to races the official list already has. States without official data yet fall back to the older Wikipedia-only mode.

Every stance on a card is marked as **from the record**, **inferred from endorsements**, or **assumed from party**, and the match score weights them 1 / 0.5 / 0.3. Candidates we haven't found anything on say so, with a web-search link, rather than showing nothing.

Your answers and picks never leave your browser (localStorage). Share links put the picks inside the URL itself.

## Ballot data

```
data/sources/MI.json                     where each official list lives (edit this to add coverage)
data/ballots/index.json                  which states/counties have data
data/ballots/MI/2026-11-03/state.json    every federal, statewide, legislative, appellate/circuit/probate race (MI Secretary of State)
data/ballots/MI/2026-11-03/county/26025.json   every local race in Calhoun County (county clerk)
data/curated/MI.json                     researched candidate profiles and race notes, keyed by name / contest id
```

Each contest has a `scope` (`state`, `cd`, `sldu`, `sldl`, `county`, `city`, `township`, `village`, `school`, `college`, `ward`, …) that `js/ballot.js` matches against the Census lookup. Ward and split school-district races get a picker.

The files are plain JSON in a table-like shape (contests → candidates, with sources), so moving to a hosted database later is a load script, not a rewrite.

**Michigan coverage:** all 83 counties get every federal, statewide, legislative, state-board and Supreme Court race. Local races are in for Calhoun County. To add a county, add its clerk's *Official Candidate List* PDF to `data/sources/MI.json` (most Michigan counties publish the same report) and run the importer. **Other states:** add `data/sources/XX.json` and an importer for that state's official list in `tools/import/`.

**Running the importer:** `npm ci && npm run import && npm run check`, or run the *Import official ballot data* workflow in GitHub Actions. `check` fails the run if a list suddenly parses to too few contests, so a layout change can't silently ship an empty ballot.

## Adding candidate research

Add entries to `data/curated/{STATE}.json` → `candidates` with `blurb`, optional `incumbent`, `endorsedBy` (names matched against `data/endorsers.json`), `stances` (`issue: [-2..2, "one-line summary"]`) and `sources`. Names match the official list; "Jr.", "II" and middle initials are ignored. Race-level context goes in `contestNotes`, keyed by contest id.

## Run locally

Any static server works, e.g. `npx serve .` or `python -m http.server`. Opening `index.html` as a file won't work because the browser blocks module loading from `file://`.

## Deploy

GitHub Pages: Settings → Pages → Deploy from branch → `main` / root.
