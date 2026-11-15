# Token Radar — pre-token protocols ranked by implied value

A make.fun token-radar-01 entry (program/v1). It reads the sealed DefiLlama snapshot,
scores every pre-token protocol with a valuation model adapted from **Sigma On-Chain V6**
(the owner's own signal engine), and renders a sortable, filterable dashboard with a
detail view and a farm plan for every ranked protocol.

## The value model (Sigma V6, adapted)

V6 scores every on-chain signal as a weighted sum, then routes it by threshold
(`v6_signal_processor.py`):

```
SCORE = SOURCE_QUALITY * 0.30 + WALLET_REPUTATION * 0.25
      + SIGNAL_STRENGTH * 0.20 + CROSS_VALIDATION * 0.25
score < 0.45  -> DISCARD      (noise, never distributed)
score >= 0.45 -> DISTRIBUTE
score >= 0.75 -> PRIORITY     (priority push)
```

The radar ports that engine to the snapshot. A protocol is the "signal" and the
snapshot's own figures are the evidence — no protocol name is ever special-cased:

| V6 component | Weight | Snapshot mapping |
| --- | --- | --- |
| SOURCE_QUALITY | 0.30 | Record completeness, Bayesian-style prior. Base 0.55 (Birdeye's prior) + 0.15 listed date with 180+ days of track record + 0.10 sane reported 7-day change (\|change\| ≤ 200%) + 0.10 named category + 0.10 three or more chains. A field counts only when it is informative. |
| WALLET_REPUTATION | 0.25 | Protocol reputation, standing in for V6's wallet score. Half maturity (age capped at 1095 days, unknown age = 365 days) and half scale (log TVL from the $5M floor). |
| SIGNAL_STRENGTH | 0.20 | Momentum. V6's DEX scanner fires on a >= 4x volume spike; here the spike is the 7-day TVL change, clamped to [-60, +120]% and mapped onto [0, 1]. |
| CROSS_VALIDATION | 0.25 | V6's own step function over four independent fields of the record (listed date with 180+ days behind it, sane 7-day change, named category, deployment on 3+ chains): 1 field = 0.0, 2 = 0.6, 3+ = 1.0. |

Implied value:

```
implied = round( tvl_usd x 0.25 x growthMult x maturityMult x scoreBoost )
growthMult   = 1 + clamp(change_7d, -60, 120) / 100 x 0.5
maturityMult = 0.6 + min(age_days, 1095) / 1095 x 0.4   (unknown age: 365 days)
scoreBoost   = 0.6 + 0.8 x v6_score
```

The V6 tier is shown on every row. A DISCARD row is still ranked (the gate requires
every watchlist slug on the board) but the dashboard marks it "watch only" and its
farm plan says so.

Risk flags come from V6's DEX scanner and two-layer anti-rug screener, adapted to
what the snapshot can see: a 7-day fall of 30% or more is a `drain-watch` (V6 fires
CRITICAL at a >= 30% drain); a rise of 100% or more is a `volume-spike`; a protocol
under 90 days old with under $100M TVL is a `new-launch`.

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
- Every row carries a 7-step farm plan with a cost and a time for each step, derived
  from the protocol's own category, chains, TVL, age and V6 tier.

## How to run

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Node 22.18+ (tested on Node 24), standard library only, no network. The run is
deterministic: the same snapshot bytes always produce the same `board.json` and
`dossier.json`.

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
lib/model.ts             V6-adapted valuation model + farm plan generator
vendor/makefun-board.ts  make.fun's dossier library (copied from the kit, byte for byte)
dashboard/index.html     page shell
dashboard/app.css        dark radar-room styling
dashboard/app.js         board, filters, detail view, hash routing
screenshots/             1-board.png, 2-detail.png, 3-filtered.png
LICENSE                  MIT
```

## Screenshot note

The three PNGs in `screenshots/` are **temporary placeholders** generated with
PIL so the entry runs end to end and the dossier builds. They are NOT screenshots
of the dashboard. The parent agent replaces them with real browser screenshots of
the three hash views above (`#/`, `#/detail/<rank-1 slug>`, `#/filtered`) before
submitting.
