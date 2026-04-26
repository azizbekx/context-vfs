"""Cluster -> ResolvedDecision: the storage-agnostic entry point.

Pipeline per cluster:
  1. Build the chat messages from the cluster payload (system + few-shot +
     cluster JSON).
  2. Call the LLM via the chosen provider (Ollama / Gemini / your own).
  3. Parse the JSON verdict (`decision`, `confidence`, `reasoning`, ...).
  4. Compute a risk score from confidence + action cost + cluster shape.
  5. Return a `ResolvedDecision` containing both the LLM verdict and the
     risk assessment, including a `recommended` action ("auto_act" or
     "escalate") for the calling code to act on.

This module performs zero storage mutations. The caller is responsible for
applying the recommendation against its own store (see
`examples/resolve_review_queue.py`).
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Optional

from .prompts import build_chat_messages
from .providers import LLMProvider
from .risk import RiskAssessment, assess_risk
from .types import ClusterPayload


# Default fields surfaced to the LLM for entity-match decisions. Adjust to
# your schema by passing `llm_fields=[...]` to `resolve_cluster`.
DEFAULT_LLM_FIELDS = [
    "business_name",
    "tax_id",
    "registered_address",
    "industry",
    "business_type",
    "contact_email",
    "phone_number",
    "monthly_revenue",
    "onboarding_date",
    "current_poc_product",
    "poc_status",
    "engagement_description",
    "relationship_description",
    "representative_emp_id",
    "management_representative_employee",
]


@dataclass
class ResolvedDecision:
    cluster_id: str
    decision: str                       # "same_entity" | "different" | "uncertain"
    confidence: float
    reasoning: str
    key_signals: list[str] = field(default_factory=list)
    open_questions: list[str] = field(default_factory=list)
    risk: Optional[RiskAssessment] = None
    raw_response: str = ""
    model: str = ""
    elapsed_s: float = 0.0

    def as_dict(self) -> dict[str, Any]:
        return {
            "cluster_id": self.cluster_id,
            "decision": self.decision,
            "confidence": round(self.confidence, 3),
            "reasoning": self.reasoning,
            "key_signals": list(self.key_signals),
            "open_questions": list(self.open_questions),
            "risk": self.risk.as_dict() if self.risk else None,
            "model": self.model,
            "elapsed_s": round(self.elapsed_s, 2),
        }


def _parse_decision(raw: str) -> dict[str, Any]:
    """Parse the JSON payload the LLM returned. Tolerant of stray prose
    (some providers/models wrap JSON in code fences even with format=json)."""
    txt = raw.strip()
    if txt.startswith("```"):
        lines = txt.split("\n")
        lines = [ln for ln in lines if not ln.strip().startswith("```")]
        txt = "\n".join(lines).strip()
    try:
        return json.loads(txt)
    except json.JSONDecodeError:
        start = txt.find("{")
        end = txt.rfind("}")
        if start >= 0 and end > start:
            return json.loads(txt[start : end + 1])
        raise


def resolve_cluster(
    cluster: ClusterPayload,
    provider: LLMProvider,
    *,
    risk_threshold: float = 5.0,
    llm_fields: Optional[list[str]] = None,
    timeout: int = 300,
) -> ResolvedDecision:
    """Adjudicate one candidate cluster.

    Args:
        cluster: The candidate cluster from your rules layer.
        provider: An `LLMProvider` (e.g. `GeminiProvider()`).
        risk_threshold: Above this risk score the decision is escalated to
            human review even if the LLM is confident.
        llm_fields: Which member properties to surface to the LLM. Defaults
            to a business-record set; override for other entity types.
        timeout: Per-call LLM timeout in seconds.

    Returns:
        A `ResolvedDecision` with the LLM verdict, full risk assessment,
        and a `recommended` action you can act on (auto_act / escalate).
    """
    cluster_dict = cluster.to_llm_dict(fields=llm_fields or DEFAULT_LLM_FIELDS)
    messages = build_chat_messages(cluster_dict)

    started = time.time()
    raw = provider.chat(messages, timeout=timeout)
    elapsed = time.time() - started

    parsed = _parse_decision(raw)
    decision = str(parsed.get("decision", "uncertain"))
    confidence = float(parsed.get("confidence", 0.0))

    risk = assess_risk(
        decision=decision,
        confidence=confidence,
        same_type=cluster.same_type,
        cluster_size=len(cluster.members),
        has_identifier_conflict=cluster.has_identifier_conflict,
        model=provider.name,
        risk_threshold=risk_threshold,
    )

    return ResolvedDecision(
        cluster_id=cluster.cluster_id,
        decision=decision,
        confidence=confidence,
        reasoning=str(parsed.get("reasoning", "")),
        key_signals=list(parsed.get("key_signals", []) or []),
        open_questions=list(parsed.get("open_questions", []) or []),
        risk=risk,
        raw_response=raw,
        model=provider.name,
        elapsed_s=round(elapsed, 2),
    )
