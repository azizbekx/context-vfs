"""Find cross-source incidents: text records that violate company policies
or contradict customer order commitments.

Reads three corpora directly from disk (no DB dependency, so this works
the moment the dataset is unpacked, before ingestion is complete):

  POLICIES   - Policy markdown files (Policy_Documents_md/*.md, minus
               anything starting with `invoice_` / `purchase_` /
               `shipping_` — those are order docs, not policies).

  ORDERS     - Customer order markdown files. By default the same
               directory as policies, filtered to filenames starting
               with `invoice_` / `purchase_` / `shipping_`. Override
               with --orders-dir.

  RECORDS    - One of:
                 emails         (Enterprise_mail_system/emails.json)
                 conversations  (Collaboration_tools/conversations.json)
                 tickets        (IT_Service_Management/it_tickets.json)

Output: incidents.json — list of {record_id, record_type, incident_type,
source_doc, source_quote, record_quote, rule_summary, severity,
confidence, reasoning}.

Usage:
    export GEMINI_API_KEY=...
    python examples/find_incidents.py \\
        --data-dir EnterpriseBench-data \\
        --records tickets --max-records 50 \\
        --out incidents.json
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


# Source descriptor: relative path under --data-dir, id field, body builder.
# `body` may be a string field name or a callable that takes the record dict.
RECORD_SOURCES: dict[str, dict] = {
    "emails": {
        "path": "Enterprise_mail_system/emails.json",
        "id_field": "email_id",
        "body": lambda r: f"Subject: {r.get('subject', '')}\n\n{r.get('body', '')}",
    },
    "conversations": {
        "path": "Collaboration_tools/conversations.json",
        "id_field": "conversation_id",
        "body": "text",
    },
    "tickets": {
        "path": "IT_Service_Management/it_tickets.json",
        "id_field": "id",
        "body": lambda r: f"Issue: {r.get('Issue', '')}\n\nResolution: {r.get('Resolution', '')}",
    },
}

ORDER_PREFIXES = ("invoice_", "purchase_", "shipping_")


def _is_policy_file(name: str) -> bool:
    n = name.lower()
    return n.endswith(".md") and not any(n.startswith(p) for p in ORDER_PREFIXES)


def _is_order_file(name: str) -> bool:
    n = name.lower()
    return n.endswith(".md") and any(n.startswith(p) for p in ORDER_PREFIXES)


def _read_md_files(directory: Path, predicate, limit: int | None) -> list[dict[str, str]]:
    if not directory.exists():
        return []
    files = sorted(p for p in directory.iterdir() if predicate(p.name))
    if limit:
        files = files[:limit]
    out: list[dict[str, str]] = []
    for p in files:
        try:
            out.append({"header": p.name, "body": p.read_text(encoding="utf-8")})
        except OSError:
            continue
    return out


def _load_records(data_dir: Path, source: str, max_records: int) -> list[dict[str, str]]:
    descriptor = RECORD_SOURCES[source]
    src_path = data_dir / descriptor["path"]
    if not src_path.exists():
        raise SystemExit(f"Record source not found: {src_path}")

    with src_path.open("r", encoding="utf-8") as f:
        raw = json.load(f)

    if isinstance(raw, dict):
        # Some HF dumps wrap the array under a single key
        for v in raw.values():
            if isinstance(v, list):
                raw = v
                break

    body_spec = descriptor["body"]
    id_field = descriptor["id_field"]

    out: list[dict[str, str]] = []
    for r in raw[:max_records]:
        body = body_spec(r) if callable(body_spec) else r.get(body_spec, "")
        body = (body or "").strip()
        if len(body) < 30:
            continue
        out.append({
            "id": str(r.get(id_field, "")),
            "type": source,
            "body": body,
        })
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", required=True,
                        help="Path to the EnterpriseBench dataset root")
    parser.add_argument("--policies-dir", default=None,
                        help="Defaults to <data-dir>/Policy_Documents_md")
    parser.add_argument("--orders-dir", default=None,
                        help="Defaults to <data-dir>/Policy_Documents_md "
                             "(filtered to invoice_/purchase_/shipping_ prefix)")
    parser.add_argument("--records", default="tickets",
                        choices=sorted(RECORD_SOURCES.keys()),
                        help="Which records source to scan (default: tickets)")
    parser.add_argument("--max-records", type=int, default=50)
    parser.add_argument("--max-policies", type=int, default=None)
    parser.add_argument("--max-orders", type=int, default=None)
    parser.add_argument("--provider", choices=["gemini", "ollama"], default="gemini")
    parser.add_argument("--model", default=None)
    parser.add_argument("--out", default="incidents.json")
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    if not data_dir.exists():
        raise SystemExit(f"--data-dir does not exist: {data_dir}")

    pol_dir = Path(args.policies_dir) if args.policies_dir else data_dir / "Policy_Documents_md"
    ord_dir = Path(args.orders_dir) if args.orders_dir else pol_dir

    if args.provider == "gemini":
        provider = GeminiProvider(model=args.model or "gemini-3.1-flash-lite-preview")
    else:
        provider = OllamaProvider(model=args.model or "llama3.2:3b")

    policies = _read_md_files(pol_dir, _is_policy_file, args.max_policies)
    orders = _read_md_files(ord_dir, _is_order_file, args.max_orders)
    records = _load_records(data_dir, args.records, args.max_records)

    if not policies:
        raise SystemExit(f"No policy files found in {pol_dir}")
    if not records:
        raise SystemExit(f"No '{args.records}' records found")

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
