from __future__ import annotations

from pathlib import Path
from typing import Any

from .storage import Store
from .utils import clean_text


def search(store: Store, out_dir: Path, query: str, limit: int = 12) -> list[dict[str, Any]]:
    terms = [term.lower() for term in query.split() if len(term) > 1]
    if not terms:
        return []
    pattern = "%" + "%".join(terms) + "%"
    results: list[dict[str, Any]] = []

    for row in store.rows(
        """
        SELECT id, type, name, path, summary
        FROM entities
        WHERE lower(name || ' ' || COALESCE(summary, '') || ' ' || aliases_json) LIKE ?
        ORDER BY type, name
        LIMIT ?
        """,
        (pattern, limit),
    ):
        results.append(
            {
                "kind": "entity",
                "entity_id": row["id"],
                "type": row["type"],
                "name": row["name"],
                "path": row["path"],
                "snippet": clean_text(row["summary"], 240),
                "neighbors": neighbors(store, row["id"], limit=5),
            }
        )

    remaining = max(0, limit - len(results))
    if remaining:
        for row in store.rows(
            """
            SELECT f.id, f.subject_id, f.predicate, f.value, f.confidence,
                   e.name, e.type, e.path, s.dataset_path, s.record_id
            FROM facts f
            JOIN entities e ON e.id = f.subject_id
            JOIN source_records s ON s.id = f.source_id
            WHERE f.status IN ('generated', 'confirmed')
              AND lower(f.predicate || ' ' || COALESCE(f.value, '')) LIKE ?
            ORDER BY f.confidence DESC
            LIMIT ?
            """,
            (pattern, remaining),
        ):
            results.append(
                {
                    "kind": "fact",
                    "fact_id": row["id"],
                    "entity_id": row["subject_id"],
                    "type": row["type"],
                    "name": row["name"],
                    "path": row["path"],
                    "predicate": row["predicate"],
                    "snippet": clean_text(row["value"], 260),
                    "source": f"{row['dataset_path']}#{row['record_id']}",
                    "confidence": row["confidence"],
                }
            )

    remaining = max(0, limit - len(results))
    if remaining:
        vfs_root = out_dir / "vfs"
        for path in sorted(vfs_root.rglob("*.md")) if vfs_root.exists() else []:
            text = path.read_text(encoding="utf-8", errors="ignore")
            lowered = text.lower()
            if all(term in lowered for term in terms):
                idx = min([lowered.find(term) for term in terms if lowered.find(term) >= 0] or [0])
                snippet = clean_text(text[max(0, idx - 80) : idx + 220], 260)
                results.append(
                    {
                        "kind": "file",
                        "path": path.relative_to(vfs_root).as_posix(),
                        "snippet": snippet,
                    }
                )
                if len(results) >= limit:
                    break

    return results[:limit]


def neighbors(store: Store, entity_id: str, limit: int = 20) -> list[dict[str, Any]]:
    rows = store.rows(
        """
        SELECT edge.relation, target.id, target.type, target.name, target.path, 'outgoing' AS direction
        FROM edges edge
        JOIN entities target ON target.id = edge.to_entity_id
        JOIN facts f ON f.id = edge.source_fact_id
        WHERE edge.from_entity_id = ? AND f.status IN ('generated', 'confirmed')
        UNION ALL
        SELECT edge.relation, source.id, source.type, source.name, source.path, 'incoming' AS direction
        FROM edges edge
        JOIN entities source ON source.id = edge.from_entity_id
        JOIN facts f ON f.id = edge.source_fact_id
        WHERE edge.to_entity_id = ? AND f.status IN ('generated', 'confirmed')
        LIMIT ?
        """,
        (entity_id, entity_id, limit),
    )
    return [
        {
            "direction": row["direction"],
            "relation": row["relation"],
            "entity_id": row["id"],
            "type": row["type"],
            "name": row["name"],
            "path": row["path"],
        }
        for row in rows
    ]
