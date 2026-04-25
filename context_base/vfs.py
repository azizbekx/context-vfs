from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path
from typing import Any

from .storage import Store
from .utils import clean_text, markdown_escape, now_iso, stable_hash


RENDERED_TYPES = {
    "employee",
    "customer",
    "conversation",
    "email_thread",
    "product",
    "sale",
    "sentiment",
    "social_post",
    "support_chat",
    "ticket",
    "policy",
    "client",
    "vendor",
    "repo",
    "process",
    "project",
    "task",
    "work_item",
    "overflow",
}


class VFSGenerator:
    def __init__(self, store: Store, out_dir: Path):
        self.store = store
        self.out_dir = out_dir
        self.vfs_root = out_dir / "vfs"

    def generate(self) -> int:
        self.vfs_root.mkdir(parents=True, exist_ok=True)
        self._generated_paths: set[str] = set()
        count = 0
        for row in self.store.rows(
            "SELECT * FROM entities WHERE path IS NOT NULL AND type IN (%s) ORDER BY type, name"
            % ",".join("?" for _ in RENDERED_TYPES),
            tuple(sorted(RENDERED_TYPES)),
        ):
            content = self.render_entity(dict(row))
            self.write_file(row["path"], content, row["id"])
            count += 1
        count += self.generate_reviews()
        count += self.generate_index_pages()
        count += self.generate_source_coverage()
        self.prune_stale_files()
        self.store.rebuild_search_index()
        self.store.commit()
        return count

    def write_file(self, relative_path: str, content: str, entity_id: str | None) -> None:
        self._generated_paths.add(relative_path)
        target = self.vfs_root / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        existing = target.read_text(encoding="utf-8") if target.exists() else None
        if existing != content:
            target.write_text(content, encoding="utf-8")
        self.store.upsert_vfs_file(relative_path, entity_id, content)

    def prune_stale_files(self) -> None:
        generated = getattr(self, "_generated_paths", set())
        root = self.vfs_root.resolve()
        known_paths = {row["path"] for row in self.store.rows("SELECT path FROM vfs_files")}
        disk_paths = {
            path.relative_to(self.vfs_root).as_posix()
            for path in self.vfs_root.rglob("*.md")
        }
        for relative_path in sorted((known_paths | disk_paths) - generated):
            target = (self.vfs_root / relative_path).resolve()
            if root in target.parents and target.exists() and target.is_file():
                target.unlink()
            self.store.conn.execute("DELETE FROM vfs_files WHERE path = ?", (relative_path,))

    def render_entity(self, entity: dict[str, Any]) -> str:
        facts = self.store.rows(
            """
            SELECT f.*, s.dataset_path, s.record_id, s.raw_ref
            FROM facts f
            JOIN source_records s ON s.id = f.source_id
            WHERE f.subject_id = ?
              AND f.status IN ('generated', 'confirmed')
            ORDER BY f.predicate, f.confidence DESC
            LIMIT 160
            """,
            (entity["id"],),
        )
        outgoing = self.store.rows(
            """
            SELECT edge.relation, target.id AS target_id, target.name, target.path, edge.source_fact_id
            FROM edges edge
            JOIN entities target ON target.id = edge.to_entity_id
            JOIN facts e ON e.id = edge.source_fact_id
            WHERE edge.from_entity_id = ?
              AND e.status IN ('generated', 'confirmed')
            ORDER BY edge.relation, target.name
            LIMIT 80
            """,
            (entity["id"],),
        )
        incoming = self.store.rows(
            """
            SELECT edge.relation, source.id AS source_id, source.name, source.path, edge.source_fact_id
            FROM edges edge
            JOIN entities source ON source.id = edge.from_entity_id
            JOIN facts e ON e.id = edge.source_fact_id
            WHERE edge.to_entity_id = ?
              AND e.status IN ('generated', 'confirmed')
            ORDER BY edge.relation, source.name
            LIMIT 80
            """,
            (entity["id"],),
        )
        source_rows = self.store.rows(
            """
            SELECT DISTINCT s.dataset_path, s.record_id, s.raw_ref
            FROM facts f
            JOIN source_records s ON s.id = f.source_id
            WHERE f.subject_id = ?
              AND f.status IN ('generated', 'confirmed')
            ORDER BY s.dataset_path, s.record_id
            LIMIT 80
            """,
            (entity["id"],),
        )
        related_paths = self._related_paths(outgoing, incoming)
        confidence = float(entity["confidence"] or 1.0)
        lines = [
            "---",
            f"id: {entity['id']}",
            f"type: {entity['type']}",
            f"generated_at: {now_iso()}",
            f"confidence: {confidence:.2f}",
            "---",
            "",
            f"# {entity['name']}",
            "",
            "## Summary",
            "",
            entity["summary"] or self._summary_from_facts(entity, facts),
            "",
            "## Facts",
            "",
            "| Fact | Value | Source | Confidence | Status | Method | Updated | Fact ID |",
            "|---|---|---|---|---|---|---|---|",
        ]
        for fact in facts:
            value = fact["value"]
            if fact["object_entity_id"]:
                target = self.store.row(
                    "SELECT name, path FROM entities WHERE id = ?",
                    (fact["object_entity_id"],),
                )
                value = self._link(target["path"], target["name"]) if target else fact["object_entity_id"]
            lines.append(
                "| %s | %s | `%s#%s` | %.2f |"
                " %s | %s | %s | `%s` |"
                % (
                    markdown_escape(fact["predicate"]),
                    markdown_escape(value),
                    markdown_escape(fact["dataset_path"]),
                    markdown_escape(fact["record_id"]),
                    float(fact["confidence"] or 0),
                    markdown_escape(fact["status"]),
                    markdown_escape(fact["extraction_method"]),
                    markdown_escape(fact["updated_at"]),
                    markdown_escape(fact["id"]),
                )
            )
        if not facts:
            lines.append("| No generated facts yet |  |  |  |  |  |  |  |")
        lines.extend(["", "## Relationships", ""])
        rel_lines = []
        for edge in outgoing:
            rel_lines.append(
                f"- {edge['relation']}: {self._link(edge['path'], edge['name'])}"
            )
        for edge in incoming:
            rel_lines.append(
                f"- referenced by {edge['relation']}: {self._link(edge['path'], edge['name'])}"
            )
        lines.extend(rel_lines or ["- No graph relationships yet."])
        lines.extend(["", "## Related Files", ""])
        lines.extend([f"- [[{path}]]" for path in related_paths] or ["- No related files yet."])
        lines.extend(["", "## Provenance", ""])
        for source in source_rows:
            lines.append(f"- `{source['dataset_path']}#{source['record_id']}`")
        if not source_rows:
            lines.append("- No source records linked yet.")
        lines.append("")
        return "\n".join(lines)

    def generate_reviews(self) -> int:
        count = 0
        review_rows = self.store.rows(
            "SELECT * FROM review_items WHERE status = 'open' ORDER BY created_at"
        )
        for review in self.store.rows(
            "SELECT * FROM review_items WHERE status = 'open' ORDER BY created_at"
        ):
            content = self.render_review(dict(review))
            path = f"company/reviews/conflicts/{review['id'].replace(':', '-')}.md"
            self.write_file(path, content, review["entity_id"])
            count += 1
        if review_rows:
            self.write_file("company/reviews/_index.md", self.render_review_index(review_rows), None)
            count += 1
        return count

    def render_review_index(self, reviews: list[Any]) -> str:
        lines = [
            "---",
            "id: review:index",
            "type: index",
            f"generated_at: {now_iso()}",
            "---",
            "",
            "# Open Reviews",
            "",
            f"{len(reviews)} unresolved review items.",
            "",
            "| Review | Entity | Type |",
            "|---|---|---|",
        ]
        for review in reviews[:1000]:
            entity = self.store.row(
                "SELECT name, path FROM entities WHERE id = ?",
                (review["entity_id"],),
            )
            review_path = f"company/reviews/conflicts/{review['id'].replace(':', '-')}.md"
            entity_label = (
                self._link(entity["path"], entity["name"])
                if entity
                else markdown_escape(review["entity_id"])
            )
            lines.append(
                "| [[%s\\|%s]] | %s | %s |"
                % (
                    review_path,
                    markdown_escape(review["predicate"]),
                    entity_label,
                    markdown_escape(review["conflict_type"]),
                )
            )
        lines.append("")
        return "\n".join(lines)

    def render_review(self, review: dict[str, Any]) -> str:
        entity = self.store.row("SELECT * FROM entities WHERE id = ?", (review["entity_id"],))
        candidates = json.loads(review["candidates_json"])
        lines = [
            "---",
            f"id: {review['id']}",
            "type: review",
            f"status: {review['status']}",
            f"entity_id: {review['entity_id']}",
            "---",
            "",
            f"# Conflict: {review['predicate']}",
            "",
            f"Entity: {self._link(entity['path'], entity['name']) if entity else review['entity_id']}",
            "",
            "## Candidates",
            "",
            "| Choice | Value | Source | Confidence |",
            "|---|---|---|---|",
        ]
        for candidate in candidates:
            lines.append(
                "| `%s` | %s | `%s` | %.2f |"
                % (
                    candidate["choice_id"],
                    markdown_escape(candidate.get("value")),
                    markdown_escape(candidate.get("source")),
                    float(candidate.get("confidence") or 0),
                )
            )
        lines.extend(
            [
                "",
                "## Suggested Resolution",
                "",
                review["suggested_resolution"] or "Review and choose the correct candidate.",
                "",
                "Resolve with:",
                "",
                f"`python3 context_base.py resolve-review {review['id']} --choice <choice-id>`",
                "",
            ]
        )
        return "\n".join(lines)

    def generate_index_pages(self) -> int:
        count = 0

        company_lines = [
            "---",
            "id: company:index",
            "type: index",
            f"generated_at: {now_iso()}",
            "---",
            "",
            "# Company Context Base",
            "",
            "Structured company memory generated from internal data sources.",
            "",
        ]

        type_config = [
            ("employee", "company/employees", "Employees", "employee"),
            ("customer", "company/customers", "Customers", "customer"),
            ("product", "company/products", "Products", "product"),
            ("sale", "company/sales", "Sales", "sale"),
            ("sentiment", "company/sentiment", "Product Sentiment", "sentiment"),
            ("support_chat", "company/support-chats", "Support Chats", "support_chat"),
            ("email_thread", "company/email-threads", "Email Threads", "email_thread"),
            ("conversation", "company/conversations", "Conversations", "conversation"),
            ("social_post", "company/posts", "Social Posts", "social_post"),
            ("policy", "company/policies", "Policies", "policy"),
            ("ticket", "company/tickets", "IT Tickets", "ticket"),
            ("client", "company/clients", "Business Clients", "client"),
            ("vendor", "company/vendors", "Vendors", "vendor"),
            ("repo", "company/repos", "Repositories", "repo"),
            ("process", "company/processes", "Processes & SOPs", "process"),
            ("project", "company/projects", "Projects", "project"),
            ("task", "company/tasks", "Tasks", "task"),
            ("work_item", "company/work-items", "Work Items", "work_item"),
            ("overflow", "company/overflow", "Overflow Data", "overflow"),
        ]

        for entity_type, folder, label, _prefix in type_config:
            rows = self.store.rows(
                "SELECT id, name, path, summary FROM entities WHERE type = ? ORDER BY name LIMIT 500",
                (entity_type,),
            )
            if not rows:
                continue

            count += self._write_type_index(entity_type, folder, label, rows)
            company_lines.append(f"## {label}")
            company_lines.append("")
            company_lines.append(f"- [[{folder}/_index.md|{len(rows)} {label}]]")
            company_lines.append("")

        review_count = self.store.row("SELECT COUNT(*) AS c FROM review_items WHERE status = 'open'")["c"]
        if review_count:
            company_lines.append("## Open Reviews")
            company_lines.append("")
            company_lines.append(f"- [[company/reviews/_index.md|{review_count} unresolved conflicts]]")
            company_lines.append("")

        company_lines.append("## Operations")
        company_lines.append("")
        company_lines.append("- [[company/source-coverage.md|Source coverage]]")
        company_lines.append("")

        company_lines.append("## Graph Stats")
        company_lines.append("")
        entity_count = self.store.row("SELECT COUNT(*) AS c FROM entities")["c"]
        fact_count = self.store.row("SELECT COUNT(*) AS c FROM facts WHERE status IN ('generated','confirmed')")["c"]
        edge_count = self.store.row("SELECT COUNT(*) AS c FROM edges")["c"]
        source_count = self.store.row("SELECT COUNT(*) AS c FROM source_records WHERE stale = 0")["c"]
        company_lines.append(f"- {entity_count} entities")
        company_lines.append(f"- {fact_count} facts")
        company_lines.append(f"- {edge_count} graph edges")
        company_lines.append(f"- {source_count} source records")
        company_lines.append("")

        self.write_file("company/index.md", "\n".join(company_lines), None)
        count += 1
        return count

    def generate_source_coverage(self) -> int:
        sources = self.store.rows(
            """
            SELECT dataset_path, kind, COUNT(*) AS records,
                   SUM(CASE WHEN stale = 1 THEN 1 ELSE 0 END) AS stale_records
            FROM source_records
            WHERE id != 'source:manual'
            GROUP BY dataset_path, kind
            ORDER BY dataset_path, kind
            """
        )
        entity_rows = self.store.rows(
            "SELECT type, COUNT(*) AS count FROM entities GROUP BY type ORDER BY count DESC"
        )
        fact_rows = self.store.rows(
            """
            SELECT s.dataset_path, COUNT(f.id) AS facts
            FROM facts f
            JOIN source_records s ON s.id = f.source_id
            WHERE f.status IN ('generated', 'confirmed')
            GROUP BY s.dataset_path
            ORDER BY facts DESC
            LIMIT 80
            """
        )
        review_count = self.store.row(
            "SELECT COUNT(*) AS c FROM review_items WHERE status = 'open'"
        )["c"]
        stale_count = self.store.row(
            "SELECT COUNT(*) AS c FROM source_records WHERE stale = 1"
        )["c"]
        lines = [
            "---",
            "id: source-coverage",
            "type: operations",
            f"generated_at: {now_iso()}",
            "---",
            "",
            "# Source Coverage",
            "",
            "## Health",
            "",
            f"- Open reviews: {review_count}",
            f"- Stale source records: {stale_count}",
            "",
            "## Sources",
            "",
            "| Source | Kind | Records | Stale |",
            "|---|---|---|---|",
        ]
        for row in sources:
            lines.append(
                "| %s | %s | %s | %s |"
                % (
                    markdown_escape(row["dataset_path"]),
                    markdown_escape(row["kind"]),
                    row["records"],
                    row["stale_records"],
                )
            )
        lines.extend(["", "## Entities By Type", "", "| Type | Count |", "|---|---|"])
        for row in entity_rows:
            lines.append(f"| {markdown_escape(row['type'])} | {row['count']} |")
        lines.extend(["", "## Facts By Source", "", "| Source | Facts |", "|---|---|"])
        for row in fact_rows:
            lines.append(f"| {markdown_escape(row['dataset_path'])} | {row['facts']} |")
        lines.append("")
        self.write_file("company/source-coverage.md", "\n".join(lines), None)
        return 1

    def _write_type_index(
        self, entity_type: str, folder: str, label: str, rows: list[Any]
    ) -> int:
        lines = [
            "---",
            f"id: {entity_type}:index",
            "type: index",
            f"generated_at: {now_iso()}",
            "---",
            "",
            f"# {label}",
            "",
            f"{len(rows)} entities of type `{entity_type}`.",
            "",
            "| Name | Summary |",
            "|---|---|",
        ]
        for row in rows:
            name = markdown_escape(row["name"])
            path = row["path"]
            summary = clean_text(row["summary"] or "", 120)
            if path:
                lines.append(f"| [[{path}\\|{name}]] | {markdown_escape(summary)} |")
            else:
                lines.append(f"| {name} | {markdown_escape(summary)} |")
        lines.append("")
        self.write_file(f"{folder}/_index.md", "\n".join(lines), None)
        return 1

    def _summary_from_facts(self, entity: dict[str, Any], facts: list[Any]) -> str:
        grouped: dict[str, list[str]] = defaultdict(list)
        for fact in facts:
            if fact["value"] and len(grouped[fact["predicate"]]) < 2:
                grouped[fact["predicate"]].append(str(fact["value"]))
        if not grouped:
            return f"{entity['name']} is a {entity['type']} entity in the company context graph."
        fragments = []
        for predicate, values in list(grouped.items())[:4]:
            fragments.append(f"{predicate.replace('_', ' ')}: {', '.join(values)}")
        return f"{entity['name']} is a {entity['type']} entity. " + "; ".join(fragments) + "."

    def _related_paths(self, outgoing: list[Any], incoming: list[Any]) -> list[str]:
        paths = []
        for row in [*outgoing, *incoming]:
            path = row["path"]
            if path and path not in paths:
                paths.append(path)
        return paths[:40]

    def _link(self, path: str | None, label: str) -> str:
        return f"[[{path}|{label}]]" if path else label


def tree(vfs_root: Path) -> list[str]:
    if not vfs_root.exists():
        return []
    return sorted(path.relative_to(vfs_root).as_posix() for path in vfs_root.rglob("*.md"))
