"""LLM-driven conflict resolver — adjudicates ambiguous entity-match clusters
that a deterministic / rules-based stage couldn't decide on.

Public surface:
    from context_base.conflict_resolver import (
        resolve_cluster,
        ClusterPayload, Member, ResolvedDecision,
        OllamaProvider, GeminiProvider,
    )
"""

from .decisions import resolve_cluster, ResolvedDecision
from .policy_check import find_incidents, Incident
from .providers import LLMProvider, OllamaProvider, GeminiProvider
from .risk import RiskAssessment, assess_risk
from .types import ClusterPayload, Member

__all__ = [
    "resolve_cluster",
    "ResolvedDecision",
    "find_incidents",
    "Incident",
    "ClusterPayload",
    "Member",
    "LLMProvider",
    "OllamaProvider",
    "GeminiProvider",
    "RiskAssessment",
    "assess_risk",
]
