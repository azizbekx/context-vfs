export const API_BASE = '/api';

export async function fetchTree() {
  const res = await fetch(`${API_BASE}/vfs/tree`);
  if (!res.ok) throw new Error('Failed to fetch tree');
  return res.json();
}

export async function fetchFile(path: string) {
  const res = await fetch(`${API_BASE}/vfs/file?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error('Failed to fetch file');
  return res.json();
}

export async function fetchEntity(entityId: string) {
  const res = await fetch(`${API_BASE}/entities/${encodeURIComponent(entityId)}`);
  if (!res.ok) throw new Error('Failed to fetch entity');
  return res.json();
}

export async function fetchNeighbors(entityId: string) {
  const res = await fetch(`${API_BASE}/entities/${encodeURIComponent(entityId)}/neighbors`);
  if (!res.ok) throw new Error('Failed to fetch neighbors');
  return res.json();
}

export async function search(q: string) {
  const res = await fetch(`${API_BASE}/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error('Failed to search');
  return res.json();
}

export async function resolveReview(reviewId: string, choice: string) {
  const res = await fetch(`${API_BASE}/reviews/${encodeURIComponent(reviewId)}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ choice })
  });
  if (!res.ok) throw new Error('Failed to resolve review');
  return res.json();
}

export async function fetchReviews() {
  const res = await fetch(`${API_BASE}/reviews`);
  if (!res.ok) throw new Error('Failed to fetch reviews');
  return res.json();
}

export async function createEntity(payload: {
  entity_id: string;
  entity_type: string;
  name: string;
  path?: string;
  summary?: string;
}) {
  const res = await fetch(`${API_BASE}/entities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function addFact(entityId: string, payload: {
  predicate: string;
  value?: string;
  object_entity_id?: string;
  confidence?: number;
}) {
  const res = await fetch(`${API_BASE}/entities/${encodeURIComponent(entityId)}/facts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function editFact(factId: string, payload: { value?: string; confidence?: number }) {
  const res = await fetch(`${API_BASE}/facts/${encodeURIComponent(factId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteFact(factId: string) {
  const res = await fetch(`${API_BASE}/facts/${encodeURIComponent(factId)}`, {
    method: 'DELETE'
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteEntity(entityId: string) {
  const res = await fetch(`${API_BASE}/entities/${encodeURIComponent(entityId)}`, {
    method: 'DELETE'
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
