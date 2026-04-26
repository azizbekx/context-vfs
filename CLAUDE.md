# CLAUDE.md — Qontext AI project context

## What this project is

A hackathon project for the Qontext challenge. We're turning a 27MB simulated enterprise dataset (10 source systems, 307 files) into a structured company memory — a knowledge graph with a virtual file system interface.

The backend is complete: a Python ingestion pipeline that reads JSON/CSV/PDF sources, builds a SQLite-backed knowledge graph with 60,070 entities, 296,473 facts, and 99,429 edges. It has provenance tracking, conflict detection with AI-assisted resolution (Gemini), semantic vector search, and an MCP server for AI agent integration.

## What the judges care about

1. **Generalisability** — works beyond just this dataset
2. **Conflict resolution** — auto-resolves easy cases, surfaces ambiguous ones for humans
3. **Provenance** — every fact traces back to its source
4. **Change propagation** — updates when source data changes
5. **Explainable, editable, robust, useful in practice**

## Current frontend status (as of this session)

The frontend has been substantially improved. The backend is solid — don't change it. All work is on the React frontend in `/ui`.

**Active GitHub branches / PRs:**
- `ui/visual-polish` → PR #4 (visual polish: stat cards, bar charts, breadcrumb, AI suggestion box)
- `ui/dark-mode` → PR #5 (dark theme + nav polish + file tree readable names) — **this is the most current branch**, all recent commits land here

**What's been done in this session:**
1. Dark colour scheme throughout (`#0F1117` bg, `#1A1D27` surface, `#141620` sidebars, `#10B981` teal accent)
2. Dashboard: coloured stat cards with icons, horizontal bar charts for entity/edge type distribution
3. Context Browser: breadcrumb trail in toolbar, improved markdown table styling, inspector panel has distinct sidebar shade
4. Reviews page: resolved/remaining count pills, prominent AI suggestion block (teal gradient + Sparkles icon), stronger anchor/variant card borders
5. Top nav: active tab uses solid `#10B981` with white text; icons (LayoutDashboard / Folder / ShieldAlert) before each label; conflicts badge pulses with amber glow animation
6. File tree: lazily fetches markdown content on folder expand (up to 50 files at a time), extracts first `# H1` heading or `**Name:**` field as human-readable primary label, shows raw ID (`emp_0431`) in small mono text below, folder child counts, expand animation, indentation guide lines, accent left-border on active file

**Reviewer:** `azizbekx` is set as reviewer on both PRs.

## Tech stack

- Backend: Python, SQLite, FastAPI/HTTP server
- Frontend: React (in /ui directory), Vite
- LLM: Google Gemini (embeddings, conflict resolution, policy extraction)
- The frontend talks to the backend API at http://localhost:5001

## The dataset: Inazuma.co

An Indian D2C tech company with 1,260 employees, 90 customers, 400 B2B clients, 1,351 products. Data comes from: HR, CRM, email (11,928), chat (2,897), IT tickets (163), GitHub (750 repos), internal Q&A (10,823 posts), social platform (971 posts), support chats (1,000), product reviews (13,510), order PDFs (~270), policy PDFs (24).

Key join key: `emp_id` connects employees across all systems.

## Key learnings from the data

- 81% of emails have signature mismatches (sender name ≠ signature block) — intentional test
- Customer IDs are short codes like "arout" that match PDF filenames
- B2B clients (400, UUID keys) are separate from B2C customers (90, short code keys)
- Product sentiment maps 1:1 with sales (both 13,510 records)
- Overflow uses Stack Overflow schema (PostTypeId 1=question, 2=answer)

## Frontend architecture notes

- All UI source lives in `context-vfs/ui/src/`
- `App.tsx` — main shell, 3-column browser layout, all state, `TreeNode` component, modals
- `components/Dashboard.tsx` — stat cards + bar charts, calls `/api/stats`
- `components/ReviewQueue.tsx` — dedicated review page with keyboard shortcuts (J/K navigate, A accept top, S skip)
- `components/MarkdownRenderer.tsx` — lightweight markdown-to-HTML (no external deps, handles tables/headings/code)
- `index.css` — single CSS file, uses CSS custom properties throughout; all dark-mode colours live in `:root`
- Vite proxy: `/api` → `http://127.0.0.1:8000` (check `vite.config.ts` if the backend port differs)
- lucide-react is available for icons; framer-motion is installed but not yet used

## Key CSS variables (dark theme)

```css
--bg: #0F1117        /* page background */
--panel: #1A1D27     /* cards / surfaces */
--sidebar: #141620   /* left + right sidebar panels */
--ink: #E4E4E7       /* primary text */
--muted: #9CA3AF     /* secondary text */
--line: #2A2D37      /* borders */
--line-soft: #1E2030 /* hover backgrounds */
--accent: #10B981    /* teal — brand colour */
--accent-dark: #34D399 /* lighter teal for text on dark bg */
```

## Commands

```bash
# Backend
python3 context_base.py serve

# Frontend
cd ui
npm run dev
# Opens at http://localhost:5173
```
