from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

try:
    from mcp.server.fastmcp import FastMCP
except ImportError:
    FastMCP = None

from context_base.storage import Store
from context_base.search import search, neighbors
from context_base.vfs import VFSGenerator, tree


class _LocalToolRegistry:
    """Allows tests and direct Python callers to use tools without mcp installed."""

    def __init__(self, name: str):
        self.name = name

    def tool(self):
        def decorator(func):
            return func

        return decorator

    def run(self):
        raise SystemExit("Please install MCP dependencies first: pip install -r requirements.txt")


mcp = FastMCP("Context Base") if FastMCP else _LocalToolRegistry("Context Base")
DEFAULT_OUT_DIR = Path(os.environ.get("CONTEXT_BASE_OUT_DIR", "context_base_out"))


def set_out_dir(out_dir: str | Path) -> None:
    """Set the context-base output directory used by all MCP tools."""
    global DEFAULT_OUT_DIR
    DEFAULT_OUT_DIR = Path(out_dir)


def _json(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2, default=str)


def get_db(out_dir: Path | None = None) -> Store:
    out_dir = out_dir or DEFAULT_OUT_DIR
    db = Store(out_dir / "context.db")
    db.init_schema()
    return db


def _refresh_vfs(db: Store) -> int:
    return VFSGenerator(db, DEFAULT_OUT_DIR).generate()


@mcp.tool()
def search_context(query: str) -> str:
    """Search the company knowledge graph and file system for a given text query. Use this to find relevant entities or files before exploring further."""
    db = get_db()
    try:
        return _json({"query": query, "results": search(db, DEFAULT_OUT_DIR, query)})
    finally:
        db.close()


@mcp.tool()
def get_entity_context(entity_id: str) -> str:
    """Get the full details, facts, and immediate graph neighbors for a specific entity ID. Use this when you have an entity_id and want to traverse the graph."""
    db = get_db()
    try:
        row = db.row("SELECT * FROM entities WHERE id = ?", (entity_id,))
        if not row:
            return _json({"error": "Entity not found", "entity_id": entity_id})
        facts = db.rows(
            """
            SELECT f.*, s.dataset_path, s.record_id, s.raw_ref
            FROM facts f
            JOIN source_records s ON s.id = f.source_id
            WHERE f.subject_id = ?
              AND f.status IN ('generated', 'confirmed')
            ORDER BY f.predicate
            """,
            (entity_id,),
        )
        return _json(
            {
                "entity": dict(row),
                "facts": [dict(item) for item in facts],
                "neighbors": neighbors(db, entity_id, limit=20),
            }
        )
    finally:
        db.close()


@mcp.tool()
def read_vfs_file(path: str) -> str:
    """Read a specific markdown file from the virtual file system. Use this to read the full generated documentation for an entity or index."""
    full_path = (DEFAULT_OUT_DIR / "vfs" / path).resolve()
    try:
        full_path.relative_to((DEFAULT_OUT_DIR / "vfs").resolve())
    except ValueError:
        return "Access denied: Path is outside VFS root."
        
    if not full_path.exists() or not full_path.is_file():
        return f"File not found: {path}"
    return full_path.read_text(encoding="utf-8")


@mcp.tool()
def list_vfs_files(prefix: str = "") -> str:
    """List generated VFS markdown files. Use an optional prefix such as company/tickets to narrow the file list."""
    files = tree(DEFAULT_OUT_DIR / "vfs")
    if prefix:
        files = [path for path in files if path.startswith(prefix)]
    return _json({"out_dir": str(DEFAULT_OUT_DIR), "files": files})


@mcp.tool()
def get_context_base_status() -> str:
    """Return graph, source, review, and VFS counts for judging context-base completeness."""
    db = get_db()
    try:
        by_type = db.rows(
            "SELECT type, COUNT(*) AS count FROM entities GROUP BY type ORDER BY count DESC"
        )
        payload = {
            "out_dir": str(DEFAULT_OUT_DIR),
            "database": str(DEFAULT_OUT_DIR / "context.db"),
            "entities": db.row("SELECT COUNT(*) AS count FROM entities")["count"],
            "facts": db.row(
                "SELECT COUNT(*) AS count FROM facts WHERE status IN ('generated', 'confirmed')"
            )["count"],
            "edges": db.row("SELECT COUNT(*) AS count FROM edges")["count"],
            "active_sources": db.row(
                "SELECT COUNT(*) AS count FROM source_records WHERE stale = 0"
            )["count"],
            "stale_sources": db.row(
                "SELECT COUNT(*) AS count FROM source_records WHERE stale = 1"
            )["count"],
            "open_reviews": db.row(
                "SELECT COUNT(*) AS count FROM review_items WHERE status = 'open'"
            )["count"],
            "vfs_files": len(tree(DEFAULT_OUT_DIR / "vfs")),
            "entities_by_type": {row["type"]: row["count"] for row in by_type},
        }
        return _json(payload)
    finally:
        db.close()


@mcp.tool()
def get_fact_source(fact_id: str) -> str:
    """Return raw source provenance for a fact ID. Use this before citing a fact as evidence."""
    db = get_db()
    try:
        row = db.row(
            """
            SELECT f.*, s.dataset_path, s.record_id, s.raw_ref, s.raw_json
            FROM facts f
            JOIN source_records s ON s.id = f.source_id
            WHERE f.id = ?
            """,
            (fact_id,),
        )
        if not row:
            return _json({"error": "Fact not found", "fact_id": fact_id})
        return _json({"fact": dict(row)})
    finally:
        db.close()


@mcp.tool()
def list_review_items(status: str = "open", limit: int = 20) -> str:
    """List human review items for unresolved conflicts and ambiguity."""
    db = get_db()
    try:
        rows = db.rows(
            """
            SELECT *
            FROM review_items
            WHERE status = ?
            ORDER BY created_at
            LIMIT ?
            """,
            (status, limit),
        )
        return _json({"status": status, "reviews": [dict(row) for row in rows]})
    finally:
        db.close()


@mcp.tool()
def resolve_review_item(review_id: str, choice_id: str) -> str:
    """Resolve a review item with a candidate choice ID, then regenerate VFS files."""
    db = get_db()
    try:
        if not db.resolve_review(review_id, choice_id):
            return _json(
                {
                    "ok": False,
                    "error": "Review or choice not found",
                    "review_id": review_id,
                    "choice_id": choice_id,
                }
            )
        files_generated = _refresh_vfs(db)
        return _json(
            {
                "ok": True,
                "review_id": review_id,
                "choice_id": choice_id,
                "files_generated": files_generated,
            }
        )
    finally:
        db.close()


@mcp.tool()
def add_entity_fact(
    entity_id: str,
    predicate: str,
    value: str = "",
    object_entity_id: str = "",
    confidence: float = 1.0,
) -> str:
    """Add a manually confirmed fact to an entity and regenerate the VFS."""
    db = get_db()
    try:
        entity = db.row("SELECT id FROM entities WHERE id = ?", (entity_id,))
        if not entity:
            return _json({"ok": False, "error": "Entity not found", "entity_id": entity_id})
        fact_id = db.upsert_fact(
            subject_id=entity_id,
            predicate=predicate,
            source_id="source:manual",
            run_id="manual",
            value=value or None,
            object_entity_id=object_entity_id or None,
            confidence=confidence,
            status="confirmed",
            extraction_method="manual",
        )
        db.commit()
        files_generated = _refresh_vfs(db)
        return _json({"ok": True, "fact_id": fact_id, "files_generated": files_generated})
    finally:
        db.close()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Run the Qontext context-base MCP server.")
    parser.add_argument(
        "--out-dir",
        default=os.environ.get("CONTEXT_BASE_OUT_DIR", str(DEFAULT_OUT_DIR)),
        help="Context-base output directory containing context.db and vfs/.",
    )
    args = parser.parse_args()
    set_out_dir(args.out_dir)
    mcp.run()
