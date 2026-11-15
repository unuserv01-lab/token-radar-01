# Token Radar — pre-token protocols ranked by implied value

A make.fun token-radar-01 entry (program/v1). It reads the sealed DefiLlama snapshot,
scores every pre-token protocol with a valuation model adapted from **Sigma On-Chain V6**
(the owner's own signal engine), and renders a sortable, filterable dashboard with a
detail view and a farm plan for every ranked protocol.

## The value model (Sigma V6, adapted — radar-v6-2)

V6 scores every on-chain signal as a weighted sum, then routes it by threshold
(`v6_signal_processor.py`):

```
SCORE = SOURCE_QUALITY * 0.40 + MATURITY_SCALE * 0.33
      + SIGNAL_STRENGTH * 0.27 + CROSS_VALIDATION * 0.00
score < 0.45  -> DISCARD      (noise, never distributed)
score >= 0.45 -> DISTRIBUTE
score >= 0.75 -> PRIORITY     (priority push)
```

The weights are V6's, renormalized over the three components a single sealed snapshot
can measure: cross-validation is **0** — one cross-section carries no independent
confirmation, and its four "confirmation" fields are the same fields source quality
already counts, so counting them again would double-count the evidence. Its 0.25 weight
is shared out (0.30/0.75, 0.25/0.75, 0.20/0.75) so the weights still sum to 1 and the
0.45 / 0.75 thresholds keep their meaning. Without the redistribution, PRIORITY would
be unreachable even at a perfect record.

The radar ports that engine to the snapshot. A protocol is the "signal" and the
snapshot's own figures are the evidence — no protocol name is ever special-cased:

| V6 component | Weight | Snapshot mapping |
| --- | --- | --- |
| SOURCE_QUALITY | 0.40 | Record completeness on a stated 0.55 baseline (a heuristic, not a calibrated prior) + 0.15 listed date with 180+ days of track record + 0.10 change evidence (full while \|change\| ≤ 200%, fading linearly to 0 at 400% — no cliff at 200%) + 0.10 named category + 0.10 three or more chains. A field counts only when it is informative. |
| MATURITY_SCALE | 0.33 | Half maturity (age capped at 1095 days; an unknown age earns no credit — 0 days, not the old invented 365) and half scale (log TVL from the $5M floor). Renamed from WALLET_REPUTATION: it never measured a wallet. |
| SIGNAL_STRENGTH | 0.27 | Momentum. V6's DEX scanner fires on a >= 4x volume spike; here the spike is the 7-day TVL change, clamped to [-60, +120]% and mapped onto [0, 1]. |
| CROSS_VALIDATION | 0.00 | 0 until an outside source confirms a protocol. The evidence count is still reported, so completeness stays visible — it just earns no confirmation bonus. |

Implied value — fitted on comps, not guessed:

```
implied = round( compsValue x growthMult x maturityMult x scoreBoost )
compsValue   = exp(6.9646) x tvl^0.5223, multiple clamped to [0.01, 1.0]
growthMult   = 1 + clamp(change_7d, -60, 120) / 100 x 0.5
maturityMult = 0.6 + min(age_days or 0, 1095) / 1095 x 0.4   (unknown age: 0)
scoreBoost   = 0.6 + 0.8 x v6_score
```

`compsValue` is a log-log fit of market cap on TVL across the 128 live-token
protocols in this snapshot (`ln(mcap) = 6.9646 + 0.5223 x ln(tvl)`, R2 0.19;
leave-one-out median error 3.40x, against 4.91x for the old flat 0.25 multiple).
The multiple falls smoothly with size — 0.67x at $5M TVL, 0.13x at $154M, 0.05x at
$1B. Reproduce it with `node tools/fit-comps.mjs <snapshot.json>`; `CALIBRATION.md`
records the numbers and the rejected alternatives (a 4-variable fit whose growth
coefficient came out at -3.79 — confounded, rejected; a category-matched fit that
fit worse, rejected).

The V6 tier is shown on every row. A DISCARD row is still ranked (the gate requires
every watchlist slug on the board) but the dashboard marks it "watch only" and its
farm plan says so. On this snapshot: **0 PRIORITY, 176 DISTRIBUTE, 44 DISCARD** —
no protocol earns PRIORITY once the double-counted confirmation is removed; the top
score is 0.71. That is the honest outcome of the fix, not a target to tune back.

Risk flags come from V6's DEX scanner and two-layer anti-rug screener, adapted to
what the snapshot can see: a 7-day fall of 30% or more is a `drain-watch` (V6 fires
CRITICAL at a >= 30% drain); a rise of 100% or more is a `tvl-spike` (the trigger is
TVL growth — the snapshot carries no volume figure, so the old `volume-spike` name
was wrong); a protocol under 90 days old with under $100M TVL is a `new-launch`.

Duplicate slugs are deduped openly (highest TVL wins; every duplicate is reported),
and the board tie-break is implied value, then TVL, then slug, with ties counted.

Discovery borrows the shape of CloddsBot's pump.fun skill (read as reference only,
logic rewritten here): rank candidates the way pump.fun surfaces tokens — trending
by volume, gainers by change, new-hot by recency — then separate the "already
trading" set from the "still to come" set. Protocols whose token already trades
(market cap on record) are set aside in the Live token view with their market cap
shown, never ranked as pre-token.

## The board

- **220 rows**: all 40 watchlist protocols (the floor, never the ceiling) plus the
  180 pre-token protocols below the floor with the most TVL — the early radar.
- **32 live-token protocols** set aside, by market cap.
- Every row carries an **8-step farm plan** with a cost and a time for each step, derived
  from the protocol's own category, chains, TVL, age and V6 tier. Gas is a rough
  per-chain estimate (Ethereum ~$5, Base ~$0.20, Solana ~$0.01, unlisted chains $2);
  the 8th step states the plan's limits in plain words: capital is a TVL heuristic and
  nobody checked whether the protocol runs a farming or points program.

## How to run

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
node test-radar.ts [<snapshot.json>]          # 47 deterministic tests
node tools/fit-comps.mjs <snapshot.json>      # reproduce the comps fit
```

Node 22.18+ (tested on Node 24), standard library only, no network. The run is
deterministic: the same snapshot bytes always produce the same `board.json` and
`dossier.json` (verified: two runs byte-identical).

## Dashboard deep links (hash routing)

| Hash | View |
| --- | --- |
| `#/` | The board, unfiltered |
| `#/detail/<slug>` | One protocol's detail view (use the rank-1 slug for the detail screenshot) |
| `#/filtered` | Preset filtered view: pre-token **Risk Curators** protocols, TVL $100M and up (9 rows, including ranks 1–3) |
| `#/filter?category=<c>&tier=<t>&minTvl=<n>&q=<text>` | Any filter combination; the hash is written back as you filter |

The dashboard is a static page with no network: `dashboard/index.html`,
`dashboard/app.css`, `dashboard/app.js` read `data.js` written beside them. The
page recomputes each row's V6 score and implied value from the snapshot figures
and checks the number `board.json` carries, so the code and the data agree.

## Files

```
main.ts                  entrypoint (Node 22, stdlib only)
lib/model.ts             V6-adapted valuation model + farm plan generator (radar-v6-2)
test-radar.ts            47 deterministic tests for the model (run: node test-radar.ts)
tools/fit-comps.mjs      reproduces the comps fit from any snapshot
CALIBRATION.md           the fit, its validation numbers, and the rejected alternatives
vendor/makefun-board.ts  make.fun's dossier library (copied from the kit, byte for byte)
dashboard/index.html     page shell
dashboard/app.css        dark radar-room styling
dashboard/app.js         board, filters, detail view, hash routing (+ a hash-routing fix:
                         changing hash no longer keeps the previous detail dialog open)
screenshots/             1-board.png, 2-detail.png, 3-filtered.png
LICENSE                  MIT
```

## Screenshot note

The three PNGs in `screenshots/` are **real browser captures** of the dashboard
rendered on this snapshot (headless Chromium, 1440x900, Playwright): the board at
`#/`, the rank-1 detail at `#/detail/steakhouse-financial`, and the preset filtered
view at `#/filtered` (Risk Curators, TVL $100M+, 9 rows). Each is under the 512 KiB
cap (126 KB / 180 KB / 139 KB). The capture script is a dev tool, not part of the
entry; the method is: build the output with `main.ts`, serve it over loopback HTTP,
screenshot the three hash views. The page's recompute was verified against
`board.json` on the detail shot: the page shows the same $81.1M for rank 1 that the
board carries.
