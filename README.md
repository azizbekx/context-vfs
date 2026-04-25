# Policy Document QA Agent

This project includes a small Retrieval Augmented Generation (RAG) agent for answering questions from the PDFs in `dataset/Policy_Documents`.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export GEMINI_API_KEY="your-api-key"
```

## Build The Index

```bash
python3 policy_agent.py ingest
```

This reads all PDFs in `dataset/Policy_Documents`, extracts page text, chunks it, creates Gemini embeddings, and writes a local index to `policy_index/policies.json`.

## Ask A Question

```bash
python3 policy_agent.py ask "What is the password policy?"
```

The agent retrieves the most relevant policy chunks and asks Gemini to answer using only that context. Answers include source PDF names and page references.

## Useful Options

```bash
python3 policy_agent.py ingest --force
python3 policy_agent.py ask "How many leave days are employees entitled to?" --top-k 8
python3 policy_agent.py ask "What happens after a data breach?" --show-context
```

## Notes

- The default PDF folder is `dataset/Policy_Documents`.
- The default index folder is `policy_index`.
- Set `GEMINI_API_KEY` before running commands.
- Re-run `ingest --force` after changing policy PDFs.

## Context Base Compiler

This repo also includes a broader context-base MVP for the Qontext-style
challenge. It turns the simulated enterprise dataset into:

- a SQLite graph and fact store at `context_base_out/context.db`
- a generated virtual file system at `context_base_out/vfs`
- provenance-backed markdown files for employees, customers, products, tickets,
  policies, clients, vendors, and repos
- CLI and HTTP interfaces for reading, searching, and inspecting context

Build the context base:

```bash
python3 context_base.py build --dataset-dir dataset --out-dir context_base_out --force
```

Inspect generated context:

```bash
python3 context_base.py tree
python3 context_base.py read company/employees/emp_0431.md
python3 context_base.py search "vpn access issue for engineering"
python3 context_base.py entity employee:emp_0431
python3 context_base.py reviews
```

Run the local API:

```bash
python3 context_base.py serve --host 127.0.0.1 --port 8000
```

Open the context browser:

```text
http://127.0.0.1:8000/
```

Useful endpoints:

```text
GET /
GET /health
GET /vfs/tree
GET /vfs/file?path=company/customers/arout.md
GET /entities/employee:emp_0431
GET /entities/employee:emp_0431/neighbors
GET /search?q=vpn%20access
GET /reviews
POST /reviews/{review_id}/resolve
```

The context-base build is deterministic by default and does not require a model
API key. Policy PDFs are summarized from extracted text when `pypdf` is
available. The `--use-llm` flag is reserved for future Gemini-assisted
extraction extensions.
