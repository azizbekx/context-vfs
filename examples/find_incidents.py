"""Find cross-source incidents: text records that violate company policies
or contradict customer order commitments.

Sources scanned in one batched LLM call:
  - POLICIES   (markdown files, e.g. EnterpriseBench-data/Policy_Documents_md/*.md)
  - ORDERS     (markdown / text files, e.g. extracted invoice or PO PDFs)
  - RECORDS    (rows from the SQLite store: emails, conversations, IT tickets,
                customer support chats — anything with a text body)

Output: incidents.json — list of {record_id, record_type, incident_type,
source_doc, source_quote, record_quote, rule_summary, severity,
confidence, reasoning}.

Usage:
    export GEMINI_API_KEY=...
    python examples/find_incidents.py \
        --policies-dir "EnterpriseBench-data/Policy_Documents_md" \
        --orders-dir  "EnterpriseBench-data/Orders_md" \
        --records support_chats --max-records 30 \
        --out incidents.json

Default record source is `support_chats` because that's what's already in
the SQLite store today; once email / conversation / ticket bodies are
ingested, pass `--records emails` etc.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from context_base.conflict_resolver import (  # noqa: E402
    GeminiProvider,
    OllamaProvider,
    find_incidents,
)
from context_base.storage import Storage  # noqa: E402


# Per-source SQL — pulls records with a textual body. Adapt as you ingest
# emails / conversations / tickets. Each query must yield (id, body).
RECORD_QUERIES: dict[str, str] = {
    "support_chats": (
        "SELECT f.subject_id AS id, f.value AS body FROM facts f "
        "WHERE f.predicate = 'text' "
        "AND f.subject_id LIKE 'support_chat:%' "
        "AND f.value IS NOT NULL "
        "AND length(f.value) > 30 "
        "ORDER BY f.id LIMIT ?"
    ),
    "tickets": (
        "SELECT f.subject_id AS id, f.value AS body FROM facts f "
        "WHERE f.predicate IN ('description', 'text', 'summary') "
        "AND f.subject_id LIKE 'ticket:%' "
        "AND f.value IS NOT NULL "
        "AND length(f.value) > 30 "
        "ORDER BY f.id LIMIT ?"
    ),
    "emails": (
        "SELECT f.subject_id AS id, f.value AS body FROM facts f "
        "WHERE f.predicate IN ('body', 'text', 'content') "
        "AND f.subject_id LIKE 'email:%' "
        "AND f.value IS NOT NULL "
        "AND length(f.value) > 30 "
        "ORDER BY f.id LIMIT ?"
    ),
    "conversations": (
        "SELECT f.subject_id AS id, f.value AS body FROM facts f "
        "WHERE f.predicate IN ('text', 'content', 'transcript') "
        "AND f.subject_id LIKE 'conversation:%' "
        "AND f.value IS NOT NULL "
        "AND length(f.value) > 30 "
        "ORDER BY f.id LIMIT ?"
    ),
}


def _read_dir_md(path: Path, limit: int | None = None) -> list[dict[str, str]]:
    if not path.exists():
        return []
    files = sorted(p for p in path.iterdir() if p.suffix.lower() in {".md", ".txt"})
    if limit:
        files = files[:limit]
    out: list[dict[str, str]] = []
    for p in files:
        try:
            out.append({"header": p.name, "body": p.read_text(encoding="utf-8")})
        except OSError:
            continue
    return out


def _load_records(store: Storage, source: str, max_records: int) -> list[dict[str, str]]:
    if source not in RECORD_QUERIES:
        raise SystemExit(
            f"Unknown --records source '{source}'. Known: {sorted(RECORD_QUERIES)}"
        )
    rows = store.rows(RECORD_QUERIES[source], (max_records,))
    return [
        {"id": str(r["id"]), "type": source, "body": r["body"] or ""}
        for r in rows
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policies-dir", required=True,
                        help="Directory with policy markdown files")
    parser.add_argument("--orders-dir", default=None,
                        help="Directory with customer order markdown / text files")
    parser.add_argument("--records", default="support_chats",
                        choices=sorted(RECORD_QUERIES.keys()),
                        help="Which SQLite source to scan (default: support_chats)")
    parser.add_argument("--max-records", type=int, default=30)
    parser.add_argument("--max-policies", type=int, default=None,
                        help="Cap policies (long context still has limits)")
    parser.add_argument("--max-orders", type=int, default=None)
    parser.add_argument("--db", default="context_base.db")
    parser.add_argument("--provider", choices=["gemini", "ollama"], default="gemini")
    parser.add_argument("--model", default=None)
    parser.add_argument("--out", default="incidents.json")
    args = parser.parse_args()

    if args.provider == "gemini":
        provider = GeminiProvider(model=args.model or "gemini-3.1-flash-lite-preview")
    else:
        provider = OllamaProvider(model=args.model or "llama3.2:3b")

    policies = _read_dir_md(Path(args.policies_dir), limit=args.max_policies)
    if not policies:
        raise SystemExit(f"No policy files found in {args.policies_dir}")

    orders: list[dict[str, str]] = []
    if args.orders_dir:
        orders = _read_dir_md(Path(args.orders_dir), limit=args.max_orders)

    store = Storage(Path(args.db))
    records = _load_records(store, args.records, args.max_records)
    if not records:
        raise SystemExit(
            f"No records found for source '{args.records}'. Has that source been "
            f"ingested into {args.db}?"
        )

    print(
        f"Scanning {len(records)} {args.records} record(s) against "
        f"{len(policies)} polic(ies) and {len(orders)} order doc(s) "
        f"via {provider.name}..."
    )

    incidents = find_incidents(
        policies=policies,
        orders=orders,
        records=records,
        provider=provider,
    )

    payload = {
        "scanned": {
            "policies": len(policies),
            "orders": len(orders),
            "records": len(records),
            "record_source": args.records,
        },
        "model": provider.name,
        "incidents": [i.as_dict() for i in incidents],
    }
    Path(args.out).write_text(
        json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8",
    )

    print()
    print(f"Found {len(incidents)} incident(s) -> {args.out}")
    if incidents:
        # Sort by severity then confidence so the worst float to the top
        sev_rank = {"critical": 4, "high": 3, "medium": 2, "low": 1}
        ranked = sorted(
            incidents,
            key=lambda i: (sev_rank.get(i.severity, 0), i.confidence),
            reverse=True,
        )
        print()
        print("Top incidents:")
        for i in ranked[:5]:
            print(
                f"  [{i.severity:>8}] conf={i.confidence:.2f} "
                f"{i.incident_type} on {i.record_type} {i.record_id}"
            )
            print(f"             rule: {i.rule_summary}")
            print(f"             src : {i.source_doc}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
