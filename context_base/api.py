from pathlib import Path
from typing import Any, Optional

from .search import neighbors, search
from .storage import Store
from .utils import now_iso
from .vfs import VFSGenerator, tree


def create_app(db_path: Path, out_dir: Path):
    try:
        from fastapi import FastAPI, HTTPException, Query
        from fastapi.responses import HTMLResponse
        from pydantic import BaseModel
    except ImportError as exc:
        raise SystemExit(
            "Missing API dependencies. Run: pip install -r requirements.txt"
        ) from exc

    app = FastAPI(title="Context Base API", version="0.1.0")

    class ResolveBody(BaseModel):
        choice: str

    class CreateEntityBody(BaseModel):
        entity_id: str
        entity_type: str
        name: str
        path: Optional[str] = None
        summary: Optional[str] = None

    class AddFactBody(BaseModel):
        predicate: str
        value: Optional[str] = None
        object_entity_id: Optional[str] = None
        confidence: float = 1.0

    class EditFactBody(BaseModel):
        value: Optional[str] = None
        confidence: Optional[float] = None

    def store() -> Store:
        db = Store(db_path)
        db.init_schema()
        return db

    def refresh_vfs(db: Store) -> int:
        return VFSGenerator(db, out_dir).generate()

    def refresh_entities(db: Store, entity_ids: list[str]) -> int:
        return VFSGenerator(db, out_dir).refresh_entities(entity_ids)

    def refresh_review(db: Store, review_id: str) -> int:
        return VFSGenerator(db, out_dir).refresh_review(review_id)

    @app.get("/", response_class=HTMLResponse)
    def index():
        return HTMLResponse(STATUS_PAGE_HTML)

    @app.get("/health")
    def health():
        return {"ok": True, "db": str(db_path), "out_dir": str(out_dir)}

    @app.get("/stats")
    def stats():
        db = store()
        try:
            entity_count = db.row("SELECT COUNT(*) AS c FROM entities")["c"]
            fact_count = db.row("SELECT COUNT(*) AS c FROM facts WHERE status IN ('generated','confirmed')")["c"]
            edge_count = db.row("SELECT COUNT(*) AS c FROM edges")["c"]
            source_count = db.row("SELECT COUNT(*) AS c FROM source_records WHERE stale = 0")["c"]
            review_count = db.row("SELECT COUNT(*) AS c FROM review_items WHERE status = 'open'")["c"]
            type_rows = db.rows(
                "SELECT type, COUNT(*) AS c FROM entities GROUP BY type ORDER BY c DESC"
            )
            return {
                "entities": entity_count,
                "facts": fact_count,
                "edges": edge_count,
                "sources": source_count,
                "open_reviews": review_count,
                "by_type": {row["type"]: row["c"] for row in type_rows},
            }
        finally:
            db.close()

    @app.get("/vfs/tree")
    def vfs_tree():
        return {"files": tree(out_dir / "vfs")}

    @app.get("/vfs/file")
    def vfs_file(path: str = Query(...)):
        full_path = (out_dir / "vfs" / path).resolve()
        root = (out_dir / "vfs").resolve()
        if root not in full_path.parents and full_path != root:
            raise HTTPException(status_code=400, detail="Path escapes VFS root")
        if not full_path.exists() or not full_path.is_file():
            raise HTTPException(status_code=404, detail="File not found")
        db = store()
        try:
            file_row = db.row("SELECT entity_id FROM vfs_files WHERE path = ?", (path,))
            return {
                "path": path,
                "entity_id": file_row["entity_id"] if file_row else None,
                "content": full_path.read_text(encoding="utf-8"),
            }
        finally:
            db.close()

    @app.get("/entities/{entity_id:path}/neighbors")
    def entity_neighbors(entity_id: str):
        db = store()
        try:
            return {"entity_id": entity_id, "neighbors": neighbors(db, entity_id)}
        finally:
            db.close()

    @app.get("/entities/{entity_id:path}")
    def entity(entity_id: str):
        db = store()
        try:
            row = db.row("SELECT * FROM entities WHERE id = ?", (entity_id,))
            if not row:
                raise HTTPException(status_code=404, detail="Entity not found")
            facts = db.rows(
                """
                SELECT f.*, s.dataset_path, s.record_id, s.raw_ref
                FROM facts f
                JOIN source_records s ON s.id = f.source_id
                WHERE f.subject_id = ?
                  AND f.status IN ('generated', 'confirmed')
                ORDER BY f.predicate, f.confidence DESC
                LIMIT 160
                """,
                (entity_id,),
            )
            return {"entity": dict(row), "facts": [dict(item) for item in facts]}
        finally:
            db.close()

    @app.get("/facts/{fact_id:path}/sources")
    def fact_sources(fact_id: str):
        db = store()
        try:
            rows = db.rows(
                """
                SELECT f.*, s.dataset_path, s.record_id, s.raw_ref, s.raw_json
                FROM facts f
                JOIN source_records s ON s.id = f.source_id
                WHERE f.id = ?
                """,
                (fact_id,),
            )
            if not rows:
                raise HTTPException(status_code=404, detail="Fact not found")
            return {"fact": dict(rows[0])}
        finally:
            db.close()

    @app.get("/search")
    def api_search(q: str = Query(...)):
        db = store()
        try:
            return {"query": q, "results": search(db, out_dir, q)}
        finally:
            db.close()

    @app.get("/reviews")
    def reviews():
        db = store()
        try:
            rows = db.rows("SELECT * FROM review_items ORDER BY created_at")
            return {"reviews": [dict(row) for row in rows]}
        finally:
            db.close()

    @app.post("/reviews/{review_id:path}/resolve")
    def resolve(review_id: str, body: ResolveBody):
        db = store()
        try:
            if not db.resolve_review(review_id, body.choice):
                raise HTTPException(status_code=404, detail="Review or choice not found")
            files_generated = refresh_review(db, review_id)
            return {"ok": True, "files_generated": files_generated}
        finally:
            db.close()

    @app.post("/entities")
    def create_entity(body: CreateEntityBody):
        db = store()
        try:
            existing = db.row("SELECT id FROM entities WHERE id = ?", (body.entity_id,))
            if existing:
                raise HTTPException(status_code=409, detail="Entity already exists")
            entity_path = body.path or f"company/{body.entity_type}s/{body.entity_id.replace(':', '-')}.md"
            db.upsert_entity(
                entity_id=body.entity_id,
                entity_type=body.entity_type,
                name=body.name,
                path=entity_path,
                summary=body.summary,
            )
            db.commit()
            files_generated = refresh_entities(db, [body.entity_id])
            return {
                "ok": True,
                "entity_id": body.entity_id,
                "path": entity_path,
                "files_generated": files_generated,
            }
        finally:
            db.close()

    @app.post("/entities/{entity_id:path}/facts")
    def add_fact(entity_id: str, body: AddFactBody):
        db = store()
        try:
            entity = db.row("SELECT * FROM entities WHERE id = ?", (entity_id,))
            if not entity:
                raise HTTPException(status_code=404, detail="Entity not found")
            fact_id = db.upsert_fact(
                subject_id=entity_id,
                predicate=body.predicate,
                source_id="source:manual",
                run_id="manual",
                value=body.value,
                object_entity_id=body.object_entity_id,
                confidence=body.confidence,
                status="confirmed",
                extraction_method="manual",
            )
            db.commit()
            files_generated = refresh_entities(db, [entity_id])
            return {"ok": True, "fact_id": fact_id, "files_generated": files_generated}
        finally:
            db.close()

    @app.patch("/facts/{fact_id:path}")
    def edit_fact(fact_id: str, body: EditFactBody):
        db = store()
        try:
            existing = db.row("SELECT * FROM facts WHERE id = ?", (fact_id,))
            if not existing:
                raise HTTPException(status_code=404, detail="Fact not found")
            refresh_ids = [existing["subject_id"]]
            if existing["object_entity_id"]:
                refresh_ids.append(existing["object_entity_id"])
            updates = []
            params: list[Any] = []
            if body.value is not None:
                updates.append("value = ?")
                params.append(body.value)
            if body.confidence is not None:
                updates.append("confidence = ?")
                params.append(body.confidence)
            if not updates:
                raise HTTPException(status_code=400, detail="No updates provided")
            updates.append("status = 'confirmed'")
            updates.append("updated_at = ?")
            params.append(now_iso())
            params.append(fact_id)
            db.conn.execute(
                f"UPDATE facts SET {', '.join(updates)} WHERE id = ?", params
            )
            db.commit()
            files_generated = refresh_entities(db, refresh_ids)
            return {"ok": True, "files_generated": files_generated}
        finally:
            db.close()

    @app.delete("/facts/{fact_id:path}")
    def delete_fact(fact_id: str):
        db = store()
        try:
            existing = db.row("SELECT subject_id, object_entity_id FROM facts WHERE id = ?", (fact_id,))
            if not existing:
                raise HTTPException(status_code=404, detail="Fact not found")
            refresh_ids = [existing["subject_id"]]
            if existing["object_entity_id"]:
                refresh_ids.append(existing["object_entity_id"])
            if not db.delete_fact(fact_id):
                raise HTTPException(status_code=404, detail="Fact not found")
            db.commit()
            files_generated = refresh_entities(db, refresh_ids)
            return {"ok": True, "files_generated": files_generated}
        finally:
            db.close()

    @app.delete("/entities/{entity_id:path}")
    def delete_entity(entity_id: str):
        db = store()
        try:
            existing = db.row("SELECT path FROM entities WHERE id = ?", (entity_id,))
            if not existing:
                raise HTTPException(status_code=404, detail="Entity not found")
            if not db.delete_entity(entity_id):
                raise HTTPException(status_code=404, detail="Entity not found")
            if existing["path"]:
                VFSGenerator(db, out_dir).remove_file(existing["path"])
            db.commit()
            files_generated = refresh_entities(db, [])
            return {"ok": True, "files_generated": files_generated}
        finally:
            db.close()

    @app.post("/vfs/refresh")
    def vfs_refresh():
        db = store()
        try:
            count = refresh_vfs(db)
            return {"ok": True, "files_generated": count}
        finally:
            db.close()

    return app


STATUS_PAGE_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Qontext API — Context Base</title>
  <style>
    :root {
      --bg: #f7f8fa; --panel: #fff; --ink: #171a1f; --muted: #667085;
      --line: #e4e7ec; --accent: #0d9488; --accent-dark: #0f766e;
      --accent-soft: #e6f4f1;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--ink); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 4px 24px rgba(16,24,40,.07); max-width: 560px; width: 100%; padding: 36px 40px; }
    .logo { display: flex; align-items: center; gap: 10px; margin-bottom: 24px; }
    .logo-hex { width: 36px; height: 36px; background: var(--accent-soft); border-radius: 8px; display: flex; align-items: center; justify-content: center; }
    .logo-hex svg { color: var(--accent-dark); }
    .logo-name { font-size: 20px; font-weight: 700; color: var(--accent-dark); }
    .logo-sub { font-size: 13px; color: var(--muted); margin-left: 2px; }
    h2 { font-size: 15px; font-weight: 600; margin-bottom: 12px; color: var(--ink); }
    .cta { display: block; background: var(--accent); color: #fff; text-decoration: none; font-weight: 600; font-size: 15px; text-align: center; padding: 13px 20px; border-radius: 8px; margin-bottom: 24px; transition: background .15s; }
    .cta:hover { background: var(--accent-dark); }
    .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 24px; }
    .stat { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 12px; text-align: center; }
    .stat-val { font-size: 22px; font-weight: 700; color: var(--accent-dark); }
    .stat-label { font-size: 11px; color: var(--muted); margin-top: 2px; text-transform: uppercase; letter-spacing: .04em; }
    .endpoints { border-top: 1px solid var(--line); padding-top: 20px; }
    .endpoint { display: flex; gap: 10px; align-items: baseline; padding: 5px 0; font-size: 13px; border-bottom: 1px solid var(--line); }
    .endpoint:last-child { border-bottom: none; }
    .method { font-family: monospace; font-size: 11px; font-weight: 700; background: var(--accent-soft); color: var(--accent-dark); border-radius: 4px; padding: 2px 6px; white-space: nowrap; }
    .method.post { background: #fef3c7; color: #92400e; }
    .method.patch { background: #ede9fe; color: #6d28d9; }
    .method.delete { background: #fee2e2; color: #b91c1c; }
    .path { font-family: monospace; font-size: 12px; color: var(--ink); }
    .desc { font-size: 12px; color: var(--muted); margin-left: auto; }
    .badge-ok { display: inline-block; background: #dcfce7; color: #15803d; font-size: 11px; font-weight: 700; border-radius: 999px; padding: 2px 10px; margin-left: 8px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <div class="logo-hex">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5"/>
        </svg>
      </div>
      <div>
        <div class="logo-name">Qontext <span class="logo-sub">API</span></div>
      </div>
      <span class="badge-ok" id="health-badge">checking…</span>
    </div>

    <a class="cta" href="http://localhost:5173" target="_blank">
      Open React Dashboard → localhost:5173
    </a>

    <h2>Graph Stats</h2>
    <div class="stats" id="stats-grid">
      <div class="stat"><div class="stat-val">—</div><div class="stat-label">Entities</div></div>
      <div class="stat"><div class="stat-val">—</div><div class="stat-label">Facts</div></div>
      <div class="stat"><div class="stat-val">—</div><div class="stat-label">Edges</div></div>
      <div class="stat"><div class="stat-val">—</div><div class="stat-label">Sources</div></div>
      <div class="stat"><div class="stat-val">—</div><div class="stat-label">Open Reviews</div></div>
    </div>

    <div class="endpoints">
      <h2 style="margin-bottom:12px">API Endpoints</h2>
      <div class="endpoint"><span class="method">GET</span><span class="path">/stats</span><span class="desc">Graph counts</span></div>
      <div class="endpoint"><span class="method">GET</span><span class="path">/search?q=…</span><span class="desc">Hybrid search</span></div>
      <div class="endpoint"><span class="method">GET</span><span class="path">/entities/{id}</span><span class="desc">Entity + facts</span></div>
      <div class="endpoint"><span class="method">GET</span><span class="path">/entities/{id}/neighbors</span><span class="desc">Graph edges</span></div>
      <div class="endpoint"><span class="method">GET</span><span class="path">/vfs/tree</span><span class="desc">VFS file list</span></div>
      <div class="endpoint"><span class="method">GET</span><span class="path">/vfs/file?path=…</span><span class="desc">Read VFS file</span></div>
      <div class="endpoint"><span class="method">GET</span><span class="path">/facts/{id}/sources</span><span class="desc">Raw provenance</span></div>
      <div class="endpoint"><span class="method">GET</span><span class="path">/reviews</span><span class="desc">Open conflicts</span></div>
      <div class="endpoint"><span class="method post">POST</span><span class="path">/reviews/{id}/resolve</span><span class="desc">Resolve conflict</span></div>
      <div class="endpoint"><span class="method post">POST</span><span class="path">/entities</span><span class="desc">Create entity</span></div>
      <div class="endpoint"><span class="method post">POST</span><span class="path">/entities/{id}/facts</span><span class="desc">Add fact</span></div>
      <div class="endpoint"><span class="method patch">PATCH</span><span class="path">/facts/{id}</span><span class="desc">Edit fact</span></div>
      <div class="endpoint"><span class="method delete">DELETE</span><span class="path">/facts/{id}</span><span class="desc">Delete fact</span></div>
      <div class="endpoint"><span class="method delete">DELETE</span><span class="path">/entities/{id}</span><span class="desc">Delete entity</span></div>
      <div class="endpoint"><span class="method post">POST</span><span class="path">/vfs/refresh</span><span class="desc">Regenerate VFS</span></div>
    </div>
  </div>

  <script>
    fetch('/health').then(r => r.json()).then(() => {
      document.getElementById('health-badge').textContent = 'API running';
      document.getElementById('health-badge').style.background = '#dcfce7';
      document.getElementById('health-badge').style.color = '#15803d';
    }).catch(() => {
      document.getElementById('health-badge').textContent = 'offline';
      document.getElementById('health-badge').style.background = '#fee2e2';
      document.getElementById('health-badge').style.color = '#b91c1c';
    });
    fetch('/stats').then(r => r.json()).then(d => {
      const vals = [d.entities, d.facts, d.edges, d.sources, d.open_reviews];
      document.querySelectorAll('#stats-grid .stat-val').forEach((el, i) => {
        el.textContent = (vals[i] ?? 0).toLocaleString();
      });
    }).catch(() => {});
  </script>
</body>
</html>
"""
