#!/usr/bin/env python3
"""Portfolio optimizer (from the Optimus Portfolio notebook, Version 10), writing data/portfolio.json.

Universe: the current holdings (portfolio/holdings.json) plus the rebound watchlist.
- Expected returns: half 2-year history, half what each stock's beta implies (keeps the optimizer
  from simply chasing whatever ran hardest), capped at ±80% a year.
- Risk: 2-year daily covariance, annualized, with a little shrinkage toward the diagonal.
- Position caps by volatility tier (ultra 5%, high 8%, anchor 12%); tickers not tiered in the
  notebook are tiered by their own 1-year volatility.
- Outputs: max-Sharpe and min-volatility mixes, the efficient frontier, a cloud of random portfolios,
  a 2-year back-test vs the S&P 500, and each holding's beta (for the core + satellite planner).
"""
import json
import os
import sys

import numpy as np
import pandas as pd
import yfinance as yf
from scipy.optimize import minimize

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MARKET_PREMIUM = 0.06
SHRINK = 0.5                 # weight on history vs beta-implied return
YEARS = 2


def load():
    h = json.load(open(os.path.join(ROOT, "portfolio", "holdings.json")))
    watch = sorted({f.strip().upper() for f in os.listdir(os.path.join(ROOT, "watchlist")) if not f.startswith(".")})
    w = {k.upper(): float(v) for k, v in h["weights"].items()}
    return h, w, watch


def rfr():
    try:
        return float(yf.Ticker("^IRX").history(period="5d")["Close"].dropna().iloc[-1]) / 100
    except Exception:
        return 0.044


def solve(fun, n, bounds, cons, x0):
    r = minimize(fun, x0, method="SLSQP", bounds=bounds, constraints=cons, options={"maxiter": 500, "ftol": 1e-10})
    x = np.clip(r.x, 0, None)
    return x / x.sum()


def frontier_point(args):
    """One point of the efficient frontier: least volatility for a target return (runs in its own process)."""
    target, mu, cov, bounds, x0 = args
    cons = [{"type": "eq", "fun": lambda w: w.sum() - 1}, {"type": "eq", "fun": lambda w: w @ mu - target}]
    w = solve(lambda w: w @ cov @ w, len(mu), bounds, cons, x0)
    return [round(float(np.sqrt(w @ cov @ w)), 4), round(float(w @ mu), 4)]


def stats(w, mu, cov, rf):
    ret, vol = float(w @ mu), float(np.sqrt(w @ cov @ w))
    return {"ret": round(ret, 4), "vol": round(vol, 4), "sharpe": round((ret - rf) / vol, 3) if vol else None}


def backtest(w, rets):
    daily = (rets.fillna(0) @ w)
    growth = (1 + daily).cumprod()
    dd = float((growth / growth.cummax() - 1).min())
    return growth, dd


def main(out):
    h, cur, watch = load()
    tiers = {t: name for name, ts in h["tiers"].items() for t in ts}
    sector_of = {t: s for s, ts in h["sectors"].items() for t in ts}
    universe = sorted(set(cur) | set(watch))
    rf = rfr()

    px = yf.download(universe + ["SPY"], period=f"{YEARS}y", auto_adjust=True, progress=False, threads=True)["Close"]
    px = px.dropna(axis=1, how="all")
    rets = px.pct_change().iloc[1:]
    enough = [t for t in universe if t in rets and rets[t].notna().sum() >= 200]     # about 10 months of data
    dropped = sorted(set(universe) - set(enough))
    rets_u = rets[enough]
    spy = rets["SPY"]

    mkt_var = spy.var()
    beta = {t: float(rets_u[t].cov(spy) / mkt_var) for t in enough}
    hist = (rets_u.mean() * 252).clip(-0.8, 0.8)
    implied = pd.Series({t: rf + beta[t] * MARKET_PREMIUM for t in enough})
    mu = (SHRINK * hist + (1 - SHRINK) * implied).values
    cov = rets_u.cov().values * 252
    cov = 0.9 * cov + 0.1 * np.diag(np.diag(cov))                                    # shrink toward the diagonal
    vol1y = rets_u.iloc[-252:].std() * np.sqrt(252)

    def tier(t):
        if t in tiers:
            return tiers[t]
        v = vol1y[t]
        return "ultra" if v > 0.7 else "high" if v > 0.45 else "anchor"
    caps = np.array([h["caps"][tier(t)] for t in enough])
    n = len(enough)
    bounds = [(0, c) for c in caps]
    full = {"type": "eq", "fun": lambda w: w.sum() - 1}
    x0 = caps / caps.sum()

    max_sharpe = solve(lambda w: -((w @ mu - rf) / np.sqrt(w @ cov @ w)), n, bounds, [full], x0)
    min_vol = solve(lambda w: w @ cov @ w, n, bounds, [full], x0)
    # highest return the caps allow: fill the best expected returns first
    order = np.argsort(-mu)
    w_hi, left = np.zeros(n), 1.0
    for i in order:
        w_hi[i] = min(caps[i], left); left -= w_hi[i]
        if left <= 1e-9:
            break
    r_lo, r_hi = float(min_vol @ mu), float(w_hi @ mu)
    # 22 small solves of a few milliseconds each: one process is fastest here (tested: a process pool
    # doubled the run time, because start-up and data copying cost more than the math, and numpy
    # already uses several cores inside each solve)
    frontier = [frontier_point((t, mu, cov, bounds, min_vol)) for t in np.linspace(r_lo, r_hi, 22)]

    rng = np.random.default_rng(7)                    # cloud of random portfolios for context
    cloud = []
    for _ in range(1500):
        pick = rng.choice(n, size=min(n, rng.integers(10, 35)), replace=False)
        w = np.zeros(n); w[pick] = rng.dirichlet(np.ones(len(pick)))
        w = np.minimum(w, caps); w /= w.sum()
        cloud.append([round(float(np.sqrt(w @ cov @ w)), 4), round(float(w @ mu), 4)])

    cur_w = np.array([cur.get(t, 0.0) for t in enough])
    cur_w = cur_w / cur_w.sum()
    spy_s = {"ret": round(float(rf + MARKET_PREMIUM), 4), "vol": round(float(spy.std() * np.sqrt(252)), 4)}
    spy_s["sharpe"] = round((spy_s["ret"] - rf) / spy_s["vol"], 3)

    series, dds = {}, {}
    for name, w in (("current", cur_w), ("optimized", max_sharpe), ("min_vol", min_vol)):
        g, dd = backtest(w, rets_u)
        series[name], dds[name] = g, dd
    g_spy = (1 + spy.fillna(0)).cumprod()
    weekly = pd.DataFrame({**series, "spy": g_spy}).resample("W-FRI").last().dropna()

    def mix(w):
        return {"stats": stats(w, mu, cov, rf), "beta": round(float(sum(w[i] * beta[t] for i, t in enumerate(enough))), 2)}

    out_json = {
        "rf": round(rf, 4), "universe": enough, "dropped": dropped,
        "assets": [{"t": t, "sector": sector_of.get(t, "Other"), "tier": tier(t), "cap": caps[i], "mu": round(float(mu[i]), 4),
                    "vol": round(float(np.sqrt(cov[i, i])), 4), "beta": round(beta[t], 2),
                    "current": round(float(cur_w[i]), 4), "optimized": round(float(max_sharpe[i]), 4), "min_vol": round(float(min_vol[i]), 4),
                    "watchlist": t in watch} for i, t in enumerate(enough)],
        "mixes": {"current": {**mix(cur_w), "max_dd": round(dds["current"], 4)},
                  "optimized": {**mix(max_sharpe), "max_dd": round(dds["optimized"], 4)},
                  "min_vol": {**mix(min_vol), "max_dd": round(dds["min_vol"], 4)},
                  "spy": {"stats": spy_s, "beta": 1.0, "max_dd": round(float((g_spy / g_spy.cummax() - 1).min()), 4)}},
        "frontier": frontier, "cloud": cloud,
        "growth": {"dates": [d.strftime("%Y-%m-%d") for d in weekly.index],
                   **{k: [round(float(v) * 10000) for v in weekly[k]] for k in ("current", "optimized", "min_vol", "spy")}},
    }
    with open(os.path.join(out, "portfolio.json"), "w") as f:
        json.dump(out_json, f, separators=(",", ":"))
    m = out_json["mixes"]
    print(f"portfolio: {n} assets ({len(dropped)} without enough history: {', '.join(dropped) or 'none'})")
    for k in ("current", "optimized", "min_vol", "spy"):
        s = m[k]["stats"]
        print(f"  {k:9} return {s['ret']:+.1%}  vol {s['vol']:.1%}  sharpe {s['sharpe']}  beta {m[k]['beta']}  max drawdown {m[k]['max_dd']:.1%}")


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "site", "data")
    os.makedirs(out, exist_ok=True)
    main(out)
