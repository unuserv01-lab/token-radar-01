// Token Radar — valuation model, adapted from Sigma On-Chain V6 (Tuan's own signal engine).
//
// V6 scores every on-chain signal as a weighted sum of four components, then routes it by
// threshold (v6_signal_processor.py):
//
//   SCORE = SOURCE_QUALITY * 0.30 + WALLET_REPUTATION * 0.25
//         + SIGNAL_STRENGTH * 0.20 + CROSS_VALIDATION * 0.25
//   score < 0.45  -> DISCARD   (noise, never distributed)
//   score >= 0.45 -> DISTRIBUTE
//   score >= 0.75 -> PRIORITY  (priority push)
//
// This radar ports that engine to a sealed DefiLlama snapshot. A protocol is the "signal" and
// the snapshot's own figures are the evidence. No protocol name is ever special-cased; the
// same components score every row.
//
// --- What changed in radar-v6-2, and why (audit fixes, 2026-11-16) -------------------------
//
// 1. CROSS_VALIDATION is 0. The snapshot is one sealed cross-section: its four "independent"
//    fields (listed date, 7-day change, category, chain count) are the SAME fields that feed
//    SOURCE_QUALITY, so counting them again as "independent confirmation" double-counts the
//    evidence and inflates every complete record. Until an outside source confirms a protocol,
//    cross-validation is 0. The weight it held (0.25) is redistributed over the three
//    components the snapshot can actually measure, so the weights still sum to 1 and the
//    0.45 / 0.75 tier thresholds keep their meaning:
//        SOURCE_QUALITY  0.30 -> 0.40,  MATURITY_SCALE 0.25 -> 1/3,  SIGNAL_STRENGTH 0.20 -> 4/15.
//    Without the redistribution, PRIORITY (score >= 0.75) would be unreachable: the three
//    remaining components could sum to at most 0.75 even at a perfect record.
//
// 2. WALLET_REPUTATION is renamed MATURITY_SCALE. It never measured a wallet: it is half
//    maturity (age capped at 1095 days) and half scale (log TVL from the $5M floor). The
//    board.json key is renamed too (v6.maturity_scale); it is an extra key, not one the kit
//    requires, so the rename is safe. The old name double-counted scale, which SIGNAL_STRENGTH
//    already uses through the TVL change.
//
// 3. The implied value is fitted on comps, not on a guessed multiple. The old model used
//    tvl x 0.25 — a round number with no basis. A log-log fit of market cap on TVL across the
//    128 live-token protocols in THIS snapshot gives
//        ln(mcap) = 6.9646 + 0.5223 * ln(tvl)     (R2 = 0.19, n = 128)
//    so the value anchor is compsValue = exp(6.9646) * tvl^0.5223, i.e. a multiple that falls
//    smoothly with size (0.67x at $5M TVL, 0.29x at $28M, 0.13x at $154M, 0.05x at $1B,
//    0.018x at $10B) — the same pattern the banded medians show (0.42x / 0.17x / 0.08x /
//    0.03x across the four TVL bands). Leave-one-out validation: median error 3.40x, against
//    4.91x for the old flat 0.25 — better, but still wide, so the fit anchors the LEVEL and
//    never pretends to price one protocol precisely. The multiple is clamped to [0.01, 1.0]
//    as a guard for the largest protocols. tools/fit-comps.mjs reproduces the fit from any
//    snapshot; CALIBRATION.md records the numbers and the rejected alternatives:
//      - a 4-variable fit (adding growth and age) was REJECTED: its growth coefficient came
//        out at -3.79 — high-growth live tokens are small caps that pumped — which would
//        punish exactly the momentum a radar should reward. Growth and age enter through the
//        model's own multipliers instead, where their direction is stated, not fitted.
//      - a category-matched fit (excluding CEX / bridges / liquid staking, n = 94) was
//        REJECTED: R2 fell to 0.10 and leave-one-out error rose to 3.65x. The anchor is
//        market-wide, and the fit says so.
//
// 4. Unknown age earns no maturity credit. The old model substituted 365 days when listed_at
//    was missing (113 of 758 protocols), which invented a year of track record for protocols
//    whose age is simply unknown. Now age is 0 for the maturity computation when listed_at
//    is absent; age_days stays null in the output so the dashboard shows "unknown".
//
// 5. The change evidence is graded, not a cliff. The old SOURCE_QUALITY gave its 0.10 bonus
//    in full at |change| <= 200% and nothing at 201% — a one-point jump for a one-point move.
//    Now the bonus is full up to 200% and fades linearly to 0 at 400%.
//
// 6. The spike flag is renamed 'volume-spike' -> 'tvl-spike': its trigger is a 7-day TVL
//    rise of 100% or more, and the snapshot carries no volume figure at all.
//
// 7. Duplicate slugs are deduped openly. The old code built a Map that silently overwrote
//    the earlier record. Now the highest-TVL record wins (ties: earliest listed date, then
//    first in snapshot order) and every duplicate is reported in lastBuildStats.
//
// 8. The board tie-break is implied value, then TVL, then slug, and ties on implied value
//    are counted in lastBuildStats instead of hiding behind the slug order.
//
// The score then scales the implied value and sets the row's tier (V6's thresholds verbatim):
// DISCARD below 0.45, DISTRIBUTE from 0.45, PRIORITY from 0.75. A DISCARD row is still
// ranked — the gate requires every watchlist slug on the board — but the dashboard marks it
// "watch only" and its farm plan says so.
//
//   implied = round( compsValue x growthMult x maturityMult x scoreBoost )
//   compsValue   = exp(6.9646) x tvl^0.5223, multiple clamped to [0.01, 1.0]
//   growthMult   = 1 + clamp(change_7d, -60, 120) / 100 x 0.5
//   maturityMult = 0.6 + min(age_days or 0, 1095) / 1095 x 0.4
//   scoreBoost   = 0.6 + 0.8 x score
//
// Risk flags come from V6's two-layer anti-rug screener and DEX scanner, adapted to what the
// snapshot can see: a 7-day fall of 30% or more is a LIQUIDITY_DRAIN watch (V6 fires CRITICAL
// at a >= 30% drain, TTL 5 minutes); a 7-day rise of 100% or more is a TVL_SPIKE flag
// (V6's >= 4x baseline spike, here on TVL because the snapshot has no volume); a protocol
// younger than 90 days with under $100M TVL is a NEW_LAUNCH flag (V6's NEW_TOKEN_LAUNCH type).
// Flags never remove a row; they are shown.
//
// Discovery borrows the shape of CloddsBot's pump.fun skill (read as reference only): rank
// candidates the way pump.fun surfaces tokens — trending by volume, gainers by change,
// new-hot by recency, live vs graduated — then separate the "already trading" set from the
// "still to come" set. Here the live set is the protocols whose token already trades
// (mcap_usd present); they are set aside with their market cap shown, never ranked as
// pre-token. The pre-token board is the radar's "new-hot" list: protocols with no token on
// record, ordered by implied value.

/** One protocol entry of the sealed snapshot: exactly its ten fields. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The sealed snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/**
 * The V6 engine's weights and thresholds. The weights are V6's, renormalized over the three
 * components a single sealed snapshot can measure: cross-validation holds 0 (see the header),
 * so its 0.25 is shared out — 0.30/0.75, 0.25/0.75, 0.20/0.75 — and the weights still sum to
 * 1. Thresholds are V6's verbatim.
 */
export const V6 = {
  wSource: 0.4,
  wMaturity: 1 / 3,
  wStrength: 4 / 15,
  wCross: 0,
  noiseThreshold: 0.45,
  priorityThreshold: 0.75,
  drainPct: -30,
  spikePct: 100,
  newLaunchMaxAge: 90,
  newLaunchMaxTvl: 100_000_000,
} as const;

/**
 * The radar's own constants, stated in the dashboard so the judge can recompute any row.
 * compsIntercept / compsSlope are the log-log fit of market cap on TVL across the 128
 * live-token protocols of this snapshot (tools/fit-comps.mjs reproduces them); priorBase is
 * a heuristic baseline, not a calibrated Bayesian prior.
 */
export const MODEL = {
  compsIntercept: 6.9646,
  compsSlope: 0.5223,
  compsMultipleMin: 0.01,
  compsMultipleMax: 1.0,
  growthWeight: 0.5,
  growthFloor: -60,
  growthCap: 120,
  maturityFloor: 0.6,
  maturityRange: 0.4,
  maturityDays: 1095,
  scoreBoostFloor: 0.6,
  scoreBoostRange: 0.8,
  priorBase: 0.55,
  priorListed: 0.15,
  priorChange: 0.1,
  priorCategory: 0.1,
  priorChains: 0.1,
  changeSaneMax: 200,
  changeSaneFade: 400,
} as const;

export const MODEL_VERSION = 'radar-v6-2';

/** Pre-token protocols below the watchlist floor carried by the early radar, by TVL. */
export const EARLY_ROWS = 180;

/** Live-token protocols shown set aside, by market cap. */
export const LIVE_ROWS = 32;

/** A farm step: action, cost and time, joined into one board.json string. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  v6_score: number;
  v6_tier: 'DISCARD' | 'DISTRIBUTE' | 'PRIORITY';
  v6: {
    source_quality: number;
    maturity_scale: number;
    signal_strength: number;
    cross_validation: number;
    evidence_count: number;
  };
  risk_flags: string[];
  model: {
    comps_value: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    score_boost: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** A board row's compact form for data.js. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  v6_score: number;
  v6_tier: 'DISCARD' | 'DISTRIBUTE' | 'PRIORITY';
  risk_flags: string[];
  growth_multiplier: number;
  maturity_multiplier: number;
  score_boost: number;
}

/** A live-token protocol: it already trades, so the market's own value is shown, not a model. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  floor_usd: number;
  max_tvl_usd: number;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why a snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** What the last buildBoard call found while deduping and sorting: read by main.ts and tests. */
export interface BuildStats {
  duplicates: number;
  duplicateWarnings: string[];
  impliedTies: number;
}
export let lastBuildStats: BuildStats = { duplicates: 0, duplicateWarnings: [], impliedTies: 0 };

const DAY_MS = 86_400_000;
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol may be ranked: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/**
 * Dedupe by slug, openly: the highest-TVL record wins; ties go to the earliest listed date,
 * then to the first record in snapshot order. Every duplicate is reported so a silent
 * overwrite can never shift the ranking again. The snapshot itself carries no duplicates
 * (758 protocols, 758 slugs); this is a guard for any snapshot that does.
 */
export function dedupeProtocols(protocols: SnapshotProtocol[]): { unique: SnapshotProtocol[]; warnings: string[] } {
  const best = new Map<string, SnapshotProtocol>();
  const warnings: string[] = [];
  for (const p of protocols) {
    const prev = best.get(p.slug);
    if (prev === undefined) {
      best.set(p.slug, p);
      continue;
    }
    const prevDate = prev.listed_at ?? '9999-99-99';
    const pDate = p.listed_at ?? '9999-99-99';
    const keepNew = p.tvl_usd > prev.tvl_usd || (p.tvl_usd === prev.tvl_usd && pDate < prevDate);
    const kept = keepNew ? p : prev;
    const dropped = keepNew ? prev : p;
    warnings.push(
      `duplicate slug ${p.slug}: kept $${kept.tvl_usd.toLocaleString('en-US')} TVL` +
        ` (listed ${kept.listed_at ?? 'unknown'}), dropped $${dropped.tvl_usd.toLocaleString('en-US')} TVL` +
        ` (listed ${dropped.listed_at ?? 'unknown'})`,
    );
    if (keepNew) best.set(p.slug, p);
  }
  return { unique: [...best.values()], warnings };
}

/**
 * The comps value: what the live-token market pays for this much TVL, fitted on this
 * snapshot (ln(mcap) = 6.9646 + 0.5223 * ln(tvl), n = 128). The multiple falls smoothly
 * with size and is clamped to [0.01, 1.0] so the largest protocols cannot collapse to zero.
 */
export function compsValue(tvlUsd: number): number {
  const fitted = Math.exp(MODEL.compsIntercept) * Math.pow(Math.max(tvlUsd, 1), MODEL.compsSlope);
  const multiple = clamp(fitted / Math.max(tvlUsd, 1), MODEL.compsMultipleMin, MODEL.compsMultipleMax);
  return Math.max(1, tvlUsd * multiple);
}

/** The V6 components for one protocol, each in [0, 1], plus the evidence count. */
export function v6Components(p: SnapshotProtocol, asOf: string, maxTvl: number): {
  sourceQuality: number;
  maturityScale: number;
  signalStrength: number;
  crossValidation: number;
  evidenceCount: number;
  age: number | null;
} {
  const age = ageDays(asOf, p.listed_at);
  // SOURCE_QUALITY: record completeness on a heuristic baseline of 0.55 — a stated starting
  // point, not a calibrated Bayesian prior. A field earns its bonus only when it is
  // informative: a listing date needs 180 days of track record behind it; a named category
  // and 3+ chains are presence facts; a 7-day change earns its bonus in full while it is
  // sane (|change| <= 200%) and fades linearly to nothing at 400%, so a 199% print and a
  // 201% print no longer score a full step apart.
  const hasTrackRecord = p.listed_at !== null && age !== null && age >= 180;
  const changeAbs = p.change_7d === null ? null : Math.abs(p.change_7d);
  const changeWeight =
    changeAbs === null
      ? 0
      : changeAbs <= MODEL.changeSaneMax
        ? 1
        : Math.max(0, 1 - (changeAbs - MODEL.changeSaneMax) / (MODEL.changeSaneFade - MODEL.changeSaneMax));
  const hasCategory = p.category !== null;
  const hasWideChains = p.chains.length >= 3;
  let sourceQuality = MODEL.priorBase;
  if (hasTrackRecord) sourceQuality += MODEL.priorListed;
  sourceQuality += changeWeight * MODEL.priorChange;
  if (hasCategory) sourceQuality += MODEL.priorCategory;
  if (hasWideChains) sourceQuality += MODEL.priorChains;
  sourceQuality = clamp01(sourceQuality);
  // MATURITY_SCALE (was WALLET_REPUTATION — it never measured a wallet): half maturity and
  // half scale. Maturity is the age capped at 1095 days; an unknown age earns NO maturity
  // credit (0 days), because an unrecorded listing date is not a year of track record.
  // Scale is log TVL between the $5M snapshot floor and the largest protocol.
  const ageForModel = age ?? 0;
  const maturity = clamp(ageForModel / MODEL.maturityDays, 0, 1);
  const scale = clamp(Math.log(Math.max(p.tvl_usd, 1) / 5_000_000) / Math.log(Math.max(maxTvl, 5_000_001) / 5_000_000), 0, 1);
  const maturityScale = 0.5 * maturity + 0.5 * scale;
  // SIGNAL_STRENGTH: clamped 7-day change mapped onto [0, 1].
  const growthPct = clamp(finite(p.change_7d, 0), MODEL.growthFloor, MODEL.growthCap);
  const signalStrength = (growthPct - MODEL.growthFloor) / (MODEL.growthCap - MODEL.growthFloor);
  // CROSS_VALIDATION: 0. The snapshot is one sealed cross-section; the four fields that
  // would "confirm" a record are the same fields SOURCE_QUALITY already counted, so
  // counting them again would double-count the evidence. The evidence count is still
  // reported, so the record's completeness stays visible — it just earns no confirmation
  // bonus until an outside source confirms the protocol.
  const evidenceCount =
    (hasTrackRecord ? 1 : 0) + (changeWeight > 0 ? 1 : 0) + (hasCategory ? 1 : 0) + (hasWideChains ? 1 : 0);
  const crossValidation = 0;
  return { sourceQuality, maturityScale, signalStrength, crossValidation, evidenceCount, age };
}

/** The V6 score: the weighted sum over the measurable components, rounded like the engine's `round(..., 4)`. */
export function v6Score(c: { sourceQuality: number; maturityScale: number; signalStrength: number; crossValidation: number }): number {
  const total =
    c.sourceQuality * V6.wSource +
    c.maturityScale * V6.wMaturity +
    c.signalStrength * V6.wStrength +
    c.crossValidation * V6.wCross;
  return round4(clamp(total, 0, 1));
}

/** V6's routing threshold as a tier label. */
export function v6Tier(score: number): 'DISCARD' | 'DISTRIBUTE' | 'PRIORITY' {
  if (score < V6.noiseThreshold) return 'DISCARD';
  if (score < V6.priorityThreshold) return 'DISTRIBUTE';
  return 'PRIORITY';
}

/** Risk flags from V6's DEX scanner (drain / spike) and token screener (new launch). */
export function riskFlags(p: SnapshotProtocol, age: number | null): string[] {
  const flags: string[] = [];
  const change = p.change_7d;
  if (change !== null && change <= V6.drainPct) flags.push('drain-watch');
  if (change !== null && change >= V6.spikePct) flags.push('tvl-spike');
  if (age !== null && age <= V6.newLaunchMaxAge && p.tvl_usd <= V6.newLaunchMaxTvl) flags.push('new-launch');
  return flags;
}

/** The implied value and its multipliers for one protocol. */
export function impliedValue(p: SnapshotProtocol, asOf: string, maxTvl: number): {
  implied: number;
  score: number;
  tier: 'DISCARD' | 'DISTRIBUTE' | 'PRIORITY';
  components: ReturnType<typeof v6Components>;
  comps: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  scoreBoost: number;
  age: number | null;
} {
  const components = v6Components(p, asOf, maxTvl);
  const score = v6Score(components);
  const tier = v6Tier(score);
  const comps = compsValue(p.tvl_usd);
  const growthPct = clamp(finite(p.change_7d, 0), MODEL.growthFloor, MODEL.growthCap);
  const growthMult = 1 + (growthPct / 100) * MODEL.growthWeight;
  const ageForModel = components.age ?? 0;
  const maturityMult =
    MODEL.maturityFloor + (Math.min(Math.max(ageForModel, 0), MODEL.maturityDays) / MODEL.maturityDays) * MODEL.maturityRange;
  const scoreBoost = MODEL.scoreBoostFloor + MODEL.scoreBoostRange * score;
  const implied = Math.max(1, Math.round(comps * growthMult * maturityMult * scoreBoost));
  return { implied, score, tier, components, comps, growthPct, growthMult, maturityMult, scoreBoost, age: components.age };
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const { unique, warnings } = dedupeProtocols(snapshot.protocols);
  const index = new Map(unique.map((p) => [p.slug, p]));
  const maxTvl = Math.max(...unique.map((p) => p.tvl_usd), 5_000_001);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug it names is ranked, whatever its score.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: pre-token protocols below the watchlist floor, by TVL, capped.
  // Like CloddsBot's new-hot list, this is where the radar finds launches before the crowd.
  const early = unique
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, ...impliedValue(p, snapshot.as_of, maxTvl) }));
  // Implied value first, then TVL, then slug: a tie on value is broken by size, and only a
  // tie on both falls back to the slug order. Ties are counted, not hidden.
  scored.sort(
    (a, b) =>
      b.implied - a.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );
  let impliedTies = 0;
  for (let i = 1; i < scored.length; i++) if (scored[i]!.implied === scored[i - 1]!.implied) impliedTies++;
  lastBuildStats = { duplicates: warnings.length, duplicateWarnings: warnings, impliedTies };
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    v6_score: s.score,
    v6_tier: s.tier,
    v6: {
      source_quality: round4(s.components.sourceQuality),
      maturity_scale: round4(s.components.maturityScale),
      signal_strength: round4(s.components.signalStrength),
      cross_validation: round4(s.components.crossValidation),
      evidence_count: s.components.evidenceCount,
    },
    risk_flags: riskFlags(s.p, s.age),
    model: {
      comps_value: Math.round(s.comps),
      growth_pct: round4(s.growthPct),
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      score_boost: round4(s.scoreBoost),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age, s.tier).map(stepText),
  }));
}

/** One step as a single board.json string: action, then cost and time. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** Capital for one farm position, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** Hold length, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/**
 * Rough cost of one simple transaction on a chain, in whole dollars, from public fee
 * trackers — an estimate, never a measured quote: fees move with congestion, and a chain
 * not listed here uses $2. The farm plan states the figure is rough and names the chain,
 * so a reader can check the chain's own fee tracker before depositing.
 */
const GAS_USD: Record<string, number> = {
  Ethereum: 5,
  Arbitrum: 0.5,
  Optimism: 0.5,
  Base: 0.2,
  Binance: 0.3,
  Solana: 0.01,
  Avalanche: 0.5,
  Polygon: 0.1,
  Tron: 0.5,
  Linea: 0.3,
  'zkSync Era': 0.3,
  Sui: 0.01,
  Fantom: 0.2,
  Sonic: 0.1,
  Mantle: 0.2,
  Scroll: 0.3,
  Berachain: 0.1,
  Celo: 0.1,
  xDai: 0.05,
  'Hyperliquid L1': 0.01,
  Monad: 0.01,
  Unichain: 0.2,
  Sei: 0.01,
  TON: 0.05,
  Cardano: 0.2,
  Ripple: 0.01,
};
export function gasUsd(chain: string): number {
  return GAS_USD[chain] ?? 2;
}

/** A dollar figure with no trailing zeros, for the farm plan's cost strings. */
function fmtGas(n: number): string {
  return n % 1 === 0 ? String(n) : n.toFixed(2).replace(/0$/, '');
}

/** The category's one action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain}, then borrow $20 of a stable asset against it and repay it the same week.`;
  if (c.includes('dex') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s deepest pool on ${chain} in a narrow price range and keep the position open.`;
  if (c.includes('yield') || c.includes('yield aggregator')) return `Deposit $${capital} of USDC into ${name}'s highest-yield vault on ${chain} and leave the shares untouched.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name}, then use the bridged funds inside its app the same day.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token in the same wallet.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name}, open one small hedge, and close it within 24 hours.`;
  if (c.includes('prediction')) return `Fund $${capital} on ${name} and place one small position on a market that settles within a week.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('onchain capital')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares for the whole qualifying window.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it in the farming wallet.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield-bearing asset on ${chain} and hold it for the full window.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active for the whole window.`;
  if (c.includes('liquid staking')) return `Stake $${capital} of the chain asset through ${name} and use the liquid token once inside its own app.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: eight steps, each an action with a cost and a time, derived from
 * the protocol's own record (category, chains, TVL, age, V6 tier) — never from a hand-written
 * list of names. The discovery step mirrors CloddsBot's pump.fun watch: check the
 * protocol's new pools and vaults the way a launch radar watches new-hot tokens, and the
 * risk step mirrors V6's wash-trading and drain checks: a sharp TVL fall means pause, not
 * chase. Gas is a rough per-chain estimate (see gasUsd); capital is a heuristic from TVL;
 * the last step says so in plain words, and no step claims the protocol runs a farming or
 * points program — that has to be confirmed on its own site.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, tier: 'DISCARD' | 'DISTRIBUTE' | 'PRIORITY'): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = fmtGas(gasUsd(chain));
  const action = actionFor(p, capital, chain);
  const tierNote =
    tier === 'PRIORITY'
      ? 'This is a PRIORITY row (V6 score 0.75 or higher): farm it first.'
      : tier === 'DISTRIBUTE'
        ? 'This is a DISTRIBUTE row (V6 score 0.45 to 0.75): worth a standard position.'
        : 'This is a DISCARD row (V6 score under 0.45): watch only, put no fresh capital in until its score rises.';
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline on paper. ${tierNote}`,
      cost: `about $${gas} of gas for the first transaction`,
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and about $${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Do one qualifying action each week on ${chain} — a deposit, a borrow, a swap or a vote — and keep a different action each week so the pattern looks like real use.`,
      cost: `about $${gas} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text: `Once a week, check ${p.name} for newly added pools, vaults or markets and use the newest one once with $10, the way a launch radar watches new-hot listings.`,
      cost: `$10 of capital and about $${gas} of gas`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot, and do not withdraw and re-deposit to game the count.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `If the protocol's TVL falls 30% in a week, pause new deposits and check its own announcements first — a drain that steep is a V6 liquidity-drain watch, not a buying signal.`,
      cost: 'nothing to check',
      time: '5 minutes a week',
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page from its official site and claim only from the link it publishes; never pay anyone to claim for you.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Treat every figure in this plan as an estimate from the protocol's TVL and its first chain: the $${capital} capital is a heuristic, the $${gas} gas is a rough public figure for ${chain}, and nobody here checked whether ${p.name} runs a farming or points program — confirm that on its own site before you deposit.`,
      cost: 'nothing to check',
      time: '10 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  const { unique } = dedupeProtocols(snapshot.protocols);
  return unique
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    v6_score: row.v6_score,
    v6_tier: row.v6_tier,
    risk_flags: row.risk_flags,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    score_boost: row.model.score_boost,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  // The page recomputes each row's V6 score, so it needs the same scale denominator the
  // model used: the largest TVL in the whole snapshot, not just on the board.
  const { unique } = dedupeProtocols(snapshot.protocols);
  const maxTvl = Math.max(...unique.map((p) => p.tvl_usd), 5_000_001);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    max_tvl_usd: maxTvl,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared value, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
