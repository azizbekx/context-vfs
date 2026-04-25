from __future__ import annotations

import json
import os
import re
from typing import Any

GENERATION_MODEL = "gemini-2.5-flash"
EMBEDDING_MODEL = "gemini-embedding-001"


def _require_key() -> str:
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    return key


def _client() -> Any:
    from google import genai

    return genai.Client(api_key=_require_key())


def _parse_json_response(text: str) -> Any:
    raw = text.strip()
    raw = re.sub(r"^```(?:json)?\s*\n?", "", raw)
    raw = re.sub(r"\n?```\s*$", "", raw)
    return json.loads(raw.strip())


def extract_policy_knowledge(policy_name: str, text: str) -> dict[str, Any]:
    if not text or len(text.strip()) < 50:
        return {
            "summary": "",
            "processes": [],
            "definitions": [],
            "roles": [],
            "rules": [],
        }

    prompt = (
        "Analyze this company policy document and extract structured knowledge.\n"
            f"Policy: {policy_name}\n\n"
            f"Text:\n{text[:8000]}\n\n"
        "Return JSON with:\n"
        '- "summary": 1-2 sentence plain English summary of this policy\n'
        '- "processes": [{"name": str, "steps": [str], "responsible_role": str, "trigger": str}]\n'
        '- "definitions": [{"term": str, "definition": str}]\n'
        '- "roles": [{"role": str, "responsibilities": [str]}]\n'
        '- "rules": [{"rule": str, "applies_to": str}]\n'
        "Return ONLY valid JSON."
    )

    client = _client()
    from google.genai import types

    response = client.models.generate_content(
        model=GENERATION_MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(temperature=0.1),
    )
    try:
        result = _parse_json_response(response.text)
        for key in ("processes", "definitions", "roles", "rules"):
            result.setdefault(key, [])
        result.setdefault("summary", "")
        return result
    except (json.JSONDecodeError, Exception):
        return {
            "summary": "",
            "processes": [],
            "definitions": [],
            "roles": [],
            "rules": [],
        }


def ask_question(question: str, context: str) -> str:
    client = _client()
    from google.genai import types

    prompt = (
        "Answer the question using only the provided company context. "
        'If the context does not contain the answer, say "I could not find that in the company context base." '
        "Cite source references (file paths, entity IDs, or source records) when possible.\n\n"
            f"Context:\n{context}\n\n"
            f"Question: {question}"
    )

    response = client.models.generate_content(
        model=GENERATION_MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(temperature=0.2),
    )
    return response.text


def embed_text(text: str) -> list[float]:
    client = _client()
    response = client.models.embed_content(model=EMBEDDING_MODEL, contents=text)
    embeddings = getattr(response, "embeddings", None)
    if not embeddings:
        raise ValueError("No embeddings returned")
    first = embeddings[0]
    values = getattr(first, "values", None)
    if values is None and isinstance(first, dict):
        values = first.get("values")
    if values is None:
        raise ValueError("Could not read embedding values")
    return [float(v) for v in values]
