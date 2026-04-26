#!/usr/bin/env bash
set -euo pipefail

SKIP_BUILD=0
if [[ "${1:-}" == "--skip-build" ]]; then
  SKIP_BUILD=1
  shift
fi

OUT_DIR="${1:-context_base_demo_out}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATASET_DIR="$ROOT_DIR/dataset"
SCHEMA_PATH="$ROOT_DIR/dataset_schema.json"

if [[ "$OUT_DIR" != /* ]]; then
  OUT_DIR="$ROOT_DIR/$OUT_DIR"
fi

if [[ "$SKIP_BUILD" -eq 1 ]]; then
  if [[ ! -f "$OUT_DIR/context.db" ]]; then
    echo "Missing context database: $OUT_DIR/context.db" >&2
    exit 1
  fi
  echo "== Reuse existing context base =="
else
  echo "== Build context base =="
  python3 "$ROOT_DIR/context_base.py" build --force --dataset-dir "$DATASET_DIR" --schema "$SCHEMA_PATH" --out-dir "$OUT_DIR"
fi

echo
echo "== Graph stats =="
python3 - "$OUT_DIR/context.db" <<'PY'
import sqlite3
import sys

conn = sqlite3.connect(sys.argv[1])
conn.row_factory = sqlite3.Row
queries = [
    ("entities", "SELECT COUNT(*) AS c FROM entities"),
    ("active_facts", "SELECT COUNT(*) AS c FROM facts WHERE status IN ('generated','confirmed')"),
    ("edges", "SELECT COUNT(*) AS c FROM edges"),
    ("sources", "SELECT COUNT(*) AS c FROM source_records WHERE stale = 0"),
    ("open_reviews", "SELECT COUNT(*) AS c FROM review_items WHERE status = 'open'"),
]
for label, query in queries:
    print(f"{label}: {conn.execute(query).fetchone()['c']}")
PY

echo
echo "== Retrieval example: VPN engineering =="
python3 "$ROOT_DIR/context_base.py" search "VPN engineering" --out-dir "$OUT_DIR" --limit 3

echo
echo "== VFS example =="
python3 "$ROOT_DIR/context_base.py" read company/source-coverage.md --out-dir "$OUT_DIR" | sed -n '1,80p'

echo
echo "Demo output is in $OUT_DIR"
echo "Run the API with: python3 $ROOT_DIR/context_base.py serve --out-dir $OUT_DIR"
echo "Run the UI with:  cd $ROOT_DIR/ui && npm run dev"
