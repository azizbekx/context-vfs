#!/usr/bin/env python3
"""Question-answering agent for local policy PDFs using Gemini."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import textwrap
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable, List, Sequence


DEFAULT_PDF_DIR = Path("dataset/Policy_Documents")
DEFAULT_INDEX_DIR = Path("policy_index")
DEFAULT_INDEX_FILE = "policies.json"
EMBEDDING_MODEL = "gemini-embedding-001"
GENERATION_MODEL = "gemini-2.5-flash"


@dataclass
class PolicyChunk:
    id: str
    source: str
    page_start: int
    page_end: int
    text: str
    embedding: List[float]


def require_api_key() -> None:
    if not os.environ.get("GEMINI_API_KEY"):
        raise SystemExit(
            "GEMINI_API_KEY is not set. Run: export GEMINI_API_KEY='your-api-key'"
        )


def make_client() -> Any:
    require_api_key()
    try:
        from google import genai
    except ImportError as exc:
        raise SystemExit(
            "Missing dependency: google-genai. Run: pip install -r requirements.txt"
        ) from exc

    return genai.Client(api_key=os.environ["GEMINI_API_KEY"])


def stable_id(source: str, page_start: int, page_end: int, text: str) -> str:
    digest = hashlib.sha256(
        f"{source}:{page_start}:{page_end}:{text}".encode("utf-8")
    ).hexdigest()[:16]
    return f"{source}:{page_start}-{page_end}:{digest}"


def extract_pdf_pages(pdf_path: Path) -> List[tuple[int, str]]:
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise SystemExit(
            "Missing dependency: pypdf. Run: pip install -r requirements.txt"
        ) from exc

    reader = PdfReader(str(pdf_path))
    pages = []
    for page_number, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        cleaned = "\n".join(line.strip() for line in text.splitlines() if line.strip())
        if cleaned:
            pages.append((page_number, cleaned))
    return pages


def chunk_pages(
    pages: Sequence[tuple[int, str]], max_chars: int = 2400, overlap_chars: int = 350
) -> Iterable[tuple[int, int, str]]:
    buffer = ""
    start_page = None
    end_page = None

    for page_number, page_text in pages:
        remaining = page_text
        while remaining:
            if start_page is None:
                start_page = page_number
            end_page = page_number

            available = max_chars - len(buffer)
            piece = remaining[:available]
            buffer = f"{buffer}\n{piece}".strip()
            remaining = remaining[available:]

            if len(buffer) >= max_chars:
                yield start_page, end_page, buffer
                buffer = buffer[-overlap_chars:]
                start_page = end_page

    if buffer and start_page is not None and end_page is not None:
        yield start_page, end_page, buffer


def embedding_values(embedding_response: object) -> List[float]:
    embeddings = getattr(embedding_response, "embeddings", None)
    if not embeddings:
        raise ValueError("Gemini returned no embeddings")

    first = embeddings[0]
    values = getattr(first, "values", None)
    if values is None and isinstance(first, dict):
        values = first.get("values")
    if values is None:
        raise ValueError("Could not read embedding values from Gemini response")
    return [float(value) for value in values]


def embed_text(client: Any, text: str) -> List[float]:
    response = client.models.embed_content(model=EMBEDDING_MODEL, contents=text)
    return embedding_values(response)


def index_path(index_dir: Path) -> Path:
    return index_dir / DEFAULT_INDEX_FILE


def load_index(index_dir: Path) -> List[PolicyChunk]:
    path = index_path(index_dir)
    if not path.exists():
        raise SystemExit(
            f"No index found at {path}. Build it first with: python3 policy_agent.py ingest"
        )

    with path.open("r", encoding="utf-8") as handle:
        raw_chunks = json.load(handle)
    return [PolicyChunk(**item) for item in raw_chunks]


def save_index(index_dir: Path, chunks: Sequence[PolicyChunk]) -> None:
    index_dir.mkdir(parents=True, exist_ok=True)
    with index_path(index_dir).open("w", encoding="utf-8") as handle:
        json.dump([asdict(chunk) for chunk in chunks], handle, ensure_ascii=False)


def ingest(args: argparse.Namespace) -> None:
    pdf_dir = Path(args.pdf_dir)
    index_dir = Path(args.index_dir)
    path = index_path(index_dir)

    if args.chunk_chars <= 0:
        raise SystemExit("--chunk-chars must be greater than 0")
    if args.overlap_chars < 0:
        raise SystemExit("--overlap-chars cannot be negative")
    if args.overlap_chars >= args.chunk_chars:
        raise SystemExit("--overlap-chars must be smaller than --chunk-chars")
    if path.exists() and not args.force:
        raise SystemExit(f"Index already exists at {path}. Use --force to rebuild it.")
    if not pdf_dir.exists():
        raise SystemExit(f"PDF directory does not exist: {pdf_dir}")

    client = make_client()
    pdf_files = sorted(pdf_dir.glob("*.pdf"))
    if not pdf_files:
        raise SystemExit(f"No PDFs found in {pdf_dir}")

    chunks: List[PolicyChunk] = []
    for pdf_file in pdf_files:
        print(f"Reading {pdf_file.name}", file=sys.stderr)
        pages = extract_pdf_pages(pdf_file)
        if not pages:
            print(f"Skipping {pdf_file.name}: no extractable text", file=sys.stderr)
            continue

        for page_start, page_end, text in chunk_pages(
            pages, max_chars=args.chunk_chars, overlap_chars=args.overlap_chars
        ):
            print(
                f"Embedding {pdf_file.name} pages {page_start}-{page_end}",
                file=sys.stderr,
            )
            chunks.append(
                PolicyChunk(
                    id=stable_id(pdf_file.name, page_start, page_end, text),
                    source=pdf_file.name,
                    page_start=page_start,
                    page_end=page_end,
                    text=text,
                    embedding=embed_text(client, text),
                )
            )

    save_index(index_dir, chunks)
    print(f"Indexed {len(chunks)} chunks from {len(pdf_files)} PDFs into {path}")


def cosine_similarity(left: Sequence[float], right: Sequence[float]) -> float:
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(a * a for a in left))
    right_norm = math.sqrt(sum(b * b for b in right))
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return dot / (left_norm * right_norm)


def retrieve(
    client: Any, chunks: Sequence[PolicyChunk], question: str, top_k: int
) -> List[tuple[float, PolicyChunk]]:
    question_embedding = embed_text(client, question)
    ranked = sorted(
        (
            (cosine_similarity(question_embedding, chunk.embedding), chunk)
            for chunk in chunks
        ),
        key=lambda item: item[0],
        reverse=True,
    )
    return ranked[:top_k]


def format_context(results: Sequence[tuple[float, PolicyChunk]]) -> str:
    blocks = []
    for score, chunk in results:
        blocks.append(
            "\n".join(
                [
                    f"Source: {chunk.source}",
                    f"Pages: {chunk.page_start}-{chunk.page_end}",
                    f"Relevance: {score:.4f}",
                    "Text:",
                    chunk.text,
                ]
            )
        )
    return "\n\n---\n\n".join(blocks)


def answer(args: argparse.Namespace) -> None:
    client = make_client()
    try:
        from google.genai import types
    except ImportError as exc:
        raise SystemExit(
            "Missing dependency: google-genai. Run: pip install -r requirements.txt"
        ) from exc

    chunks = load_index(Path(args.index_dir))
    results = retrieve(client, chunks, args.question, args.top_k)
    context = format_context(results)

    if args.show_context:
        print("Retrieved context:\n")
        print(context)
        print("\n" + "=" * 80 + "\n")

    prompt = textwrap.dedent(
        f"""
        You are a policy document QA agent.

        Answer the user's question using only the policy context below.
        If the context does not contain the answer, say: "I could not find that in the policy documents."
        Cite the source PDF filename and page range for each factual claim.
        Keep the answer concise and practical.

        Policy context:
        {context}

        User question:
        {args.question}
        """
    ).strip()

    response = client.models.generate_content(
        model=args.model,
        contents=prompt,
        config=types.GenerateContentConfig(temperature=0.2),
    )
    print(response.text)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Answer questions from local policy PDFs using Gemini."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    ingest_parser = subparsers.add_parser("ingest", help="Build the local policy index")
    ingest_parser.add_argument("--pdf-dir", default=str(DEFAULT_PDF_DIR))
    ingest_parser.add_argument("--index-dir", default=str(DEFAULT_INDEX_DIR))
    ingest_parser.add_argument("--chunk-chars", type=int, default=2400)
    ingest_parser.add_argument("--overlap-chars", type=int, default=350)
    ingest_parser.add_argument("--force", action="store_true")
    ingest_parser.set_defaults(func=ingest)

    ask_parser = subparsers.add_parser("ask", help="Ask a policy question")
    ask_parser.add_argument("question")
    ask_parser.add_argument("--index-dir", default=str(DEFAULT_INDEX_DIR))
    ask_parser.add_argument("--top-k", type=int, default=6)
    ask_parser.add_argument("--model", default=GENERATION_MODEL)
    ask_parser.add_argument("--show-context", action="store_true")
    ask_parser.set_defaults(func=answer)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
