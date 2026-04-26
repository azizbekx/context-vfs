from __future__ import annotations

import json
import os
import re
import warnings
from typing import Any

# Suppress the harmless thought_signature warnings from the SDK to keep terminal clean
warnings.filterwarnings("ignore", message=".*thought_signature.*")

GENERATION_MODEL = "gemini-3.1-flash-lite-preview"
EMBEDDING_MODEL = "gemini-embedding-2"


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


def resolve_conflict(
    entity_id: str,
    entity_type: str,
    predicate: str,
    value_a: str,
    source_a: str,
    confidence_a: float,
    date_a: str,
    value_b: str,
    source_b: str,
    confidence_b: float,
    date_b: str,
) -> dict[str, Any]:
    """Ask the LLM to analyze a fact conflict and return a structured resolution.

    Returns a dict with keys:
        resolution: "auto_resolve" | "needs_human_review"
        winner: "A" | "B" | None
        reason: str
        conflict_category: str
        confidence: float
        human_summary: str | None
    """
    prompt = (
        "You are an enterprise data conflict resolver for a company knowledge base.\n\n"
        "CONFLICT:\n"
        f"  Entity: {entity_id} ({entity_type})\n"
        f"  Predicate: {predicate}\n\n"
        f'VALUE A: "{value_a}"\n'
        f"  Source: {source_a}\n"
        f"  Confidence: {confidence_a}\n"
        f"  Observed: {date_a}\n\n"
        f'VALUE B: "{value_b}"\n'
        f"  Source: {source_b}\n"
        f"  Confidence: {confidence_b}\n"
        f"  Observed: {date_b}\n\n"
        "ANALYSIS REQUIRED:\n"
        "1. Are these values semantically identical (synonyms, abbreviations, formatting differences)?\n"
        "2. Does one source clearly supersede the other (newer version, higher authority system)?\n"
        "3. Could both be valid at different points in time (temporal change, e.g. HQ moved)?\n"
        "4. Is this a genuine contradiction that requires human review?\n\n"
        "Respond with ONLY valid JSON:\n"
        "{\n"
        '  "resolution": "auto_resolve" or "needs_human_review",\n'
        '  "winner": "A" or "B" or null,\n'
        '  "reason": "one sentence explaining why",\n'
        '  "conflict_category": one of "synonym" | "version_superseded" | "temporal_change" | "authority_mismatch" | "genuine_contradiction" | "data_quality",\n'
        '  "confidence": 0.0 to 1.0,\n'
        '  "human_summary": "If needs_human_review, a specific explanation for the human reviewer, otherwise null"\n'
        "}"
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
        # Validate required keys
        result.setdefault("resolution", "needs_human_review")
        result.setdefault("winner", None)
        result.setdefault("reason", "LLM could not determine a reason.")
        result.setdefault("conflict_category", "genuine_contradiction")
        result.setdefault("confidence", 0.5)
        result.setdefault("human_summary", None)
        return result
    except (json.JSONDecodeError, Exception):
        return {
            "resolution": "needs_human_review",
            "winner": None,
            "reason": "LLM response could not be parsed.",
            "conflict_category": "genuine_contradiction",
            "confidence": 0.0,
            "human_summary": (
                f"Multiple sources disagree on '{predicate}'. "
                f"Source A ({source_a}) says '{value_a}', "
                f"Source B ({source_b}) says '{value_b}'. "
                "Please verify which is current."
            ),
        }
