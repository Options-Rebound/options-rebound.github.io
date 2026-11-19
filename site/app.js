// Options Rebound: everything here runs in the browser from the JSON the scanner publishes.
"use strict";

const REPO = "FTalla18/options-rebound";
const RATE = 0.04;                     // risk-free rate for pricing
const IV_RALLY = -0.10, IV_SELLOFF = 0.20;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const fmt$ = (v, d = 0) => (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v, d = 0) => (v > 0 ? "+" : "") + (v * 100).toFixed(d) + "%";
const pctPlain = (v) => (v * 100).toFixed(0) + "%";
const ratio = (v) => (v == null ? "—" : v.toFixed(2));
const mult = (x) => (x >= 10 ? x.toFixed(0) : x.toFixed(1)) + "x";
const cls = (v) => (v > 0.001 ? "up" : v < -0.001 ? "down" : "");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------- math
function ncdf(x) {                     // standard normal CDF (Abramowitz-Stegun 7.1.26)
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
const npdf = (x) => 0.3989422804014327 * Math.exp(-x * x / 2);
function bs(type, S, K, T, iv) {
  if (T <= 0 || iv <= 0) return Math.max(type === "call" ? S - K : K - S, 0);
  const sq = iv * Math.sqrt(T), d1 = (Math.log(S / K) + (RATE + iv * iv / 2) * T) / sq, d2 = d1 - sq;
  return type === "call" ? S * ncdf(d1) - K * Math.exp(-RATE * T) * ncdf(d2) : K * Math.exp(-RATE * T) * ncdf(-d2) - S * ncdf(-d1);
}
function greeks(type, S, K, T, iv) {
  if (T <= 0 || iv <= 0) return { delta: 0, gamma: 0, theta: 0, vega: 0, itm: (type === "call" ? S > K : S < K) ? 1 : 0 };
  const sq = iv * Math.sqrt(T), d1 = (Math.log(S / K) + (RATE + iv * iv / 2) * T) / sq, d2 = d1 - sq;
  const disc = Math.exp(-RATE * T);
  const call = type === "call";
  const theta = (-S * npdf(d1) * iv / (2 * Math.sqrt(T)) - (call ? RATE * K * disc * ncdf(d2) : -RATE * K * disc * ncdf(-d2))) / 365;
  return { delta: call ? ncdf(d1) : ncdf(d1) - 1, gamma: npdf(d1) / (S * sq), theta, vega: S * npdf(d1) * Math.sqrt(T) / 100, itm: call ? ncdf(d2) : ncdf(-d2) };
}
const daysTo = (exp) => Math.max(0, (new Date(exp + "T21:00:00Z") - Date.now()) / 864e5);
// IV eases as the stock rallies and rises as it falls, gradually (full effect at a 20% move)
const ivAfter = (iv, move) => iv * (1 + (move > 0 ? IV_RALLY : IV_SELLOFF) * Math.min(1, Math.abs(move) / 0.2));
const pay = (c) => (c[2] > 0 ? c[2] : c[3]);            // what you pay: the ask (or last trade if no ask)

// ---------------------------------------------------------------- data
const state = { index: null, market: null, chains: {}, picks: [], target: 0.3, horizon: 60, budget: 1000 };
async function getJSON(u) { const r = await fetch(u, { cache: "no-cache" }); if (!r.ok) throw new Error(u + " " + r.status); return r.json(); }
async function chain(t) { return (state.chains[t] ||= getJSON(`data/chains/${t}.json`)); }

// ---------------------------------------------------------------- rebound board
function targetPrice(s, target) { return target === "ath" ? s.ath : s.price * (1 + target); }

function bestCall(s, ch, { target, horizon, budget }) {
  const S = s.price, St = targetPrice(s, target), Sh = S + (St - S) / 2, move = St / S - 1;
  let best = null;
  for (const [exp, sides] of Object.entries(ch.chains)) {
    const dte = daysTo(exp);
    if (dte < horizon + 14) continue;                              // still has time left after the rebound
    const T = dte / 365, Th = (dte - horizon) / 365;
    for (const c of sides.calls) {
      const [K, bid, ask, last, iv, oi, vol] = c, cost = pay(c);
      if (!(cost > 0.05) || cost * 100 > budget || !(iv > 0.05) || (oi < 10 && vol < 5)) continue;
      if (bid > 0 && (ask - bid) / ask > 0.4) continue;           // too wide to trade sensibly
      if (K < S * 0.7 || K > St * 1.15) continue;
      const full = bs("call", St, K, Th, ivAfter(iv, move)) / cost;
      const half = bs("call", Sh, K, Th, ivAfter(iv, move / 2)) / cost;
      const flat = bs("call", S, K, Th, iv) / cost - 1;
      const dip = bs("call", S * 0.9, K, Th, ivAfter(iv, -0.1)) / cost - 1;
      const atAth = bs("call", s.ath, K, T, iv);
      const row = { s, exp, dte, K, cost, iv, oi, full, half, flat, dip, beaten: atAth > 0 ? 1 - cost / atAth : 0 };
      if (!best || row.half > best.half || (row.half === best.half && row.full > best.full)) best = row;
    }
  }
  return best;
}

async function renderBoard() {
  const opts = { target: state.target, horizon: state.horizon, budget: state.budget };
  const stocks = state.index.stocks;
  const chains = await Promise.all(stocks.map((s) => chain(s.ticker).catch(() => null)));
  const NEAR = -0.10;                                   // within 10% of the all-time high: nothing to rebound from
  const rows = stocks.map((s, i) => ({ s, near: s.below_ath > NEAR, best: chains[i] ? bestCall(s, chains[i], opts) : null }))
    .sort((a, b) => (a.near - b.near) || ((b.best?.half ?? -1) - (a.best?.half ?? -1)));
  state.rows = rows;
  const tname = state.target === "ath" ? "back to ATH" : pct(state.target);
  $("#boardTable").innerHTML = `<thead><tr><th></th><th class="l">Stock</th><th>Below ATH</th><th>Beta</th><th class="l">Best call</th><th>Cost</th>
      <th title="Discount vs what this call would cost if the stock were at its all-time high today">Beaten down</th>
      <th>If halfway</th><th>If ${esc(tname)}</th><th>If flat</th><th>If -10%</th><th>Stock alone</th></tr></thead><tbody>` +
    rows.map(({ s, best: b, near }, i) => {
      const divider = near && (i === 0 || !rows[i - 1].near)
        ? `<tr><td colspan="12" class="l muted small" style="padding-top:18px">Near their all-time highs (within 10%): a big move here would be a breakout, not a rebound</td></tr>` : "";
      return divider + rowHtml(s, b);
    }).join("") + "</tbody>";
  function rowHtml(s, b) {
      const move = targetPrice(s, state.target) / s.price - 1;
      if (!b) return `<tr><td></td><td class="l"><span class="tk">${s.ticker}</span><span class="sub">${esc(s.name)}</span></td><td class="down">${pct(s.below_ath)}</td>
        <td>${s.beta ?? "—"}</td><td class="l muted" colspan="8">No call fits (try a bigger budget or shorter window)</td></tr>`;
      const on = state.picks.some((p) => p.s.ticker === s.ticker);
      return `<tr class="click" data-t="${s.ticker}"><td><input type="checkbox" data-pick="${s.ticker}" ${on ? "checked" : ""} aria-label="Plan a play with ${s.ticker}"></td>
        <td class="l"><span class="tk">${s.ticker}</span><span class="sub">${esc(s.name)}</span></td>
        <td class="down">${pct(s.below_ath)}</td><td>${s.beta ?? "—"}</td>
        <td class="l">$${b.K} call<span class="sub">${b.exp} · ${Math.round(b.dte)} days</span></td>
        <td>${fmt$(b.cost * 100)}</td><td>${pct(-b.beaten)}</td>
        <td><span class="pill ${cls(b.half - 1)}">${mult(b.half)}</span></td><td><span class="pill ${cls(b.full - 1)}">${mult(b.full)}</span></td>
        <td class="${cls(b.flat)}">${pct(b.flat)}</td><td class="${cls(b.dip)}">${pct(b.dip)}</td>
        <td class="muted">${pct(move)}</td></tr>`;
  }
  // keep the picks in sync with the current scenario
  state.picks = state.picks.map((p) => rows.find((r) => r.s.ticker === p.s.ticker)?.best).filter(Boolean);
  renderPlay();
}

function renderPlay() {
  const el = $("#play");
  let picks = state.picks;
  const auto = !picks.length;
  const budget = state.planBudget ?? 1000;
  if (auto) {                                           // the best two that fit the budget together
    picks = [];
    let left = budget;
    for (const r of (state.rows || []).filter((r) => !r.near && r.best)) {
      if (r.best.cost * 100 <= left) { picks.push(r.best); left -= r.best.cost * 100; }
      if (picks.length === 2) break;
    }
  }
  if (!picks.length) {
    el.innerHTML = `<div class="card__head"><h2>Your play</h2></div><p class="muted">No call on the board fits ${fmt$(budget)}. Pick a bigger budget below or a lower "max per contract" above.</p>
      <div class="seg" id="planBudget">${[500, 1000, 2500, 5000].map((v) => `<button data-v="${v}" class="${v === budget ? "on" : ""}">${fmt$(v)}</button>`).join("")}</div>`;
    return;
  }
  // add contracts one at a time across the picks until the budget runs out
  const legs = picks.map((b) => ({ b, n: 0 }));
  let left = budget, added = true;
  while (added) {
    added = false;
    for (const l of legs) if (l.b.cost * 100 <= left) { l.n++; left -= l.b.cost * 100; added = true; }
  }
  legs.forEach((l) => (l.spent = l.n * l.b.cost * 100));
  const spent = legs.reduce((a, l) => a + l.spent, 0);
  const scen = [["-10% dip", "dip"], ["Flat", "flat"], ["Halfway", "half"], [state.target === "ath" ? "Back to ATH" : pct(state.target), "full"]];
  const optVal = (key) => legs.reduce((a, { b, n }) => a + n * b.cost * 100 * (key === "dip" || key === "flat" ? 1 + b[key] : b[key]), 0);
  const stockMove = (b, key) => { const St = targetPrice(b.s, state.target); const m = St / b.s.price - 1;
    return key === "dip" ? -0.1 : key === "flat" ? 0 : key === "half" ? m / 2 : m; };
  const stockVal = (key) => legs.reduce((a, { b, spent }) => a + spent * (1 + stockMove(b, key)), 0);
  const rows = scen.map(([label, key]) => {
    const o = optVal(key) - spent, st = stockVal(key) - spent;
    return `<tr><td class="l">${label}</td><td class="${cls(o)}">${fmt$(o)}</td><td class="${cls(st)}">${fmt$(st)}</td></tr>`;
  }).join("");
  const fullO = optVal("full") - spent, fullS = stockVal("full") - spent, flatO = optVal("flat") - spent;
  el.innerHTML = `<div class="card__head"><h2>Your play ${auto ? '<span class="muted small">(top 2 suggested; tick rows above to choose)</span>' : ""}</h2>
      <span class="ctl" style="margin-left:auto"><label>Budget</label><div class="seg" id="planBudget">
      ${[500, 1000, 2500, 5000].map((v) => `<button data-v="${v}" class="${v === budget ? "on" : ""}">${fmt$(v)}</button>`).join("")}</div></span></div>
    <div class="grid2"><div>
      ${legs.map(({ b, n }) => `<p><b>${n}×</b> ${b.s.ticker} $${b.K} call, ${b.exp} <span class="muted">(${fmt$(b.cost * 100)} each = ${fmt$(n * b.cost * 100)})</span>${n === 0 ? ' <span class="down">· doesn\'t fit what\'s left of the budget</span>' : ""}</p>`).join("")}
      <p class="muted small">Total in options: ${fmt$(spent)} of ${fmt$(budget)}${left >= 1 ? ` (${fmt$(left)} left over)` : ""}. "Same $ in stock" puts the same ${fmt$(spent)} into the shares.</p>
      <div class="verdict">If the rebound happens on time, the options make <b class="${cls(fullO)}">${fmt$(fullO)}</b> vs <b>${fmt$(fullS)}</b> from buying the same stocks.
        If nothing happens for ${state.horizon} days, the options lose <b class="down">${fmt$(Math.abs(flatO))}</b> to time decay; the stocks would be about even.</div>
    </div><div><table><thead><tr><th class="l">Over ${state.horizon} days</th><th>Options</th><th>Same $ in stock</th></tr></thead><tbody>${rows}</tbody></table></div></div>
    <p class="note">Concentrated plays only make sense with money you can afford to lose entirely. Rebounds that come late or small can still take an option to $0.</p>`;
}

// ---------------------------------------------------------------- market
function vixWord(v) { return v < 15 ? "Calm" : v < 20 ? "Normal" : v < 30 ? "Elevated fear" : "High fear"; }
function pcWord(v) { return v == null ? "" : v > 1.0 ? "Fearful (puts > calls)" : v < 0.7 ? "Optimistic (calls dominate)" : "Neutral"; }

function renderPulse() {
  const m = state.market;
  $("#pulse").innerHTML = `
    <div class="stat"><span>VIX (fear index)</span><b>${m.vix}</b><span>${vixWord(m.vix)}</span></div>
    <div class="stat"><span>S&P 500 (SPY) vs its all-time high</span><b class="${cls(m.spy_below_ath)}">${pct(m.spy_below_ath, 1)}</b><span>$${m.spy} · high $${m.spy_ath}</span></div>
    <div class="stat"><span>Market put/call ratio (SPY + QQQ, volume)</span><b>${ratio(m.pc_volume)}</b><span>${pcWord(m.pc_volume)}</span></div>`;
}
let charts = {};
function lineChart(id, labels, sets, opts = {}) {
  charts[id]?.destroy();
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue("--muted").trim(), grid = css.getPropertyValue("--line").trim();
  charts[id] = new Chart(document.getElementById(id), {
    type: "line", data: { labels, datasets: sets },
    options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: sets.length > 1, labels: { color: ink, boxWidth: 12 } }, tooltip: opts.tooltip || {} },
      scales: { x: { ticks: { color: ink, maxTicksLimit: 8 }, grid: { color: grid }, ...(opts.x || {}) },
                y: { ticks: { color: ink, callback: opts.yfmt }, grid: { color: grid } } } },
  });
}
function renderMarket() {
  const m = state.market;
  $("#marketStats").innerHTML = $("#pulse").innerHTML;
  const css = getComputedStyle(document.documentElement);
  lineChart("vixChart", m.vix_chart.map((p) => p[0]), [{ label: "VIX", data: m.vix_chart.map((p) => p[1]), borderColor: css.getPropertyValue("--accent").trim(), pointRadius: 0, borderWidth: 2 },
    { label: "20 = elevated fear", data: m.vix_chart.map(() => 20), borderColor: css.getPropertyValue("--warn").trim(), borderDash: [5, 4], pointRadius: 0, borderWidth: 1 }]);
  const rows = [...state.index.stocks].filter((s) => s.pc_volume != null).sort((a, b) => b.pc_volume - a.pc_volume);
  $("#pcTable").innerHTML = `<thead><tr><th class="l">Stock</th><th>Put/call (volume today)</th><th>Put/call (open interest)</th><th class="l">Read</th><th>Below ATH</th></tr></thead><tbody>` +
    rows.map((s) => `<tr class="click" data-t="${s.ticker}"><td class="l tk">${s.ticker}</td><td>${ratio(s.pc_volume)}</td><td>${ratio(s.pc_oi)}</td><td class="l muted">${pcWord(s.pc_volume)}</td><td class="down">${pct(s.below_ath)}</td></tr>`).join("") + "</tbody>";
}

// ---------------------------------------------------------------- explorer
const ex = { t: null, data: null, exp: null, type: "call", K: null, horizon: null, ivchg: 0 };

async function openTicker(t) {
  t = (t || "").trim().toUpperCase();
  $("#tickerInput").value = t;
  const body = $("#exploreBody");
  if (!t) { body.innerHTML = `<div class="card empty">Type a ticker above, or open one from the board.</div>`; return; }
  const known = state.index.stocks.some((s) => s.ticker === t);
  const failed = (state.index.failed || []).find((f) => f.ticker === t);
  if (!/^[A-Z][A-Z0-9]{0,5}([.-][A-Z]{1,2})?$/.test(t)) {
    body.innerHTML = `<div class="card empty"><b>${esc(t)}</b> doesn't look like a ticker symbol. Use letters only, like NVDA or BRK-B.</div>`;
    return;
  }
  if (failed) {
    body.innerHTML = `<div class="card empty"><p><b>${esc(t)}</b> ${esc(failed.error)}.</p>
      <p><a class="btn btn--ghost" target="_blank" rel="noopener" href="https://github.com/${REPO}/delete/main/watchlist/${encodeURIComponent(t)}">Remove ${esc(t)} from the watchlist</a></p></div>`;
    return;
  }
  if (!known) {
    body.innerHTML = `<div class="card empty"><p><b>${esc(t)}</b> isn't tracked yet.</p>
      <p>Add it in one click: GitHub opens with the file ready, press <b>Commit changes</b>. The scanner picks it up within a few minutes.</p>
      <p><a class="btn" target="_blank" rel="noopener" href="https://github.com/${REPO}/new/main?filename=watchlist/${encodeURIComponent(t)}&value=${encodeURIComponent(t)}">Track ${esc(t)}</a></p></div>`;
    return;
  }
  body.innerHTML = `<div class="card empty">Loading ${esc(t)}…</div>`;
  try { ex.data = await chain(t); } catch (e) {
    delete state.chains[t];
    body.innerHTML = `<div class="card empty">Couldn't load ${esc(t)} right now. Try again in a moment.</div>`; return;
  }
  ex.t = t;
  const exps = Object.keys(ex.data.chains).sort();
  ex.exp = exps.find((e) => daysTo(e) >= 60) || exps[exps.length - 1];
  ex.type = "call"; ex.K = null; ex.horizon = null; ex.ivchg = 0;
  try { renderExplorer(); } catch (e) {
    console.error(e);
    body.innerHTML = `<div class="card empty">Something in ${esc(t)}'s data couldn't be shown. Try another expiration or ticker.</div>`;
  }
}

function renderExplorer() {
  const d = ex.data, S = d.price, side = d.chains[ex.exp][ex.type === "call" ? "calls" : "puts"];
  if (!side.length) {                                   // e.g. an expiration with no puts listed
    ex.type = ex.type === "call" ? "put" : "call";
    if (!d.chains[ex.exp][ex.type === "call" ? "calls" : "puts"].length) {
      $("#exploreBody").innerHTML = `<div class="card empty">No contracts listed for ${ex.exp}. Pick another expiration.</div>`; return;
    }
    return renderExplorer();
  }
  if (ex.K == null || !side.some((c) => c[0] === ex.K)) ex.K = side.reduce((a, c) => (Math.abs(c[0] - S) < Math.abs(a[0] - S) ? c : a), side[0])[0];
  const c = side.find((x) => x[0] === ex.K), [K, bid, ask, last, iv0, oi, vol] = c, cost = pay(c), iv = iv0 > 0.05 ? iv0 : d.hv;
  const dte = daysTo(ex.exp), T = dte / 365;
  if (ex.horizon == null || ex.horizon > dte) ex.horizon = Math.min(60, Math.floor(dte));
  const g = greeks(ex.type, S, K, T, iv);
  const be = ex.type === "call" ? K + cost : K - cost;
  const atAth = bs(ex.type, d.ath, K, T, iv);
  const exps = Object.keys(d.chains).sort();
  const Th = Math.max(0, (dte - ex.horizon) / 365);
  const scen = [["-20%", S * 0.8], ["-10%", S * 0.9], ["No change", S], ["+20%", S * 1.2], ["+30%", S * 1.3], ["+50%", S * 1.5], ["Back to ATH", d.ath]];
  const valueAt = (Sx, Tx) => bs(ex.type, Sx, K, Tx, Math.max(0.01, ivAfter(iv, Sx / S - 1) * (1 + ex.ivchg)));

  $("#exploreBody").innerHTML = `
  <div class="grid3">
    <div class="stat"><span>${esc(d.name)}</span><b>$${S}</b><span class="down">${pct(d.below_ath)} vs all-time high $${d.ath} (${d.ath_date})</span></div>
    <div class="stat"><span>Beta vs S&P 500 · volatility</span><b>${d.beta ?? "—"}</b><span>1-yr volatility ${pctPlain(d.hv)} · option IV ${d.atm_iv ? pctPlain(d.atm_iv) : "—"}</span></div>
    <div class="stat"><span>Put/call ratio (volume · open interest)</span><b>${ratio(d.pc_volume)} · ${ratio(d.pc_oi)}</b><span>${pcWord(d.pc_volume)}</span></div>
  </div>
  <div class="card"><div class="card__head"><h2>${d.ticker}, last 2 years</h2></div><div class="chart"><canvas id="priceChart"></canvas></div></div>
  <div class="card">
    <div class="pickers">
      <div class="ctl"><label>Type</label><div class="seg" id="exType"><button data-v="call" class="${ex.type === "call" ? "on" : ""}">Call</button><button data-v="put" class="${ex.type === "put" ? "on" : ""}">Put</button></div></div>
      <div class="ctl"><label>Expiration</label><select id="exExp">${exps.map((e) => `<option value="${e}" ${e === ex.exp ? "selected" : ""}>${e} (${Math.round(daysTo(e))} days)</option>`).join("")}</select></div>
      <div class="ctl"><label>Strike</label><select id="exK">${side.map((x) => `<option value="${x[0]}" ${x[0] === K ? "selected" : ""}>$${x[0]}${Math.abs(x[0] - S) / S < 0.02 ? " (at the money)" : ""}</option>`).join("")}</select></div>
    </div>
    <div class="greeks" style="margin-top:14px">
      <div><span>Cost (1 contract)</span><b>${fmt$(cost * 100)}</b><span>bid ${bid} · ask ${ask}</span></div>
      <div><span>Breakeven at expiration</span><b>$${be.toFixed(2)}</b><span>${pct(be / S - 1, 1)} from today</span></div>
      <div><span>Beaten down</span><b>${atAth > 0 ? pct(-(1 - cost / atAth)) : "—"}</b><span>vs ${fmt$(atAth * 100)} if the stock were at its ATH</span></div>
      <div><span>Chance it ends in the money</span><b>${(g.itm * 100).toFixed(0)}%</b><span>implied vol ${pctPlain(iv)}</span></div>
      <div><span>Delta</span><b>${g.delta.toFixed(2)}</b><span>${fmt$(Math.abs(g.delta) * 100)} per $1 stock move</span></div>
      <div><span>Gamma</span><b>${g.gamma.toFixed(3)}</b><span>delta change per $1</span></div>
      <div><span>Theta (time decay)</span><b class="down">${fmt$(g.theta * 100)}/day</b><span>if the stock doesn't move</span></div>
      <div><span>Vega</span><b>${fmt$(g.vega * 100)}</b><span>per 1-point IV change</span></div>
    </div>
  </div>
  <div class="card">
    <div class="card__head"><h2>What if the stock moves?</h2>
      <span class="range"><label class="muted small">after <b id="hzv">${ex.horizon}</b> days</label><input type="range" id="hz" min="0" max="${Math.floor(dte)}" value="${ex.horizon}"></span>
      <span class="range"><label class="muted small">IV <b id="ivv">${pct(ex.ivchg)}</b></label><input type="range" id="ivc" min="-50" max="50" step="5" value="${ex.ivchg * 100}"></span>
    </div>
    <div class="grid2">
      <div class="chart tall"><canvas id="payChart"></canvas></div>
      <div><table><thead><tr><th class="l">Stock</th><th>Price</th><th>Option worth</th><th>Profit/loss</th><th>Return</th></tr></thead><tbody>
        ${scen.map(([l, Sx]) => { const v = valueAt(Sx, Th) * 100, pl = v - cost * 100;
          return `<tr><td class="l">${l}</td><td>$${Sx.toFixed(2)}</td><td>${fmt$(v)}</td><td class="${cls(pl)}">${fmt$(pl)}</td><td><span class="pill ${cls(pl)}">${mult(v / (cost * 100))}</span></td></tr>`; }).join("")}
      </tbody></table>
      <p class="note">IV eases up to 10% as the stock rallies and rises up to 20% as it falls; your IV slider applies on top.</p></div>
    </div>
  </div>
  <div class="card"><div class="card__head"><h2>Time decay if the stock goes nowhere</h2><span class="muted small">Theta speeds up as expiration nears</span></div><div class="chart"><canvas id="decayChart"></canvas></div></div>`;

  // price chart with the all-time high line
  const css = getComputedStyle(document.documentElement), acc = css.getPropertyValue("--accent").trim(), warn = css.getPropertyValue("--warn").trim(), bad = css.getPropertyValue("--bad").trim(), good = css.getPropertyValue("--good").trim();
  lineChart("priceChart", d.chart.map((p) => p[0]), [{ label: d.ticker, data: d.chart.map((p) => p[1]), borderColor: acc, pointRadius: 0, borderWidth: 2 },
    { label: `All-time high $${d.ath}`, data: d.chart.map(() => d.ath), borderColor: warn, borderDash: [5, 4], pointRadius: 0, borderWidth: 1 }], { yfmt: (v) => "$" + v });
  // payoff across stock prices: today, after the chosen days, at expiration
  const lo = S * 0.6, hi = Math.max(d.ath * 1.08, S * 1.6), xs = Array.from({ length: 60 }, (_, i) => lo + (hi - lo) * i / 59);
  const curve = (Tx) => xs.map((x) => +(valueAt(x, Tx) * 100 - cost * 100).toFixed(0));
  lineChart("payChart", xs.map((x) => "$" + x.toFixed(0)), [
    { label: "Today", data: curve(T), borderColor: acc, pointRadius: 0, borderWidth: 2 },
    { label: `After ${ex.horizon} days`, data: curve(Th), borderColor: good, pointRadius: 0, borderWidth: 2 },
    { label: "At expiration", data: curve(0), borderColor: bad, pointRadius: 0, borderWidth: 1.5, borderDash: [4, 3] }],
    { yfmt: (v) => (v < 0 ? "-$" : "$") + Math.abs(v) });
  // time decay at today's price
  const days = Array.from({ length: Math.max(2, Math.ceil(dte) + 1) }, (_, i) => i).filter((i, _, a) => a.length < 120 || i % Math.ceil(a.length / 120) === 0 || i === Math.ceil(dte));
  lineChart("decayChart", days.map((i) => i + "d"), [{ label: "Option value", data: days.map((i) => +(bs(ex.type, S, K, Math.max(0, (dte - i) / 365), iv) * 100).toFixed(0)), borderColor: bad, pointRadius: 0, borderWidth: 2 }],
    { yfmt: (v) => "$" + v });

  $("#exExp").onchange = (e) => { ex.exp = e.target.value; ex.horizon = null; renderExplorer(); };
  $("#exK").onchange = (e) => { ex.K = +e.target.value; renderExplorer(); };
  $$("#exType button").forEach((b) => (b.onclick = () => { ex.type = b.dataset.v; ex.K = null; renderExplorer(); }));
  $("#hz").oninput = (e) => { ex.horizon = +e.target.value; renderExplorer(); $("#hz").focus(); };
  $("#ivc").oninput = (e) => { ex.ivchg = +e.target.value / 100; renderExplorer(); $("#ivc").focus(); };
}

// ---------------------------------------------------------------- routing + wiring
function show(tab) {
  $$(".view").forEach((v) => (v.hidden = v.id !== tab));
  $$(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === tab));
}
function route() {
  const [, tab = "board", arg] = location.hash.split("/");
  show(["board", "explore", "market"].includes(tab) ? tab : "board");
  if (tab === "explore") openTicker(arg || ex.t || "");
  if (tab === "market") renderMarket();
}
function seg(id, key, cb) {
  $$(`#${id} button`).forEach((b) => (b.onclick = () => {
    $$(`#${id} button`).forEach((x) => x.classList.toggle("on", x === b));
    state[key] = b.dataset.v === "ath" ? "ath" : +b.dataset.v; cb();
  }));
}

async function init() {
  try {
    [state.index, state.market] = await Promise.all([getJSON("data/index.json"), getJSON("data/market.json")]);
  } catch (e) {
    $("#board").innerHTML = `<div class="card empty">Couldn't load market data yet. The first scan may still be running; try again in a few minutes.</div>`; return;
  }
  const mins = Math.round((Date.now() - new Date(state.index.updated)) / 60000);
  $("#updated").textContent = `Prices from ${mins < 60 ? mins + " min" : Math.round(mins / 60) + " h"} ago`;
  $("#tickerList").innerHTML = state.index.stocks.map((s) => `<option value="${s.ticker}">${esc(s.name)}</option>`).join("");
  renderPulse();
  seg("target", "target", renderBoard); seg("horizon", "horizon", renderBoard); seg("budget", "budget", renderBoard);
  document.addEventListener("click", (e) => {
    const pick = e.target.closest("[data-pick]");
    if (pick) {
      const t = pick.dataset.pick, row = state.rows.find((r) => r.s.ticker === t);
      if (pick.checked) { state.picks = [...state.picks.filter((p) => p.s.ticker !== t), row.best].slice(-2); }
      else state.picks = state.picks.filter((p) => p.s.ticker !== t);
      $$("[data-pick]").forEach((c) => (c.checked = state.picks.some((p) => p.s.ticker === c.dataset.pick)));
      renderPlay(); return;
    }
    const pb = e.target.closest("#planBudget button");
    if (pb) { state.planBudget = +pb.dataset.v; renderPlay(); return; }
    const row = e.target.closest("tr.click");
    if (row && !e.target.closest("input")) location.hash = `#/explore/${row.dataset.t}`;
  });
  $("#go").onclick = () => (location.hash = `#/explore/${$("#tickerInput").value.trim().toUpperCase()}`);
  $("#tickerInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#go").click(); });
  window.addEventListener("hashchange", route);
  await renderBoard();
  route();
}
init();
