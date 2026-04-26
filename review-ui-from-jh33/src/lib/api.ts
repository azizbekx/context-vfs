/**
 * Thin fetch wrapper against the Qontext FastAPI backend (api/server.py).
 *
 * Base URL is read from VITE_API_BASE_URL and defaults to localhost:8000
 * so it works out of the box when both `python api/server.py` and
 * `npm run dev` are running locally.
 */

export const API_BASE: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://127.0.0.1:8000";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    throw new ApiError(`${init?.method ?? "GET"} ${path} -> ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

/* ---------------------------------------------------------------- */
/* Backend conflict shapes (heterogeneous)                          */
/* ---------------------------------------------------------------- */

export interface BackendProvenance {
  source_system?: string;
  file?: string;
  record_id?: string;
  field?: string;
  confidence?: number;
  ingested_at?: string;
  timestamp?: string;
}

export interface BackendConflictBase {
  conflict_type: string;
  detected_at?: string;
  resolution?: { status?: string; winner?: string; reason?: string };
}

export interface EntityMatchReviewConflict extends BackendConflictBase {
  conflict_type: "entity_match_review";
  members: string[];
  member_types: string[];
  member_summaries: Array<{
    id: string;
    type: string;
    name?: string;
    business_name?: string;
    tax_id?: string | null;
    registered_address?: string | null;
    industry?: string | null;
    category?: string | null;
  }>;
  match_score: number;
  match_reasons: string[];
  review_reason: string;
}

export interface EmployeeNameInconsistencyConflict extends BackendConflictBase {
  conflict_type: "employee_name_inconsistency";
  entity_id: string;
  entity_type: "Employee";
  hr_name: string;
  signature_variants: Record<string, number>;
  total_mismatched_emails: number;
  distinct_variant_count: number;
  sample_email_ids: string[];
}

export interface PropertyChangeConflict extends BackendConflictBase {
  conflict_type: "human_edit" | string;
  entity_id: string;
  entity_type: string;
  field: string;
  existing_value: unknown;
  new_value: unknown;
  existing_provenance?: BackendProvenance;
  new_provenance?: BackendProvenance;
}

export type BackendConflict =
  | EntityMatchReviewConflict
  | EmployeeNameInconsistencyConflict
  | PropertyChangeConflict;

interface ConflictsResponse {
  total: number;
  conflicts: BackendConflict[];
}

interface GraphStatsResponse {
  total_nodes: number;
  total_edges: number;
  total_conflicts: number;
  nodes_by_type: Record<string, number>;
  edges_by_type: Record<string, number>;
  conflicts_summary: { total: number; auto_resolved: number; pending_review: number };
}

/* ---------------------------------------------------------------- */
/* Endpoints                                                         */
/* ---------------------------------------------------------------- */

export function fetchConflicts(status?: string): Promise<ConflictsResponse> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return request<ConflictsResponse>(`/conflicts${qs}`);
}

export function fetchGraphStats(): Promise<GraphStatsResponse> {
  return request<GraphStatsResponse>("/graph/stats");
}

export function patchVfsField(
  section: string,
  entityId: string,
  field: string,
  value: unknown,
  actor = "anonymous",
  reason?: string
): Promise<{ status: string; node_id: string; field: string; previous_value: unknown; new_value: unknown }> {
  return request(`/vfs/${section}/${encodeURIComponent(entityId)}`, {
    method: "PATCH",
    body: JSON.stringify({ field, value, actor, reason }),
  });
}

export function postVfsNote(
  section: string,
  entityId: string,
  content: string,
  author = "anonymous",
  tags?: string[]
): Promise<{ status: string; note_id: string; target: string; author: string; created_at: string }> {
  return request(`/vfs/${section}/${encodeURIComponent(entityId)}/notes`, {
    method: "POST",
    body: JSON.stringify({ content, author, tags }),
  });
}
