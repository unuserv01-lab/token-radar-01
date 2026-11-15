# Calibration — how the implied value is anchored (radar-v6-2)

Reproduce everything here with `node tools/fit-comps.mjs <snapshot.json>`.

## The anchor: a comps fit on the snapshot's own live tokens

The old model valued every protocol at `tvl x 0.25` — a round number with no basis.
The v6-2 model fits the market instead: a log-log regression of market cap on TVL
across the **128 live-token protocols** in this snapshot (mcap_usd and tvl_usd both
present and positive):

```
ln(mcap) = 6.9646 + 0.5223 * ln(tvl)     R2 = 0.19, n = 128
```

So `compsValue = exp(6.9646) * tvl^0.5223` — a multiple that falls smoothly with size:

| TVL | Fitted multiple | Fitted mcap |
| --- | --- | --- |
| $5M | 0.67x | $3.3M |
| $28M | 0.29x | $8.2M |
| $154M (watchlist median) | 0.13x | $20.0M |
| $1B | 0.05x | $53.1M |
| $10B | 0.018x | $176.7M |

The same pattern shows in the banded medians (0.42x / 0.17x / 0.08x / 0.03x across
the four TVL bands), so the smooth fit follows the data rather than imposing a shape.
The multiple is clamped to [0.01, 1.0] as a guard for the largest protocols.

## How good is the fit? (honest numbers)

- Leave-one-out validation: **median error 3.40x**, 32% of protocols predicted within 2x.
- The old flat 0.25 on the same test: median error **4.91x**, 30% within 2x.
- The fit is better out-of-sample, but R2 is only 0.19 and the residual spread is wide:
  the fit anchors the LEVEL of the board, it never pretends to price one protocol
  precisely. The dashboard says so on the page.

## What was tried and rejected

- **4-variable fit (adding 7-day growth and age):** R2 rose only to 0.21, and the growth
  coefficient came out at **-3.79** — high-growth live tokens are small caps that pumped,
  so the regression would punish exactly the momentum a radar should reward. Growth and
  age enter through the model's own multipliers instead, where their direction is stated,
  not fitted.
- **Category-matched fit (excluding CEX / bridges / liquid staking, n = 94):** R2 fell
  to 0.10 and leave-one-out error rose to 3.65x. The anchor is market-wide, and the model
  says so; it does not claim a category-matched comp.

## The rest of the value formula (unchanged drivers)

```
implied = round( compsValue x growthMult x maturityMult x scoreBoost )
growthMult   = 1 + clamp(change_7d, -60, 120) / 100 x 0.5
maturityMult = 0.6 + min(age_days or 0, 1095) / 1095 x 0.4   (unknown age: 0, no credit)
scoreBoost   = 0.6 + 0.8 x v6_score
```

## Score changes in v6-2 (same file, lib/model.ts header has the full reasoning)

- **Cross-validation is 0.** One sealed cross-section carries no independent
  confirmation; its four "confirmation" fields are the same fields source quality
  already counts. Its 0.25 weight is redistributed over the three measurable
  components (0.40 / 1/3 / 4/15) so the weights still sum to 1 and the 0.45 / 0.75
  tier thresholds keep their meaning.
- **Wallet reputation is renamed maturity scale** — it is half age, half log-TVL, and
  never measured a wallet.
- **Unknown age earns no maturity credit** (was: 365 invented days).
- **Change evidence is graded** (full to 200%, fading to 0 at 400%) instead of a cliff
  at 200%.
- **Spike flag renamed** `volume-spike` -> `tvl-spike` (the trigger is TVL growth; the
  snapshot has no volume figure).
- **Duplicates deduped openly** (highest TVL wins, every duplicate reported) and the
  **tie-break is implied value, then TVL, then slug**, with ties counted.
- **Farm plans** use a rough per-chain gas table (documented estimates, not quotes) and
  carry an 8th step stating the plan's limits: capital is a TVL heuristic and nobody
  checked whether the protocol runs a farming or points program.
