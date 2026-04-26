"""Tavily web search utility for conflict resolution context enrichment."""

from __future__ import annotations

import os
from typing import Any


def tavily_search(query: str, max_results: int = 5) -> list[dict[str, Any]]:
    """Search the web via Tavily and return a list of result dicts.

    Each result contains: title, url, content, score.
    Returns [] when TAVILY_API_KEY is unset or the request fails.
    """
    api_key = os.environ.get("TAVILY_API_KEY", "")
    if not api_key:
        return []
    try:
        from tavily import TavilyClient
        client = TavilyClient(api_key=api_key)
        response = client.search(query=query, max_results=max_results)
        results = response.get("results", [])
        return [
            {
                "title": r.get("title", ""),
                "url": r.get("url", ""),
                "content": r.get("content", ""),
                "score": r.get("score", 0.0),
            }
            for r in results
        ]
    except Exception:
        return []


def build_conflict_query(
    entity_id: str,
    predicate: str,
    value_a: str,
    value_b: str,
    entity_type: str = "",
) -> str:
    """Build a focused search query from conflict fields."""
    parts = [entity_id.split(":")[-1]]
    if entity_type and entity_type != "unknown":
        parts.append(entity_type)
    parts.append(predicate)
    if value_a and value_a != value_b:
        parts.append(f'"{value_a}" OR "{value_b}"')
    elif value_a:
        parts.append(f'"{value_a}"')
    return " ".join(parts)


def format_web_context(results: list[dict[str, Any]]) -> str:
    """Format Tavily results as a compact text block for LLM injection."""
    if not results:
        return ""
    lines = ["WEB CONTEXT (from Tavily search):"]
    for i, r in enumerate(results, 1):
        lines.append(f"[{i}] {r['title']}")
        lines.append(f"    URL: {r['url']}")
        snippet = r["content"][:400].replace("\n", " ")
        lines.append(f"    {snippet}")
    return "\n".join(lines)
