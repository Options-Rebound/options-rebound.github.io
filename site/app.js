// Options Rebound: everything here runs in the browser from the JSON the scanner publishes.
"use strict";

const REPO = "Options-Rebound/options-rebound.github.io";
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
  const rows = stocks.map((s, i) => ({ s, ch: chains[i], near: s.below_ath > NEAR, best: chains[i] ? bestCall(s, chains[i], opts) : null }))
    .sort((a, b) => (a.near - b.near) || ((b.best?.half ?? -1) - (a.best?.half ?? -1)));
  state.rows = rows;
  const tname = state.target === "ath" ? "back to ATH" : pct(state.target);
  $("#boardTable").innerHTML = `<thead><tr><th></th><th class="l">Stock</th><th class="l">1 year</th><th>Below ATH</th><th>Beta</th><th class="l">Best call</th><th>Cost</th>
      <th title="Discount vs what this call would cost if the stock were at its all-time high today">Beaten down</th>
      <th>If halfway</th><th>If ${esc(tname)}</th><th>If flat</th><th>If -10%</th><th>Stock alone</th></tr></thead><tbody>` +
    rows.map(({ s, best: b, near, ch }, i) => {
      const divider = near && (i === 0 || !rows[i - 1].near)
        ? `<tr class="divider"><td colspan="13">Near their all-time highs (within 10%): a big move here would be a breakout, not a rebound</td></tr>` : "";
      return divider + rowHtml(s, b, ch);
    }).join("") + "</tbody>";
  function rowHtml(s, b, ch) {
      const sp = `<td class="sp">${spark(ch?.chart?.slice(-130), s.ath)}</td>`;
      const move = targetPrice(s, state.target) / s.price - 1;
      if (!b) return `<tr><td></td><td class="l"><span class="tk">${s.ticker}</span><span class="sub">${esc(s.name)}</span></td>${sp}<td class="down">${pct(s.below_ath)}</td>
        <td>${s.beta ?? "—"}</td><td class="l muted" colspan="8">No call fits (try a bigger budget or shorter window)</td></tr>`;
      const on = state.picks.some((p) => p.s.ticker === s.ticker);
      return `<tr class="click" data-t="${s.ticker}"><td><input type="checkbox" data-pick="${s.ticker}" ${on ? "checked" : ""} aria-label="Plan a play with ${s.ticker}"></td>
        <td class="l"><span class="tk">${s.ticker}</span>${state.own?.[s.ticker] ? `<span class="own" title="Already in your portfolio: a call adds to this exposure">own ${pctPlain(state.own[s.ticker])}</span>` : ""}<span class="sub">${esc(s.name)}</span></td>${sp}
        <td class="down">${pct(s.below_ath)}</td><td>${s.beta ?? "—"}</td>
        <td class="l">$${b.K} call<span class="sub">${b.exp} · ${Math.round(b.dte)} days</span></td>
        <td>${fmt$(b.cost * 100)}</td><td>${pct(-b.beaten)}</td>
        <td><span class="pill ${cls(b.half - 1)}">${mult(b.half)}</span></td><td><span class="pill ${cls(b.full - 1)}">${mult(b.full)}</span></td>
        <td class="${cls(b.flat)}">${pct(b.flat)}</td><td class="${cls(b.dip)}">${pct(b.dip)}</td>
        <td class="muted">${pct(move)}</td></tr>`;
  }
  // keep the picks in sync with the current scenario
  state.picks = state.picks.map((p) => rows.find((r) => r.s.ticker === p.s.ticker)?.best).filter(Boolean);
  renderPicks(rows, tname);
  renderOpp(rows);
  renderPlay();
}

function renderPicks(rows, tname) {
  const top = rows.filter((r) => !r.near && r.best).slice(0, 3);
  $("#picks").innerHTML = top.map(({ s, best: b, ch }) => `
    <div class="tile pick accent" data-t="${s.ticker}" role="link" tabindex="0">
      <div class="row"><span class="tk">${s.ticker}</span><span class="pill up">${mult(b.half)} halfway</span></div>
      <div class="s">$${b.K} call · ${b.exp} · ${fmt$(b.cost * 100)}</div>
      <div class="spark">${spark(ch?.chart?.slice(-130), s.ath, 300, 40)}</div>
      <div class="mults"><span class="pill up">${mult(b.full)} if ${esc(tname)}</span><span class="pill down">${pct(b.flat)} if flat</span><span class="pill ${cls(s.below_ath)}">${pct(s.below_ath)} vs ATH</span></div>
    </div>`).join("");
}

function renderOpp(rows) {
  const c = colors();
  const pts = rows.filter((r) => !r.near && r.best).map((r) => ({ x: +(-r.s.below_ath * 100).toFixed(1), y: +r.best.half.toFixed(2), r: 5 + Math.min(12, (r.s.beta || 1) * 3.5), t: r.s.ticker }));
  const labels = {
    id: "labels",
    afterDatasetsDraw(chart) {
      const { ctx, scales: { y }, chartArea: a } = chart;
      ctx.save();
      const y1 = y.getPixelForValue(1);                    // break-even line: below it, the halfway case loses money
      if (y1 > a.top && y1 < a.bottom) {
        ctx.strokeStyle = c.ink; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(a.left, y1); ctx.lineTo(a.right, y1); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = c.ink; ctx.font = "600 11px Manrope, sans-serif"; ctx.fillText("break-even halfway", a.left + 6, y1 - 6);
      }
      ctx.fillStyle = c.text; ctx.font = "700 11px Manrope, sans-serif";
      chart.getDatasetMeta(0).data.forEach((el, i) => ctx.fillText(pts[i].t, el.x + el.options.radius + 3, el.y + 4));
      ctx.restore();
    },
  };
  makeChart("oppChart", {
    type: "bubble",
    data: { datasets: [{ data: pts, backgroundColor: alpha(c.accent, 0.35), borderColor: c.accent, borderWidth: 1.5, hoverBackgroundColor: alpha(c.accent, 0.6) }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { ...tooltip(c), callbacks: { label: (i) => `${pts[i.dataIndex].t}: ${i.raw.x}% below ATH · ${i.raw.y}x halfway` } } },
      scales: axes(c, { yfmt: (v) => v + "x", x: { ticks: { color: c.ink, callback: (v) => v + "%" }, title: { display: true, text: "below all-time high", color: c.ink } },
        y: { title: { display: true, text: "pays if halfway", color: c.ink } } }),
      onClick: (e, els) => { if (els[0]) location.hash = `#/explore/${pts[els[0].index].t}`; } },
    plugins: [labels],
  });
}

const options = (vals, cur, f) => vals.map((v) => `<option value="${v}" ${v === cur ? "selected" : ""}>${f(v)}</option>`).join("");
const budgetSelect = (cur) => `<select id="planBudget" aria-label="Budget">${options([250, 500, 1000, 1500, 2500, 5000, 10000], cur, (v) => fmt$(v))}</select>`;

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
      ${budgetSelect(budget)}`;
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
      <span class="ctl" style="margin-left:auto"><label>Budget</label>${budgetSelect(budget)}</span></div>
    <div>
      ${legs.map(({ b, n }) => `<p><b>${n}×</b> ${b.s.ticker} $${b.K} call, ${b.exp} <span class="muted">(${fmt$(b.cost * 100)} each = ${fmt$(n * b.cost * 100)})</span>${n === 0 ? ' <span class="down">· doesn\'t fit what\'s left of the budget</span>' : ""}</p>`).join("")}
      <p class="muted small">Total in options: ${fmt$(spent)} of ${fmt$(budget)}${left >= 1 ? ` (${fmt$(left)} left over)` : ""}. "Same $ in stock" puts the same ${fmt$(spent)} into the shares.</p>
      <div class="verdict">If the rebound happens on time, the options make <b class="${cls(fullO)}">${fmt$(fullO)}</b> vs <b>${fmt$(fullS)}</b> from buying the same stocks.
        If nothing happens for ${state.horizon} days, the options lose <b class="down">${fmt$(Math.abs(flatO))}</b> to time decay; the stocks would be about even.</div>
    </div><table><thead><tr><th class="l">Over ${state.horizon} days</th><th>Options</th><th>Same $ in stock</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="note">Concentrated plays only make sense with money you can afford to lose entirely. Rebounds that come late or small can still take an option to $0.</p>`;
}

// ---------------------------------------------------------------- market
function vixWord(v) { return v < 15 ? "Calm" : v < 20 ? "Normal" : v < 30 ? "Elevated fear" : "High fear"; }
function pcWord(v) { return v == null ? "" : v > 1.0 ? "Fearful (puts > calls)" : v < 0.7 ? "Optimistic (calls dominate)" : "Neutral"; }

const tile = (k, v, s, c = "") => `<div class="tile accent"><span class="k">${k}</span><span class="v ${c}">${v}</span><span class="s">${s}</span></div>`;
function renderPulse() {
  const m = state.market;
  $("#pulse").innerHTML = tile("Fear index (VIX)", m.vix, vixWord(m.vix)) +
    tile("S&P 500 vs its high", pct(m.spy_below_ath, 1), `$${m.spy} · high $${m.spy_ath}`, cls(m.spy_below_ath)) +
    tile("Market put/call", ratio(m.pc_volume), pcWord(m.pc_volume) + " · SPY + QQQ");
}
let charts = {};
function colors() {
  const c = getComputedStyle(document.documentElement), g = (n) => c.getPropertyValue(n).trim();
  return { ink: g("--muted"), text: g("--ink"), grid: g("--line"), accent: g("--accent"), silver: g("--silver"), good: g("--good"), bad: g("--bad"), card: g("--card-solid") };
}
function alpha(hex, a) {                                // "#a67c1f" → rgba(…, a)
  const h = hex.replace("#", ""), n = parseInt(h.length === 3 ? h.split("").map((x) => x + x).join("") : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
function makeChart(id, config) {
  charts[id]?.destroy();
  const el = document.getElementById(id);
  if (!el) return;
  Chart.defaults.font.family = "Manrope, -apple-system, sans-serif";
  Chart.defaults.font.size = 12;
  charts[id] = new Chart(el, config);
}
function axes(c, opts = {}) {
  return {
    x: { ticks: { color: c.ink, maxTicksLimit: 8 }, grid: { display: false }, border: { color: c.grid }, ...(opts.x || {}) },
    y: { ticks: { color: c.ink, callback: opts.yfmt, maxTicksLimit: 6 }, grid: { color: c.grid }, border: { display: false }, ...(opts.y || {}) },
  };
}
function tooltip(c) { return { backgroundColor: c.card, titleColor: c.text, bodyColor: c.text, borderColor: c.grid, borderWidth: 1, padding: 10, cornerRadius: 10, boxPadding: 4 }; }
function lineChart(id, labels, sets, opts = {}) {
  const c = colors();
  makeChart(id, { type: "line", data: { labels, datasets: sets },
    options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: sets.length > 1, labels: { color: c.ink, boxWidth: 8, boxHeight: 8, usePointStyle: true } }, tooltip: tooltip(c) },
      scales: axes(c, opts) } });
}
const area = (color) => (ctx) => {                      // soft fade under a line
  const { chart } = ctx, { ctx: g, chartArea: a } = chart;
  if (!a) return "transparent";
  const grad = g.createLinearGradient(0, a.top, 0, a.bottom);
  grad.addColorStop(0, alpha(color, 0.22)); grad.addColorStop(1, alpha(color, 0));
  return grad;
};
function spark(points, ath, w = 86, h = 26) {          // tiny 1-year price line, gold dashes = all-time high (if in range)
  if (!points || points.length < 2) return "";
  const ys = points.map((p) => p[1]), lo = Math.min(...ys), hi = Math.max(...ys);
  const top = ath && ath <= hi * 1.6 ? Math.max(hi, ath) : hi;
  const x = (i) => (i / (ys.length - 1)) * w, y = (v) => h - 2 - ((v - lo) / (top - lo || 1)) * (h - 4);
  const d = ys.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const col = ys[ys.length - 1] >= ys[0] ? "var(--good)" : "var(--bad)";
  const athLine = ath && ath <= top ? `<line x1="0" x2="${w}" y1="${y(ath).toFixed(1)}" y2="${y(ath).toFixed(1)}" stroke="var(--accent)" stroke-dasharray="3 3" stroke-width="1" vector-effect="non-scaling-stroke"/>` : "";
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${athLine}<path d="${d}" fill="none" stroke="${col}" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
}
function renderMarket() {
  const m = state.market, c = colors();
  $("#marketStats").innerHTML = $("#pulse").innerHTML;
  const lab = m.vix_chart.map((p) => p[0]);
  lineChart("vixChart", lab, [
    { label: "VIX", data: m.vix_chart.map((p) => p[1]), borderColor: c.accent, backgroundColor: area(c.accent), fill: true, pointRadius: 0, borderWidth: 2, tension: 0.25 },
    { label: "20 · elevated", data: lab.map(() => 20), borderColor: c.silver, borderDash: [5, 4], pointRadius: 0, borderWidth: 1 },
    { label: "30 · panic", data: lab.map(() => 30), borderColor: c.bad, borderDash: [5, 4], pointRadius: 0, borderWidth: 1 }]);
  const dd = [...state.index.stocks].sort((a, b) => a.below_ath - b.below_ath);
  $("#ddChart").parentElement.style.height = Math.max(260, dd.length * 18 + 50) + "px";     // room for every stock
  makeChart("ddChart", {
    type: "bar",
    data: { labels: dd.map((s) => s.ticker), datasets: [{ data: dd.map((s) => +(s.below_ath * 100).toFixed(1)),
      backgroundColor: dd.map((s) => alpha(s.below_ath < -0.5 ? c.bad : s.below_ath < -0.2 ? c.accent : c.silver, 0.75)), borderRadius: 4, barThickness: 11 }] },
    options: { indexAxis: "y", responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { ...tooltip(c), callbacks: { label: (i) => `${i.raw}% below all-time high` } } },
      scales: { x: { ticks: { color: c.ink, callback: (v) => v + "%" }, grid: { color: c.grid }, border: { display: false }, max: 0 },
                y: { ticks: { color: c.text, autoSkip: false, font: { size: 11, weight: "700" } }, grid: { display: false } } },
      onClick: (e, els) => { if (els[0]) location.hash = `#/explore/${dd[els[0].index].ticker}`; } },
  });
  const h = (m.history || []).filter((x) => x.pc != null);
  $("#pcHistCard").hidden = h.length < 3;
  if (h.length >= 3) {
    makeChart("pcHist", { type: "line", data: { labels: h.map((x) => x.date), datasets: [
        { label: "Put/call", data: h.map((x) => x.pc), borderColor: c.accent, pointRadius: 2, borderWidth: 2, yAxisID: "y" },
        { label: "VIX", data: h.map((x) => x.vix), borderColor: c.silver, pointRadius: 2, borderWidth: 1.5, yAxisID: "y1" }] },
      options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
        plugins: { legend: { labels: { color: c.ink, boxWidth: 8, boxHeight: 8, usePointStyle: true } }, tooltip: tooltip(c) },
        scales: { ...axes(c), y1: { position: "right", ticks: { color: c.ink }, grid: { display: false }, border: { display: false } } } } });
  }
  const rows = [...state.index.stocks].filter((s) => s.pc_volume != null).sort((a, b) => b.pc_volume - a.pc_volume);
  $("#pcTable").innerHTML = `<thead><tr><th class="l">Stock</th><th>Put/call (volume today)</th><th>Put/call (open interest)</th><th class="l">Read</th><th>Below ATH</th></tr></thead><tbody>` +
    rows.map((s) => `<tr class="click" data-t="${s.ticker}"><td class="l tk">${s.ticker}</td><td>${ratio(s.pc_volume)}</td><td>${ratio(s.pc_oi)}</td><td class="l muted">${pcWord(s.pc_volume)}</td><td class="down">${pct(s.below_ath)}</td></tr>`).join("") + "</tbody>";
}

// ---------------------------------------------------------------- explorer
const ex = { t: null, data: null, exp: null, type: "call", K: null, horizon: null, ivchg: 0 };

async function openTicker(t) {
  t = (t || "").trim().toUpperCase();
  if ($("#tickerSelect").querySelector(`option[value="${CSS.escape(t)}"]`)) { $("#tickerSelect").value = t; $("#tickerInput").value = ""; }
  else $("#tickerInput").value = t;
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
  <div class="tiles t4">
    ${tile(esc(d.name), "$" + S, `<span class="down">${pct(d.below_ath)}</span> vs high $${d.ath} (${d.ath_date})`)}
    ${tile("Beta vs S&P 500", d.beta ?? "—", "moves " + (d.beta ? d.beta.toFixed(1) + "× the market" : "—"))}
    ${tile("Volatility", d.atm_iv ? pctPlain(d.atm_iv) : "—", `option IV · actual 1-yr ${pctPlain(d.hv)}`)}
    ${tile("Put/call", ratio(d.pc_volume), `${pcWord(d.pc_volume)} · open interest ${ratio(d.pc_oi)}`)}
  </div>
  <div class="card"><div class="card__head"><h2>${d.ticker}, last 2 years</h2></div><div class="chart"><canvas id="priceChart"></canvas></div></div>
  <div class="card">
    <div class="pickers">
      <div class="ctl"><label>Type</label><div class="seg" id="exType"><button data-v="call" class="${ex.type === "call" ? "on" : ""}">Call</button><button data-v="put" class="${ex.type === "put" ? "on" : ""}">Put</button></div></div>
      <div class="ctl"><label>Expiration</label><select id="exExp">${exps.map((e) => `<option value="${e}" ${e === ex.exp ? "selected" : ""}>${e} (${Math.round(daysTo(e))} days)</option>`).join("")}</select></div>
      <div class="ctl"><label>Strike</label><select id="exK">${side.map((x) => `<option value="${x[0]}" ${x[0] === K ? "selected" : ""}>$${x[0]}${Math.abs(x[0] - S) / S < 0.02 ? " (at the money)" : ""}</option>`).join("")}</select></div>
    </div>
    <div class="greeks">
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
  <div class="grid2">
    <div class="card"><div class="card__head"><h2>Time decay if the stock goes nowhere</h2><span class="muted small">Theta speeds up near expiration</span></div><div class="chart"><canvas id="decayChart"></canvas></div></div>
    <div class="card"><div class="card__head"><h2>Volatility smile, ${ex.exp}</h2><span class="muted small">Higher = pricier strikes</span></div><div class="chart"><canvas id="smileChart"></canvas></div></div>
  </div>
  <div class="card"><div class="card__head"><h2>Where traders are positioned, ${ex.exp}</h2><span class="muted small">Open interest by strike: calls vs puts</span></div><div class="chart short"><canvas id="oiChart"></canvas></div></div>`;

  // price chart with the all-time high line
  const C = colors(), acc = C.accent, bad = C.bad, good = C.good;
  lineChart("priceChart", d.chart.map((p) => p[0]), [{ label: d.ticker, data: d.chart.map((p) => p[1]), borderColor: acc, backgroundColor: area(acc), fill: true, pointRadius: 0, borderWidth: 2, tension: 0.2 },
    { label: `All-time high $${d.ath}`, data: d.chart.map(() => d.ath), borderColor: C.silver, borderDash: [5, 4], pointRadius: 0, borderWidth: 1 }], { yfmt: (v) => "$" + v });
  // payoff across stock prices: today, after the chosen days, at expiration
  const lo = S * 0.6, hi = Math.max(d.ath * 1.08, S * 1.6), xs = Array.from({ length: 60 }, (_, i) => lo + (hi - lo) * i / 59);
  const curve = (Tx) => xs.map((x) => +(valueAt(x, Tx) * 100 - cost * 100).toFixed(0));
  lineChart("payChart", xs.map((x) => "$" + x.toFixed(0)), [
    { label: "Today", data: curve(T), borderColor: C.silver, pointRadius: 0, borderWidth: 1.5 },
    { label: `After ${ex.horizon} days`, data: curve(Th), borderColor: acc, pointRadius: 0, borderWidth: 2.5 },
    { label: "At expiration", data: curve(0), borderColor: bad, pointRadius: 0, borderWidth: 1.5, borderDash: [4, 3] }],
    { yfmt: (v) => (v < 0 ? "-$" : "$") + Math.abs(v) });
  // time decay at today's price
  const days = Array.from({ length: Math.max(2, Math.ceil(dte) + 1) }, (_, i) => i).filter((i, _, a) => a.length < 120 || i % Math.ceil(a.length / 120) === 0 || i === Math.ceil(dte));
  lineChart("decayChart", days.map((i) => i + "d"), [{ label: "Option value", data: days.map((i) => +(bs(ex.type, S, K, Math.max(0, (dte - i) / 365), iv) * 100).toFixed(0)), borderColor: bad, backgroundColor: area(bad), fill: true, pointRadius: 0, borderWidth: 2 }],
    { yfmt: (v) => "$" + v });
  // volatility smile and open interest for this expiration (strikes within ±45% of the price)
  const near = (rowsx) => rowsx.filter((x) => x[0] >= S * 0.55 && x[0] <= S * 1.45);
  const calls = near(d.chains[ex.exp].calls), puts = near(d.chains[ex.exp].puts);
  const strikes = [...new Set([...calls, ...puts].map((x) => x[0]))].sort((a, b) => a - b);
  const byK = (rowsx, i) => { const m = new Map(rowsx.map((x) => [x[0], x[i]])); return strikes.map((k) => m.get(k) ?? null); };
  const ivs = (arr) => arr.map((v) => (v && v > 0.05 && v < 5 ? +(v * 100).toFixed(1) : null));
  lineChart("smileChart", strikes.map((k) => "$" + k), [
    { label: "Calls", data: ivs(byK(calls, 4)), borderColor: acc, pointRadius: 0, borderWidth: 2, spanGaps: true, tension: 0.3 },
    { label: "Puts", data: ivs(byK(puts, 4)), borderColor: C.silver, pointRadius: 0, borderWidth: 2, spanGaps: true, tension: 0.3 }], { yfmt: (v) => v + "%" });
  makeChart("oiChart", { type: "bar", data: { labels: strikes.map((k) => "$" + k), datasets: [
      { label: "Calls", data: byK(calls, 5), backgroundColor: alpha(acc, 0.75), borderRadius: 3 },
      { label: "Puts", data: byK(puts, 5), backgroundColor: alpha(C.silver, 0.6), borderRadius: 3 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { color: C.ink, boxWidth: 8, boxHeight: 8, usePointStyle: true } }, tooltip: tooltip(C) },
      scales: axes(C, { yfmt: (v) => (v >= 1000 ? v / 1000 + "k" : v) }) } });

  $("#exExp").onchange = (e) => { ex.exp = e.target.value; ex.horizon = null; renderExplorer(); };
  $("#exK").onchange = (e) => { ex.K = +e.target.value; renderExplorer(); };
  $$("#exType button").forEach((b) => (b.onclick = () => { ex.type = b.dataset.v; ex.K = null; renderExplorer(); }));
  $("#hz").oninput = (e) => { ex.horizon = +e.target.value; renderExplorer(); $("#hz").focus(); };
  $("#ivc").oninput = (e) => { ex.ivchg = +e.target.value / 100; renderExplorer(); $("#ivc").focus(); };
}

// ---------------------------------------------------------------- themes (morning silver, afternoon graphite, evening onyx)
function autoTheme() { const h = new Date().getHours(); return h >= 6 && h < 12 ? "silver" : h >= 12 && h < 18 ? "graphite" : "onyx"; }
function themeChoice() { try { return localStorage.getItem("theme") || "auto"; } catch (e) { return "auto"; } }
function applyTheme() {
  const choice = themeChoice(), t = choice === "auto" ? autoTheme() : choice;
  $$(".sw").forEach((b) => b.classList.toggle("on", b.dataset.theme === choice));
  if (document.documentElement.dataset.theme === t) return;
  document.documentElement.dataset.theme = t;
  redrawCharts();
}
function redrawCharts() {
  if (state.rows) renderOpp(state.rows);
  const tab = location.hash.split("/")[1] || "board";
  if (tab === "explore" && ex.data && $("#exK")) renderExplorer();
  if (tab === "market") renderMarket();
  if (tab === "portfolio") renderPortfolio();
}

// ---------------------------------------------------------------- portfolio: optimized core + option satellite
const pfState = { capital: 10000, sat: 0.1, core: "optimized" };

function pickForBudget(budget) {                        // the board's best calls that fit the satellite money
  if (state.picks.length) return state.picks;
  const out = []; let left = budget;
  for (const r of (state.rows || []).filter((r) => !r.near && r.best)) {
    if (r.best.cost * 100 <= left) { out.push(r.best); left -= r.best.cost * 100; }
    if (out.length === 2) break;
  }
  return out;
}

function renderPortfolio() {
  const pf = state.pf;
  if (!pf) { $("#portfolio").innerHTML = `<div class="card empty">Portfolio data isn't available yet. It appears after the next update.</div>`; return; }
  const m = pf.mixes, c = colors();
  const t = (name, x, cl = "") => tile(name, pct(x.stats.ret) + ` <span class="muted small" style="font-size:14px">a year</span>`,
    `volatility ${pctPlain(x.stats.vol)} · Sharpe ${x.stats.sharpe.toFixed(2)} · worst drop ${pct(x.max_dd)} · beta ${x.beta.toFixed(2)}`, cl);
  $("#pfTiles").innerHTML = t("Your current mix", m.current) + t("Optimized (best return per risk)", m.optimized) + t("S&P 500", m.spy);

  // ----- core + satellite planner
  const core = m[pfState.core], capital = pfState.capital, satCash = capital * pfState.sat, coreCash = capital - satCash;
  const legs = [], picks = pfState.sat > 0 ? pickForBudget(satCash) : [];
  let left = satCash, added = true;
  picks.forEach((b) => legs.push({ b, n: 0 }));
  while (added) { added = false; for (const l of legs) if (l.b.cost * 100 <= left) { l.n++; left -= l.b.cost * 100; added = true; } }
  const optCost = legs.reduce((a, l) => a + l.n * l.b.cost * 100, 0);
  const h = state.horizon;
  const satValue = (mkt) => legs.reduce((a, { b, n }) => {
    const sm = Math.max(-0.9, (b.s.beta || 1) * mkt), St = b.s.price * (1 + sm);
    return a + n * 100 * bs("call", St, b.K, Math.max(0, (b.dte - h) / 365), ivAfter(b.iv, sm));
  }, 0) + left;                                         // unspent satellite cash stays as cash
  const moves = [[-0.2, "−20%"], [-0.1, "−10%"], [0, "Flat"], [0.1, "+10%"], [0.2, "+20%"], [0.3, "+30%"]];
  const rows = moves.map(([mv, label]) => {
    const coreP = coreCash * core.beta * mv, satP = satValue(mv) - satCash, tot = coreP + satP, spyP = capital * mv;
    return `<tr><td class="l">${label}</td><td class="${cls(coreP)}">${fmt$(coreP)}</td><td class="${cls(satP)}">${fmt$(satP)}</td>
      <td class="${cls(tot)}"><b>${fmt$(tot)}</b></td><td class="${cls(tot / capital)}">${pct(tot / capital, 1)}</td><td class="muted">${fmt$(spyP)}</td></tr>`;
  }).join("");
  const segB = (id, vals, cur, f) => `<div class="seg" id="${id}">${vals.map((v) => `<button data-v="${v}" class="${v === cur ? "on" : ""}">${f(v)}</button>`).join("")}</div>`;
  $("#plan").innerHTML = `<div class="card__head"><h2>Core + satellite plan</h2><span class="muted small">A diversified core plus 1–2 rebound calls from the Board, over ${h} days (set on the Board)</span></div>
    <div class="controls" style="margin-bottom:14px">
      <div class="ctl"><label>Total capital</label><select id="pfCap">${options([1000, 2500, 5000, 10000, 25000, 50000, 100000], capital, (v) => fmt$(v))}</select></div>
      <div class="ctl"><label>In options (satellite)</label><select id="pfSat">${options([0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3], pfState.sat, (v) => pctPlain(v))}</select></div>
      <div class="ctl"><label>Core</label>${segB("pfCore", ["optimized", "current"], pfState.core, (v) => (v === "optimized" ? "Optimized" : "My current mix"))}</div>
    </div>
    <div class="grid2"><div>
      <p><b>Core:</b> ${fmt$(coreCash)} in ${pfState.core === "optimized" ? "the optimized mix" : "your current mix"} (beta ${core.beta}, so it moves about ${core.beta}× the market).</p>
      <p><b>Satellite:</b> ${legs.length ? legs.map(({ b, n }) => `${n}× ${b.s.ticker} $${b.K} call (${b.exp})`).join(", ") + ` = ${fmt$(optCost)}` : "none"}${left >= 1 && legs.length ? `, ${fmt$(left)} kept as cash` : ""}.</p>
      ${pfState.sat > 0 && !legs.length ? `<p class="down small">No board call fits ${fmt$(satCash)}; raise the capital or the satellite share.</p>` : ""}
      <p class="muted small">Stocks are assumed to move by their beta times the market; options are repriced with each one's own volatility. Tick calls on the Board to choose the satellite yourself.</p>
    </div><div class="tablewrap"><table><thead><tr><th class="l">If the market moves</th><th>Core</th><th>Satellite</th><th>Total</th><th>Return</th><th>All in S&P 500</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  $("#pfCap").onchange = (e) => { pfState.capital = +e.target.value; renderPortfolio(); };
  $("#pfSat").onchange = (e) => { pfState.sat = +e.target.value; renderPortfolio(); };
  $$("#pfCore button").forEach((b) => (b.onclick = () => { pfState.core = b.dataset.v; renderPortfolio(); }));

  // ----- efficient frontier
  const pt = (x, label, color, style = "circle", r = 7) => ({ label, data: [{ x: +(x.stats.vol * 100).toFixed(1), y: +(x.stats.ret * 100).toFixed(1) }],
    backgroundColor: color, borderColor: c.text, borderWidth: 1, pointRadius: r, pointHoverRadius: r + 2, pointStyle: style });
  makeChart("frontierChart", { type: "scatter", data: { datasets: [
      { label: "Possible mixes", data: pf.cloud.map(([v, r]) => ({ x: +(v * 100).toFixed(1), y: +(r * 100).toFixed(1) })), backgroundColor: alpha(c.silver, 0.18), pointRadius: 2, pointHoverRadius: 2 },
      { label: "Efficient frontier", type: "line", data: pf.frontier.map(([v, r]) => ({ x: +(v * 100).toFixed(1), y: +(r * 100).toFixed(1) })), borderColor: c.accent, borderWidth: 2.5, pointRadius: 0, tension: 0.3 },
      pt(m.current, "Your mix", c.silver), pt(m.optimized, "Optimized", c.accent, "star", 11), pt(m.min_vol, "Lowest risk", c.good, "rectRot"), pt(m.spy, "S&P 500", c.bad, "triangle")] },
    options: { responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { labels: { color: c.ink, boxWidth: 8, boxHeight: 8, usePointStyle: true, filter: (i) => i.text !== "Possible mixes" } },
        tooltip: { ...tooltip(c), callbacks: { label: (i) => `${i.dataset.label}: ${i.raw.y}% a year at ${i.raw.x}% volatility` } } },
      scales: axes(c, { yfmt: (v) => v + "%", x: { ticks: { color: c.ink, callback: (v) => v + "%" }, title: { display: true, text: "risk (volatility a year)", color: c.ink } },
        y: { title: { display: true, text: "expected return a year", color: c.ink } } }) } });

  // ----- growth of $10,000
  const g = pf.growth;
  lineChart("growthChart", g.dates, [
    { label: "Optimized", data: g.optimized, borderColor: c.accent, pointRadius: 0, borderWidth: 2.5 },
    { label: "Your mix", data: g.current, borderColor: c.silver, pointRadius: 0, borderWidth: 2 },
    { label: "S&P 500", data: g.spy, borderColor: c.bad, pointRadius: 0, borderWidth: 1.5, borderDash: [4, 3] }], { yfmt: (v) => "$" + (v / 1000).toFixed(0) + "k" });

  // ----- biggest weight changes
  const shifts = [...pf.assets].map((a) => ({ ...a, d: a.optimized - a.current })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 16);
  const max = Math.max(...shifts.map((a) => Math.max(a.current, a.optimized)), 0.01);
  $("#shiftTable").innerHTML = `<thead><tr><th class="l">Stock</th><th class="l">Sector</th><th>Now</th><th>Optimized</th><th class="l"></th><th>Change</th><th>Expected return</th><th>Volatility</th></tr></thead><tbody>` +
    shifts.map((a) => `<tr class="click" data-t="${a.t}"><td class="l tk">${a.t}${a.watchlist ? '<span class="sub">on the watchlist</span>' : ""}</td><td class="l muted">${esc(a.sector)}</td>
      <td>${pctPlain(a.current)}</td><td><b>${pctPlain(a.optimized)}</b></td>
      <td class="l"><span class="bar cur" style="width:${(a.current / max) * 70}px"></span><br><span class="bar" style="width:${(a.optimized / max) * 70}px"></span></td>
      <td class="${cls(a.d)}">${a.d > 0 ? "+" : ""}${(a.d * 100).toFixed(1)} pts</td><td>${pct(a.mu)}</td><td>${pctPlain(a.vol)}</td></tr>`).join("") + "</tbody>";
  $("#pfNote").textContent = `Expected returns blend each stock's last 2 years with what its beta implies (risk-free ${pctPlain(pf.rf)} + beta × 6%), so the optimizer doesn't just chase recent winners. ` +
    `${pf.assets.length} stocks considered${pf.dropped.length ? ` (${pf.dropped.join(", ")} skipped: not enough price history)` : ""}. Estimates, not investment advice.`;
}

// ---------------------------------------------------------------- routing + wiring
function show(tab) {
  $$(".view").forEach((v) => (v.hidden = v.id !== tab));
  $$(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === tab));
}
function route() {
  const [, tab = "board", arg] = location.hash.split("/");
  show(["board", "explore", "portfolio", "market"].includes(tab) ? tab : "board");
  if (tab === "portfolio") renderPortfolio();
  if (tab === "explore") openTicker(arg || ex.t || "");
  if (tab === "market") renderMarket();
}
function seg(id, key, cb) {
  $$(`#${id} button`).forEach((b) => (b.onclick = () => {
    $$(`#${id} button`).forEach((x) => x.classList.toggle("on", x === b));
    state[key] = b.dataset.v === "ath" ? "ath" : +b.dataset.v; cb();
  }));
}

function showFreshness() {
  const mins = Math.max(0, Math.round((Date.now() - new Date(state.index.updated)) / 60000));
  $("#updated").textContent = `Prices from ${mins < 1 ? "just now" : mins < 60 ? mins + " min ago" : Math.round(mins / 60) + " h ago"}`;
  $("#dot").classList.toggle("stale", mins > 45);
}

async function checkForNewData() {
  if (document.hidden) return;                          // no work while the tab is in the background
  try {
    const idx = await getJSON("data/index.json");
    if (idx.updated === state.index.updated) return;
    const [market, pf] = await Promise.all([getJSON("data/market.json"), getJSON("data/portfolio.json").catch(() => state.pf)]);
    state.index = idx; state.market = market; state.pf = pf; state.chains = {};
    state.own = Object.fromEntries((state.pf?.assets || []).filter((a) => a.current > 0).map((a) => [a.t, a.current]));
    if (ex.t) ex.data = await chain(ex.t);              // keep the Explorer's current pick, with new prices
    renderPulse(); showFreshness();
    await renderBoard();
    const tab = location.hash.split("/")[1] || "board";
    if (tab === "explore" && ex.data && $("#exK")) renderExplorer();
    if (tab === "market") renderMarket();
    if (tab === "portfolio") renderPortfolio();
  } catch (e) { /* offline or mid-deploy: try again next time */ }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && state.index) { showFreshness(); checkForNewData(); } });

async function init() {
  try {
    [state.index, state.market] = await Promise.all([getJSON("data/index.json"), getJSON("data/market.json")]);
    state.pf = await getJSON("data/portfolio.json").catch(() => null);
    state.own = Object.fromEntries((state.pf?.assets || []).filter((a) => a.current > 0).map((a) => [a.t, a.current]));
  } catch (e) {
    $("#board").innerHTML = `<div class="card empty">Couldn't load market data yet. The first scan may still be running; try again in a few minutes.</div>`; return;
  }
  showFreshness();
  setInterval(showFreshness, 60 * 1000);                // keep "Prices from … ago" honest while the page stays open
  setInterval(checkForNewData, 2 * 60 * 1000);          // and pick up each new update without a reload
  applyTheme();
  setInterval(applyTheme, 5 * 60 * 1000);
  $("#tickerSelect").innerHTML = `<option value="">Choose a stock…</option>` +
    [...state.index.stocks].sort((a, b) => a.ticker.localeCompare(b.ticker)).map((s) => `<option value="${s.ticker}">${s.ticker} · ${esc(s.name)}</option>`).join("");
  renderPulse();
  seg("target", "target", renderBoard); seg("horizon", "horizon", renderBoard);
  $("#budget").onchange = (e) => { state.budget = +e.target.value; renderBoard(); };
  $("#paletteTab").onclick = () => $("#palette").classList.toggle("open");
  document.addEventListener("change", (e) => { if (e.target.id === "planBudget") { state.planBudget = +e.target.value; renderPlay(); } });
  $("#tickerSelect").onchange = (e) => { if (e.target.value) location.hash = `#/explore/${e.target.value}`; };
  document.addEventListener("click", (e) => {
    const pick = e.target.closest("[data-pick]");
    if (pick) {
      const t = pick.dataset.pick, row = state.rows.find((r) => r.s.ticker === t);
      if (pick.checked) { state.picks = [...state.picks.filter((p) => p.s.ticker !== t), row.best].slice(-2); }
      else state.picks = state.picks.filter((p) => p.s.ticker !== t);
      $$("[data-pick]").forEach((c) => (c.checked = state.picks.some((p) => p.s.ticker === c.dataset.pick)));
      renderPlay(); return;
    }
    const sw = e.target.closest(".sw");
    if (sw) { try { localStorage.setItem("theme", sw.dataset.theme); } catch (err) {} applyTheme(); return; }
    const row = e.target.closest("tr.click, .pick[data-t]");
    if (row && !e.target.closest("input")) location.hash = `#/explore/${row.dataset.t}`;
  });
  $("#go").onclick = () => (location.hash = `#/explore/${($("#tickerInput").value.trim() || $("#tickerSelect").value).toUpperCase()}`);
  $("#tickerInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#go").click(); });
  window.addEventListener("hashchange", route);
  await renderBoard();
  route();
}
init();
