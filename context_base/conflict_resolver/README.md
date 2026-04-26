# conflict_resolver

LLM-driven adjudication for ambiguous entity-match clusters that a deterministic / rules-based stage couldn't decide on. Pluggable LLM provider (Ollama for local dev, Gemini for production), risk-aware action policy, and a strict JSON output contract.

## What it does

For each candidate cluster a rules layer flags for review, the resolver:

1. Asks the LLM **same_entity / different / uncertain** with a calibrated confidence.
2. Computes a **risk score** = `error_probability × cost_of_error`, where the cost depends on what action the verdict implies (`merge_records` is destructive, `remove_same_as_link` is trivially reversible).
3. Recommends `auto_act` (apply the action) when risk < threshold, else `escalate` (leave in queue with reasoning attached for a human).

It is **storage-agnostic** — it does not read or write your database. You map your store's review items to a `ClusterPayload`, call `resolve_cluster(...)`, and apply the resulting `ResolvedDecision` against your store yourself.

## What it does **not** do

- Find new conflicts. The resolver only adjudicates clusters you already have. Your existing detector / rules layer is what surfaces them.
- Mutate any database. The output is a decision object — you write it back.
- Override identifier disagreements lightly. When the LLM votes `same_entity` despite an identifier conflict the rules layer flagged, the risk model down-weights it (1.6× cost multiplier).

## Wiring against the existing context-vfs review queue

In this repo, conflicts surface as rows in the `reviews` table written by `context_base/ingest.py:detect_conflicts`. Today they are `fact_value_conflict` and `identity_mismatch`.

The pre-built prompts here are aimed at **business-entity matching** (cluster of records that *might* be the same company across HR / CRM / Vendors). They are not the right shape for `fact_value_conflict` reviews where the question is which value of a single predicate to keep.

Two ways to integrate:

**(a) Use today, narrowly.** Run the resolver on `identity_mismatch` reviews where you have two records (HR row + résumé row) and want a same/different verdict. Map each review row to a 2-member `ClusterPayload`. The risk layer's cost table maps cleanly: `same_entity` -> `merge_records` (destructive), `different` -> remove the suspected link.

**(b) Add a second prompt set for fact-value reviews.** A prompt that takes a predicate + N candidate values + their sources, returns `winner_choice_id` + confidence + reasoning. Drop it into `prompts.py` alongside the entity-match prompt, add a parallel `resolve_fact_conflict()` entry, reuse the same provider + risk machinery.

See `examples/resolve_review_queue.py` for option (a) — a runnable script that pulls `identity_mismatch` reviews from `context_base.db`, calls Gemini, and prints the verdicts (no DB writes; opt-in).

## Provider configuration

```python
from context_base.conflict_resolver import GeminiProvider, OllamaProvider

# Production (managed, fast — needs GEMINI_API_KEY in env)
provider = GeminiProvider(model="gemini-3.1-flash-lite-preview")

# Local dev (no API key, slower — needs Ollama running locally)
provider = OllamaProvider(model="llama3.2:3b")
```

`GeminiProvider` reuses the same env-var convention (`GEMINI_API_KEY`) as the rest of this repo's `context_base/llm.py`, so no new config plumbing is required.

To plug in another provider, implement the `LLMProvider` protocol — one method, `chat(messages, *, timeout) -> str`, where `messages` is a list of `{role, content}` dicts (`role` ∈ `system | user | assistant`). The system message is the calibration / instructions; the rest are alternating few-shot turns plus the final cluster.

## Usage

```python
from context_base.conflict_resolver import (
    GeminiProvider,
    ClusterPayload, Member,
    resolve_cluster,
)

cluster = ClusterPayload(
    cluster_id="review-42",
    members=[
        Member(id="emp_0042", type="Employee", properties={
            "name": "Aditya Khanna",
            "email": "aditya.k@inazuma.co",
            "department": "Platform",
        }),
        Member(id="resume:0042", type="Employee", properties={
            "name": "Adi Khanna",
            "email": "aditya.k@inazuma.co",
            "department": "Engineering",
        }),
    ],
    rules_match_reasons=["Exact email match"],
    rules_review_reason="Name disagrees: 'Aditya Khanna' vs 'Adi Khanna'",
    has_identifier_conflict=False,
)

decision = resolve_cluster(cluster, provider=GeminiProvider())
print(decision.as_dict())
```

Output:

```json
{
  "cluster_id": "review-42",
  "decision": "same_entity",
  "confidence": 0.92,
  "reasoning": "...",
  "key_signals": ["Exact email match", "Adi is a common short-form of Aditya"],
  "open_questions": [],
  "risk": {
    "action": "merge_records",
    "risk_score": 7.2,
    "recommended": "escalate",
    "rationale": "..."
  },
  "model": "gemini-3.1-flash-lite-preview",
  "elapsed_s": 1.3
}
```

Note in this example the risk layer **escalates** despite high confidence: `merge_records` is the most destructive action (base cost 90), so a single 0.92-confidence call doesn't clear the autonomous-action budget. To act, either tune `risk_threshold` upward or wait for a second corroborating signal.

## Files

- `types.py` — `ClusterPayload`, `Member` (storage-agnostic input shape).
- `prompts.py` — System prompt + 3 few-shot examples for entity-match.
- `providers.py` — `LLMProvider` protocol, `OllamaProvider`, `GeminiProvider`.
- `risk.py` — `ActionCost` table, `assess_risk()`, `RiskAssessment` dataclass.
- `decisions.py` — `resolve_cluster()` entry point + `ResolvedDecision`.
