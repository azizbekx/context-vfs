# Qontext Agent Skill

Use this workflow when acting as an AI agent or judge over the generated company
context base.

## Goal

Decide whether a business task is answered by source-backed company memory, then
cite the exact context used.

## MCP Workflow

1. Call `get_context_base_status` to check graph, source, VFS, and review counts.
2. Call `search_context` with the task query.
3. Pick the best entity or file result.
4. Call `get_entity_context` for entity details, facts, and graph neighbors.
5. Call `read_vfs_file` for the generated human-readable file.
6. Call `get_fact_source` before citing any important fact.
7. Call `list_review_items` when ambiguity or conflicts may affect the answer.
8. Call `add_entity_fact` only when adding an explicit manual judgement or
   verified human/agent annotation.
9. Call `resolve_review_item` only when the task gives enough evidence to choose
   one of the review candidates.

## Evidence Rules

- Prefer facts with source records over summary-only text.
- Cite entity IDs, VFS paths, fact IDs, and raw source refs.
- Mention unresolved review items when they could affect the conclusion.
- Do not invent missing company facts.
- Treat `source:manual` facts as annotations, not original source data.

## HTTP API Equivalents

- `GET /stats`
- `GET /search?q=<query>`
- `GET /entities/{entity_id}`
- `GET /entities/{entity_id}/neighbors`
- `GET /vfs/file?path=<path>`
- `GET /facts/{fact_id}/sources`
- `GET /reviews`
- `POST /entities/{entity_id}/facts`
- `POST /reviews/{review_id}/resolve`

