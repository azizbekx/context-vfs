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
                 documents).

  ORDERS       - customer-specific commitments from order documents
                 (invoices, purchase orders, shipping orders). Pricing,
                 quantities, delivery dates, included/excluded scope.

  RECORDS      - the surface to scrutinise. Each record has an id, a
                 type (email / conversation / it_ticket / support_chat),
                 optional metadata such as `thread_id` linking it to
                 other records in this batch, and a text body.

You flag four kinds of incident:

  1. `policy_violation`        - a record does or claims something that
                                  contradicts a POLICY rule.

  2. `order_contradiction`     - a record contradicts a commitment in an
                                  ORDER (price quoted differently, status
                                  inconsistent with shipping, etc.).

  3. `internal_inconsistency`  - a single record contradicts itself
                                  (e.g. subject says "shipped", body
                                  says "still pending"; resolution
                                  contradicts the issue description).

  4. `cross_record_conflict`   - two RECORDS in this batch (typically
                                  sharing a thread_id, conversation_id,
                                  or referenced customer) make
                                  contradictory factual claims about
                                  the same subject. Use the
                                  `record_id` field for the primary
                                  record and put the conflicting
                                  partner's id in `related_record_id`.

Be conservative - flag only when there is *concrete textual evidence*
of a conflict between two specific spans of text. Quote the exact spans
you're relying on; do not invent text.

EXPLICIT NON-INCIDENTS (do NOT flag any of the following):

  - **Differences in data size or detail level.** A short ticket and a
    long email about the same issue are NOT in conflict. A summary in
    one record and full line items in another are NOT in conflict.
    Missing fields, omitted attachments, or terser language are not
    contradictions; they are merely less detail.

  - **Silence on a topic.** A record that does not mention a policy
    rule or order commitment at all is NOT a violation of it. Only
    flag when a record makes an active, concrete claim that
    contradicts the policy/order/partner record.

  - **Temporal updates.** A later record reporting a state change
    (e.g. "in progress" -> "resolved", "pending" -> "shipped") is NOT
    a contradiction with the earlier record; it is a normal lifecycle
    update.

  - **Different aspects of the same entity.** Records discussing
    different facets (one mentions price, another mentions shipping
    date) are NOT in conflict unless they make incompatible claims
    about the *same* facet.

  - **Approximate vs. precise wording.** "around $400" and "$420.50"
    are not in conflict unless the rounding is genuinely incompatible.
    Same for vague vs specific dates ("next week" vs "March 5").

When you flag, you must:
  - quote the exact span you are conflicting with (`source_quote`).
    For policy/order incidents, this is from POLICIES or ORDERS. For
    `internal_inconsistency`, it is the *first* contradicting span
    inside the same record. For `cross_record_conflict`, it is the
    contradicting span from the partner record.
  - quote the exact span of the (primary) record (`record_quote`).
  - choose `severity` ∈ {"low", "medium", "high", "critical"} based on
    customer impact, regulatory exposure, and reversibility.
  - state `confidence` ∈ [0.0, 1.0] honestly (do NOT inflate).

OUTPUT STRICTLY VALID JSON. Top level is an object with one key:

{
  "incidents": [
    {
      "record_id": "<id of the offending (primary) record>",
      "record_type": "email" | "conversation" | "it_ticket" | "support_chat" | "<other>",
      "incident_type": "policy_violation" | "order_contradiction" | "internal_inconsistency" | "cross_record_conflict",
      "source_doc": "<policy filename / order id / record_id of the partner record / 'self' for internal_inconsistency>",
      "source_quote": "<verbatim span from policy/order/partner-record/same-record>",
      "record_quote": "<verbatim span from the (primary) record>",
      "related_record_id": "<id of the partner record, only for cross_record_conflict; null otherwise>",
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
    incident_type: str            # see SYSTEM_PROMPT for the four valid values
    source_doc: str
    source_quote: str
    record_quote: str
    rule_summary: str
    severity: str                 # "low" | "medium" | "high" | "critical"
    confidence: float
    reasoning: str
    related_record_id: Optional[str] = None  # set on cross_record_conflict
    raw: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "record_id": self.record_id,
            "record_type": self.record_type,
            "incident_type": self.incident_type,
            "source_doc": self.source_doc,
            "source_quote": self.source_quote,
            "record_quote": self.record_quote,
            "related_record_id": self.related_record_id,
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
    rec_items = []
    for r in records:
        meta = r.get("meta") or {}
        meta_bits = "  ".join(f"{k}={v}" for k, v in meta.items() if v not in (None, ""))
        header = f"id={r.get('id', '?')}  type={r.get('type', '?')}"
        if meta_bits:
            header += "  " + meta_bits
        rec_items.append({
            "header": header,
            "body": _truncate(r.get("body", ""), max_record_chars),
        })
    rec_section = _format_section("RECORDS", rec_items)

    user_msg = (
        "Find all incidents in RECORDS. Look for: policy_violation, "
        "order_contradiction, internal_inconsistency, and "
        "cross_record_conflict (use `thread_id` / `conversation_id` / "
        "`customer_id` in record headers to spot related records). "
        "Return strict JSON per the system prompt schema.\n\n"
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
            related = it.get("related_record_id")
            out.append(Incident(
                record_id=str(it.get("record_id", "")),
                record_type=str(it.get("record_type", "")),
                incident_type=str(it.get("incident_type", "")),
                source_doc=str(it.get("source_doc", "")),
                source_quote=str(it.get("source_quote", "")),
                record_quote=str(it.get("record_quote", "")),
                related_record_id=str(related) if related else None,
                rule_summary=str(it.get("rule_summary", "")),
                severity=str(it.get("severity", "medium")),
                confidence=float(it.get("confidence", 0.0)),
                reasoning=str(it.get("reasoning", "")),
                raw=it,
            ))
        except (TypeError, ValueError):
            continue
    return out
