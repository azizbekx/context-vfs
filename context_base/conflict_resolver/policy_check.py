"""Cross-source incident detection: scan textual records (emails,
conversations, IT tickets, customer-support chats) for conflicts against
two reference corpora — company policies and customer-specific commitments
captured in customer order PDFs.

Two conflict types this finds:
  - "policy_violation"      — a record does something a policy bans /
                               fails something a policy requires
  - "order_contradiction"   — a record contradicts a commitment recorded
                               in a customer order (price, quantity,
                               delivery date, scope, ...)

This module ships a *single-batch* implementation: policies + orders +
N records go in one LLM call, JSON list of incidents comes out. Suitable
for tens-to-low-hundreds of records per call with Gemini's long context.
For larger queues, batch upstream and concatenate the result lists.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Optional

from .decisions import _parse_decision  # tolerant JSON parse
from .providers import LLMProvider


SYSTEM_PROMPT = """\
You are Qontext-Compliance-LLM, a cross-source incident detector for an
enterprise context base. You receive three corpora:

  POLICIES     - the company's own rules (markdown extracts of policy
                 documents). Anything an employee or system does that
                 contradicts a policy rule is a `policy_violation`.

  ORDERS       - customer-specific commitments from order documents
                 (invoices, purchase orders, shipping orders). Pricing,
                 quantities, delivery dates, included/excluded scope.
                 Anything in the records that contradicts an order is
                 an `order_contradiction`.

  RECORDS      - the surface to scrutinise. Each record has an id, a
                 type (email / conversation / it_ticket / support_chat)
                 and a text body.

For every RECORD, decide whether it surfaces an incident against POLICIES
or ORDERS. Be conservative — flag only when there is *concrete textual
evidence* of a conflict. Do NOT flag generic complaints, neutral status
updates, or matters silent on policy/order subject matter.

When you do flag, you must:
  - quote the exact span of the policy/order that's being conflicted with
  - quote the exact span of the record providing the evidence
  - choose `severity` ∈ {"low", "medium", "high", "critical"} based on
    customer impact, regulatory exposure, and reversibility
  - state `confidence` ∈ [0.0, 1.0] honestly (do NOT inflate)

OUTPUT STRICTLY VALID JSON. Top level is an object with one key:

{
  "incidents": [
    {
      "record_id": "<id of the offending record>",
      "record_type": "email" | "conversation" | "it_ticket" | "support_chat" | "<other>",
      "incident_type": "policy_violation" | "order_contradiction",
      "source_doc": "<policy filename or order id>",
      "source_quote": "<verbatim span from policy/order>",
      "record_quote": "<verbatim span from the record>",
      "rule_summary": "<one sentence: the rule or commitment that was violated>",
      "severity": "low" | "medium" | "high" | "critical",
      "confidence": <float 0.0 - 1.0>,
      "reasoning": "<2-3 sentences linking record_quote to source_quote>"
    }
  ]
}

If no incidents are found, return `{"incidents": []}`. Do NOT invent
records or quote spans that are not literally present in the inputs.
"""


@dataclass
class Incident:
    record_id: str
    record_type: str
    incident_type: str            # "policy_violation" | "order_contradiction"
    source_doc: str
    source_quote: str
    record_quote: str
    rule_summary: str
    severity: str                 # "low" | "medium" | "high" | "critical"
    confidence: float
    reasoning: str
    raw: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "record_id": self.record_id,
            "record_type": self.record_type,
            "incident_type": self.incident_type,
            "source_doc": self.source_doc,
            "source_quote": self.source_quote,
            "record_quote": self.record_quote,
            "rule_summary": self.rule_summary,
            "severity": self.severity,
            "confidence": round(self.confidence, 3),
            "reasoning": self.reasoning,
        }


def _truncate(text: str, max_chars: int) -> str:
    text = text or ""
    return text if len(text) <= max_chars else text[: max_chars - 3] + "..."


def _format_section(title: str, items: list[dict[str, str]]) -> str:
    parts = [f"=== {title} ==="]
    for it in items:
        header = it.get("header") or it.get("id") or ""
        body = it.get("body") or ""
        parts.append(f"--- {header} ---\n{body}")
    return "\n".join(parts)


def find_incidents(
    *,
    policies: list[dict[str, str]],
    orders: list[dict[str, str]],
    records: list[dict[str, str]],
    provider: LLMProvider,
    max_policy_chars: int = 6000,
    max_order_chars: int = 4000,
    max_record_chars: int = 1500,
    timeout: int = 300,
) -> list[Incident]:
    """Run one cross-source scan and return the incidents list.

    Args:
        policies: list of {"header": filename, "body": markdown} dicts
        orders:   list of {"header": order_id, "body": text} dicts
        records:  list of {"id": ..., "type": ..., "body": ...} dicts.
                  `id` and `type` are surfaced to the LLM as `record_id`
                  and `record_type` so quoted incidents reference back to
                  the original row.
        provider: any `LLMProvider` (Gemini recommended for token volume)
        max_*_chars: per-item truncation to keep prompt within the model's
                  context. Defaults sized for low-token flash-class models.
        timeout: per-call LLM timeout in seconds.

    Returns:
        List of `Incident`s. Empty list if no incidents (LLM returned
        `{"incidents": []}`) or on parse failure.
    """
    pol_section = _format_section("POLICIES", [
        {"header": p.get("header", "policy"),
         "body": _truncate(p.get("body", ""), max_policy_chars)}
        for p in policies
    ])
    ord_section = _format_section("ORDERS", [
        {"header": o.get("header", "order"),
         "body": _truncate(o.get("body", ""), max_order_chars)}
        for o in orders
    ])
    rec_section = _format_section("RECORDS", [
        {"header": f"id={r.get('id', '?')}  type={r.get('type', '?')}",
         "body": _truncate(r.get("body", ""), max_record_chars)}
        for r in records
    ])

    user_msg = (
        "Find all incidents in RECORDS that conflict with POLICIES or "
        "ORDERS. Return strict JSON per the system prompt schema.\n\n"
        f"{pol_section}\n\n{ord_section}\n\n{rec_section}"
    )

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_msg},
    ]

    raw = provider.chat(messages, timeout=timeout)
    try:
        parsed = _parse_decision(raw)
    except json.JSONDecodeError:
        return []

    items = parsed.get("incidents") or []
    out: list[Incident] = []
    for it in items:
        try:
            out.append(Incident(
                record_id=str(it.get("record_id", "")),
                record_type=str(it.get("record_type", "")),
                incident_type=str(it.get("incident_type", "")),
                source_doc=str(it.get("source_doc", "")),
                source_quote=str(it.get("source_quote", "")),
                record_quote=str(it.get("record_quote", "")),
                rule_summary=str(it.get("rule_summary", "")),
                severity=str(it.get("severity", "medium")),
                confidence=float(it.get("confidence", 0.0)),
                reasoning=str(it.get("reasoning", "")),
                raw=it,
            ))
        except (TypeError, ValueError):
            continue
    return out
