# The recommender

How Aurora decides what to put in "Recommended for You", "Because you finished …",
"More like this" and the rows around them. One engine on the server
(`src/media/recs/`); the website and the TV app both read its output.

No training, no model file, no new dependency: titles are described by sparse
feature vectors built from catalogue data, a person by a signed sum of the
vectors of what they watched, and every score can be broken down and read.

## Layers

| file | what it is |
| --- | --- |
| `recs/titleindex.js` | What is known about a title, on disk (`data/cache/recs-titles.json`). Full records from one TMDB call; "lite" records from a catalogue card with no network. |
| `recs/taxonomy.js` + `taxonomy.json` | Canonical genre names; TMDB's keyword folksonomy mapped onto ~110 themes. |
| `recs/features.js` | A title as eight unit vectors; similarity between two titles. |
| `recs/person.js` | A profile's stored history as per-title evidence; the taste model. |
| `recs/rank.js` | Scoring, the diversity + calibration re-rank, the rows. |
| `recs/index.js` | Glue: caches, `/api/home` rows, the per-profile re-order of "More like this", the daily sync. `ALGO` lives here. |
| `recs/tmdb.js` | The one door to TMDB: paced (~9 requests/s), retried once, counted. |
| `vibe.js`, `similar.js` | "More like this" (the vibe ranker, v5) and its row cache. |
| `taste.js`, `hero.js` | The previous recommenders — still the fallback while the index is not in memory, and for a profile nothing is known about. |

## A title (`features.js`)

| block | built from | weight in title-to-title similarity |
| --- | --- | --- |
| `kw` | TMDB keywords, weighted by rarity across the index (stop-listed paperwork such as "based on novel" weighs nothing) | 0.24 |
| `theme` | the taxonomy's themes | 0.22 |
| `genre` | canonical genres; first-listed weighs most, common genres are discounted | 0.17 |
| `link` | TMDB's "recommended with" lists as a graph (the one collaborative signal available) | 0.12 |
| `people` | director / creator 1.0, writer 0.5, cast 0.6 falling by billing | 0.09 |
| `meta` | decade (neighbours count 0.4), language, film/series, runtime band, age band, country | 0.07 |
| `plot` | the synopsis' most telling words (TF-IDF) | 0.06 |
| `col` | the franchise (a bonus when shared, never a penalty) | 0.03 |

Plus priors used in ranking: a vote-shrunk rating (a 9.1 from 12 votes is not a
9.1), log-popularity, and freshness.

## The taxonomy

Six groups: **plot** (heist, whodunit, revenge, time travel, courtroom…),
**mood** (slow-burn, feel-good, dark comedy, mind-bending, satire…), **setting**
(space, dystopia, small town, wartime, prison…), **character** (found family,
coming of age, antihero, underdog…), **subgenre** (cyberpunk, neo-noir,
superhero, folk horror, epic fantasy…) and **form** (true crime, mockumentary,
anthology, anime…).

A theme matches a title by keyword (exact), by a keyword containing one of the
theme's `has` fragments, or by its `plot` pattern in the synopsis. One keyword
is weak evidence (0.7), two are solid (1.2), three or more settle it (1.5); the
synopsis alone is 0.4. `onlyGenres` fences a theme in ("slasher" needs Horror
or Thriller). `"row": false` keeps a theme out of the "More …" rows while it
still shapes taste ("suspenseful" is true of a title, not a reason to pick one).

It is a data file. To extend it:

```
node tools/recs-eval/keywords.js --top 200
```

prints how much of the index the taxonomy explains (currently ~96% of titles
have at least one theme) and the most common keywords no theme claims yet.

## A person (`person.js`)

Signals and weights are the table at the top of `person.js`. In short: ratings
(±3 … ±2), titles picked as loved (+2.5), a finished film (+1.6, +0.8 more for
a rewatch), a series by how far they went (6+ episodes +2.0 … dropped after the
pilot −0.4), a binge (+0.5), a follow (+1.5), My List (+1.0), marked watched
(+0.6), gave up early (−0.8), removed from Continue Watching (−1.0), and the
genres picked in Settings (a prior on genre only).

Time works on two scales at once: weight × (0.65 · half-life 180 days + 0.35 ·
half-life 14 days). Undated signals count 0.7.

Two things were added to the stored profile state for this (both additive):
`dismissed` (title → when it was removed from Continue Watching unfinished) and
`plays` on a progress row (a watched-through title started over at least six
hours later).

What is **not** used, because the data does not exist or is not tied to a title:
trailer plays, time spent on a title page, time of day. `watch-sessions.json`
names a title only by its display string.

## Ranking and rows (`rank.js`)

`score = (0.6 · taste + 0.4 · nearest − 0.6 · dislike) × quality prior + freshness + household + daily jitter`

- **taste**: the person's vector against the title's, block by block.
- **nearest**: closeness to the liked titles nearest to it (top 3).
- **dislike**: closeness to something abandoned, dismissed or rated down.
- The jitter is seeded by (profile, day): rows are byte-stable within a day.

Re-rank (greedy): `0.75 · score − 0.25 · similarity to what is already picked − 0.8 · KL(person's genre mix ‖ row's genre mix)`, one title per franchise.

Rows, in order — no title appears in two of them, nothing watched appears at all:

| id | title | built from |
| --- | --- | --- |
| `recommended` | Recommended for You | the calibrated, diversified best |
| `because-<imdbId>` (≤2) | Because you finished / loved / watched X | the neighbourhood of one strongly liked title |
| `theme-<slug>` (≤2) | More heists & capers | a theme at least two liked titles share |
| `person-<tmdbId>` (≤1) | From the director / creator of X | a maker behind two liked titles, or one loved one |
| `stretch` | Something Different | well-rated titles outside the person's usual genres and far from everything they liked |

Every item carries `why`; every row carries `reason` and (optionally) `sub`.

Cold start (almost no history): the Settings genre picks + what other profiles
in the household have liked in the last 90 days + quality. No picks and no
household: no personalised rows; the generic home is served as before.

Kids profiles: candidates are filtered by the same rule as the kids gate
before ranking (so the rows are full, not filtered down), and the gate in front
of the router still has the last word.

## Where the knowledge comes from

Only TMDB (free; the key already configured), through `recs/tmdb.js`.

| what | calls |
| --- | --- |
| a film → full record (keywords, credits, franchise, ratings by country, recommended + similar ids) | 1 |
| a series known only by its IMDb id | 2 (`/find` first) |
| a liked director's / creator's other work | 1 per maker per week |
| the best titles carrying a liked theme's keywords | 1 per theme per week |

The daily task `recommendations` (`recs.sync()`): learns what profiles touched,
upgrades catalogue cards to full records, then steps along each person's top
titles, makers and themes. Budget per run: 350 detail calls (1,200 on a first
run), 90 per profile for expansion, 40 for refreshing stale records. The index
is capped at 5,000 titles; the least-voted untouched ones are pruned.

Every title the "More like this" ranker enriches is also kept — rows people
open widen the index at no extra request.

Without a TMDB key, or with TMDB unreachable, the index still holds lite
records (genre, year, rating, synopsis) for everything in the catalogue and the
library; ranking and "More like this" run on those.

## The ALGO rule

`ALGO` in `recs/index.js` is part of every cache key. Bump it whenever ranking
changes — weights, signals, features, row rules, the meaning of a theme. The
"More like this" rows on disk have their own `ALGO` in `similar.js` (now 5),
same rule.

## Evaluating a change

```
# the index the evaluation runs on (this checkout's data/, never the live server's)
TMDB_API_KEY=… node tools/recs-eval/build-index.js --library http://localhost:4000/api/library --profiles <profiles.json>

# old vs new: household replay (aggregates only), personas, item-to-item
node tools/recs-eval/eval.js --profiles <profiles.json> --ablate --examples

# end to end in a private copy of the server: latency, memory, invariants, the rows
node --expose-gc tools/recs-eval/bench.js --rows
```

`eval.js` never prints a household member's name or a title from their
history; the examples it prints are for the synthetic personas in
`tools/recs-eval/personas.js`.
