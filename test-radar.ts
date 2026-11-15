// test-radar.ts — deterministic tests for the radar-v6-2 model (lib/model.ts).
// Run: node test-radar.ts [snapshot.json]   (defaults to the kit snapshot)
// Exit 0 when every test passes, 1 otherwise. No network, no clock, no randomness.
import { readFileSync } from 'node:fs';
import {
  MODEL,
  V6,
  ageDays,
  boardIssue,
  buildBoard,
  compsValue,
  dedupeProtocols,
  farmSteps,
  gasUsd,
  impliedValue,
  lastBuildStats,
  parseSnapshot,
  riskFlags,
  v6Components,
  v6Score,
  v6Tier,
  type Snapshot,
  type SnapshotProtocol,
} from './lib/model.ts';

const snapPath = process.argv[2] ?? '/home/hatch/workspace/makefun/token-radar-01-kit/token-radar-01-kit/input/snapshot.json';
const snapshot: Snapshot = parseSnapshot(readFileSync(snapPath, 'utf8'));
const maxTvl = Math.max(...snapshot.protocols.map((p) => p.tvl_usd));

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function proto(over: Partial<SnapshotProtocol> & { slug: string }): SnapshotProtocol {
  return {
    name: over.slug,
    category: 'Lending',
    chains: ['Ethereum', 'Arbitrum', 'Base'],
    tvl_usd: 100_000_000,
    change_7d: 10,
    mcap_usd: null,
    listed_at: '2024-01-01',
    gecko_id: null,
    symbol: null,
    ...over,
  };
}

// --- P0: dedupe keeps the highest-TVL record and reports it -------------------------
{
  const dup = proto({ slug: 'dup' });
  const dupSmall = proto({ slug: 'dup', tvl_usd: 50_000_000, listed_at: '2020-01-01' });
  const dupBig = proto({ slug: 'dup', tvl_usd: 200_000_000, listed_at: '2025-01-01' });
  const { unique, warnings } = dedupeProtocols([dupSmall, dup, dupBig]);
  check('dedupe keeps highest TVL', unique.length === 1 && unique[0]!.tvl_usd === 200_000_000, `got ${unique.length} rows, tvl ${unique[0]?.tvl_usd}`);
  check('dedupe reports every duplicate', warnings.length === 2, `got ${warnings.length} warnings`);
  check('dedupe warning names the slug', warnings.every((w) => w.includes('dup')));
  const { unique: u2, warnings: w2 } = dedupeProtocols(snapshot.protocols);
  check('real snapshot has no duplicates', u2.length === snapshot.protocols.length && w2.length === 0);
}

// --- P0: cross-validation is 0 even for a fully evidenced record ----------------------
{
  const p = proto({ slug: 'full-evidence' });
  const c = v6Components(p, snapshot.as_of, maxTvl);
  check('crossValidation is 0', c.crossValidation === 0, `got ${c.crossValidation}`);
  check('evidence count still reported', c.evidenceCount === 4, `got ${c.evidenceCount}`);
}

// --- Weights still sum to 1; a perfect record scores 1.0 --------------------------------
{
  const sum = V6.wSource + V6.wMaturity + V6.wStrength + V6.wCross;
  check('weights sum to 1', Math.abs(sum - 1) < 1e-9, `sum=${sum}`);
  const perfect = proto({ slug: 'perfect', change_7d: 120, listed_at: '2020-01-01', tvl_usd: maxTvl });
  const c = v6Components(perfect, snapshot.as_of, maxTvl);
  check('perfect record: source 1.0', c.sourceQuality === 1, `got ${c.sourceQuality}`);
  check('perfect record: maturityScale 1.0', c.maturityScale === 1, `got ${c.maturityScale}`);
  check('perfect record: strength 1.0', c.signalStrength === 1, `got ${c.signalStrength}`);
  check('perfect record scores 1.0 and PRIORITY', v6Score(c) === 1 && v6Tier(v6Score(c)) === 'PRIORITY');
  check('tier boundaries', v6Tier(0.4499) === 'DISCARD' && v6Tier(0.45) === 'DISTRIBUTE' && v6Tier(0.7499) === 'DISTRIBUTE' && v6Tier(0.75) === 'PRIORITY');
}

// --- Graded change evidence: no cliff at 200% -------------------------------------------
{
  const at199 = v6Components(proto({ slug: 'c199', change_7d: 199 }), snapshot.as_of, maxTvl).sourceQuality;
  const at201 = v6Components(proto({ slug: 'c201', change_7d: 201 }), snapshot.as_of, maxTvl).sourceQuality;
  const at400 = v6Components(proto({ slug: 'c400', change_7d: 400 }), snapshot.as_of, maxTvl).sourceQuality;
  check('change evidence: 199 vs 201 differ by a hair, not a step', Math.abs(at199 - at201) < 0.001, `199=${at199} 201=${at201}`);
  check('change evidence fades to zero at 400', at400 < at201, `400=${at400} 201=${at201}`);
}

// --- Risk flags: tvl-spike, never volume-spike -------------------------------------------
{
  const spike = riskFlags(proto({ slug: 'spike', change_7d: 150 }), 500);
  check('spike flag is tvl-spike', spike.includes('tvl-spike') && !spike.includes('volume-spike'), spike.join(','));
  const drain = riskFlags(proto({ slug: 'drain', change_7d: -40 }), 500);
  check('drain flag', drain.includes('drain-watch'), drain.join(','));
  const fresh = riskFlags(proto({ slug: 'fresh', change_7d: 5, listed_at: '2026-11-01', tvl_usd: 50_000_000 }), ageDays(snapshot.as_of, '2026-11-01'));
  check('new-launch flag', fresh.includes('new-launch'), fresh.join(','));
}

// --- Unknown age earns no maturity credit --------------------------------------------------
{
  const known = impliedValue(proto({ slug: 'known-age', listed_at: '2025-11-14' }), snapshot.as_of, maxTvl);
  const unknown = impliedValue(proto({ slug: 'unknown-age', listed_at: null }), snapshot.as_of, maxTvl);
  check('unknown age scores lower than a 1-year record', unknown.score < known.score, `unknown=${unknown.score} known=${known.score}`);
  check('unknown age implies less than a 1-year record', unknown.implied < known.implied, `unknown=${unknown.implied} known=${known.implied}`);
  check('unknown age stays null in the output', unknown.age === null);
}

// --- Comps value: fitted, smooth, monotone --------------------------------------------------
{
  check('comps multiple falls with size', compsValue(5_000_000) / 5_000_000 > compsValue(1_000_000_000) / 1_000_000_000);
  check('comps value rises with TVL', compsValue(1_000_000_000) > compsValue(100_000_000) && compsValue(100_000_000) > compsValue(5_000_000));
  const m5 = compsValue(5_000_000) / 5_000_000;
  const m154 = compsValue(154_000_000) / 154_000_000;
  const m1b = compsValue(1_000_000_000) / 1_000_000_000;
  check('comps multiples near the fit (0.67 / 0.13 / 0.05)', Math.abs(m5 - 0.667) < 0.02 && Math.abs(m154 - 0.13) < 0.02 && Math.abs(m1b - 0.053) < 0.02, `got ${m5.toFixed(3)} / ${m154.toFixed(3)} / ${m1b.toFixed(3)}`);
  check('comps multiple clamped to [0.01, 1.0] at the top', compsValue(116_083_653_379) / 116_083_653_379 >= 0.01 - 1e-12);
  check('model constants are the published fit', MODEL.compsIntercept === 6.9646 && MODEL.compsSlope === 0.5223);
}

// --- Farm plan: chain gas + disclaimer step ---------------------------------------------------
{
  check('gasUsd Ethereum is 5', gasUsd('Ethereum') === 5);
  check('gasUsd Solana is 0.01', gasUsd('Solana') === 0.01);
  check('gasUsd defaults to 2', gasUsd('SomeNewChain') === 2);
  const steps = farmSteps(proto({ slug: 'farm-eth', chains: ['Ethereum'] }), 400, 'DISTRIBUTE');
  check('farm plan has 8 steps', steps.length === 8, `got ${steps.length}`);
  check('farm plan names chain gas', steps[0]!.text.includes('$5') || steps[0]!.cost.includes('$5'), steps[0]!.cost);
  const sol = farmSteps(proto({ slug: 'farm-sol', chains: ['Solana'] }), 400, 'DISTRIBUTE');
  check('farm plan gas follows the chain', sol[0]!.cost.includes('$0.01'), sol[0]!.cost);
  check('farm plan carries the limits disclaimer', steps[7]!.text.includes('heuristic') && steps[7]!.text.includes('runs a farming or points program'));
  const texts = steps.map((s) => `${s.text} Cost: ${s.cost}. Time: ${s.time}.`);
  check('farm steps within 20-600 chars', texts.every((t) => t.length >= 20 && t.length <= 600), `lengths ${texts.map((t) => t.length).join(',')}`);
}

// --- Real board: shape, coverage, order, determinism -----------------------------------------
{
  const board = buildBoard(snapshot);
  check('board has 220 rows', board.length === 220, `got ${board.length}`);
  check('boardIssue is null', boardIssue(board, snapshot) === null, boardIssue(board, snapshot) ?? '');
  check('ranks are 1..N', board.every((r, i) => r.rank === i + 1));
  check('implied values never rise with rank', board.every((r, i) => i === 0 || r.implied_value_usd <= board[i - 1]!.implied_value_usd));
  check('watchlist fully covered', snapshot.watchlist.every((s) => board.some((r) => r.slug === s)));
  check('no duplicate slugs on the board', new Set(board.map((r) => r.slug)).size === board.length);
  check('no volume-spike flag anywhere', board.every((r) => !r.risk_flags.includes('volume-spike')));
  check('every row has 8 farm steps', board.every((r) => r.farm_steps.length === 8));
  check('every farm step 20-600 chars', board.every((r) => r.farm_steps.every((s) => s.trim().length >= 20 && s.trim().length <= 600)));
  check('v6 key is maturity_scale, not wallet_reputation', board.every((r) => 'maturity_scale' in r.v6 && !('wallet_reputation' in r.v6)));
  check('cross_validation is 0 on every row', board.every((r) => r.v6.cross_validation === 0));
  let tieOrderOk = true;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd === board[i - 1]!.implied_value_usd && board[i]!.tvl_usd > board[i - 1]!.tvl_usd) tieOrderOk = false;
  }
  check('ties break by TVL then slug', tieOrderOk);
  check('build stats recorded', lastBuildStats.duplicates === 0, `duplicates=${lastBuildStats.duplicates}`);
  const board2 = buildBoard(snapshot);
  check('board is deterministic', JSON.stringify(board) === JSON.stringify(board2));
  const tiers = { PRIORITY: 0, DISTRIBUTE: 0, DISCARD: 0 };
  for (const r of board) tiers[r.v6_tier]++;
  console.log(`  board tiers: ${tiers.PRIORITY} PRIORITY, ${tiers.DISTRIBUTE} DISTRIBUTE, ${tiers.DISCARD} DISCARD; rank 1: ${board[0]!.slug} $${board[0]!.implied_value_usd.toLocaleString('en-US')}; implied ties: ${lastBuildStats.impliedTies}`);
}

console.log(`\ntest-radar: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
