#!/usr/bin/env python3
"""Load a vLLM server with concurrent completions, to give the inspector something to show.

Reads the address from VITE_VLLM_URL in the repo's .env (the same one the connect dialog
offers); --url overrides it. Standard library only.
"""

import argparse
import json
import random
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

DEFAULT_URL = "http://localhost:8000"
ENV_FILE = Path(__file__).resolve().parent.parent / ".env"

TOPICS = ["the KV cache", "paged attention", "continuous batching", "speculative decoding", "prefix caching"]


def url_from_env() -> str:
    if not ENV_FILE.exists():
        return DEFAULT_URL
    for line in ENV_FILE.read_text().splitlines():
        key, sep, value = line.strip().partition("=")
        if sep and key == "VITE_VLLM_URL":
            return value.strip().strip("'\"")
    return DEFAULT_URL


def call(url: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as resp:
        return json.load(resp)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", default=url_from_env(), help="vLLM address (default: VITE_VLLM_URL from .env)")
    parser.add_argument("-n", "--requests", type=int, default=64, help="total requests")
    parser.add_argument("-c", "--concurrency", type=int, default=16, help="requests in flight at once")
    parser.add_argument("--max-tokens", type=int, default=256, help="tokens generated per request")
    args = parser.parse_args()

    base = args.url.rstrip("/")
    model = call(f"{base}/v1/models")["data"][0]["id"]
    print(f"{base} serving {model}: {args.requests} requests, {args.concurrency} at a time")

    def one(i: int) -> tuple[int, float, int]:
        # repeated sentences vary the prompt length (and so the prefill work) per request
        prompt = f"Explain {random.choice(TOPICS)} in vLLM. " * random.randint(1, 50)
        start = time.perf_counter()
        resp = call(f"{base}/v1/completions", {
            "model": model,
            "prompt": prompt,
            "max_tokens": args.max_tokens,
            # vLLM extension: always generate max_tokens, so requests stay in the batch long enough to see
            "ignore_eos": True,
        })
        return i, time.perf_counter() - start, resp["usage"]["completion_tokens"]

    start = time.perf_counter()
    tokens = 0
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        for i, latency, n in pool.map(one, range(args.requests)):
            tokens += n
            print(f"request {i:>4}  {latency:6.2f} s  {n} tokens")
    elapsed = time.perf_counter() - start
    print(f"done in {elapsed:.1f} s, {tokens / elapsed:.0f} generated tok/s")


if __name__ == "__main__":
    main()
