#!/usr/bin/env python3
"""Options Rebound scanner: writes the JSON the website reads.

    python scanner/scan.py [--out site/data] [TICKER ...]

For every ticker in watchlist/ (one file per ticker), it saves:
  data/chains/<T>.json   every expiration's calls and puts (strike, bid, ask, last, IV, open interest, volume)
  data/index.json        one summary line per stock (price, all-time high, beta, volatility, put/call ratios)
  data/market.json       VIX, S&P 500 distance from its high, market put/call ratio (+ a short history)

Greeks and scenarios are computed in the browser from this data.
Network work is done in parallel threads (it is all waiting on Yahoo, not CPU).
"""
import argparse
import json
import math
import re
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone

import numpy as np
import yfinance as yf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TICKER_WORKERS = int(os.environ.get("TICKER_WORKERS", 6))   # stocks fetched at once
CHAIN_WORKERS = int(os.environ.get("CHAIN_WORKERS", 4))     # expirations fetched at once per stock
RETRIES = 3


def retry(fn, *a, **k):
    for i in range(RETRIES):
        try:
            return fn(*a, **k)
        except Exception as e:                      # Yahoo throttles bursts; back off and try again
            if i == RETRIES - 1:
                raise
            time.sleep(2 * (i + 1))


def r(x, n=2):
    return None if x is None or (isinstance(x, float) and (math.isnan(x) or math.isinf(x))) else round(float(x), n)


VALID = re.compile(r"^[A-Z][A-Z0-9]{0,5}([.-][A-Z]{1,2})?$")      # NVDA, BRK-B, BF.B


def watchlist():
    """Ticker files in watchlist/; names that can't be a ticker are ignored (reported, never fatal)."""
    d = os.path.join(ROOT, "watchlist")
    names = {f.strip().upper() for f in os.listdir(d) if not f.startswith(".") and f.strip()}
    bad = sorted(n for n in names if not VALID.match(n))
    if bad:
        print("  ignoring names that aren't tickers:", ", ".join(bad), file=sys.stderr)
    return sorted(n for n in names if VALID.match(n)), bad


def closes(ticker, period):
    h = retry(yf.Ticker(ticker).history, period=period, auto_adjust=True)
    return h["Close"].dropna()


def beta_vs(stock, market):
    s, m = stock.pct_change().dropna(), market.pct_change().dropna()
    j = s.to_frame("s").join(m.to_frame("m"), how="inner").dropna().iloc[-504:]   # about 2 years
    if len(j) < 60:
        return None, None
    raw = float(np.cov(j["s"], j["m"])[0, 1] / j["m"].var())
    return raw, 0.67 * raw + 0.33                                                   # Blume-adjusted: drifts toward 1


def chain_rows(df, lo, hi):
    out = []
    for row in df.itertuples(index=False):
        k = float(row.strike)
        if not lo <= k <= hi:
            continue
        bid, ask, last = (float(x) if x == x else 0.0 for x in (row.bid, row.ask, row.lastPrice))
        if not (bid or ask or last):
            continue
        iv = float(row.impliedVolatility) if row.impliedVolatility == row.impliedVolatility else 0.0
        oi = int(row.openInterest) if row.openInterest == row.openInterest else 0
        vol = int(row.volume) if row.volume == row.volume else 0
        out.append([r(k, 3), r(bid), r(ask), r(last), r(iv, 4), oi, vol])
    return out


def scan_ticker(ticker, spy_closes):
    t = yf.Ticker(ticker)
    hist = retry(t.history, period="max", auto_adjust=True)["Close"].dropna()
    if hist.empty:
        raise LookupError("wasn't found on the market (no price history)")
    price = float(hist.iloc[-1])
    ath_i = hist.idxmax()
    ath = float(hist.max())
    one_year = hist.iloc[-252:]
    raw_beta, adj_beta = beta_vs(hist, spy_closes)
    rets = hist.pct_change().dropna()
    hv = float(rets.iloc[-252:].std() * math.sqrt(252))
    hv30 = float(rets.iloc[-21:].std() * math.sqrt(252))
    # chart: the last 2 years, about 260 points
    two = hist.iloc[-504:]
    step = max(1, len(two) // 260)
    chart = [[d.strftime("%Y-%m-%d"), r(v)] for d, v in list(two.items())[::step]]

    exps = [e for e in retry(lambda: t.options) if re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(e))]   # only real dates reach the site
    if not exps:
        raise LookupError("has no listed options")
    lo, hi = price * 0.3, max(price * 2.2, ath * 1.25)

    def one(exp):
        ch = retry(t.option_chain, exp)
        return exp, chain_rows(ch.calls, lo, hi), chain_rows(ch.puts, lo, hi)

    chains = {}
    with ThreadPoolExecutor(max_workers=CHAIN_WORKERS) as pool:
        for exp, calls, puts in pool.map(one, exps):
            if calls or puts:
                chains[exp] = {"calls": calls, "puts": puts}

    pv = sum(p[6] for c in chains.values() for p in c["puts"])
    cv = sum(p[6] for c in chains.values() for p in c["calls"])
    po = sum(p[5] for c in chains.values() for p in c["puts"])
    co = sum(p[5] for c in chains.values() for p in c["calls"])
    # at-the-money implied volatility, about a month out
    atm_iv = None
    for exp in sorted(chains):
        if (date.fromisoformat(exp) - date.today()).days >= 20:
            ivs = [row[4] for side in ("calls", "puts") for row in chains[exp][side]
                   if row[4] and abs(row[0] - price) <= price * 0.03]
            if ivs:
                atm_iv = sum(ivs) / len(ivs)
                break
    try:
        name = str(t.info.get("shortName") or ticker)[:80]
    except Exception:
        name = ticker
    summary = {
        "ticker": ticker, "name": name, "price": r(price), "ath": r(ath), "ath_date": ath_i.strftime("%Y-%m-%d"),
        "below_ath": r(price / ath - 1, 4), "high_1y": r(float(one_year.max())), "low_1y": r(float(one_year.min())),
        "beta": r(adj_beta, 2), "beta_raw": r(raw_beta, 2), "hv": r(hv, 4), "hv30": r(hv30, 4), "atm_iv": r(atm_iv, 4),
        "pc_volume": r(pv / cv, 2) if cv else None, "pc_oi": r(po / co, 2) if co else None,
        "expirations": len(chains), "contracts": sum(len(c["calls"]) + len(c["puts"]) for c in chains.values()),
    }
    detail = {**summary, "chart": chart, "chains": chains}
    return summary, detail


def market(prev_history, spy_max):
    vix = closes("^VIX", "1y")
    spy = float(spy_max.iloc[-1])
    # market put/call proxy: SPY + QQQ option volume and open interest, expirations within 60 days (fetched in parallel)
    jobs = []
    for sym in ("SPY", "QQQ"):
        t = yf.Ticker(sym)
        jobs += [(t, e) for e in retry(lambda: t.options) if (date.fromisoformat(e) - date.today()).days <= 60]

    def sums(job):
        ch = retry(job[0].option_chain, job[1])
        return (int(ch.puts["volume"].fillna(0).sum()), int(ch.calls["volume"].fillna(0).sum()),
                int(ch.puts["openInterest"].fillna(0).sum()), int(ch.calls["openInterest"].fillna(0).sum()))
    with ThreadPoolExecutor(max_workers=8) as pool:
        totals = list(pool.map(sums, jobs))
    pv, cv, po, co = (sum(x[i] for x in totals) for i in range(4))
    today = date.today().isoformat()
    pc = r(pv / cv, 2) if cv else None
    hist = [h for h in prev_history if h.get("date") != today][-400:]
    hist.append({"date": today, "vix": r(float(vix.iloc[-1])), "pc": pc, "spy_below_ath": r(spy / float(spy_max.max()) - 1, 4)})
    return {
        "vix": r(float(vix.iloc[-1])), "vix_chart": [[d.strftime("%Y-%m-%d"), r(v)] for d, v in vix.items()],
        "spy": r(spy), "spy_ath": r(float(spy_max.max())), "spy_below_ath": r(spy / float(spy_max.max()) - 1, 4),
        "pc_volume": pc, "pc_oi": r(po / co, 2) if co else None, "history": hist,
    }


def previous_history(url):
    if not url:
        return []
    try:
        with urllib.request.urlopen(url.rstrip("/") + "/data/market.json", timeout=20) as f:
            return json.load(f).get("history", [])
    except Exception:
        return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "site", "data"))
    ap.add_argument("--site-url", default=os.environ.get("SITE_URL", ""))
    ap.add_argument("tickers", nargs="*")
    a = ap.parse_args()
    if a.tickers:
        tickers, bad_names = [t.upper() for t in a.tickers], []
    else:
        tickers, bad_names = watchlist()
    os.makedirs(os.path.join(a.out, "chains"), exist_ok=True)
    t0 = time.time()

    spy_closes = closes("SPY", "max")                       # needed first: every stock's beta uses it
    summaries = []
    failed = [{"ticker": n, "error": "isn't a valid ticker symbol"} for n in bad_names]

    def job(tk):
        try:
            return tk, scan_ticker(tk, spy_closes), None
        except LookupError as e:                          # the ticker itself is the problem
            return tk, None, str(e)
        except Exception as e:                            # network trouble: say so, try again next run
            return tk, None, "couldn't be downloaded this time (" + type(e).__name__ + "); it will retry next update"

    with ThreadPoolExecutor(max_workers=TICKER_WORKERS + 1) as pool:
        mkt_future = pool.submit(market, previous_history(a.site_url), spy_closes)   # market data alongside the stocks
        for tk, res, err in pool.map(job, tickers):
            if err:
                failed.append({"ticker": tk, "error": err})
                print(f"  ✗ {tk}: {err}", file=sys.stderr)
                continue
            summary, detail = res
            summaries.append(summary)
            with open(os.path.join(a.out, "chains", f"{tk}.json"), "w") as f:
                json.dump(detail, f, separators=(",", ":"))
            print(f"  {tk:6} {summary['below_ath']:+.0%} vs ATH  {summary['expirations']:3} expirations  {summary['contracts']:5} contracts")

        mkt = mkt_future.result()
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with open(os.path.join(a.out, "index.json"), "w") as f:
        json.dump({"updated": stamp, "stocks": sorted(summaries, key=lambda s: s["below_ath"]), "failed": failed,
                   "seconds": round(time.time() - t0)}, f, separators=(",", ":"))
    with open(os.path.join(a.out, "market.json"), "w") as f:
        json.dump({"updated": stamp, **mkt}, f, separators=(",", ":"))
    print(f"{len(summaries)} stocks, {len(failed)} failed, {time.time() - t0:.0f}s")
    return 0 if summaries else 1


if __name__ == "__main__":
    sys.exit(main())
