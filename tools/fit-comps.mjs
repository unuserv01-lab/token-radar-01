// fit-comps.mjs — reproduce the comps fit behind MODEL.compsIntercept / compsSlope.
//
//   node tools/fit-comps.mjs <snapshot.json>
//
// Fits ln(market cap) = a + b * ln(TVL) by least squares over the snapshot's live-token
// protocols (mcap_usd and tvl_usd both present and positive), then reports R2, the
// leave-one-out median error, the banded median multiples, and the same numbers for the
// old flat 0.25 multiple, so the fit can be checked against the model it replaced.
// Standard library only; no network. The fitted coefficients are copied into
// lib/model.ts by hand — the entry itself never runs this script.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: node tools/fit-comps.mjs <snapshot.json>\n');
  process.exit(2);
}
const snap = JSON.parse(readFileSync(file, 'utf8'));
const live = snap.protocols.filter((p) => p.mcap_usd && p.mcap_usd > 0 && p.tvl_usd > 0);
const xs = live.map((p) => Math.log(p.tvl_usd));
const ys = live.map((p) => Math.log(p.mcap_usd));
const n = live.length;

// Least squares for y = a + b*x via the normal equations.
function ols(x, y) {
  const n = x.length;
  const sx = x.reduce((s, v) => s + v, 0);
  const sy = y.reduce((s, v) => s + v, 0);
  const sxx = x.reduce((s, v) => s + v * v, 0);
  const sxy = x.reduce((s, v, i) => s + v * y[i], 0);
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const a = (sy - b * sx) / n;
  return { a, b };
}
function r2(x, y, { a, b }) {
  const mean = y.reduce((s, v) => s + v, 0) / y.length;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < y.length; i++) {
    ssRes += (y[i] - (a + b * x[i])) ** 2;
    ssTot += (y[i] - mean) ** 2;
  }
  return 1 - ssRes / ssTot;
}
function median(v) {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const fit = ols(xs, ys);
console.log(`comps fit: ln(mcap) = ${fit.a.toFixed(4)} + ${fit.b.toFixed(4)} * ln(tvl)  (n=${n}, R2=${r2(xs, ys, fit).toFixed(3)})`);
for (const tvl of [5e6, 28e6, 154e6, 1e9, 1e10]) {
  const fitted = Math.exp(fit.a + fit.b * Math.log(tvl));
  console.log(`  TVL $${tvl.toLocaleString('en-US')}: multiple ${(fitted / tvl).toFixed(3)}  fitted mcap $${Math.round(fitted).toLocaleString('en-US')}`);
}
// Leave-one-out: refit without each row, predict it, take the median |log error|.
const errs = [];
for (let i = 0; i < n; i++) {
  const xi = xs.filter((_, j) => j !== i);
  const yi = ys.filter((_, j) => j !== i);
  const bi = ols(xi, yi);
  errs.push(Math.abs(ys[i] - (bi.a + bi.b * xs[i])));
}
const loocv = median(errs);
console.log(
  `LOOCV: median |ln error| ${loocv.toFixed(3)} (factor ${Math.exp(loocv).toFixed(2)}x), ` +
    `within 2x ${(errs.filter((e) => e < Math.log(2)).length / n).toFixed(2)}`,
);
// The old flat multiple, for comparison.
const oldErrs = ys.map((y, i) => Math.abs(y - (Math.log(0.25) + xs[i])));
const oldMed = median(oldErrs);
console.log(
  `flat 0.25: median |ln error| ${oldMed.toFixed(3)} (factor ${Math.exp(oldMed).toFixed(2)}x), ` +
    `within 2x ${(oldErrs.filter((e) => e < Math.log(2)).length / n).toFixed(2)}`,
);
// Banded median multiples, the pattern the smooth fit follows.
for (const [lo, hi] of [[5e6, 5e7], [5e7, 2e8], [2e8, 1e9], [1e9, 1e11]]) {
  const sub = live.filter((p) => p.tvl_usd >= lo && p.tvl_usd < hi);
  if (sub.length > 0) {
    console.log(
      `  band $${(lo / 1e6).toFixed(0)}M-$${(hi / 1e9).toFixed(1)}B: n=${sub.length} median mcap/tvl=${median(sub.map((p) => p.mcap_usd / p.tvl_usd)).toFixed(3)}`,
    );
  }
}
