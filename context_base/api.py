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
        return HTMLResponse(CONTEXT_BROWSER_HTML)

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


CONTEXT_BROWSER_HTML = r"""
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Context Base Browser</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --panel: #ffffff;
      --ink: #171a1f;
      --muted: #667085;
      --line: #d9dee7;
      --line-soft: #edf0f5;
      --accent: #0f766e;
      --accent-soft: #e6f4f1;
      --danger: #b42318;
      --shadow: 0 1px 2px rgba(16, 24, 40, 0.08);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--ink);
    }
    button, input {
      font: inherit;
    }
    .app {
      display: grid;
      grid-template-columns: 320px minmax(420px, 1fr) 360px;
      min-height: 100vh;
    }
    .sidebar, .inspector {
      background: var(--panel);
      border-color: var(--line);
      min-width: 0;
    }
    .sidebar {
      border-right: 1px solid var(--line);
      display: flex;
      flex-direction: column;
    }
    .inspector {
      border-left: 1px solid var(--line);
      overflow: auto;
    }
    .brand {
      padding: 18px 18px 14px;
      border-bottom: 1px solid var(--line-soft);
    }
    .brand h1 {
      margin: 0;
      font-size: 18px;
      line-height: 1.2;
      letter-spacing: 0;
    }
    .brand p {
      margin: 7px 0 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.4;
    }
    .search-box {
      padding: 14px;
      border-bottom: 1px solid var(--line-soft);
    }
    .search-row {
      display: flex;
      gap: 8px;
    }
    input {
      width: 100%;
      min-width: 0;
      height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 10px;
      background: #fff;
      color: var(--ink);
    }
    button {
      height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--ink);
      padding: 0 10px;
      cursor: pointer;
    }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    button:hover {
      border-color: var(--accent);
    }
    .nav-tabs {
      display: grid;
      grid-template-columns: 1fr 1fr;
      padding: 10px 14px 0;
      gap: 8px;
    }
    .nav-tabs button {
      height: 32px;
      font-size: 13px;
    }
    .nav-tabs button.active {
      background: var(--accent-soft);
      border-color: var(--accent);
      color: var(--accent);
    }
    .list {
      overflow: auto;
      padding: 10px 8px 18px;
      flex: 1;
    }
    .item {
      width: 100%;
      min-height: 34px;
      height: auto;
      border: 0;
      border-radius: 6px;
      background: transparent;
      text-align: left;
      padding: 8px 10px;
      display: block;
      color: var(--ink);
    }
    .item:hover, .item.active {
      background: var(--accent-soft);
    }
    .item .path {
      font-size: 12px;
      color: var(--muted);
      overflow-wrap: anywhere;
    }
    .item .title {
      font-size: 13px;
      font-weight: 650;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .content {
      display: flex;
      flex-direction: column;
      min-width: 0;
      overflow: hidden;
    }
    .toolbar {
      height: 56px;
      background: var(--panel);
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 18px;
      gap: 12px;
    }
    .current-path {
      font-size: 13px;
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .toolbar-actions {
      display: flex;
      gap: 8px;
      flex: 0 0 auto;
    }
    .document {
      overflow: auto;
      padding: 24px;
    }
    .doc-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      max-width: 1040px;
      margin: 0 auto;
      padding: 28px;
    }
    .empty {
      color: var(--muted);
      text-align: center;
      padding: 72px 24px;
    }
    .md h1 { font-size: 28px; margin: 0 0 20px; letter-spacing: 0; }
    .md h2 { font-size: 17px; margin: 28px 0 12px; letter-spacing: 0; }
    .md p, .md li { line-height: 1.55; }
    .md code {
      background: #f2f4f7;
      border: 1px solid var(--line-soft);
      border-radius: 4px;
      padding: 1px 4px;
      font-size: 12px;
    }
    .md pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: #101828;
      color: #f8fafc;
      border-radius: 8px;
      padding: 14px;
      overflow: auto;
    }
    .md table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      table-layout: fixed;
    }
    .md th, .md td {
      border: 1px solid var(--line);
      padding: 8px;
      vertical-align: top;
      overflow-wrap: anywhere;
    }
    .md th {
      background: #f8fafc;
      text-align: left;
    }
    .raw {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      line-height: 1.5;
      display: none;
    }
    .inspector-section {
      padding: 18px;
      border-bottom: 1px solid var(--line-soft);
    }
    .inspector-section h2 {
      margin: 0 0 12px;
      font-size: 14px;
      letter-spacing: 0;
    }
    .kv {
      display: grid;
      grid-template-columns: 92px minmax(0, 1fr);
      gap: 7px 10px;
      font-size: 13px;
    }
    .kv .key { color: var(--muted); }
    .kv .value { overflow-wrap: anywhere; }
    .fact {
      border: 1px solid var(--line-soft);
      border-radius: 6px;
      padding: 9px;
      margin: 8px 0;
      background: #fff;
    }
    .fact button {
      margin-top: 8px;
      height: 28px;
      font-size: 12px;
    }
    .muted {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.4;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      border-radius: 999px;
      padding: 2px 8px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 12px;
      font-weight: 650;
    }
    .graph {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .node {
      height: auto;
      min-height: 30px;
      max-width: 100%;
      text-align: left;
      background: #fff;
      font-size: 12px;
    }
    .source-panel {
      display: none;
      position: fixed;
      inset: auto 24px 24px auto;
      width: min(620px, calc(100vw - 48px));
      max-height: min(620px, calc(100vh - 48px));
      overflow: auto;
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 18px 48px rgba(16, 24, 40, 0.22);
      padding: 16px;
      z-index: 10;
    }
    .source-panel.open { display: block; }
    .source-panel header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 10px;
    }
    .source-panel h2 {
      margin: 0;
      font-size: 15px;
    }
    .source-panel pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 12px;
      line-height: 1.45;
      background: #f8fafc;
      border: 1px solid var(--line-soft);
      border-radius: 8px;
      padding: 12px;
    }
    @media (max-width: 1100px) {
      .app {
        grid-template-columns: 280px minmax(0, 1fr);
      }
      .inspector {
        grid-column: 1 / -1;
        border-left: 0;
        border-top: 1px solid var(--line);
        max-height: 45vh;
      }
    }
    @media (max-width: 760px) {
      .app {
        grid-template-columns: 1fr;
      }
      .sidebar {
        max-height: 42vh;
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .toolbar {
        align-items: stretch;
        height: auto;
        padding: 12px;
        flex-direction: column;
      }
      .toolbar-actions {
        width: 100%;
      }
      .toolbar-actions button {
        flex: 1;
      }
      .document {
        padding: 12px;
      }
      .doc-card {
        padding: 18px;
      }
    }
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(16,24,40,0.4);
      z-index: 20;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .modal {
      background: var(--panel);
      border-radius: 8px;
      padding: 20px;
      width: min(480px, calc(100vw - 48px));
      box-shadow: 0 18px 48px rgba(16,24,40,0.22);
    }
    .modal h3 { margin: 0 0 14px; font-size: 16px; }
    .modal .field { margin-bottom: 10px; }
    .modal .field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
    .modal .field input, .modal .field textarea, .modal .field select { width: 100%; }
    .modal .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
    .btn-sm { height: 26px; font-size: 11px; padding: 0 7px; border-radius: 4px; }
    .btn-danger { color: var(--danger); border-color: var(--danger); }
    .btn-danger:hover { background: #fef2f2; }
    .add-btn { display: block; width: 100%; margin-top: 8px; font-size: 12px; color: var(--accent); border-style: dashed; }
  
  </style>
</head>
<body>
  <main class="app">
    <aside class="sidebar">
      <section class="brand">
        <h1>Context Base</h1>
        <p>Inspect the generated virtual file system, graph links, facts, and provenance.</p>
      </section>
      <section class="search-box">
        <div class="search-row">
          <input id="searchInput" placeholder="Search context..." />
          <button id="searchButton" class="primary">Search</button>
        </div>
      </section>
      <nav class="nav-tabs">
        <button id="treeTab" class="active">Files</button>
        <button id="searchTab">Results</button>
      </nav>
      <section id="treeList" class="list"></section>
      <section id="searchList" class="list" style="display:none"></section>
    </aside>

    <section class="content">
      <header class="toolbar">
        <div id="currentPath" class="current-path">No file selected</div>
        <div class="toolbar-actions">
          <button id="previewButton" class="active">Preview</button>
          <button id="rawButton">Raw</button>
          <button id="refreshButton">Refresh</button>
        </div>
      </header>
      <section class="document">
        <article class="doc-card">
          <div id="emptyState" class="empty">Choose a file or run a search to inspect company context.</div>
          <div id="markdownView" class="md"></div>
          <pre id="rawView" class="raw"></pre>
        </article>
      </section>
    </section>

    <aside class="inspector">
      <section class="inspector-section" style="display:flex;justify-content:space-between;align-items:center">
        <h2 style="margin:0">Entity</h2>
        <button id="newEntityBtn" class="btn-sm primary" style="display:none">+ New Entity</button>
      </section>
      <section class="inspector-section">
        <div id="entityDetails" class="muted">No entity selected.</div>
      </section>
      <section class="inspector-section">
        <h2>Graph Neighbors</h2>
        <div id="graphView" class="graph muted">No graph loaded.</div>
      </section>
      <section class="inspector-section">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h2 style="margin:0">Facts</h2>
          <button id="addFactBtn" class="btn-sm primary" style="display:none">+ Add Fact</button>
        </div>
        <div id="factsView" class="muted" style="margin-top:10px">No facts loaded.</div>
      </section>
      <section class="inspector-section">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h2 style="margin:0">Open Reviews</h2>
          <button id="reloadReviewsBtn" class="btn-sm">Reload</button>
        </div>
        <div id="reviewsView" class="muted" style="margin-top:10px">No reviews loaded.</div>
      </section>
    </aside>
  </main>

  <section id="sourcePanel" class="source-panel">
    <header>
      <h2>Source Record</h2>
      <button id="closeSource">Close</button>
    </header>
    <pre id="sourceContent"></pre>
  </section>

  <div id="modalOverlay" class="modal-overlay" style="display:none">
    <div class="modal">
      <h3 id="modalTitle">Edit</h3>
      <div id="modalBody"></div>
      <div class="actions">
        <button id="modalCancel">Cancel</button>
        <button id="modalSave" class="primary">Save</button>
      </div>
    </div>
  </div>

  <script>
    const state = {
      files: [],
      selectedPath: null,
      selectedEntityId: null,
      currentFacts: [],
      currentReviews: [],
      modalSubmit: null,
      rawMarkdown: "",
      mode: "preview"
    };

    const byId = (id) => document.getElementById(id);

    async function api(path, options) {
      const response = await fetch(path, options);
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`${response.status} ${text}`);
      }
      return response.json();
    }

    async function refreshVfsAndSelection(path = state.selectedPath) {
      await api("/vfs/refresh", { method: "POST" });
      await loadTree();
      if (path) {
        await openFile(path);
      }
    }

    function escapeHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function inlineMarkdown(value) {
      return escapeHtml(value)
        .replace(/`\[\[([^|\]]+)\|([^\]]+)\]\]`/g, "<code>[[$1|$2]]</code>")
        .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "<button class=\"node\" data-path=\"$1\">$2</button>")
        .replace(/\[\[([^\]]+)\]\]/g, "<button class=\"node\" data-path=\"$1\">$1</button>")
        .replace(/`([^`]+)`/g, "<code>$1</code>");
    }

    function renderMarkdown(markdown) {
      const body = markdown.replace(/^---[\s\S]*?---\s*/, "");
      const lines = body.split("\n");
      const html = [];
      let inList = false;
      let index = 0;

      function closeList() {
        if (inList) {
          html.push("</ul>");
          inList = false;
        }
      }

      while (index < lines.length) {
        const line = lines[index];
        if (!line.trim()) {
          closeList();
          index += 1;
          continue;
        }
        if (line.startsWith("# ")) {
          closeList();
          html.push(`<h1>${inlineMarkdown(line.slice(2))}</h1>`);
          index += 1;
          continue;
        }
        if (line.startsWith("## ")) {
          closeList();
          html.push(`<h2>${inlineMarkdown(line.slice(3))}</h2>`);
          index += 1;
          continue;
        }
        if (line.startsWith("|") && lines[index + 1]?.startsWith("|---")) {
          closeList();
          const headers = line.split("|").slice(1, -1).map(cell => cell.trim());
          index += 2;
          const rows = [];
          while (lines[index]?.startsWith("|")) {
            rows.push(lines[index].split("|").slice(1, -1).map(cell => cell.trim()));
            index += 1;
          }
          html.push("<table><thead><tr>" + headers.map(h => `<th>${inlineMarkdown(h)}</th>`).join("") + "</tr></thead><tbody>");
          for (const row of rows) {
            html.push("<tr>" + row.map(cell => `<td>${inlineMarkdown(cell)}</td>`).join("") + "</tr>");
          }
          html.push("</tbody></table>");
          continue;
        }
        if (line.startsWith("- ")) {
          if (!inList) {
            html.push("<ul>");
            inList = true;
          }
          html.push(`<li>${inlineMarkdown(line.slice(2))}</li>`);
          index += 1;
          continue;
        }
        closeList();
        html.push(`<p>${inlineMarkdown(line)}</p>`);
        index += 1;
      }
      closeList();
      return html.join("");
    }

    function entityIdFromMarkdown(markdown) {
      const match = markdown.match(/^id:\s*(.+)$/m);
      return match ? match[1].trim() : null;
    }

    function setMode(mode) {
      state.mode = mode;
      byId("markdownView").style.display = mode === "preview" ? "block" : "none";
      byId("rawView").style.display = mode === "raw" ? "block" : "none";
      byId("previewButton").classList.toggle("active", mode === "preview");
      byId("rawButton").classList.toggle("active", mode === "raw");
    }

    function selectTab(tab) {
      byId("treeList").style.display = tab === "tree" ? "block" : "none";
      byId("searchList").style.display = tab === "search" ? "block" : "none";
      byId("treeTab").classList.toggle("active", tab === "tree");
      byId("searchTab").classList.toggle("active", tab === "search");
    }

    function renderTree(filter = "") {
      const list = byId("treeList");
      const needle = filter.trim().toLowerCase();
      const files = state.files.filter(path => !needle || path.toLowerCase().includes(needle)).slice(0, 600);
      list.innerHTML = files.map(path => `
        <button class="item ${path === state.selectedPath ? "active" : ""}" data-path="${escapeHtml(path)}">
          <div class="title">${escapeHtml(path.split("/").pop())}</div>
          <div class="path">${escapeHtml(path)}</div>
        </button>
      `).join("") || "<div class=\"empty\">No files found.</div>";
    }

    async function loadTree() {
      const payload = await api("/vfs/tree");
      state.files = payload.files || [];
      renderTree();
      byId("newEntityBtn").style.display = "inline-flex";
      await loadReviews();
    }

    async function openFile(path) {
      const payload = await api(`/vfs/file?path=${encodeURIComponent(path)}`);
      state.selectedPath = path;
      state.rawMarkdown = payload.content;
      state.selectedEntityId = entityIdFromMarkdown(payload.content);
      byId("currentPath").textContent = path;
      byId("emptyState").style.display = "none";
      byId("markdownView").innerHTML = renderMarkdown(payload.content);
      byId("rawView").textContent = payload.content;
      renderTree(byId("searchInput").value);
      setMode(state.mode);
      if (state.selectedEntityId) {
        await loadEntity(state.selectedEntityId);
      }
    }

    async function loadEntity(entityId) {
      const payload = await api(`/entities/${encodeURIComponent(entityId)}`);
      const entity = payload.entity;
      state.selectedEntityId = entity.id;
      byId("entityDetails").innerHTML = `
        <div class="kv">
          <div class="key">ID</div><div class="value"><code>${escapeHtml(entity.id)}</code></div>
          <div class="key">Type</div><div class="value"><span class="badge">${escapeHtml(entity.type)}</span></div>
          <div class="key">Name</div><div class="value">${escapeHtml(entity.name)}</div>
          <div class="key">Path</div><div class="value">${escapeHtml(entity.path || "none")}</div>
        </div>
      `;
      byId("addFactBtn").style.display = "inline-flex";
      renderFacts(payload.facts || []);
      const graphPayload = await api(`/entities/${encodeURIComponent(entityId)}/neighbors`);
      renderGraph(graphPayload.neighbors || []);
    }

    function renderGraph(neighbors) {
      const target = byId("graphView");
      if (!neighbors.length) {
        target.innerHTML = "No graph neighbors.";
        return;
      }
      target.classList.remove("muted");
      target.innerHTML = neighbors.map(item => `
        <button class="node" title="${escapeHtml(item.relation)}" data-path="${escapeHtml(item.path || "")}" data-entity="${escapeHtml(item.entity_id)}">
          ${escapeHtml(item.direction)} · ${escapeHtml(item.relation)}<br>
          <strong>${escapeHtml(item.name)}</strong>
        </button>
      `).join("");
    }

    function renderFacts(facts) {
      state.currentFacts = facts;
      const target = byId("factsView");
      if (!facts.length) {
        target.innerHTML = "<div class=\"muted\">No facts.</div>";
        return;
      }
      target.classList.remove("muted");
      target.innerHTML = facts.slice(0, 80).map(fact => `
        <div class="fact">
          <div><strong>${escapeHtml(fact.predicate)}</strong></div>
          <div class="muted">${escapeHtml(fact.value || fact.object_entity_id || "")}</div>
          <button class="btn-sm" data-fact="${escapeHtml(fact.id)}">Source</button>
          <button class="btn-sm" data-action="edit-fact" data-fact="${escapeHtml(fact.id)}">Edit</button>
          <button class="btn-sm btn-danger" data-action="delete-fact" data-fact="${escapeHtml(fact.id)}">Delete</button>
        </div>
      `).join("");
    }

    function openModal(title, bodyHtml, onSubmit) {
      byId("modalTitle").textContent = title;
      byId("modalBody").innerHTML = bodyHtml;
      state.modalSubmit = onSubmit;
      byId("modalOverlay").style.display = "flex";
    }

    function closeModal() {
      byId("modalOverlay").style.display = "none";
      byId("modalBody").innerHTML = "";
      state.modalSubmit = null;
    }

    function inputValue(id) {
      return byId(id)?.value?.trim() || "";
    }

    function numberValue(id, fallback = 1) {
      const raw = inputValue(id);
      if (!raw) return fallback;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : fallback;
    }

    function openNewEntityModal() {
      openModal("New Entity", `
        <div class="field"><label>Entity ID</label><input id="newEntityId" placeholder="project:acme-renewal-2026" /></div>
        <div class="field"><label>Type</label><input id="newEntityType" placeholder="project" /></div>
        <div class="field"><label>Name</label><input id="newEntityName" placeholder="ACME renewal 2026" /></div>
        <div class="field"><label>Path</label><input id="newEntityPath" placeholder="company/projects/acme-renewal-2026.md" /></div>
        <div class="field"><label>Summary</label><textarea id="newEntitySummary" rows="3"></textarea></div>
      `, async () => {
        const entityId = inputValue("newEntityId");
        const entityType = inputValue("newEntityType");
        const name = inputValue("newEntityName");
        if (!entityId || !entityType || !name) {
          throw new Error("Entity ID, type, and name are required.");
        }
        const payload = {
          entity_id: entityId,
          entity_type: entityType,
          name,
          path: inputValue("newEntityPath") || null,
          summary: inputValue("newEntitySummary") || null
        };
        const created = await api("/entities", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        closeModal();
        await refreshVfsAndSelection(created.path);
      });
    }

    function openAddFactModal() {
      if (!state.selectedEntityId) return;
      openModal("Add Fact", `
        <div class="field"><label>Predicate</label><input id="factPredicate" placeholder="status" /></div>
        <div class="field"><label>Value</label><textarea id="factValue" rows="3"></textarea></div>
        <div class="field"><label>Target Entity ID</label><input id="factTarget" placeholder="employee:emp_0431" /></div>
        <div class="field"><label>Confidence</label><input id="factConfidence" value="1.0" /></div>
      `, async () => {
        const predicate = inputValue("factPredicate");
        if (!predicate) {
          throw new Error("Predicate is required.");
        }
        await api(`/entities/${encodeURIComponent(state.selectedEntityId)}/facts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            predicate,
            value: inputValue("factValue") || null,
            object_entity_id: inputValue("factTarget") || null,
            confidence: numberValue("factConfidence", 1)
          })
        });
        closeModal();
        await refreshVfsAndSelection();
      });
    }

    function openEditFactModal(factId) {
      const fact = state.currentFacts.find(item => item.id === factId);
      if (!fact) return;
      openModal("Edit Fact", `
        <div class="field"><label>Predicate</label><input value="${escapeHtml(fact.predicate)}" disabled /></div>
        <div class="field"><label>Value</label><textarea id="editFactValue" rows="4">${escapeHtml(fact.value || "")}</textarea></div>
        <div class="field"><label>Confidence</label><input id="editFactConfidence" value="${escapeHtml(fact.confidence ?? 1)}" /></div>
      `, async () => {
        await api(`/facts/${encodeURIComponent(factId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            value: inputValue("editFactValue"),
            confidence: numberValue("editFactConfidence", fact.confidence ?? 1)
          })
        });
        closeModal();
        await refreshVfsAndSelection();
      });
    }

    async function deleteFact(factId) {
      if (!confirm("Delete this fact from the context base?")) return;
      await api(`/facts/${encodeURIComponent(factId)}`, { method: "DELETE" });
      await refreshVfsAndSelection();
    }

    async function loadReviews() {
      const payload = await api("/reviews");
      state.currentReviews = (payload.reviews || []).filter(item => item.status === "open");
      renderReviews();
    }

    function renderReviews() {
      const target = byId("reviewsView");
      if (!state.currentReviews.length) {
        target.innerHTML = "<div class=\"muted\">No open reviews.</div>";
        return;
      }
      target.innerHTML = state.currentReviews.slice(0, 12).map(review => {
        let choices = [];
        try { choices = JSON.parse(review.candidates_json || "[]"); } catch (_) {}
        return `
          <div class="fact">
            <div><strong>${escapeHtml(review.predicate)}</strong></div>
            <div class="muted">${escapeHtml(review.entity_id)} · ${escapeHtml(review.conflict_type)}</div>
            ${choices.map(choice => `
              <button class="btn-sm" data-action="resolve-review" data-review="${escapeHtml(review.id)}" data-choice="${escapeHtml(choice.choice_id)}">
                ${escapeHtml(choice.choice_id)}
              </button>
            `).join("")}
          </div>
        `;
      }).join("");
    }

    async function resolveReview(reviewId, choice) {
      await api(`/reviews/${encodeURIComponent(reviewId)}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choice })
      });
      await refreshVfsAndSelection();
      await loadReviews();
    }

    async function runSearch() {
      const query = byId("searchInput").value.trim();
      if (!query) {
        renderTree();
        selectTab("tree");
        return;
      }
      const payload = await api(`/search?q=${encodeURIComponent(query)}`);
      const results = payload.results || [];
      byId("searchList").innerHTML = results.map(item => `
        <button class="item" data-path="${escapeHtml(item.path || "")}" data-entity="${escapeHtml(item.entity_id || "")}">
          <div class="title">${escapeHtml(item.name || item.path || item.kind)}</div>
          <div class="path">${escapeHtml(item.kind)} ${item.type ? "· " + escapeHtml(item.type) : ""}</div>
          <div class="path">${escapeHtml(item.snippet || "")}</div>
        </button>
      `).join("") || "<div class=\"empty\">No search results.</div>";
      selectTab("search");
    }

    async function showSource(factId) {
      const payload = await api(`/facts/${encodeURIComponent(factId)}/sources`);
      byId("sourceContent").textContent = JSON.stringify(payload.fact, null, 2);
      byId("sourcePanel").classList.add("open");
    }

    document.addEventListener("click", async (event) => {
      const actionButton = event.target.closest("[data-action]");
      if (actionButton) {
        const action = actionButton.dataset.action;
        const factId = actionButton.dataset.fact;
        if (action === "edit-fact" && factId) openEditFactModal(factId);
        if (action === "delete-fact" && factId) await deleteFact(factId);
        if (action === "resolve-review") await resolveReview(actionButton.dataset.review, actionButton.dataset.choice);
        return;
      }
      const pathButton = event.target.closest("[data-path]");
      if (pathButton) {
        const path = pathButton.dataset.path;
        if (path) {
          await openFile(path);
          return;
        }
      }
      const entityButton = event.target.closest("[data-entity]");
      if (entityButton && entityButton.dataset.entity) {
        await loadEntity(entityButton.dataset.entity);
        return;
      }
      const factButton = event.target.closest("[data-fact]");
      if (factButton) {
        await showSource(factButton.dataset.fact);
      }
    });

    byId("searchButton").addEventListener("click", runSearch);
    byId("searchInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter") runSearch();
    });
    byId("searchInput").addEventListener("input", (event) => {
      renderTree(event.target.value);
    });
    byId("treeTab").addEventListener("click", () => selectTab("tree"));
    byId("searchTab").addEventListener("click", () => selectTab("search"));
    byId("previewButton").addEventListener("click", () => setMode("preview"));
    byId("rawButton").addEventListener("click", () => setMode("raw"));
    byId("refreshButton").addEventListener("click", async () => {
      await loadTree();
      if (state.selectedPath) await openFile(state.selectedPath);
    });
    byId("newEntityBtn").addEventListener("click", openNewEntityModal);
    byId("addFactBtn").addEventListener("click", openAddFactModal);
    byId("reloadReviewsBtn").addEventListener("click", loadReviews);
    byId("modalCancel").addEventListener("click", closeModal);
    byId("modalSave").addEventListener("click", async () => {
      if (!state.modalSubmit) return;
      try {
        await state.modalSubmit();
      } catch (error) {
        alert(error.message);
      }
    });
    byId("closeSource").addEventListener("click", () => {
      byId("sourcePanel").classList.remove("open");
    });

    loadTree().then(() => {
      const preferred = state.files.find(path => path === "company/tickets/1032.md") || state.files[0];
      if (preferred) openFile(preferred);
    }).catch(error => {
      byId("emptyState").textContent = error.message;
    });
  </script>
</body>
</html>
"""
