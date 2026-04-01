#!/usr/bin/env python3
import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request


SYSTEM_PROMPT = """You are a tweet collector. Search X for the requested tweets and return them as a JSON object.
Return ONLY valid JSON with this schema:
{"tweets": [{"id": "tweet_id", "author": "@username", "author_followers": 0, "content": "tweet text", "url": "https://x.com/user/status/id", "created_at": "ISO8601 datetime", "image_url": "https://pbs.twimg.com/... or null if no image", "metrics": {"likes": 0, "retweets": 0, "replies": 0, "views": 0}}]}
Do NOT include any explanation, only the JSON object."""


SCENARIOS = {
    "trend_keywords_2h": {
        "lookback_minutes": 120,
        "prompt": (
            "Search for tweets discussing these topics: AI agent Solana, DeFi AI agent, "
            "Crypto AI agent, Solana AI, onchain AI agent, crypto trend, crypto narrative. "
            "Focus on emerging narratives, trend shifts, strong opinions, early product signals, "
            "and high-signal commentary. Return up to 5 tweets. Sort results in reverse "
            "chronological order (newest first)."
        ),
        "handles": [],
    },
    "solana_kols_6h": {
        "lookback_minutes": 360,
        "prompt": (
            "Search for tweets from influential and outspoken Solana KOLs. Focus on strong "
            "conviction calls on tokens or protocols, bullish takes on Solana ecosystem growth, "
            "criticism of competing chains or narratives, reactions to major on-chain events, "
            "and early alpha on new launches or emerging trends before they go mainstream. "
            "Return up to 5 tweets. Sort results in reverse chronological order (newest first)."
        ),
        "handles": ["mert", "blknoiz06", "waleswoosh", "ArumBeadlesX", "kingboydarling"],
    },
    "active_brand_handles_6h": {
        "lookback_minutes": 360,
        "prompt": (
            "Find the most recent tweets from these exact accounts only. Return up to 5 tweets. "
            "Sort results in reverse chronological order (newest first). If none exist after "
            "the cutoff, return {\"tweets\":[]}."
        ),
        "handles": ["byreal_io", "Alpha_Bybit", "Bybit_Official"],
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Test xAI x_search model behavior.")
    parser.add_argument(
        "--model",
        action="append",
        dest="models",
        help="Model to test. Can be passed multiple times. Defaults to three common variants.",
    )
    parser.add_argument(
        "--scenario",
        action="append",
        dest="scenarios",
        choices=sorted(SCENARIOS.keys()),
        help="Scenario to run. Can be passed multiple times. Defaults to all.",
    )
    parser.add_argument(
        "--xai-key",
        default=os.environ.get("DATA_SOURCE_API_KEY") or os.environ.get("XAI_API_KEY"),
        help="xAI API key. Defaults to DATA_SOURCE_API_KEY or XAI_API_KEY.",
    )
    parser.add_argument(
        "--twitterapi-key",
        default=os.environ.get("TWITTERAPI_IO_KEY"),
        help="twitterapi.io API key for ground truth checks.",
    )
    parser.add_argument(
        "--count",
        type=int,
        default=5,
        help="Max tweets to request from xAI per scenario.",
    )
    parser.add_argument(
        "--show-raw",
        action="store_true",
        help="Print raw xAI response JSON.",
    )
    return parser.parse_args()


def extract_output_text(response: dict) -> str:
    for item in response.get("output", []):
        if item.get("type") == "message" and item.get("role") == "assistant":
            for content in item.get("content", []):
                if content.get("type") == "output_text" and isinstance(content.get("text"), str):
                    return content["text"]
    return ""


def parse_payload(text: str) -> dict:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start != -1 and end != -1 and end > start:
        stripped = stripped[start:end + 1]
    return json.loads(stripped)


def normalize_author(author) -> str:
    if isinstance(author, str):
        if author.startswith("@"):
            return author
        if "@" in author:
            return "@" + author.split("@", 1)[1].split()[0]
        return author
    if isinstance(author, dict):
        username = author.get("username") or author.get("userName")
        if username:
            return f"@{username}"
    return str(author)


def normalize_created_at(tweet: dict) -> str | None:
    return tweet.get("created_at") or tweet.get("timestamp")


def parse_datetime(raw: str | None) -> dt.datetime | None:
    if not raw:
        return None
    normalized = raw.replace(" GMT", "+00:00").replace("Z", "+00:00")
    for fmt in (None, "%a %b %d %H:%M:%S %z %Y", "%a, %d %b %Y %H:%M:%S %Z"):
        try:
            if fmt is None:
                return dt.datetime.fromisoformat(normalized)
            return dt.datetime.strptime(raw, fmt).replace(tzinfo=dt.UTC)
        except Exception:
            continue
    return None


def run_xai(model: str, scenario_name: str, xai_key: str, count: int, show_raw: bool) -> None:
    scenario = SCENARIOS[scenario_name]
    cutoff = dt.datetime.now(dt.UTC) - dt.timedelta(minutes=scenario["lookback_minutes"])
    tool = {"type": "x_search", "from_date": cutoff.isoformat()}
    if scenario["handles"]:
        tool["allowed_x_handles"] = scenario["handles"]

    body = {
        "model": model,
        "input": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": scenario["prompt"].replace("up to 5", f"up to {count}")},
        ],
        "tools": [tool],
        "text": {"format": {"type": "json_object"}},
    }

    proc = subprocess.run(
        [
            "curl",
            "--max-time",
            "60",
            "-sS",
            "https://api.x.ai/v1/responses",
            "-H",
            f"Authorization: Bearer {xai_key}",
            "-H",
            "Content-Type: application/json",
            "-d",
            json.dumps(body),
        ],
        capture_output=True,
        text=True,
        timeout=70,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"curl exited {proc.returncode}")

    response = json.loads(proc.stdout)
    if show_raw:
        print("RAW_XAI_RESPONSE")
        print(json.dumps(response, ensure_ascii=False, indent=2))

    payload = parse_payload(extract_output_text(response))
    tweets = payload.get("tweets", [])
    allowed = {f"@{handle}" for handle in scenario["handles"]}

    print(f"\nXAI {scenario_name} model={model} response_model={response.get('model')}")
    print(f"cutoff={cutoff.isoformat()} returned={len(tweets)}")
    for tweet in tweets:
        author = normalize_author(tweet.get("author"))
        created_at = normalize_created_at(tweet)
        parsed_dt = parse_datetime(created_at)
        stale = bool(parsed_dt and parsed_dt < cutoff)
        off_handle = bool(allowed and author not in allowed)
        print(
            json.dumps(
                {
                    "id": tweet.get("id"),
                    "author": author,
                    "created_at": created_at,
                    "stale": stale,
                    "off_handle": off_handle,
                    "url": tweet.get("url"),
                },
                ensure_ascii=False,
            )
        )


def run_twitterapi_ground_truth(scenario_name: str, twitterapi_key: str) -> None:
    scenario = SCENARIOS[scenario_name]
    if not scenario["handles"]:
        return

    cutoff = dt.datetime.now(dt.UTC) - dt.timedelta(minutes=scenario["lookback_minutes"])
    query = " OR ".join(f"from:{handle}" for handle in scenario["handles"])
    params = urllib.parse.urlencode({"query": query, "queryType": "Latest", "count": "50"})
    request = urllib.request.Request(
        f"https://api.twitterapi.io/twitter/tweet/advanced_search?{params}",
        headers={"X-API-Key": twitterapi_key},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        data = json.loads(response.read().decode())

    recent = []
    counts = {f"@{handle}": 0 for handle in scenario["handles"]}
    for tweet in data.get("tweets", []):
        created = dt.datetime.strptime(tweet["createdAt"], "%a %b %d %H:%M:%S %z %Y").astimezone(dt.UTC)
        author = f"@{(tweet.get('author') or {}).get('userName', 'unknown')}"
        if created >= cutoff:
            recent.append(
                {
                    "id": tweet["id"],
                    "author": author,
                    "created_at": created.isoformat(),
                    "isReply": tweet.get("isReply"),
                    "url": tweet.get("url"),
                }
            )
            if author in counts:
                counts[author] += 1

    print(f"\nGROUND_TRUTH {scenario_name}")
    print(json.dumps({"cutoff": cutoff.isoformat(), "recent_count": len(recent), "by_handle": counts}, ensure_ascii=False))
    for tweet in recent[:20]:
        print(json.dumps(tweet, ensure_ascii=False))


def main() -> int:
    args = parse_args()
    if not args.xai_key:
        print("Missing xAI key. Pass --xai-key or set DATA_SOURCE_API_KEY/XAI_API_KEY.", file=sys.stderr)
        return 1

    models = args.models or [
        "grok-4-fast",
        "grok-4-1-fast-non-reasoning",
        "grok-4-1-fast-reasoning",
    ]
    scenarios = args.scenarios or list(SCENARIOS.keys())

    for scenario_name in scenarios:
        if args.twitterapi_key:
            run_twitterapi_ground_truth(scenario_name, args.twitterapi_key)
        for model in models:
            run_xai(model, scenario_name, args.xai_key, args.count, args.show_raw)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
