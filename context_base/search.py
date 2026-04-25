from __future__ import annotations

from pathlib import Path
from typing import Any

from .storage import Store
from .utils import clean_text


def semantic_search(store: Store, query: str, limit: int = 5) -> list[dict[str, Any]]:
    try:
        from google import genai
        import json
        import os
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            return []
        client = genai.Client(api_key=api_key)
    except ImportError:
        return []
        
    try:
        res = client.models.embed_content(model="gemini-embedding-2", contents=[query])
        if not res.embeddings:
            return []
        query_emb = res.embeddings[0].values
    except Exception:
        return []

    rows = store.rows("SELECT entity_id, embedding_json FROM entity_embeddings")
    if not rows:
        return []
    
    def cos_sim(v1, v2):
        dot = sum(a*b for a, b in zip(v1, v2))
        m1 = sum(a*a for a in v1) ** 0.5
        m2 = sum(b*b for b in v2) ** 0.5
        if m1 == 0 or m2 == 0: return 0
        return dot / (m1 * m2)

    scored = []
    for row in rows:
        try:
            emb = json.loads(row["embedding_json"])
            score = cos_sim(query_emb, emb)
            scored.append((score, row["entity_id"]))
        except Exception:
            continue
    
    scored.sort(reverse=True, key=lambda x: x[0])
    top_ids = [s[1] for s in scored[:limit] if s[0] > 0.4]
    if not top_ids:
        return []

    results = []
    placeholders = ",".join("?" for _ in top_ids)
    for row in store.rows(f"SELECT id, type, name, path, summary FROM entities WHERE id IN ({placeholders})", tuple(top_ids)):
        results.append({
            "kind": "entity",
            "entity_id": row["id"],
            "type": row["type"],
            "name": row["name"],
            "path": row["path"],
            "snippet": clean_text(row["summary"], 240),
            "neighbors": neighbors(store, row["id"], limit=5),
        })
    return results


def search(store: Store, out_dir: Path, query: str, limit: int = 12) -> list[dict[str, Any]]:
    terms = [term.lower() for term in query.split() if len(term) > 1]
    if not terms:
        return []
    
    results: list[dict[str, Any]] = []
    seen_entity_ids = set()
    
    semantic_results = semantic_search(store, query, limit=max(3, limit // 2))
    for r in semantic_results:
        results.append(r)
        seen_entity_ids.add(r["entity_id"])
        
    fts_results = _fts_search(store, query, limit)
    if fts_results:
        for r in fts_results:
            if r.get("entity_id") not in seen_entity_ids:
                results.append(r)
                if r.get("entity_id"):
                    seen_entity_ids.add(r["entity_id"])
        if len(results) >= limit:
            return results[:limit]

    pattern = "%" + "%".join(terms) + "%"

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
        if row["id"] in seen_entity_ids:
            continue
        seen_entity_ids.add(row["id"])
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


def _fts_query(query: str) -> str:
    tokens = []
    for raw in query.replace('"', " ").split():
        token = "".join(ch for ch in raw if ch.isalnum() or ch in ("_", "-"))
        if token:
            tokens.append(f'"{token}"')
    return " OR ".join(tokens)


def _fts_search(store: Store, query: str, limit: int) -> list[dict[str, Any]]:
    fts_query = _fts_query(query)
    if not fts_query:
        return []
    try:
        rows = store.rows(
            """
            SELECT kind, ref_id, entity_id, path, title,
                   snippet(search_index, 5, '[', ']', '...', 24) AS snippet,
                   bm25(search_index) AS rank
            FROM search_index
            WHERE search_index MATCH ?
            ORDER BY rank
            LIMIT ?
            """,
            (fts_query, limit),
        )
    except Exception:
        return []

    results = []
    for row in rows:
        result = {
            "kind": row["kind"],
            "ref_id": row["ref_id"],
            "entity_id": row["entity_id"],
            "path": row["path"],
            "name": row["title"],
            "snippet": clean_text(row["snippet"], 280),
            "rank": row["rank"],
        }
        if row["entity_id"]:
            result["neighbors"] = neighbors(store, row["entity_id"], limit=5)
        if row["kind"] == "fact":
            fact = store.row(
                """
                SELECT f.predicate, f.confidence, s.dataset_path, s.record_id
                FROM facts f
                JOIN source_records s ON s.id = f.source_id
                WHERE f.id = ?
                """,
                (row["ref_id"],),
            )
            if fact:
                result["fact_id"] = row["ref_id"]
                result["predicate"] = fact["predicate"]
                result["confidence"] = fact["confidence"]
                result["source"] = f"{fact['dataset_path']}#{fact['record_id']}"
        results.append(result)
    return results


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
