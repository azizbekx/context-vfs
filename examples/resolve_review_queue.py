"""Resolve open `identity_mismatch` review_items with the LLM resolver.

This is a *read-only* example by default — it pulls the open queue, asks
Gemini to adjudicate each one, and prints the verdicts. Pass `--apply` to
write `resolution` JSON back via `Storage.resolve_review`.

Usage:
    GEMINI_API_KEY=... python examples/resolve_review_queue.py
    GEMINI_API_KEY=... python examples/resolve_review_queue.py --apply
    python examples/resolve_review_queue.py --provider ollama \
        --model llama3.2:3b --max 5
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Allow running this script from the repo root without installing the package.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from context_base.conflict_resolver import (  # noqa: E402
    ClusterPayload,
    GeminiProvider,
    Member,
    OllamaProvider,
    resolve_cluster,
)
from context_base.storage import Storage  # noqa: E402


def _members_from_candidates(entity_id: str, candidates: list[dict]) -> list[Member]:
    """Map a review_items.candidates_json entry to resolver `Member`s.

    For `identity_mismatch` reviews each candidate carries `value`, `source`,
    `confidence`, `fact_id`. We synthesise an entity-style Member with the
    candidate's source as the id so the LLM can reason over both sides.
    """
    members: list[Member] = []
    for c in candidates:
        members.append(
            Member(
                id=f"{entity_id}@{c.get('source', c.get('choice_id'))}",
                type="Employee",  # identity_mismatch is HR vs résumé in this repo
                properties={
                    "value": c.get("value"),
                    "source": c.get("source"),
                    "confidence": c.get("confidence"),
                    "fact_id": c.get("fact_id"),
                },
            )
        )
    return members


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default="context_base.db",
                        help="Path to the SQLite store (default: context_base.db)")
    parser.add_argument("--provider", choices=["gemini", "ollama"], default="gemini")
    parser.add_argument("--model", default=None,
                        help="Override the default model for the chosen provider")
    parser.add_argument("--max", type=int, default=None,
                        help="Cap the number of reviews processed")
    parser.add_argument("--conflict-type", default="identity_mismatch",
                        help="Which conflict_type to pull (default: identity_mismatch)")
    parser.add_argument("--risk-threshold", type=float, default=5.0)
    parser.add_argument("--apply", action="store_true",
                        help="Write the LLM verdict back to the DB. Default is dry-run.")
    args = parser.parse_args()

    if args.provider == "gemini":
        provider = GeminiProvider(model=args.model or "gemini-3.1-flash-lite-preview")
    else:
        provider = OllamaProvider(model=args.model or "llama3.2:3b")

    store = Storage(Path(args.db))
    rows = list(store.rows(
        "SELECT id, entity_id, conflict_type, candidates_json "
        "FROM review_items WHERE status = 'open' AND conflict_type = ? "
        "ORDER BY created_at",
        (args.conflict_type,),
    ))
    if args.max:
        rows = rows[: args.max]

    print(f"Loaded {len(rows)} open `{args.conflict_type}` review(s)")
    if not rows:
        return 0

    auto, escalate, errors = 0, 0, 0
    for i, row in enumerate(rows, start=1):
        candidates = json.loads(row["candidates_json"])
        cluster = ClusterPayload(
            cluster_id=row["id"],
            members=_members_from_candidates(row["entity_id"], candidates),
            rules_review_reason=f"{args.conflict_type} on entity {row['entity_id']}",
        )
        try:
            decision = resolve_cluster(
                cluster, provider=provider, risk_threshold=args.risk_threshold,
            )
        except Exception as exc:
            errors += 1
            print(f"  [{i}/{len(rows)}] ERROR: {exc}")
            continue

        risk = decision.risk
        recommended = risk.recommended if risk else "?"
        action = risk.action if risk else "?"
        if recommended == "auto_act":
            auto += 1
        else:
            escalate += 1

        print(
            f"  [{i}/{len(rows)}] {decision.decision} conf={decision.confidence:.2f} "
            f"action={action} recommended={recommended} ({decision.elapsed_s}s)"
        )
        print(f"        {decision.reasoning[:200]}")

        if args.apply and recommended == "auto_act" and decision.decision == "same_entity":
            # Pick the higher-confidence candidate as the surviving fact.
            chosen = max(candidates, key=lambda c: c.get("confidence", 0))
            store.resolve_review(row["id"], chosen["choice_id"])
            print(f"        applied: choice_id={chosen['choice_id']}")

    print()
    print(f"Summary: {auto} auto, {escalate} escalate, {errors} errors")
    if not args.apply:
        print("(Dry run — pass --apply to write resolutions back to the DB.)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
