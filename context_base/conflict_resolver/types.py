"""Storage-agnostic types for the conflict resolver.

The resolver does not know about your storage layer. The wiring code (you)
is responsible for:
  1. Reading pending review items out of your store
  2. Mapping them to a `ClusterPayload`
  3. Calling `resolve_cluster(...)`
  4. Writing the returned `ResolvedDecision` back to your store and acting on it
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class Member:
    """One row in a candidate cluster.

    `id` and `type` are used by the risk layer (same-type clusters can
    autonomously merge; cross-type clusters cannot). `properties` is what
    the LLM actually reasons over — anything keyed by predicate name.
    """
    id: str
    type: str
    properties: dict[str, Any] = field(default_factory=dict)


@dataclass
class ClusterPayload:
    """A candidate cluster the rules layer flagged for review.

    `cluster_id` only needs to be unique within your run — it is used as a
    cache key. `rules_match_reasons` and `rules_review_reason` are surfaced
    verbatim to the LLM so it knows why this cluster wasn't auto-resolved.
    """
    cluster_id: str
    members: list[Member]
    rules_score: Optional[float] = None
    rules_match_reasons: list[str] = field(default_factory=list)
    rules_review_reason: Optional[str] = None
    has_identifier_conflict: bool = False

    @property
    def same_type(self) -> bool:
        return len({m.type for m in self.members}) == 1

    def to_llm_dict(self, fields: Optional[list[str]] = None) -> dict[str, Any]:
        """Compact dict shape sent to the LLM. Pass `fields` to filter which
        properties are surfaced — keep the prompt lean for quality."""
        members = []
        for m in self.members:
            entry: dict[str, Any] = {"id": m.id, "type": m.type}
            for k, v in m.properties.items():
                if fields is not None and k not in fields:
                    continue
                if v in (None, ""):
                    continue
                entry[k] = v
            members.append(entry)
        return {
            "cluster_id": self.cluster_id,
            "rules_score": self.rules_score,
            "rules_match_reasons": list(self.rules_match_reasons),
            "rules_review_reason": self.rules_review_reason,
            "members": members,
        }
