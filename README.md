# Ballot Buddy

A free, static voter guide. Pick your city, township or ZIP and it finds every race on your 2026 ballot, ranks candidates by how closely they match your views, and lets you build a printable ballot.

## How it works

| What | Where it comes from | When |
|---|---|---|
| **Who is on your ballot** | Official candidate lists from election officials (`data/elections/`) | Re-imported daily by GitHub Actions |
| Candidate bios, stances, endorsements | Hand-checked research with sources (`data/research/`) | Edited by pull request |
| Your districts, county, city/township, school district | U.S. Census Bureau TIGERweb map service | Live, in the browser |
| Extra endorsements, race forecasts, photos | Wikipedia's public API, one request at a time | Live, cached 12 hours |

Wikipedia never decides who is on the ballot; it only adds detail to races the official list already has. States without official data yet fall back to the older Wikipedia-only mode.

Every stance on a card is marked as **from the record**, **inferred from endorsements**, or **assumed from party**, and the match score weights them 1 / 0.5 / 0.3. Candidates we haven't found anything on say so, with a web-search link, rather than showing nothing.

Your answers and picks never leave your browser (localStorage). Share links put the picks inside the URL itself.

## The data

The dataset lives in this repo as plain text, one record per line, so every change is a reviewable diff with history. There is no server and nothing to pay for.

```
data/elections/MI/2026-11-03/
  election.json                      the election and where its official lists come from
  official/state/                    Michigan Secretary of State list (every federal, statewide,
                                     legislative, state-board and court race in all 83 counties)
  official/county-26025/             Calhoun County Clerk list (every local race in the county)
    source.json                      URL, sha256 fingerprint, retrieval date, Internet Archive copy
    contests.jsonl                   one contest per line
    candidacies.jsonl                one candidate-in-a-contest per line, in ballot order
    proposals.jsonl                  local ballot questions with official text
data/research/MI/
  people.jsonl                       candidate profiles: blurb, stances, endorsements, sources
  contest-notes.jsonl                context shown under a race
  proposals.jsonl                    statewide proposals explained
  state.json                         sample-ballot and voter-info links
schema/                              JSON Schema for every record type (the field reference)
data/ballots/                        GENERATED for the website by the build; never edit
```

`official/` is written only by the importers; corrections to it go into the importer, not the files. `research/` is written by people.

**The build** (`npm run build`) validates every record against `schema/`, checks cross-links (every candidacy has a contest, every stance uses a known issue, every note points at a real race) and fails if a source suddenly parses to almost nothing. Then it writes `data/ballots/` for the site and `dist/ballot.sqlite`.

**The database** is published on every change:
- [Download `ballot.sqlite`](https://github.com/josfire18/ballot-buddy/releases/tag/data-latest) from the `data-latest` release
- [Browse and query it in your browser](https://lite.datasette.io/?url=https%3A%2F%2Fraw.githubusercontent.com%2Fjosfire18%2Fballot-buddy%2Fdata-dist%2Fballot.sqlite#/ballot/ballot) with Datasette Lite (reads the copy on the `data-dist` branch, which the workflow overwrites each time)

Contests carry Open Civic Data division IDs (`ocd-division/country:us/state:mi/sldl:44`) where the mapping is unambiguous, the same IDs Google Civic and the Voting Information Project use.

**Automation** (`.github/workflows/data.yml`): pull requests are validated; pushes to `main` rebuild and publish; a daily run re-imports the official lists and only commits when a list's fingerprint changed. A source that fails keeps its last good data.

**Coverage today:** Michigan: every non-local race statewide, plus local races for Calhoun County. To add a Michigan county, add its clerk's *Official Candidate List* PDF to the election's `election.json`. To add a state, add `data/elections/XX/<date>/election.json` and an importer in `tools/import/`. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Run locally

Any static server works, e.g. `npx serve .` or `python -m http.server`. Opening `index.html` as a file won't work because the browser blocks module loading from `file://`.

## Deploy

GitHub Pages: Settings → Pages → Deploy from branch → `main` / root.

## License

Code: [MIT](LICENSE). Data in `data/` and the published database: [CC BY 4.0](data/LICENSE.md).
