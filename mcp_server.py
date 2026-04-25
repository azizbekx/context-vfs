import argparse
from pathlib import Path

try:
    from mcp.server.fastmcp import FastMCP
except ImportError:
    import sys
    sys.exit("Please install mcp: pip install mcp")

from context_base.storage import Store
from context_base.search import search, neighbors
from context_base.vfs import tree

mcp = FastMCP("Context Base")
DEFAULT_OUT_DIR = Path("context_base_out")

def get_db(out_dir: Path = DEFAULT_OUT_DIR) -> Store:
    db = Store(out_dir / "context.db")
    return db

@mcp.tool()
def search_context(query: str) -> str:
    """Search the company knowledge graph and file system for a given text query. Use this to find relevant entities or files before exploring further."""
    db = get_db()
    results = search(db, DEFAULT_OUT_DIR, query)
    db.close()
    
    if not results:
        return "No results found."
    
    formatted = []
    for r in results:
        if r['kind'] == 'entity':
            formatted.append(f"Entity: {r['name']} ({r['type']}) ID: {r['entity_id']}\nPath: {r['path']}\nSummary: {r['snippet']}")
        elif r['kind'] == 'fact':
            formatted.append(f"Fact about {r['name']}: {r['predicate']} = {r['snippet']} (Confidence: {r['confidence']})")
        elif r['kind'] == 'file':
            formatted.append(f"File: {r['path']}\nContent Snippet: {r['snippet']}")
    return "\n\n---\n\n".join(formatted)

@mcp.tool()
def get_entity_context(entity_id: str) -> str:
    """Get the full details, facts, and immediate graph neighbors for a specific entity ID. Use this when you have an entity_id and want to traverse the graph."""
    db = get_db()
    row = db.row("SELECT * FROM entities WHERE id = ?", (entity_id,))
    if not row:
        db.close()
        return f"Entity {entity_id} not found."
    facts = db.rows("SELECT * FROM facts WHERE subject_id = ? AND status IN ('generated', 'confirmed')", (entity_id,))
    ns = neighbors(db, entity_id, limit=20)
    db.close()
    
    result = f"Entity: {row['name']} ({row['type']})\nSummary: {row['summary']}\n\nFacts:\n"
    for f in facts:
        val = f['value'] or f"-> {f['object_entity_id']}"
        result += f"- {f['predicate']}: {val}\n"
    
    result += "\nNeighbors:\n"
    for n in ns:
        result += f"- {n['direction']} {n['relation']}: {n['name']} ({n['entity_id']})\n"
        
    return result

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

if __name__ == "__main__":
    mcp.run()
