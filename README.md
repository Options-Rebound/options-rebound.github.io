# Options Rebound

Finds beaten-down call options that pay the most if a stock rebounds, and shows what you lose if it doesn't.

**Site:** https://options-rebound.github.io

- **Rebound board:** each stock's best call for a rebound you choose (+20% / +30% / +50% / back to the all-time high, within 1–6 months), ranked by what it pays if the stock only gets halfway there. Tick up to 2 to plan a play with a budget, compared with buying the same stocks.
- **Explorer:** any tracked ticker, every expiration and strike, Greeks (delta, gamma, theta, vega), a what-if table and payoff chart with sliders for time and implied volatility, and the time-decay curve.
- **Portfolio:** the efficient frontier for your holdings plus the watchlist (`portfolio/holdings.json`, caps by volatility tier), the optimized mix vs yours and the S&P 500, and a core + satellite plan that pairs the core with the Board's best calls.
- **Market:** VIX, S&P 500 distance from its high, market and per-stock put/call ratios.

## How it works
`scanner/scan.py` (Python, yfinance) downloads prices, all-time highs and every option chain, in parallel threads,
and writes small JSON files to `site/data/`. A GitHub Action runs it every 15 minutes during market hours and
publishes `site/` to GitHub Pages. All pricing math (Black-Scholes, Greeks, scenarios) runs in the browser.

## Watchlist
One file per ticker in `watchlist/` (the file name is the ticker). Add one from the site's Explorer ("Track …"),
or create a file here on GitHub. Tickers that don't exist or have no options are skipped and shown with a reason.

## Run it on your computer
```
pip install -r scanner/requirements.txt
python scanner/scan.py
python -m http.server --directory site 8000   # open http://localhost:8000
```

Prices are about 15 minutes delayed (Yahoo Finance). Model estimates, not investment advice.

## Share

![QR code to options-rebound.github.io](brand/qr-options-rebound.png)

QR codes (print, gold-on-black, SVG) and the logo are in [`brand/`](brand/).
