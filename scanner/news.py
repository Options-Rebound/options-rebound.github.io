"""Headlines for the watchlist, scored for how likely they are to move the stock.

Yahoo Finance gives about 10 recent stories per ticker (title, summary, publisher, time, tagged tickers).
Each story gets an impact score from what it is about (earnings, analyst calls, deals, legal trouble, share
offerings, leadership changes, approvals...), whether it is really about the stock (not a roundup or listicle),
and whether the stock is actually moving unusually today. Stories are kept for 3 days across runs.
Everything here is plain rules: no paid services, nothing to configure.
"""
import json
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import yfinance as yf

KEEP = timedelta(days=3)
MARKET = ("SPY", "QQQ")                      # their news = market-wide stories

# (points, tag, pattern) — what a story is about
TOPICS = [
    (3, "Earnings", r"\b(earnings|quarterly results|q[1-4] (results|revenue|sales)|revenue|eps|guidance|outlook|forecast|beats? (estimates|expectations)|miss(es|ed)? (estimates|expectations)|profit warning)\b"),
    (2, "Analyst", r"\b(upgrades?|downgrades?|upgraded|downgraded|price target|initiates?|initiated|overweight|underweight|outperform|underperform|buy rating|sell rating)\b"),
    (3, "Deal", r"\b(acquir\w*|acquisition|merger|merge|buyout|takeover|agrees to buy|stake in|spin-?off|divest\w*)\b"),
    (2, "Legal", r"\b(sec|probe|investigation|lawsuit|sued|sues|antitrust|ftc|doj|subpoena|fined?|settle\w*|fraud|short seller|short report)\b"),
    (2, "Capital", r"\b(offering|dilution|dilutive|convertible|buyback|repurchase|dividend|stock split|delist\w*|bankrupt\w*|chapter 11|debt)\b"),
    (2, "Leadership", r"\b(resigns?|steps? down|ousted|departs?|appoint\w*|names new|new (ceo|cfo)|interim (ceo|cfo)|(back|returns) as ceo|layoffs?|job cuts|restructur\w*)\b"),
    (2, "Product", r"\b(fda|approv\w*|clinical|trial (data|results)|recall\w*|launch\w*|unveil\w*|outage|breach)\b"),
    (1, "Policy", r"\b(tariffs?|export (ban|controls?|curbs?)|sanctions?|fed|rate cuts?|inflation|jobs report|cpi|regulat\w*)\b"),
    (1, "Business", r"\b(contract|partnership|partners with|orders?|wins|awarded|deal with|supply)\b"),
]
NOISE = r"\b((stocks?|etfs?|shares) to (buy|sell|own|watch)|to buy (before|now|and hold)|should you|is it (time|too late)|better buy|could make you|millionaire|\d+ (reasons|things|stocks|ways)|here'?s why|what to know|predictions?|forever|investing rules|top \d+|buy (now|today)|no-?brainer|motley fool|trivia|quiz)\b"
UP = r"\b(beats?|surg\w*|soar\w*|jump\w*|rall\w*|rais\w*|upgrad\w*|record|wins?|approv\w*|strong\w*|tops|boost\w*|buyback|gains?|rebound\w*|climb\w*|outperform)\b"
DOWN = r"\b(miss\w*|plung\w*|sink\w*|sank|slump\w*|fall\w*|fell|drop\w*|tumbl\w*|cuts?|downgrad\w*|probe|lawsuit|recall\w*|weak\w*|warn\w*|layoffs?|halt\w*|delay\w*|sell-?off|declin\w*|slid\w*|crash\w*|fears?|losses|underperform)\b"


GENERIC = {"advanced", "micro", "united", "american", "first", "general", "global", "international", "digital", "simon", "the"}


def short_name(name):
    """"NVIDIA Corporation" → "nvidia", "First Majestic Silver Corp." → "first majestic": how headlines name the company."""
    words = re.sub(r"[,.(].*$", "", name).lower().split()
    if not words:
        return ""
    return " ".join(words[:2]) if words[0] in GENERIC or len(words[0]) < 4 else words[0]


def _when(c):
    s = c.get("pubDate") or c.get("displayTime")
    return datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def _stories(sym):
    try:
        return sym, yf.Ticker(sym).news or []
    except Exception:
        return sym, []                       # one ticker's news failing never matters


def score(item, names, moving):
    """Impact points + tags + sentiment for one story (title weighs more than summary)."""
    title, summary = item["title"].lower(), (item.get("summary") or "").lower()
    pts, tags = 0, []
    for p, tag, pat in TOPICS:
        if re.search(pat, title):
            pts += p; tags.append(tag)
        elif re.search(pat, summary):
            pts += p / 2; tags.append(tag)
    if re.search(NOISE, title) or re.search(NOISE, (item.get("publisher") or "").lower()):
        pts -= 3
    if item["video"]:
        pts -= 0.5
    ours = [t for t in item["tickers"] if t != "Market"]
    named = [t for t in ours if re.search(rf"\b{re.escape(t.lower())}\b", title) or (names.get(t) and names[t] in title)]
    if named:
        pts += 2                             # the headline itself is about one of our stocks
    elif ours:
        pts -= 1.5                           # only tagged by Yahoo (often a different company's news)
    if len(item["tickers"]) > 4:
        pts -= 1                             # roundup touching many names
    hot = [t for t in ours if t in moving]
    if hot and item["age_h"] < 24:
        pts += 2                             # a stock that is moving unusually today
    up, down = len(re.findall(UP, title)), len(re.findall(DOWN, title))
    return round(pts, 1), tags[:3], (1 if up > down else -1 if down > up else 0), hot


def build(summaries, prev_items=()):
    """summaries: index.json stock lines (need ticker, name, chg_1d, move_z)."""
    now = datetime.now(timezone.utc)
    ours = {s["ticker"] for s in summaries}
    names = {s["ticker"]: short_name(s.get("name") or "") for s in summaries if s.get("name") and s["name"] != s["ticker"]}
    moving = {s["ticker"]: s for s in summaries if s.get("move_z") is not None and abs(s["move_z"]) >= 2}

    items = {}
    for it in prev_items:                    # keep what earlier runs saw (Yahoo only shows the latest ~10)
        try:
            when = datetime.fromisoformat(it["time"])
        except (KeyError, ValueError):
            continue
        if now - when <= KEEP:
            items[it["id"]] = it
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(_stories, sorted(ours) + list(MARKET)))
    for sym, stories in results:
        for raw in stories:
            c = raw.get("content", raw)
            url = ((c.get("clickThroughUrl") or {}).get("url") or (c.get("canonicalUrl") or {}).get("url") or "")
            when = _when(c)
            if not c.get("title") or not url.startswith("https://") or not when or now - when > KEEP:
                continue
            tagged = {t.get("symbol") for t in ((c.get("finance") or {}).get("stockTickers") or [])}
            tick = sorted((tagged & ours) | ({sym} if sym in ours else set())) or ["Market"]
            key = c.get("id") or url
            old = items.get(key)
            if old:                          # same story under several tickers: merge the tags
                tick = sorted(set(old["tickers"]) | set(tick))
                tick = [t for t in tick if t != "Market"] or ["Market"]
            items[key] = {
                "id": key, "title": c["title"].strip()[:300], "summary": (c.get("summary") or "").strip()[:400],
                "publisher": ((c.get("provider") or {}).get("displayName") or "")[:60], "url": url[:600],
                "time": when.isoformat(timespec="seconds"), "tickers": tick[:8],
                "video": c.get("contentType") == "VIDEO",
            }
    out = []
    for it in items.values():
        it["age_h"] = (now - datetime.fromisoformat(it["time"])).total_seconds() / 3600
        it["score"], it["tags"], it["sentiment"], hot = score(it, names, moving)
        it["moving"] = hot
        del it["age_h"]
        out.append(it)
    out.sort(key=lambda x: x["time"], reverse=True)
    return {
        "items": out[:400],
        "moving": sorted(({"ticker": t, "chg": s["chg_1d"], "z": s["move_z"]} for t, s in moving.items()),
                         key=lambda m: -abs(m["z"])),
    }


def previous(url):
    if not url:
        return []
    try:
        with urllib.request.urlopen(url.rstrip("/") + "/data/news.json", timeout=20) as f:
            return json.load(f).get("items", [])
    except Exception:
        return []
