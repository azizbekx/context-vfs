"""Prompt templates for the entity-match resolver.

Output is strict JSON so the resolver can act on it deterministically.
"""

from __future__ import annotations

import json
from typing import Any


SYSTEM_PROMPT = """\
You are Qontext-Resolver-LLM, the human-judgement layer of an enterprise
entity-resolution pipeline. A rules-based stage has already grouped business
records that share signals (similar name, same address, same representative,
etc.) into a candidate cluster, but every cluster also has at least one
contradiction (typically different identifiers like tax_id) that the rules
layer cannot resolve safely. Your job is to make the call.

Possible decisions for each cluster:

1. "same_entity"   - All members refer to the SAME real-world business that
                     was simply recorded inconsistently across sources
                     (different legal suffix, OCR/typo on identifier,
                     address reformatted, employee turnover, etc.).
2. "different"     - Members are DIFFERENT businesses that happen to share
                     surface signals (very common with surname-style names
                     like "Johnson Group" or "Williams Ltd"; the
                     industries/addresses/contacts often diverge).
3. "uncertain"    - Genuinely insufficient information to decide. Do NOT use
                     this to dodge close calls; only when the evidence is
                     truly balanced and additional data would be needed.

Your reasoning must look at the full record context:
  - business_name (normalised already, but watch for legal-suffix variants)
  - tax_id (different tax_ids strongly suggest DIFFERENT entities, but
    typos / corrected records / regional re-registrations can produce
    different IDs for the same entity)
  - registered_address (real ZIP / city overlap is a strong same-entity
    signal; completely different states is a strong different-entity signal)
  - industry (same industry corroborates same_entity; very different
    industries like "Finance" vs "Agriculture" suggest different entities)
  - business_type (B2B vs Integration Partner vs other)
  - contact_email / phone_number (when present, exact matches are decisive)
  - representative_emp_id (same rep is a moderate same-entity signal)
  - engagement_description / relationship_description (semantic clues)

Confidence calibration (be honest, do not inflate):
  - 0.95 - 1.00  : Multiple independent strong signals all pointing the
                    same direction; you would defend this decision in court.
  - 0.85 - 0.94  : Strong evidence with one minor open question.
  - 0.70 - 0.84  : Likely but not certain; a careful human might disagree.
  - 0.50 - 0.69  : Lean toward your decision but acknowledge real doubt.
  - below 0.50    : Use "uncertain" instead.

The pipeline acts autonomously on decisions whose risk score is below a
configurable threshold (function of confidence x action cost); lower
confidence escalates to a human reviewer with your reasoning attached.

OUTPUT STRICTLY VALID JSON, no prose, no markdown, exactly this schema:

{
  "decision": "same_entity" | "different" | "uncertain",
  "confidence": <float 0.0 - 1.0>,
  "reasoning": "<2-4 sentence explanation citing specific fields you weighed>",
  "key_signals": ["<short bullets of the most decisive signals>"],
  "open_questions": ["<what additional data would change your mind, if any>"]
}
"""


FEW_SHOT_EXAMPLES: list[dict[str, Any]] = [
    {
        "user": {
            "cluster_id": "example-1",
            "rules_score": 0.55,
            "rules_match_reasons": [
                "Exact normalized business_name (Acme Corp)",
                "Same industry (manufacturing)",
            ],
            "rules_review_reason": "tax_id disagrees: 'TX-001' vs 'TX-002'",
            "members": [
                {
                    "id": "Client:11111111-1111-1111-1111-111111111111",
                    "type": "Client",
                    "business_name": "Acme Corporation",
                    "tax_id": "TX-001",
                    "registered_address": "100 Main St, Springfield, IL 62704",
                    "industry": "Manufacturing",
                    "business_type": "B2B",
                    "contact_email": "ops@acme.com",
                    "phone_number": "+1-555-100-2000",
                    "representative_emp_id": "emp_0042",
                },
                {
                    "id": "Vendor:vendor_77",
                    "type": "Vendor",
                    "business_name": "Acme Corp",
                    "tax_id": "TX-002",
                    "registered_address": "100 Main Street, Springfield, IL 62704",
                    "industry": "Industrial Manufacturing",
                    "business_type": "Integration Partner",
                    "management_representative_employee": "emp_0042",
                },
            ],
        },
        "assistant": {
            "decision": "same_entity",
            "confidence": 0.93,
            "reasoning": (
                "Identical address (modulo 'St' vs 'Street'), same ZIP, same "
                "representative employee (emp_0042), same industry family, and "
                "name only differs by legal-suffix abbreviation. The tax_id "
                "delta is consistent with one source recording the holding-co "
                "ID and the other a subsidiary registration."
            ),
            "key_signals": [
                "Identical address + ZIP",
                "Same representative employee",
                "Industry alignment (Manufacturing / Industrial Manufacturing)",
                "Name differs only by legal suffix",
            ],
            "open_questions": [],
        },
    },
    {
        "user": {
            "cluster_id": "example-2",
            "rules_score": 0.55,
            "rules_match_reasons": ["Exact normalized business_name (Williams Group)"],
            "rules_review_reason": "tax_id disagrees: 'AA111' vs 'BB222'",
            "members": [
                {
                    "id": "Client:aaaa",
                    "type": "Client",
                    "business_name": "Williams Group",
                    "tax_id": "AA111",
                    "registered_address": "1 Oak Ave, Boston, MA 02108",
                    "industry": "Technology",
                    "business_type": "B2B",
                },
                {
                    "id": "Vendor:vendor_50",
                    "type": "Vendor",
                    "business_name": "Williams Group",
                    "tax_id": "BB222",
                    "registered_address": "8800 Sunset Blvd, Los Angeles, CA 90069",
                    "industry": "E-commerce",
                    "business_type": "Integration Partner",
                },
            ],
        },
        "assistant": {
            "decision": "different",
            "confidence": 0.91,
            "reasoning": (
                "Same surname-style business_name is the only common signal. "
                "Addresses are on opposite coasts (MA vs CA), industries are "
                "distinct (Technology vs E-commerce), and tax_ids are unrelated. "
                "'Williams Group' is a generic name that appears for many "
                "unrelated firms; without corroborating signals, treating these "
                "as the same entity would create a wrong merge."
            ),
            "key_signals": [
                "Cross-country address mismatch",
                "Distinct industries",
                "No shared identifiers beyond a common surname",
            ],
            "open_questions": [],
        },
    },
    {
        "user": {
            "cluster_id": "example-3",
            "rules_score": 0.55,
            "rules_match_reasons": [
                "Exact normalized business_name (Sterling Holdings)",
                "Same industry (finance)",
            ],
            "rules_review_reason": "tax_id disagrees: 'EU-9912' vs 'US-7740'",
            "members": [
                {
                    "id": "Client:sample-c-3a",
                    "type": "Client",
                    "business_name": "Sterling Holdings",
                    "tax_id": "EU-9912",
                    "registered_address": "78 Cornhill, London EC3V 3QQ, UK",
                    "industry": "Finance",
                    "business_type": "B2B",
                },
                {
                    "id": "Vendor:sample-v-3b",
                    "type": "Vendor",
                    "business_name": "Sterling Holdings",
                    "tax_id": "US-7740",
                    "registered_address": "PO Box 18420, Wilmington, DE 19850",
                    "industry": "Finance",
                    "business_type": "Integration Partner",
                },
            ],
        },
        "assistant": {
            "decision": "uncertain",
            "confidence": 0.55,
            "reasoning": (
                "Identical business_name and industry suggest a possible single "
                "entity with subsidiaries in EU and US (consistent with the "
                "different tax_ids and addresses on different continents). But "
                "the same name combined with finance is also common, and a US "
                "Delaware PO Box is the kind of entity-formation address that "
                "many shell entities share. Without contact, phone, or a shared "
                "representative employee to triangulate, this could be either."
            ),
            "key_signals": [
                "Identical name + industry",
                "Cross-jurisdiction tax_ids (EU vs US) consistent with subsidiary",
                "DE PO Box is a generic registered-agent address (shell-friendly)",
            ],
            "open_questions": [
                "Does any other source list a shared parent or contact?",
                "Are the engagement_description / relationship_description fields "
                "compatible with one global entity or do they describe distinct businesses?",
            ],
        },
    },
]


def render_user_prompt(cluster: dict[str, Any]) -> str:
    """Build the user-message JSON payload for one cluster."""
    return (
        "Resolve the following candidate entity cluster. Return only the JSON "
        "object specified in the system prompt.\n\n"
        "CLUSTER:\n"
        + json.dumps(cluster, indent=2, default=str)
    )


def render_few_shot_messages() -> list[dict[str, str]]:
    """Render the few-shot examples as alternating user/assistant chat turns."""
    out: list[dict[str, str]] = []
    for ex in FEW_SHOT_EXAMPLES:
        out.append({"role": "user", "content": render_user_prompt(ex["user"])})
        out.append({
            "role": "assistant",
            "content": json.dumps(ex["assistant"], indent=2),
        })
    return out


def build_chat_messages(cluster: dict[str, Any]) -> list[dict[str, str]]:
    """Build the full chat-completion message list: system + few-shot + cluster.

    The result is provider-neutral: each provider implementation translates
    these `{role, content}` dicts into its own native chat format.
    """
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages.extend(render_few_shot_messages())
    messages.append({"role": "user", "content": render_user_prompt(cluster)})
    return messages
