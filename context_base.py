#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from context_base.ingest import ContextBuilder
from context_base.search import neighbors, search
from context_base.storage import Store
from context_base.utils import now_iso
from context_base.vfs import VFSGenerator, tree


DEFAULT_DATASET_DIR = Path("dataset")
DEFAULT_OUT_DIR = Path("context_base_out")


def db_path(out_dir: Path) -> Path:
    return out_dir / "context.db"


def open_store(out_dir: Path) -> Store:
    store = Store(db_path(out_dir))
    store.init_schema()
    return store


def cmd_build(args: argparse.Namespace) -> None:
    dataset_dir = Path(args.dataset_dir)
    out_dir = Path(args.out_dir)
    if not dataset_dir.exists():
        raise SystemExit(f"Dataset directory does not exist: {dataset_dir}")

    out_dir.mkdir(parents=True, exist_ok=True)
    if args.force and (out_dir / "vfs").exists():
        shutil.rmtree(out_dir / "vfs")

    store = open_store(out_dir)
    try:
        if args.force:
            store.reset()
        run_id = now_iso()
        builder = ContextBuilder(
            store,
            dataset_dir,
            run_id,
            force=args.force,
            use_llm=args.use_llm,
        )
        stats = builder.build()
        generated = VFSGenerator(store, out_dir).generate()
        print(
            json.dumps(
                {
                    "ok": True,
                    "db": str(db_path(out_dir)),
                    "vfs": str(out_dir / "vfs"),
                    "run_id": run_id,
                    "sources_seen": stats.sources_seen,
                    "sources_changed": stats.sources_changed,
                    "entities_touched": stats.entities,
                    "facts_touched": stats.facts,
                    "reviews_touched": stats.reviews,
                    "files_generated": generated,
                },
                indent=2,
            )
        )
    finally:
        store.close()


def cmd_search(args: argparse.Namespace) -> None:
    store = open_store(Path(args.out_dir))
    try:
        print(json.dumps(search(store, Path(args.out_dir), args.query, args.limit), indent=2))
    finally:
        store.close()


def cmd_read(args: argparse.Namespace) -> None:
    root = (Path(args.out_dir) / "vfs").resolve()
    target = (root / args.path).resolve()
    if root not in target.parents and target != root:
        raise SystemExit("Path escapes VFS root")
    if not target.exists() or not target.is_file():
        raise SystemExit(f"No VFS file found at {args.path}")
    print(target.read_text(encoding="utf-8"))


def cmd_entity(args: argparse.Namespace) -> None:
    store = open_store(Path(args.out_dir))
    try:
        row = store.row("SELECT * FROM entities WHERE id = ?", (args.entity_id,))
        if not row:
            raise SystemExit(f"Entity not found: {args.entity_id}")
        facts = store.rows(
            """
            SELECT f.*, s.dataset_path, s.record_id
            FROM facts f
            JOIN source_records s ON s.id = f.source_id
            WHERE f.subject_id = ?
              AND f.status IN ('generated', 'confirmed')
            ORDER BY f.predicate
            LIMIT ?
            """,
            (args.entity_id, args.limit),
        )
        payload = {
            "entity": dict(row),
            "facts": [dict(fact) for fact in facts],
            "neighbors": neighbors(store, args.entity_id, limit=20),
        }
        print(json.dumps(payload, indent=2))
    finally:
        store.close()


def cmd_sources(args: argparse.Namespace) -> None:
    fact_id = args.fact_id.removeprefix("fact:")
    if args.fact_id.startswith("fact:"):
        fact_id = args.fact_id
    store = open_store(Path(args.out_dir))
    try:
        rows = store.rows(
            """
            SELECT f.*, s.dataset_path, s.record_id, s.raw_ref, s.raw_json
            FROM facts f
            JOIN source_records s ON s.id = f.source_id
            WHERE f.id = ?
            """,
            (fact_id,),
        )
        if not rows:
            raise SystemExit(f"Fact not found: {args.fact_id}")
        print(json.dumps(dict(rows[0]), indent=2))
    finally:
        store.close()


def cmd_reviews(args: argparse.Namespace) -> None:
    store = open_store(Path(args.out_dir))
    try:
        rows = store.rows(
            "SELECT * FROM review_items WHERE status = ? ORDER BY created_at",
            (args.status,),
        )
        print(json.dumps([dict(row) for row in rows], indent=2))
    finally:
        store.close()


def cmd_resolve_review(args: argparse.Namespace) -> None:
    store = open_store(Path(args.out_dir))
    try:
        if not store.resolve_review(args.review_id, args.choice):
            raise SystemExit(f"Review or choice not found: {args.review_id} / {args.choice}")
        VFSGenerator(store, Path(args.out_dir)).generate()
        print(json.dumps({"ok": True, "review_id": args.review_id, "choice": args.choice}, indent=2))
    finally:
        store.close()


def cmd_tree(args: argparse.Namespace) -> None:
    for path in tree(Path(args.out_dir) / "vfs"):
        print(path)


def cmd_serve(args: argparse.Namespace) -> None:
    try:
        import uvicorn
    except ImportError as exc:
        raise SystemExit("Missing uvicorn. Run: pip install -r requirements.txt") from exc

    from context_base.api import create_app

    out_dir = Path(args.out_dir)
    app = create_app(db_path(out_dir), out_dir)
    uvicorn.run(app, host=args.host, port=args.port)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Build and inspect a provenance-backed company context base."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    build_parser = subparsers.add_parser("build", help="Build the SQLite context graph and VFS")
    build_parser.add_argument("--dataset-dir", default=str(DEFAULT_DATASET_DIR))
    build_parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    build_parser.add_argument("--force", action="store_true")
    build_parser.add_argument(
        "--use-llm",
        action="store_true",
        help="Reserved for Gemini-assisted extraction; deterministic extraction remains the default.",
    )
    build_parser.set_defaults(func=cmd_build)

    search_parser = subparsers.add_parser("search", help="Search entities, facts, and VFS files")
    search_parser.add_argument("query")
    search_parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    search_parser.add_argument("--limit", type=int, default=12)
    search_parser.set_defaults(func=cmd_search)

    read_parser = subparsers.add_parser("read", help="Read a generated VFS markdown file")
    read_parser.add_argument("path")
    read_parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    read_parser.set_defaults(func=cmd_read)

    entity_parser = subparsers.add_parser("entity", help="Inspect an entity and its facts")
    entity_parser.add_argument("entity_id")
    entity_parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    entity_parser.add_argument("--limit", type=int, default=80)
    entity_parser.set_defaults(func=cmd_entity)

    sources_parser = subparsers.add_parser("sources", help="Inspect the source for a fact id")
    sources_parser.add_argument("fact_id")
    sources_parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    sources_parser.set_defaults(func=cmd_sources)

    reviews_parser = subparsers.add_parser("reviews", help="List human review items")
    reviews_parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    reviews_parser.add_argument("--status", default="open")
    reviews_parser.set_defaults(func=cmd_reviews)

    resolve_parser = subparsers.add_parser("resolve-review", help="Resolve a conflict review")
    resolve_parser.add_argument("review_id")
    resolve_parser.add_argument("--choice", required=True)
    resolve_parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    resolve_parser.set_defaults(func=cmd_resolve_review)

    tree_parser = subparsers.add_parser("tree", help="List generated VFS markdown files")
    tree_parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    tree_parser.set_defaults(func=cmd_tree)

    serve_parser = subparsers.add_parser("serve", help="Run the local HTTP API")
    serve_parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    serve_parser.add_argument("--host", default="127.0.0.1")
    serve_parser.add_argument("--port", type=int, default=8000)
    serve_parser.set_defaults(func=cmd_serve)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.func(args)
    except KeyboardInterrupt:
        print("Interrupted", file=sys.stderr)
        raise SystemExit(130)


if __name__ == "__main__":
    main()
