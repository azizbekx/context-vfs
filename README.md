# Qontext AI - Enterprise Context Base

Public repository: https://github.com/azizbekx/context-vfs

Qontext AI turns fragmented enterprise data into an inspectable, editable
company memory that AI systems can operate on. The project ingests a simulated
company dataset, builds a SQLite-backed knowledge graph, generates a virtual
file system (VFS) of source-backed Markdown files, and exposes the result to
humans through a React dashboard and to AI agents through MCP tools.

This is not a documentation chatbot. The durable output is a context base:
entities, facts, relationships, provenance, review items, and generated files
that can be searched, inspected, validated, edited, and regenerated when source
records change.

## What This Solves

Enterprise AI usually reconstructs company reality at runtime from scattered
mail, CRM, HR, policy, ticket, workspace, and chat records. That approach is
fragile because facts are duplicated, contradictory, stale, or missing context.

This project solves that by building a persistent company memory with:

- a virtual file system for humans and AI agents
- a graph of employees, customers, products, policies, tickets, projects, tasks,
  conversations, repositories, vendors, clients, sales, and sentiment records
- fact-level provenance back to raw source records
- conflict detection and human review workflows
- MCP tools so Claude, ChatGPT, Cursor, or other agents can retrieve context and
  write confirmed annotations back into the memory
- incremental rebuild behavior so changed source records update the graph and
  VFS without destroying confirmed manual facts

## Hackathon Demo Scenario

Recommended judge flow:

1. Open the dashboard and show the generated company memory.
2. Search for `Medha Sen VPN engineering manager`.
3. Open ticket `ticket:15436` / `company/tickets/15436.md`.
4. Show facts, relationships, and provenance from
   `IT_Service_Management/it_tickets.json#15436`.
5. Traverse the graph to `employee:emp_1226` / Medha Sen.
6. Show HR facts, manager/reporting context, email/project links, and source
   provenance.
7. Ask Claude or ChatGPT through MCP to investigate the ticket, cite sources,
   find the applicable access recovery process, and add a confirmed
   `agent_triage_decision` fact.
8. Refresh the UI and show the new confirmed fact in the regenerated VFS.
9. Open the Reviews page and resolve a real ambiguous resume conflict.
10. Open `company/source-coverage.md` to show source coverage, stale-source
    health, entity counts, and facts by source.

The one-line pitch:

> Qontext turns messy company systems into an inspectable operating memory.
> Claude or ChatGPT is the worker on top; the durable product is the context
> base.

## Repository Structure

```text
.
|-- context_base.py              # CLI entrypoint: build, serve, search, read
|-- mcp_server.py                # Model Context Protocol server for AI agents
|-- dataset_schema.json          # Declarative source-to-graph ingestion schema
|-- context_base/
|   |-- ingest.py                # Data ingestion, extraction, conflict logic
|   |-- storage.py               # SQLite schema and persistence helpers
|   |-- search.py                # FTS/vector/fallback search and graph neighbors
|   |-- vfs.py                   # Markdown VFS generation
|   |-- api.py                   # FastAPI HTTP API
|   |-- llm.py                   # Gemini helpers for embeddings/conflicts
|   `-- utils.py
|-- ui/                          # React + Vite dashboard
|-- tests/                       # Backend unit/integration tests
|-- scripts/demo.sh              # Repeatable command-line demo
|-- SKILLS.md                    # Agent/judge workflow over MCP tools
`-- hackathon_evaluation.md      # Criteria-by-criteria evaluation notes
```

Generated output is written to `context_base_out/` by default:

```text
context_base_out/
|-- context.db                   # SQLite graph/context database
`-- vfs/                         # Generated Markdown virtual file system
```

## Dataset Coverage

The project is designed for the Qontext simulated enterprise dataset. The local
dataset represents Inazuma.co, an Indian D2C technology company, and includes:

- HR records and resumes
- CRM customers, products, sales, support chats, and product sentiment
- IT service tickets
- enterprise email threads
- collaboration conversations
- internal Q&A / overflow posts
- enterprise social posts
- GitHub/workspace records
- B2B clients and vendors
- policy PDFs

The current prebuilt context base contains approximately:

- `60,070` entities
- `296,468` active facts
- `99,429` graph edges
- `59,091` active source records
- `11,866` open review items

Counts may change after rebuilding from modified source data.

## Core Capabilities

### Virtual File System

The VFS renders company memory as Markdown files under `context_base_out/vfs`.
Each file includes frontmatter, summaries, facts, relationships, related files,
and source provenance.

Important files to inspect:

- `company/index.md`
- `company/source-coverage.md`
- `company/employees/emp_1226.md`
- `company/tickets/15436.md`
- `company/processes/password-reset-and-access-recovery.md`
- `company/policies/password-policy-document.md`

### Knowledge Graph

The SQLite graph stores:

- `entities`: business objects such as employees, tickets, policies, products,
  projects, and customers
- `facts`: source-backed statements about entities
- `edges`: relationships derived from entity-reference facts
- `source_records`: raw provenance records with dataset path, record ID, raw JSON,
  observed time, hash, and stale status
- `review_items`: conflicts requiring human judgment
- `vfs_files`: generated file paths and associated entities

### Fact-Level Provenance

Every generated fact links to a source record. The UI, CLI, HTTP API, and MCP
server can drill from a fact to the exact raw record that produced it.

Example:

```text
ticket:15436
fact:70872eb32a64471914dcbbbc
source: IT_Service_Management/it_tickets.json#15436
```

### Conflict Resolution

The ingestion pipeline handles conflicts in three ways:

- deterministic normalization and source-of-truth rules
- optional Gemini-assisted synonym/conflict resolution with `--use-llm`
- human review items for ambiguous facts

The React review queue shows competing candidates, confidence, source snippets,
raw source previews, and resolution controls.

### Incremental Updates

Source records are hashed. Rebuilds skip unchanged records, update changed
records, mark deleted records stale, remove orphaned generated data, and preserve
confirmed manual facts. This is covered by tests in
`tests/test_context_base.py`.

### AI Interoperability

The MCP server lets AI agents retrieve, cite, validate, resolve, and extend the
context base. This supports the intended demo where Claude or ChatGPT performs
real work using Qontext as source-backed company memory.

## Technology Stack

Backend:

- Python 3.9+ for CLI, ingestion, API, and tests
- Python 3.10+ for external MCP clients because the `mcp` package requires it
- SQLite for graph and fact storage
- FastAPI for the HTTP API
- Uvicorn for local API serving
- PyMuPDF and pypdf for PDF extraction
- Google Gemini via `google-genai`
- Gemini embedding/conflict helpers in `context_base/llm.py`

Frontend:

- React 19
- TypeScript
- Vite
- D3 for graph visualization
- lucide-react for icons
- framer-motion available for UI animation

Agent interface:

- Model Context Protocol (`mcp`)
- Claude Desktop / Cursor / other MCP clients
- ChatGPT or other assistants can use equivalent HTTP/API tooling

## Setup

### 1. Clone The Repository

```bash
git clone https://github.com/azizbekx/context-vfs.git
cd context-vfs
```

### 2. Install Python Dependencies

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Optional LLM features require a Gemini API key:

```bash
export GEMINI_API_KEY="your-api-key"
```

Without `GEMINI_API_KEY`, deterministic ingestion, graph construction, VFS
generation, keyword/FTS search, the API, and the UI still work.

### 3. Install Frontend Dependencies

```bash
cd ui
npm install
cd ..
```

## Build The Context Base

Build from the dataset into `context_base_out/`:

```bash
python3 context_base.py build --force
```

Build with Gemini-assisted extraction, embeddings, and conflict checks:

```bash
python3 context_base.py build --force --use-llm
```

Build into a custom output directory:

```bash
python3 context_base.py build \
  --dataset-dir dataset \
  --schema dataset_schema.json \
  --out-dir context_base_demo_out \
  --force
```

## Run The Product

Start the backend API:

```bash
python3 context_base.py serve --out-dir context_base_out --port 8000
```

Start the frontend in a second terminal:

```bash
cd ui
npm run dev
```

Open:

```text
http://localhost:5173
```

The Vite dev server proxies `/api` to `http://127.0.0.1:8000`.

## Repeatable CLI Demo

Run the non-interactive demo:

```bash
bash scripts/demo.sh
```

Reuse the existing prebuilt output:

```bash
bash scripts/demo.sh --skip-build context_base_out
```

The script prints graph counts, runs a retrieval query, and displays the source
coverage VFS file.

## CLI Reference

```bash
# Build graph and VFS
python3 context_base.py build --force

# Start API
python3 context_base.py serve --out-dir context_base_out --port 8000

# Search entities, facts, and VFS files
python3 context_base.py search "VPN engineering" --out-dir context_base_out --limit 5

# Read a VFS file
python3 context_base.py read company/tickets/15436.md --out-dir context_base_out

# Inspect an entity with facts and neighbors
python3 context_base.py entity ticket:15436 --out-dir context_base_out

# Inspect raw provenance for a fact
python3 context_base.py sources fact:70872eb32a64471914dcbbbc --out-dir context_base_out

# List open human-review conflicts
python3 context_base.py reviews --out-dir context_base_out

# Resolve a review item
python3 context_base.py resolve-review REVIEW_ID --choice choice-1 --out-dir context_base_out

# List generated VFS files
python3 context_base.py tree --out-dir context_base_out

# Re-run conflict detection on an existing database
python3 context_base.py detect-conflicts --out-dir context_base_out --regenerate-vfs
```

## HTTP API Reference

Base URL when served locally:

```text
http://127.0.0.1:8000
```

Endpoints:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | API status page |
| `GET` | `/health` | Health check with DB/output paths |
| `GET` | `/stats` | Entity, fact, edge, source, and review counts |
| `GET` | `/search?q=<query>` | Search entities, facts, and VFS files |
| `GET` | `/vfs/tree` | List generated VFS files |
| `GET` | `/vfs/file?path=<path>` | Read one generated VFS file |
| `GET` | `/entities/{entity_id}` | Entity facts and details |
| `GET` | `/entities/{entity_id}/neighbors` | Immediate graph neighbors |
| `POST` | `/entities` | Create a manual entity |
| `DELETE` | `/entities/{entity_id}` | Delete an entity and generated files |
| `POST` | `/entities/{entity_id}/facts` | Add a confirmed manual fact |
| `PATCH` | `/facts/{fact_id}` | Edit a fact value or confidence |
| `DELETE` | `/facts/{fact_id}` | Delete a fact |
| `GET` | `/facts/{fact_id}/sources` | Inspect raw source provenance |
| `GET` | `/reviews` | List conflict review items |
| `POST` | `/reviews/{review_id}/resolve` | Resolve a review item |
| `POST` | `/reviews/{review_id}/auto-resolve` | Attempt LLM-assisted review resolution |
| `POST` | `/vfs/refresh` | Regenerate the VFS |

Example:

```bash
curl "http://127.0.0.1:8000/search?q=VPN%20engineering"
curl "http://127.0.0.1:8000/entities/ticket%3A15436"
curl "http://127.0.0.1:8000/vfs/file?path=company%2Ftickets%2F15436.md"
```

## MCP Server

The MCP server exposes Qontext as an agent-operable company memory.

Install MCP dependencies with Python 3.10+:

```bash
python3.10 -m pip install -r requirements.txt
```

Verify MCP setup:

```bash
python3.10 mcp_server.py --check-deps --out-dir context_base_out
```

Run the server:

```bash
python3.10 mcp_server.py --out-dir context_base_out
```

You can also set the output directory with an environment variable:

```bash
CONTEXT_BASE_OUT_DIR=context_base_out python3.10 mcp_server.py
```

Claude Desktop example:

```json
{
  "mcpServers": {
    "qontext-ai": {
      "command": "python3.10",
      "args": [
        "/absolute/path/to/context-vfs/mcp_server.py",
        "--out-dir",
        "/absolute/path/to/context-vfs/context_base_out"
      ]
    }
  }
}
```

MCP tools:

| Tool | Purpose |
|---|---|
| `get_context_base_status` | Return graph, source, review, and VFS counts |
| `search_context` | Retrieve relevant entities, facts, and files |
| `get_entity_context` | Inspect an entity, facts, and graph neighbors |
| `read_vfs_file` | Read a generated Markdown VFS file |
| `list_vfs_files` | List generated VFS files |
| `get_fact_source` | Return raw source provenance for a fact |
| `list_review_items` | List unresolved or resolved review items |
| `resolve_review_item` | Resolve a human-review item and regenerate VFS files |
| `add_entity_fact` | Add a confirmed manual/agent annotation |

Recommended agent prompt:

```text
You are an enterprise operations agent. Use only Qontext MCP tools.

Investigate ticket:15436. Identify who is blocked, their role, who owns the
ticket, which process or policy applies, and the exact source records behind
important facts. Mention unresolved review items if they affect the answer.
Then add a confirmed agent_triage_decision fact to ticket:15436.
```

For stricter agent behavior, use the workflow in `SKILLS.md`.

## Declarative Ingestion Schema

`dataset_schema.json` lets new JSON or CSV sources be added without writing a
custom Python parser. A source definition describes:

- source path
- format
- record ID field
- entity type
- entity display name
- VFS path template
- facts to extract
- optional entity-reference fields that become graph edges

Example pattern:

```json
{
  "path": "IT_Service_Management/it_tickets.json",
  "format": "json",
  "id_field": "id",
  "entity_type": "ticket",
  "summary_field": "Issue",
  "path_template": "company/tickets/{id}.md",
  "facts": [
    { "field": "priority", "predicate": "priority" },
    { "field": "raised_by_emp_id", "predicate": "raised_by", "entity_ref": { "prefix": "employee" } }
  ]
}
```

This is the main generalization mechanism for new enterprise datasets.

## Frontend Product Surface

The React dashboard includes:

- dashboard with graph/source/review counts
- VFS browser with readable file labels
- full Markdown preview and raw mode
- entity inspector with editable facts
- interactive network graph
- directed graph view
- semantic/keyword search
- source provenance drawer
- review queue with candidate comparison and resolution controls
- manual create/edit/delete workflows for entities and facts
- dark/light theme support

## Testing And Verification

Run backend tests:

```bash
python3 -m unittest -v
```

Build frontend:

```bash
cd ui
npm run build
```

Optional lint:

```bash
cd ui
npm run lint
```

The backend test suite covers:

- VFS generation
- fact provenance
- source coverage output
- incremental rebuild skipping unchanged records
- stale/deleted source cleanup
- manual fact preservation
- conflict review generation
- source-of-truth auto-resolution
- schema-based generic ingestion
- MCP agent workflow support

## Jury Evaluation Guide

Use these files and flows for fast evaluation:

- `README.md`: setup, architecture, API, MCP, and demo instructions
- `hackathon_evaluation.md`: criteria-by-criteria analysis
- `SKILLS.md`: repeatable AI-agent workflow
- `dataset_schema.json`: generalized ingestion configuration
- `context_base/storage.py`: graph schema and persistence behavior
- `context_base/ingest.py`: extraction, conflict, and incremental build logic
- `context_base/vfs.py`: virtual file system generation
- `context_base/search.py`: retrieval and graph neighbor logic
- `context_base/api.py`: HTTP API
- `mcp_server.py`: agent tools
- `ui/src/App.tsx`: primary product UI
- `ui/src/components/ReviewQueue.tsx`: human-in-the-loop conflict interface
- `ui/src/components/NetworkGraph.tsx`: graph visualization

Suggested live checks:

```bash
python3 context_base.py search "VPN engineering" --out-dir context_base_out --limit 5
python3 context_base.py read company/source-coverage.md --out-dir context_base_out
python3 context_base.py read company/tickets/15436.md --out-dir context_base_out
python3 context_base.py entity employee:emp_1226 --out-dir context_base_out
```

## Known Notes

- The repository includes a prebuilt `context_base_out/` for fast judging. It can
  be regenerated from the dataset with `python3 context_base.py build --force`.
- External MCP clients need Python 3.10+ because of the `mcp` package.
- LLM-powered features require `GEMINI_API_KEY`; deterministic functionality
  works without it.
- Search uses the best available strategy for the local build: SQLite FTS,
  optional embeddings, and fallback matching.
