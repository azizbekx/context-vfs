from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .utils import now_iso, stable_hash, stable_id


@dataclass(frozen=True)
class SourceState:
    id: str
    changed: bool


class Store:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(db_path))
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")

    def close(self) -> None:
        self.conn.close()

    def init_schema(self) -> None:
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS source_records (
                id TEXT PRIMARY KEY,
                dataset_path TEXT NOT NULL,
                record_id TEXT NOT NULL,
                record_hash TEXT NOT NULL,
                kind TEXT NOT NULL,
                raw_ref TEXT,
                raw_json TEXT,
                observed_at TEXT NOT NULL,
                last_seen_run TEXT NOT NULL,
                stale INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS entities (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                name TEXT NOT NULL,
                path TEXT,
                aliases_json TEXT NOT NULL DEFAULT '[]',
                summary TEXT,
                confidence REAL NOT NULL DEFAULT 1.0,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS entity_embeddings (
                entity_id TEXT PRIMARY KEY,
                text_content TEXT NOT NULL,
                embedding_json TEXT NOT NULL,
                FOREIGN KEY(entity_id) REFERENCES entities(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS facts (
                id TEXT PRIMARY KEY,
                subject_id TEXT NOT NULL,
                predicate TEXT NOT NULL,
                value TEXT,
                object_entity_id TEXT,
                confidence REAL NOT NULL DEFAULT 1.0,
                source_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'generated',
                extraction_method TEXT NOT NULL DEFAULT 'deterministic',
                valid_from TEXT,
                valid_to TEXT,
                run_id TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(source_id) REFERENCES source_records(id)
            );

            CREATE TABLE IF NOT EXISTS edges (
                id TEXT PRIMARY KEY,
                from_entity_id TEXT NOT NULL,
                relation TEXT NOT NULL,
                to_entity_id TEXT NOT NULL,
                source_fact_id TEXT NOT NULL,
                FOREIGN KEY(source_fact_id) REFERENCES facts(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS vfs_files (
                path TEXT PRIMARY KEY,
                entity_id TEXT,
                content_hash TEXT NOT NULL,
                generated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS review_items (
                id TEXT PRIMARY KEY,
                entity_id TEXT NOT NULL,
                conflict_type TEXT NOT NULL,
                predicate TEXT NOT NULL,
                candidates_json TEXT NOT NULL,
                suggested_resolution TEXT,
                status TEXT NOT NULL DEFAULT 'open',
                created_at TEXT NOT NULL,
                resolved_at TEXT,
                resolution TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
            CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject_id);
            CREATE INDEX IF NOT EXISTS idx_facts_source ON facts(source_id);
            CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_entity_id);
            CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_entity_id);

            CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
                kind,
                ref_id UNINDEXED,
                entity_id UNINDEXED,
                path UNINDEXED,
                title,
                body
            );
            """
        )
        self.conn.execute(
            """
            INSERT OR IGNORE INTO source_records (
                id, dataset_path, record_id, record_hash, kind, raw_ref, raw_json,
                observed_at, last_seen_run, stale
            ) VALUES ('source:manual', 'manual', 'manual', '', 'manual', 'manual', '{}', ?, ?, 0)
            """,
            (now_iso(), now_iso()),
        )
        self.conn.commit()

    def reset(self) -> None:
        self.conn.executescript(
            """
            DROP TABLE IF EXISTS edges;
            DROP TABLE IF EXISTS facts;
            DROP TABLE IF EXISTS entity_embeddings;
            DROP TABLE IF EXISTS entities;
            DROP TABLE IF EXISTS source_records;
            DROP TABLE IF EXISTS vfs_files;
            DROP TABLE IF EXISTS review_items;
            DROP TABLE IF EXISTS search_index;
            """
        )
        self.init_schema()

    def upsert_source(
        self,
        *,
        dataset_path: str,
        record_id: str,
        kind: str,
        payload: Any,
        raw_ref: str | None,
        run_id: str,
        force: bool = False,
    ) -> SourceState:
        source_id = stable_id("source", dataset_path, record_id, length=24)
        record_hash = stable_hash(payload)
        existing = self.conn.execute(
            "SELECT record_hash FROM source_records WHERE id = ?", (source_id,)
        ).fetchone()
        changed = force or existing is None or existing["record_hash"] != record_hash
        now = now_iso()
        self.conn.execute(
            """
            INSERT INTO source_records (
                id, dataset_path, record_id, record_hash, kind, raw_ref, raw_json,
                observed_at, last_seen_run, stale
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT(id) DO UPDATE SET
                record_hash = excluded.record_hash,
                kind = excluded.kind,
                raw_ref = excluded.raw_ref,
                raw_json = excluded.raw_json,
                last_seen_run = excluded.last_seen_run,
                stale = 0
            """,
            (
                source_id,
                dataset_path,
                str(record_id),
                record_hash,
                kind,
                raw_ref,
                json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str),
                now,
                run_id,
            ),
        )
        if changed:
            self.delete_source_facts(source_id)
        return SourceState(source_id, changed)

    def delete_source_facts(self, source_id: str) -> None:
        fact_ids = [
            row["id"]
            for row in self.conn.execute(
                "SELECT id FROM facts WHERE source_id = ?", (source_id,)
            )
        ]
        if fact_ids:
            self.conn.executemany("DELETE FROM edges WHERE source_fact_id = ?", [(fid,) for fid in fact_ids])
            self.conn.execute("DELETE FROM facts WHERE source_id = ?", (source_id,))

    def mark_missing_sources_stale(self, run_id: str) -> None:
        self.conn.execute(
            """
            UPDATE source_records
            SET last_seen_run = ?, stale = 0
            WHERE id = 'source:manual'
            """,
            (run_id,),
        )
        self.conn.execute(
            """
            UPDATE source_records
            SET stale = 1
            WHERE last_seen_run != ?
              AND id != 'source:manual'
            """,
            (run_id,),
        )
        self.conn.execute(
            """
            UPDATE facts
            SET status = 'stale'
            WHERE source_id IN (
                SELECT id FROM source_records WHERE stale = 1
            )
              AND source_id != 'source:manual'
            """
        )

    def upsert_entity(
        self,
        *,
        entity_id: str,
        entity_type: str,
        name: str,
        path: str | None,
        aliases: Iterable[str] = (),
        summary: str | None = None,
        confidence: float = 1.0,
    ) -> None:
        now = now_iso()
        self.conn.execute(
            """
            INSERT INTO entities (id, type, name, path, aliases_json, summary, confidence, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                type = excluded.type,
                name = CASE
                    WHEN excluded.confidence >= entities.confidence THEN excluded.name
                    ELSE entities.name
                END,
                path = COALESCE(excluded.path, entities.path),
                aliases_json = CASE
                    WHEN excluded.confidence >= entities.confidence THEN excluded.aliases_json
                    ELSE entities.aliases_json
                END,
                summary = CASE
                    WHEN entities.summary IS NULL THEN excluded.summary
                    WHEN excluded.summary IS NOT NULL AND excluded.confidence >= entities.confidence THEN excluded.summary
                    ELSE entities.summary
                END,
                confidence = MAX(entities.confidence, excluded.confidence),
                updated_at = excluded.updated_at
            """,
            (
                entity_id,
                entity_type,
                name,
                path,
                json.dumps(list(dict.fromkeys(alias for alias in aliases if alias))),
                summary,
                confidence,
                now,
            ),
        )

    def upsert_fact(
        self,
        *,
        subject_id: str,
        predicate: str,
        source_id: str,
        run_id: str,
        value: Any = None,
        object_entity_id: str | None = None,
        confidence: float = 1.0,
        status: str = "generated",
        extraction_method: str = "deterministic",
        valid_from: str | None = None,
        valid_to: str | None = None,
    ) -> str:
        text_value = None if value is None else str(value)
        fact_id = stable_id(
            "fact",
            subject_id,
            predicate,
            text_value,
            object_entity_id,
            source_id,
            length=24,
        )
        now = now_iso()
        self.conn.execute(
            """
            INSERT INTO facts (
                id, subject_id, predicate, value, object_entity_id, confidence,
                source_id, status, extraction_method, valid_from, valid_to, run_id, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                value = excluded.value,
                object_entity_id = excluded.object_entity_id,
                confidence = excluded.confidence,
                status = excluded.status,
                extraction_method = excluded.extraction_method,
                valid_from = excluded.valid_from,
                valid_to = excluded.valid_to,
                run_id = excluded.run_id,
                updated_at = excluded.updated_at
            """,
            (
                fact_id,
                subject_id,
                predicate,
                text_value,
                object_entity_id,
                confidence,
                source_id,
                status,
                extraction_method,
                valid_from,
                valid_to,
                run_id,
                now,
            ),
        )
        if object_entity_id:
            edge_id = stable_id("edge", subject_id, predicate, object_entity_id, fact_id, length=24)
            self.conn.execute(
                """
                INSERT INTO edges (id, from_entity_id, relation, to_entity_id, source_fact_id)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    relation = excluded.relation,
                    source_fact_id = excluded.source_fact_id
                """,
                (edge_id, subject_id, predicate, object_entity_id, fact_id),
            )
        return fact_id

    def upsert_vfs_file(self, path: str, entity_id: str | None, content: str) -> None:
        self.conn.execute(
            """
            INSERT INTO vfs_files (path, entity_id, content_hash, generated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
                entity_id = excluded.entity_id,
                content_hash = excluded.content_hash,
                generated_at = excluded.generated_at
            """,
            (path, entity_id, stable_hash(content), now_iso()),
        )

    def rebuild_search_index(self) -> None:
        self.conn.execute("DELETE FROM search_index")
        self.conn.execute(
            """
            INSERT INTO search_index (kind, ref_id, entity_id, path, title, body)
            SELECT 'entity', e.id, e.id, e.path, e.name,
                   e.type || ' ' || COALESCE(e.summary, '') || ' ' || e.aliases_json
            FROM entities e
            """
        )
        self.conn.execute(
            """
            INSERT INTO search_index (kind, ref_id, entity_id, path, title, body)
            SELECT 'fact', f.id, f.subject_id, e.path,
                   e.name || ' ' || f.predicate,
                   f.predicate || ' ' || COALESCE(f.value, '') || ' ' ||
                   COALESCE(f.object_entity_id, '') || ' ' || s.dataset_path || '#' || s.record_id
            FROM facts f
            JOIN entities e ON e.id = f.subject_id
            JOIN source_records s ON s.id = f.source_id
            WHERE f.status IN ('generated', 'confirmed')
            """
        )
        vfs_root = self.db_path.parent / "vfs"
        if vfs_root.exists():
            rows = []
            for path in sorted(vfs_root.rglob("*.md")):
                relative = path.relative_to(vfs_root).as_posix()
                title = relative
                text = path.read_text(encoding="utf-8", errors="ignore")
                for line in text.splitlines():
                    if line.startswith("# "):
                        title = line[2:].strip()
                        break
                rows.append(("file", relative, None, relative, title, text))
            self.conn.executemany(
                """
                INSERT INTO search_index (kind, ref_id, entity_id, path, title, body)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                rows,
            )

    def refresh_search_index(
        self,
        *,
        entity_ids: Iterable[str] = (),
        file_paths: Iterable[str] = (),
    ) -> None:
        entity_ids = list(dict.fromkeys(entity_ids))
        file_paths = list(dict.fromkeys(file_paths))
        if entity_ids:
            placeholders = ",".join("?" for _ in entity_ids)
            self.conn.execute(
                f"DELETE FROM search_index WHERE kind IN ('entity', 'fact') AND entity_id IN ({placeholders})",
                tuple(entity_ids),
            )
            self.conn.execute(
                f"""
                INSERT INTO search_index (kind, ref_id, entity_id, path, title, body)
                SELECT 'entity', e.id, e.id, e.path, e.name,
                       e.type || ' ' || COALESCE(e.summary, '') || ' ' || e.aliases_json
                FROM entities e
                WHERE e.id IN ({placeholders})
                """,
                tuple(entity_ids),
            )
            self.conn.execute(
                f"""
                INSERT INTO search_index (kind, ref_id, entity_id, path, title, body)
                SELECT 'fact', f.id, f.subject_id, e.path,
                       e.name || ' ' || f.predicate,
                       f.predicate || ' ' || COALESCE(f.value, '') || ' ' ||
                       COALESCE(f.object_entity_id, '') || ' ' || s.dataset_path || '#' || s.record_id
                FROM facts f
                JOIN entities e ON e.id = f.subject_id
                JOIN source_records s ON s.id = f.source_id
                WHERE f.status IN ('generated', 'confirmed')
                  AND f.subject_id IN ({placeholders})
                """,
                tuple(entity_ids),
            )
        if file_paths:
            placeholders = ",".join("?" for _ in file_paths)
            self.conn.execute(
                f"DELETE FROM search_index WHERE kind = 'file' AND path IN ({placeholders})",
                tuple(file_paths),
            )
            vfs_root = self.db_path.parent / "vfs"
            rows = []
            for relative in file_paths:
                path = vfs_root / relative
                if not path.exists() or not path.is_file():
                    continue
                title = relative
                text = path.read_text(encoding="utf-8", errors="ignore")
                for line in text.splitlines():
                    if line.startswith("# "):
                        title = line[2:].strip()
                        break
                rows.append(("file", relative, None, relative, title, text))
            self.conn.executemany(
                """
                INSERT INTO search_index (kind, ref_id, entity_id, path, title, body)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                rows,
            )

    def upsert_review(
        self,
        *,
        review_id: str,
        entity_id: str,
        conflict_type: str,
        predicate: str,
        candidates: list[dict[str, Any]],
        suggested_resolution: str,
    ) -> None:
        self.conn.execute(
            """
            INSERT INTO review_items (
                id, entity_id, conflict_type, predicate, candidates_json,
                suggested_resolution, status, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, 'open', ?)
            ON CONFLICT(id) DO UPDATE SET
                candidates_json = excluded.candidates_json,
                suggested_resolution = excluded.suggested_resolution
            """,
            (
                review_id,
                entity_id,
                conflict_type,
                predicate,
                json.dumps(candidates, ensure_ascii=False, sort_keys=True),
                suggested_resolution,
                now_iso(),
            ),
        )

    def resolve_review(self, review_id: str, choice_id: str) -> bool:
        row = self.conn.execute(
            "SELECT candidates_json FROM review_items WHERE id = ? AND status = 'open'",
            (review_id,),
        ).fetchone()
        if not row:
            return False
        candidates = json.loads(row["candidates_json"])
        chosen = next((item for item in candidates if item.get("choice_id") == choice_id), None)
        if not chosen:
            return False

        chosen_fact = chosen.get("fact_id")
        if chosen_fact:
            self.conn.execute("UPDATE facts SET status = 'confirmed' WHERE id = ?", (chosen_fact,))
            other_ids = [
                item.get("fact_id")
                for item in candidates
                if item.get("fact_id") and item.get("fact_id") != chosen_fact
            ]
            self.conn.executemany(
                "UPDATE facts SET status = 'rejected' WHERE id = ?",
                [(fact_id,) for fact_id in other_ids],
            )
        self.conn.execute(
            """
            UPDATE review_items
            SET status = 'resolved', resolved_at = ?, resolution = ?
            WHERE id = ?
            """,
            (now_iso(), json.dumps(chosen, ensure_ascii=False, sort_keys=True), review_id),
        )
        self.conn.commit()
        return True

    def auto_resolve_conflict(self, winner_id: str, loser_ids: list[str]) -> None:
        self.conn.execute(
            "UPDATE facts SET status = 'confirmed' WHERE id = ?", (winner_id,)
        )
        self.conn.executemany(
            "UPDATE facts SET status = 'rejected' WHERE id = ?",
            [(fid,) for fid in loser_ids],
        )

    def cleanup_stale_facts(self) -> int:
        fact_ids = [
            row["id"]
            for row in self.conn.execute(
                """
                SELECT id
                FROM facts
                WHERE status = 'stale'
                  AND source_id != 'source:manual'
                """
            )
        ]
        if fact_ids:
            self.conn.executemany(
                "DELETE FROM edges WHERE source_fact_id = ?",
                [(fid,) for fid in fact_ids],
            )
            self.conn.executemany(
                "DELETE FROM facts WHERE id = ?",
                [(fid,) for fid in fact_ids],
            )
        return len(fact_ids)

    def cleanup_orphaned_entities(self) -> int:
        entity_ids = [
            row["id"]
            for row in self.conn.execute(
                """
                SELECT e.id
                FROM entities e
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM facts f
                    WHERE f.subject_id = e.id
                      AND f.status IN ('generated', 'confirmed')
                )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM edges edge
                    JOIN facts f ON f.id = edge.source_fact_id
                    WHERE edge.to_entity_id = e.id
                      AND f.status IN ('generated', 'confirmed')
                )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM edges edge
                    JOIN facts f ON f.id = edge.source_fact_id
                    WHERE edge.from_entity_id = e.id
                      AND f.status IN ('generated', 'confirmed')
                )
                """
            )
        ]
        for entity_id in entity_ids:
            self.delete_entity(entity_id)
        return len(entity_ids)

    def delete_fact(self, fact_id: str) -> bool:
        self.conn.execute(
            "DELETE FROM edges WHERE source_fact_id = ?", (fact_id,)
        )
        cursor = self.conn.execute(
            "DELETE FROM facts WHERE id = ?", (fact_id,)
        )
        return cursor.rowcount > 0

    def delete_entity(self, entity_id: str) -> bool:
        fact_ids = [
            row["id"]
            for row in self.conn.execute(
                "SELECT id FROM facts WHERE subject_id = ?", (entity_id,)
            )
        ]
        for fid in fact_ids:
            self.conn.execute(
                "DELETE FROM edges WHERE source_fact_id = ?", (fid,)
            )
        self.conn.execute(
            "DELETE FROM facts WHERE subject_id = ?", (entity_id,)
        )
        self.conn.execute(
            "DELETE FROM edges WHERE to_entity_id = ?", (entity_id,)
        )
        cursor = self.conn.execute(
            "DELETE FROM entities WHERE id = ?", (entity_id,)
        )
        return cursor.rowcount > 0

    def rows(self, query: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        return list(self.conn.execute(query, params))

    def row(self, query: str, params: tuple[Any, ...] = ()) -> sqlite3.Row | None:
        return self.conn.execute(query, params).fetchone()

    def commit(self) -> None:
        self.conn.commit()
