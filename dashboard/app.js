// Token Radar's dashboard. Reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the ranked board, a filterable table, a per-protocol detail view with the V6 score
// breakdown and the farm plan, and a live-token view set apart from the ranking. No network:
// every byte it shows is in data.js.
//
// Deep links (hash routing, so the three screenshots can be taken as three states):
//   #/                 the board, unfiltered
//   #/detail/<slug>    one protocol's detail view (rank 1's slug for the second screenshot)
//   #/filtered         the preset filtered view: pre-token Lending protocols, TVL $100M and up
//   #/filter?category=<c>&tier=<t>&minTvl=<n>&q=<text>
//                      any filter combination, written back to the hash as you filter
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', tier: 'all', minTvl: 0, tab: 'pre-token', sort: 'implied', dir: -1, selected: null, preset: false };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  // The V6 score, recomputed in the page from the snapshot figures, so the page's code and
  // board.json visibly agree. Same weights and thresholds as lib/model.ts:
  // score = source*0.30 + reputation*0.25 + strength*0.20 + cross*0.25.
  function v6Of(row, maxTvl) {
    // A field counts only when it is informative: a listing date needs 180 days of track
    // record, a 7-day change needs to be sane (|change| <= 200%), chains need 3+.
    var trackRecord = row.listed_at !== null && row.age_days !== null && row.age_days >= 180;
    var saneChange = row.change_7d !== null && Math.abs(row.change_7d) <= 200;
    var sq = 0.55;
    if (trackRecord) sq += 0.15;
    if (saneChange) sq += 0.10;
    if (row.category !== null) sq += 0.10;
    if (row.chains && row.chains.length >= 3) sq += 0.10;
    sq = clamp(sq, 0, 1);
    var age = row.age_days === null || row.age_days === undefined ? 365 : row.age_days;
    var maturity = clamp(age / 1095, 0, 1);
    var scale = clamp(Math.log(Math.max(row.tvl_usd, 1) / 5e6) / Math.log(Math.max(maxTvl, 5000001) / 5e6), 0, 1);
    var rep = 0.5 * maturity + 0.5 * scale;
    var growth = clamp(row.change_7d === null ? 0 : row.change_7d, -60, 120);
    var strength = (growth + 60) / 180;
    var evidence = (trackRecord ? 1 : 0) + (saneChange ? 1 : 0) + (row.category !== null ? 1 : 0) + (row.chains && row.chains.length >= 3 ? 1 : 0);
    var cross = evidence <= 1 ? 0 : evidence === 2 ? 0.6 : 1;
    var score = Math.round((sq * 0.3 + rep * 0.25 + strength * 0.2 + cross * 0.25) * 1e4) / 1e4;
    return { source: sq, reputation: rep, strength: strength, cross: cross, evidence: evidence, score: score };
  }
  function impliedOf(row, maxTvl) {
    var v = v6Of(row, maxTvl);
    var growth = clamp(row.change_7d === null ? 0 : row.change_7d, -60, 120);
    var growthMult = 1 + (growth / 100) * 0.5;
    var age = row.age_days === null || row.age_days === undefined ? 365 : row.age_days;
    var maturityMult = 0.6 + (Math.min(Math.max(age, 0), 1095) / 1095) * 0.4;
    var boost = 0.6 + 0.8 * v.score;
    return { implied: Math.max(1, Math.round(row.tvl_usd * 0.25 * growthMult * maturityMult * boost)), v6: v, growthMult: growthMult, maturityMult: maturityMult, boost: boost };
  }
  function maxTvl() { return DATA.max_tvl_usd || Math.max.apply(null, DATA.rows.map(function (r) { return r.tvl_usd; })); }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // The farm plan, the same derivation main.ts writes to board.json: category, chains, TVL,
  // age and V6 tier decide the action, the capital, the hold and every cost and time.
  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function capitalFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function actionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ', then borrow $20 of a stable asset against it and repay it the same week.';
    if (c.indexOf('dex') >= 0 || c.indexOf('leveraged farm') >= 0) return 'Provide $' + capital + ' of liquidity to ' + name + "'s deepest pool on " + chain + ' in a narrow price range and keep the position open.';
    if (c.indexOf('yield') >= 0) return 'Deposit $' + capital + ' of USDC into ' + name + "'s highest-yield vault on " + chain + ' and leave the shares untouched.';
    if (c.indexOf('bridge') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ', then use the bridged funds inside its app the same day.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return "Stake $" + capital + " of the chain's staking asset through " + name + ' and keep the receipt token in the same wallet.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ', open one small hedge, and close it within 24 hours.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' on ' + name + ' and place one small position on a market that settles within a week.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0 || c.indexOf('onchain capital') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares for the whole qualifying window.';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + ' and hold it in the farming wallet.';
    if (c.indexOf('rwa') >= 0) return "Mint $" + capital + " of the protocol's yield-bearing asset on " + chain + ' and hold it for the full window.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy active for the whole window.';
    if (c.indexOf('liquid staking') >= 0) return 'Stake $' + capital + ' of the chain asset through ' + name + " and use the liquid token once inside its own app.";
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function farmSteps(p) {
    var chain = chainOf(p);
    var capital = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    var tierNote = p.v6_tier === 'PRIORITY'
      ? 'This is a PRIORITY row (V6 score 0.75 or higher): farm it first.'
      : p.v6_tier === 'DISTRIBUTE'
        ? 'This is a DISTRIBUTE row (V6 score 0.45 to 0.75): worth a standard position.'
        : 'This is a DISCARD row (V6 score under 0.45): watch only, put no fresh capital in until its score rises.';
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline on paper. ' + tierNote, cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: actionFor(p, capital, chain), cost: '$' + capital + ' of capital and about $' + (capital >= 150 ? 8 : 4) + ' of gas', time: '15 minutes to set up' },
      { text: 'Do one qualifying action each week on ' + chain + ' — a deposit, a borrow, a swap or a vote — and keep a different action each week so the pattern looks like real use.', cost: 'about $2 of gas a week', time: '10 minutes a week' },
      { text: 'Once a week, check ' + p.name + ' for newly added pools, vaults or markets and use the newest one once with $10, the way a launch radar watches new-hot listings.', cost: '$10 of capital and about $2 of gas', time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot, and do not withdraw and re-deposit to game the count.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: "If the protocol's TVL falls 30% in a week, pause new deposits and check its own announcements first — a drain that steep is a V6 liquidity-drain watch, not a buying signal.", cost: 'nothing to check', time: '5 minutes a week' },
      { text: "Before you withdraw, open the protocol's own points or rewards page from its official site and claim only from the link it publishes; never pay anyone to claim for you.", cost: 'no fee to check, and never pay to claim', time: '10 minutes' }
    ].map(stepText);
  }

  // ---- hash routing -------------------------------------------------------
  function readHash() {
    var raw = window.location.hash.replace(/^#/, '');
    if (!raw || raw === '/') return;
    if (raw === '/filtered') {
      state.preset = true;
      state.category = 'Risk Curators';
      state.minTvl = 100000000;
      state.tab = 'pre-token';
      return;
    }
    if (raw.indexOf('/detail/') === 0) {
      state.selected = decodeURIComponent(raw.slice(8).split('?')[0]);
      return;
    }
    if (raw.indexOf('/filter?') === 0 || raw.indexOf('filter?') === 0) {
      var params = new URLSearchParams(raw.slice(raw.indexOf('?') + 1));
      if (params.get('q')) state.q = params.get('q');
      if (params.get('category')) state.category = params.get('category');
      if (params.get('tier')) state.tier = params.get('tier');
      if (params.get('minTvl')) state.minTvl = parseInt(params.get('minTvl'), 10) || 0;
      if (params.get('tab')) state.tab = params.get('tab');
      return;
    }
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.tier !== 'all') params.set('tier', state.tier);
    if (state.minTvl > 0) params.set('minTvl', String(state.minTvl));
    if (state.tab !== 'pre-token') params.set('tab', state.tab);
    var next;
    if (state.selected) next = '#/detail/' + encodeURIComponent(state.selected);
    else if (state.preset) next = '#/filtered';
    else if (params.toString()) next = '#/filter?' + params.toString();
    else next = '#/';
    if (window.location.hash !== next) window.history.replaceState(null, '', next);
  }

  // ---- filtering and sorting ----------------------------------------------
  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.tier !== 'all' && r.v6_tier !== state.tier) return false;
      if (state.minTvl > 0 && r.tvl_usd < state.minTvl) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'score') { av = a.v6_score; bv = b.v6_score; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  // ---- pieces of the page ---------------------------------------------------
  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { text: 'Token Radar' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: DATA.model_version + ' · Sigma V6 model' })
      )
    );
  }
  function lede() {
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        el('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + DATA.early_size + ' pre-token protocols below that floor, found the way a launch radar finds new-hot listings. Implied value is a model, not a promise.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Early rows below the floor' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Live-token set aside' }), el('b', { text: String(DATA.live_size) }))
      )
    );
  }
  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; state.preset = false; writeHash(); render(); });
    var select = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    select.addEventListener('change', function () { state.category = select.value; state.preset = false; writeHash(); render(); });
    var tierSel = el('select', { id: 'tier', 'aria-label': 'Filter by V6 tier' },
      ['all', 'PRIORITY', 'DISTRIBUTE', 'DISCARD'].map(function (t) { return el('option', { value: t, text: t === 'all' ? 'All V6 tiers' : t, selected: t === state.tier ? 'selected' : null }); })
    );
    tierSel.addEventListener('change', function () { state.tier = tierSel.value; state.preset = false; writeHash(); render(); });
    var tvlSel = el('select', { id: 'minTvl', 'aria-label': 'Minimum TVL' },
      [[0, 'Any TVL'], [50000000, 'TVL $50M+'], [100000000, 'TVL $100M+'], [1000000000, 'TVL $1B+']].map(function (pair) { return el('option', { value: String(pair[0]), text: pair[1], selected: pair[0] === state.minTvl ? 'selected' : null }); })
    );
    tvlSel.addEventListener('change', function () { state.minTvl = parseInt(tvlSel.value, 10) || 0; state.preset = false; writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; writeHash(); render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; writeHash(); render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), select),
      el('div', { class: 'field' }, el('label', { for: 'tier', text: 'V6 tier' }), tierSel),
      el('div', { class: 'field' }, el('label', { for: 'minTvl', text: 'Min TVL' }), tvlSel),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? rows().length + ' rows shown' : DATA.live.length + ' live-token protocols' })
    );
  }
  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }
  function tierBadge(tier) { return el('span', { class: 'tier tier-' + tier, text: tier }); }
  function flagChips(flags) {
    return (flags || []).map(function (f) { return el('span', { class: 'flag', text: f }); });
  }
  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.tier = 'all'; state.minTvl = 0; state.preset = false; writeHash(); render(); } })
      ));
    }
    var max = list[0].implied_value_usd || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }),
          el('div', null, tierBadge(r.v6_tier), flagChips(r.risk_flags))
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: r.v6_score.toFixed(2) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'status', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its V6 score and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('score', 'V6 score'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }
  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'status', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }
  function modelPanel() {
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures, adapted from Sigma On-Chain V6: score = source_quality x 0.30 + wallet_reputation x 0.25 + signal_strength x 0.20 + cross_validation x 0.25. Source quality is record completeness; reputation is age and TVL scale; strength is the clamped 7-day change; cross-validation counts the independent fields that confirm the record (1 field: 0.0, 2: 0.6, 3 or more: 1.0). No protocol name is special-cased.' }),
      el('div', { class: 'formula' },
        'implied = round( tvl_usd x 0.25 x (1 + clamp(change_7d, -60, 120) / 100 x 0.5) x (0.6 + min(age_days, 1095) / 1095 x 0.4) x (0.6 + 0.8 x v6_score) )'
      ),
      el('p', { class: 'sub', text: 'Tiers use V6 thresholds: under 0.45 DISCARD (watch only), 0.45 to 0.75 DISTRIBUTE, 0.75 and up PRIORITY. Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses 365 days. Risk flags: a 7-day fall of 30% or more is a drain watch, a rise of 100% or more a volume spike, and a protocol under 90 days old with under $100M TVL a new launch. This is an estimate, not a price.' })
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var calc = impliedOf(row, maxTvl());
    var steps = farmSteps(row);
    var tierText = row.v6_tier === 'PRIORITY' ? 'PRIORITY — farm first' : row.v6_tier === 'DISTRIBUTE' ? 'DISTRIBUTE — a standard position' : 'DISCARD — watch only';
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + ' · ' + tierText }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') + ' · listed ' + (row.listed_at || 'date unknown') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value — V6 score ' + row.v6_score.toFixed(2) }),
      el('div', { class: 'scorebar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.round(row.v6_score * 100) + '%' })),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) })),
        el('div', null, el('span', { text: 'Source quality (x0.30)' }), el('b', { class: 'num', text: String(calc.v6.source.toFixed(2)) })),
        el('div', null, el('span', { text: 'Reputation (x0.25)' }), el('b', { class: 'num', text: String(calc.v6.reputation.toFixed(2)) })),
        el('div', null, el('span', { text: 'Signal strength (x0.20)' }), el('b', { class: 'num', text: String(calc.v6.strength.toFixed(2)) })),
        el('div', null, el('span', { text: 'Cross-validation (x0.25)' }), el('b', { class: 'num', text: String(calc.v6.cross.toFixed(2)) + ' · ' + calc.v6.evidence + ' fields' })),
        el('div', null, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) }))
      ),
      el('p', { class: 'sub', text: 'Model ' + DATA.model_version + ': the page recomputes this row as ' + fmtUsd(calc.implied) + (calc.implied === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + (row.risk_flags && row.risk_flags.length ? ' Risk flags: ' + row.risk_flags.join(', ') + '.' : ' No risk flags.') + ' This is an estimate, not a price.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    if (state.tab === 'pre-token') shell.appendChild(modelPanel());
    if (state.preset) {
      shell.appendChild(el('div', { class: 'note', text: 'Filtered view: pre-token Risk Curators protocols with TVL of $100M or more — the preset behind #/filtered. Change any filter to leave the preset.' }));
    }
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('hashchange', function () { readHash(); render(); });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
