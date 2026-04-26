# 🏆 Qontext Hackathon — Project Evaluation

> Evaluating **context-agent** against every requirement in the Qontext track brief.
> All 13 backend tests pass ✅ — this review focuses on criteria coverage, not basic correctness.

---

## 📊 Executive Scorecard

| Criteria | Score | Notes |
|---|---|---|
| **Virtual File System** | ⭐⭐⭐⭐⭐ | Excellent. Rich markdown VFS with index pages, per-type folders, cross-links, provenance tables, source coverage dashboard. |
| **Knowledge Graph** | ⭐⭐⭐⭐☆ | Solid entities → facts → edges model in SQLite. Missing: temporal queries, confidence-weighted graph traversal. |
| **Provenance at fact level** | ⭐⭐⭐⭐⭐ | Every fact links to `source_records` with `dataset_path`, `record_id`, `raw_json`. VFS renders `## Provenance` per entity. |
| **Conflict resolution (auto)** | ⭐⭐⭐⭐☆ | Source-of-truth rules + LLM synonym detection. Solid. Slightly narrow predicate whitelist for detection. |
| **Conflict resolution (human)** | ⭐⭐⭐⭐⭐ | Full review queue UI with keyboard nav (J/K/A/S), anchor vs variant cards, and immediate VFS regeneration. |
| **Generalization beyond dataset** | ⭐⭐⭐⭐☆ | Declarative `dataset_schema.json` engine is powerful. Any JSON/CSV source is plug-and-play. |
| **Auto-update when sources change** | ⭐⭐⭐⭐⭐ | Incremental builds track `record_hash`, mark stale sources, clean orphaned entities. Test-proven. |
| **AI interoperability** | ⭐⭐⭐⭐⭐ | 9-tool MCP server with full CRUD. SKILLS.md agent workflow. Test-proven end-to-end. |
| **Product surface quality** | ⭐⭐⭐⭐☆ | React dashboard with 3 views (Dashboard, Browser, Reviews). Clean design. Could be more polished. |
| **Graph retrieval** | ⭐⭐⭐⭐☆ | FTS5 + semantic vector search + LIKE fallback. Layered strategy. Could expose graph traversal queries. |

**Overall: Strong submission** — covers every mandatory requirement and most bonus criteria. Some gaps below.

---

## ✅ What's Done Right (Strengths)

### 1. Architecture is genuinely a "context base", not a chatbot
The challenge explicitly says *"this is not about building a documentation chatbot."* Your project doesn't build a RAG chatbot — it builds a structured, inspectable graph + VFS that AI agents consume via MCP. This aligns perfectly.

### 2. Fact-level provenance is first-class
Every fact in the system traces back to a specific source record with:
- `dataset_path` — which file it came from
- `record_id` — which record within that file
- `raw_json` — the full raw source payload
- `raw_ref` — human-readable source reference

This is rendered in every VFS markdown file under `## Provenance`. The judges can click any fact and drill to the raw source. This is exactly what they asked for.

### 3. Incremental builds are production-grade
The `record_hash` system correctly:
- Skips unchanged sources (tested: `test_incremental_build_skips_unchanged_sources`)
- Removes entities/VFS files when sources are deleted (tested: `test_incremental_build_removes_entities_and_vfs_for_deleted_sources`)
- Preserves manual facts across rebuilds (tested: `test_manual_fact_survives_rebuild`)
- Marks stale sources and cleans up orphans

This directly addresses the criteria: *"update automatically when source facts change."*

### 4. Declarative schema engine for generalization
The `dataset_schema.json` approach means adding a new data source requires zero Python code — just a JSON declaration with `path`, `id_field`, `entity_type`, `facts[]`, and optional `entity_ref` links. This addresses *"generalize beyond the provided dataset and data format."*

### 5. Human-in-the-loop is genuine, not cosmetic
The `ReviewQueue` component has:
- Keyboard shortcuts (J/K navigate, A accept top candidate, S skip)
- Side-by-side anchor vs variant comparison with confidence scores
- AI-suggested resolution text
- Optimistic removal from queue after resolution
- VFS regeneration on resolve

This is a real workflow, not just a button.

### 6. MCP server is comprehensive
9 tools covering the full agent lifecycle:
```
search_context → get_entity_context → read_vfs_file → get_fact_source
→ list_review_items → resolve_review_item → add_entity_fact
→ list_vfs_files → get_context_base_status
```
Tested end-to-end in `test_mcp_tools_support_agent_judgement_workflow`.

---

## ⚠️ Issues & Gaps (What Judges Will Notice)

### 🔴 Critical Issues

#### 1. No CORS middleware on the FastAPI backend
The React UI (`localhost:5173`) calls the FastAPI backend (`localhost:8000`). Without CORS headers, the browser will block all API requests in production. The Vite proxy config likely masks this in dev, but:

- **If a judge runs `npm run build` + serves the static UI separately**, nothing will work.
- Check [vite.config.ts](file:///Users/x/projects/dev/context-agent/ui/vite.config.ts) to confirm the proxy exists.

**Fix:** Add `CORSMiddleware` to the FastAPI app in [api.py](file:///Users/x/projects/dev/context-agent/context_base/api.py#L20).

#### 2. The embedded HTML browser in `api.py` (lines 318-1268) is dead weight
There's a ~950-line HTML string (`CONTEXT_BROWSER_HTML`) embedded in the API file that serves a completely separate, inferior browser at `GET /`. This is:
- **Confusing for judges** who might hit `localhost:8000/` and see this old interface instead of the React dashboard
- Dead code that adds ~40KB to the module
- The React UI is the real product surface

**Fix:** Replace the `GET /` endpoint with a redirect to the React dev server or a simple "API running, start UI with `npm run dev`" message.

#### 3. The conflict detection predicate whitelist is very narrow
[ingest.py:693](file:///Users/x/projects/dev/context-agent/context_base/ingest.py#L693) limits conflict detection to only 6 predicates:
```python
AND predicate IN ('name', 'email', 'department', 'priority', 'poc_status', 'current_poc_product')
```
This means if two sources disagree on `salary`, `level`, `skills`, `industry`, `status`, etc., no conflict is detected. The challenge says *"resolve easy information conflicts automatically and involve humans where ambiguity actually matters"* — but most ambiguity is invisible.

**Fix:** Either expand the whitelist significantly, or better yet, detect conflicts on ALL predicates where `confidence >= 0.8` and distinct values exist.

---

### 🟡 Medium Issues

#### 4. VFS files are not truly "editable" from the UI
The challenge says *"inspect, validate, edit, and extend the company memory."* Your system supports:
- ✅ Inspect (VFS browser, entity inspector)
- ✅ Validate (provenance, source drill-down)
- ⚠️ Edit (only via fact-level CRUD; no direct markdown editing of VFS files)
- ✅ Extend (create entity, add fact)

The VFS markdown files are always regenerated from the graph. There's no way for a human to annotate or edit a VFS file directly and have that persist. Consider adding a `human_annotation` section that survives regeneration.

#### 5. No temporal/versioning dimension on facts
The schema has `valid_from` and `valid_to` columns, but they're never populated by any extractor. The challenge mentions *"trajectory information (tasks, projects, progress)"* — having temporal facts would strengthen the "trajectory" story.

#### 6. Dashboard is minimal
The `Dashboard.tsx` shows 5 stat cards and a type breakdown. For a hackathon demo, consider:
- Recent activity / last build timestamp
- Health indicators (stale sources %, review backlog)
- A mini graph visualization (even just counts/edges) 
- Ingestion progress or coverage heatmap

#### 7. No graph visualization
The challenge says *"Interactive Context Graph"* in the README, but the actual UI shows graph neighbors as a flat list of clickable cards. There's no actual graph/network visualization (e.g., d3-force, vis.js, or sigma.js). This is a **significant visual miss** for a demo — judges expect to see nodes and edges.

#### 8. The "Explainable Context Map" is good but needs polish
The 3-column layout (Incoming → Object → Outgoing) with evidence panels is genuinely well-designed. But:
- The evidence grid categorization is purely client-side heuristic, not reflected in the data model
- The "Static Business Facts" vs "Procedural Knowledge" vs "Trajectory" split would be more powerful if it was a first-class concept in the VFS

---

### 🟢 Minor Issues

#### 9. `context_base_out.zip` is 1.3GB and checked into the repo
This is likely the full build output. It should be in `.gitignore`.

#### 10. Python 3.9 deprecation warnings in tests
The test output shows `google-auth` and `urllib3` warnings about Python 3.9 EOL. Not a code issue, but noisy for judges.

#### 11. README mentions `gemini-3.1-flash-lite` — verify this is the correct model name
The actual code in [llm.py:8](file:///Users/x/projects/dev/context-agent/context_base/llm.py#L8) uses `gemini-3.1-flash-lite-preview`. Make sure the README matches the code.

---

## 🎯 Priority Recommendations (Ranked by Impact)

### Must-Do Before Submission

| # | What | Why | Effort |
|---|---|---|---|
| 1 | **Add CORS middleware** | Without it, the built UI cannot talk to the API | 5 min |
| 2 | **Remove/redirect the embedded HTML browser** | Judges hitting `localhost:8000/` will be confused | 10 min |
| 3 | **Widen conflict detection predicates** | Current 6-predicate whitelist misses most conflicts | 15 min |
| 4 | **Fix README model name** | `gemini-3.1-flash-lite` vs `gemini-3.1-flash-lite-preview` | 2 min |
| 5 | **Add `.gitignore` entry for `context_base_out.zip`** | 1.3GB artifact shouldn't ship | 1 min |

### Should-Do for Strong Impression

| # | What | Why | Effort |
|---|---|---|---|
| 6 | **Add a simple graph visualization** | Biggest visual gap vs. judge expectations | 2-3 hrs |
| 7 | **Enhance Dashboard** with health, coverage, recent changes | Makes the "product surface" feel real | 1-2 hrs |
| 8 | **Populate `valid_from`/`valid_to`** on date-bearing facts | Strengthens "trajectory" story | 1 hr |
| 9 | **Support VFS annotations** that persist through rebuilds | Addresses "editable" criteria gap | 1-2 hrs |

### Nice-to-Have

| # | What | Why | Effort |
|---|---|---|---|
| 10 | Add a "What changed" diff view after incremental builds | Demonstrates the auto-update story live | 2 hrs |
| 11 | Add confidence threshold filter in the UI | Let users see only high-confidence facts | 30 min |
| 12 | Add CSV export of the entity graph | Makes the VFS "useful in practice" | 30 min |

---

## 📝 Criteria-by-Criteria Deep Dive

### "A virtual file system that documents the business"

✅ **Static data**: Employees, customers, products all get individual markdown files with facts tables.
✅ **Procedural knowledge**: Policy documents extracted (PDF → text → facts), deterministic process templates generated, LLM-extracted processes with steps.
✅ **Trajectory information**: Work items, tasks, and projects extracted from emails/conversations/posts. Heuristic but functional.
⚠️ **Temporal trajectory**: `valid_from`/`valid_to` columns exist but are never populated. This is the weakest part of "trajectory."

### "Explicit references both inside and outside the graph"

✅ **Inside graph**: `[[path|label]]` wiki-links between entity files. `## Related Files` section. `## Relationships` with outgoing/incoming edges.
✅ **Outside graph (to sources)**: Every fact table row includes `Source` column with `dataset_path#record_id`. `## Provenance` section lists all source records.

### "Interface(s) that enable AI systems to efficiently retrieve context"

✅ **MCP server** with 9 tools, fully tested.
✅ **HTTP API** with 15+ endpoints (search, entities, facts, reviews, VFS).
✅ **CLI** with `search`, `entity`, `sources`, `read` commands.
✅ **FTS5 + semantic search** for retrieval.

### "Both business users and AI systems to inspect, validate, edit, and extend"

✅ **Inspect**: React browser with VFS tree, entity inspector, fact cards, provenance drill-down.
✅ **Validate**: Source panel shows raw JSON. Confidence scores visible. Extraction method shown.
⚠️ **Edit**: Fact-level editing only. No VFS-level annotations.
✅ **Extend**: Create entity, add fact, manual annotations via UI/MCP/API.

### "Generalize beyond the provided dataset and data format"

✅ **Schema engine**: `dataset_schema.json` supports any JSON/CSV source with declarative mapping.
✅ **Built-in extractors**: 8 dedicated extractors + 1 generic schema extractor.
⚠️ **Format limitation**: Only JSON and CSV. No XML, Parquet, or database connectors. Acceptable for hackathon.

### "Resolve easy information conflicts automatically"

✅ **Normalization**: Case-insensitive dedup.
✅ **Source-of-truth rules**: HR wins for employee data, ITSM wins for tickets, etc.
✅ **LLM synonym detection**: Gemini checks if two values are functionally identical.
⚠️ **Narrow scope**: Only 6 predicates checked. Most conflicts invisible.

### "Involve humans where ambiguity actually matters"

✅ **Review queue** with full UI workflow.
✅ **Resume identity mismatch** detection (HR vs resume names/emails).
✅ **MCP tools** for agents to list and resolve reviews.
⚠️ **Could be stronger**: No severity ranking, no batch resolution, no assignment of reviews to specific users.

### "Preserve provenance at the fact level"

✅ **Fully implemented**. Every fact → source record → raw JSON/dataset path/record ID.

### "Update automatically when source facts change"

✅ **Fully implemented** and tested. Hash-based change detection, stale source marking, orphan cleanup.

---

## 🏁 Verdict

**This is a strong, well-architected submission** that genuinely addresses the challenge's core premise: building a structured context base, not a chatbot. The provenance system, incremental updates, and MCP integration are standout features.

The main risks for judging are:
1. **Missing graph visualization** — judges expect to see a graph when you call it a "knowledge graph"
2. **Narrow conflict detection** — the system looks smart but has a blind spot on most predicates
3. **The old HTML browser at `GET /`** — this could confuse judges who don't start with the React UI

Fix those three and this project is very competitive for the gold bar. 🪙
