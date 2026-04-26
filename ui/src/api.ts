export const API_BASE = '/api';

async function request(url: string, options?: RequestInit) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export const fetchTree = () => request(`${API_BASE}/vfs/tree`);
export const fetchFile = (path: string) => request(`${API_BASE}/vfs/file?path=${encodeURIComponent(path)}`);
export const fetchEntity = (entityId: string) => request(`${API_BASE}/entities/${encodeURIComponent(entityId)}`);
export const fetchNeighbors = (entityId: string) => request(`${API_BASE}/entities/${encodeURIComponent(entityId)}/neighbors`);
export const search = (q: string) => request(`${API_BASE}/search?q=${encodeURIComponent(q)}`);
export const fetchReviews = () => request(`${API_BASE}/reviews`);
export const fetchStats = () => request(`${API_BASE}/stats`);
export const fetchFactSources = (factId: string) => request(`${API_BASE}/facts/${encodeURIComponent(factId)}/sources`);

export const resolveReview = (reviewId: string, choice: string) =>
  request(`${API_BASE}/reviews/${encodeURIComponent(reviewId)}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ choice }),
  });

export const autoResolveReview = (reviewId: string) =>
  request(`${API_BASE}/reviews/${encodeURIComponent(reviewId)}/auto-resolve`, {
    method: 'POST',
  });

export const createEntity = (payload: {
  entity_id: string;
  entity_type: string;
  name: string;
  path?: string;
  summary?: string;
}) =>
  request(`${API_BASE}/entities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

export const addFact = (entityId: string, payload: {
  predicate: string;
  value?: string;
  object_entity_id?: string;
  confidence?: number;
}) =>
  request(`${API_BASE}/entities/${encodeURIComponent(entityId)}/facts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

export const editFact = (factId: string, payload: { value?: string; confidence?: number }) =>
  request(`${API_BASE}/facts/${encodeURIComponent(factId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

export const deleteFact = (factId: string) =>
  request(`${API_BASE}/facts/${encodeURIComponent(factId)}`, { method: 'DELETE' });

export const deleteEntity = (entityId: string) =>
  request(`${API_BASE}/entities/${encodeURIComponent(entityId)}`, { method: 'DELETE' });

export const refreshVfs = () =>
  request(`${API_BASE}/vfs/refresh`, { method: 'POST' });
