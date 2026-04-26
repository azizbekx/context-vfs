import { useState, useEffect, useCallback } from 'react';
import { Hexagon, Search, Folder, FileText, ChevronRight, ChevronDown, AlertTriangle, Plus, Trash2, Save, X, Edit3, Eye, Code, RefreshCw } from 'lucide-react';
import { fetchTree, fetchEntity, fetchNeighbors, fetchFile, search, fetchReviews, resolveReview, createEntity, addFact, editFact, deleteFact, deleteEntity, fetchStats, fetchFactSources } from './api';
import Dashboard from './components/Dashboard';
import MarkdownRenderer from './components/MarkdownRenderer';

type View = 'dashboard' | 'browser';

function buildTree(paths: string[]) {
  const root: any = { id: 'root', name: 'company', type: 'folder', children: [], isOpen: true };
  const map = new Map<string, any>();
  map.set('root', root);
  for (const path of paths) {
    const parts = path.split('/');
    let parentId = 'root', parent = root;
    for (let i = 0; i < parts.length; i++) {
      const nodeId = parentId === 'root' ? parts[i] : `${parentId}/${parts[i]}`;
      let node = map.get(nodeId);
      if (!node) {
        const isFile = i === parts.length - 1;
        node = { id: nodeId, name: parts[i], type: isFile ? 'file' : 'folder', children: isFile ? undefined : [], isOpen: false, originalPath: isFile ? path : undefined };
        map.set(nodeId, node);
        parent.children.push(node);
      }
      parentId = nodeId;
      parent = node;
    }
  }
  return root.children;
}

export default function App() {
  const [view, setView] = useState<View>('browser');
  const [tree, setTree] = useState<any[]>([]);
  const [selectedNode, setSelectedNode] = useState<any>(null);
  const [entity, setEntity] = useState<any>(null);
  const [neighbors, setNeighbors] = useState<any[]>([]);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [rawMode, setRawMode] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [reviews, setReviews] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [sideTab, setSideTab] = useState<'files' | 'results'>('files');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showAddFactModal, setShowAddFactModal] = useState(false);
  const [editingFact, setEditingFact] = useState<string | null>(null);
  const [editVal, setEditVal] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [sourcePanel, setSourcePanel] = useState<any>(null);
  const [stats, setStats] = useState<any>(null);

  const refresh = useCallback(() => {
    fetchTree().then(d => d?.files && setTree(buildTree(d.files))).catch(() => {});
    fetchReviews().then(d => d?.reviews && setReviews(d.reviews)).catch(() => {});
    fetchStats().then(setStats).catch(() => {});
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const loadEntity = async (id: string) => {
    setLoading(true); setFileContent(null); setErr(null);
    try {
      const [e, n] = await Promise.all([fetchEntity(id), fetchNeighbors(id)]);
      setEntity(e); setNeighbors(n.neighbors || []);
    } catch { setEntity(null); setNeighbors([]); }
    finally { setLoading(false); }
  };

  const selectNode = async (node: any) => {
    setSelectedNode(node); setEntity(null); setNeighbors([]); setFileContent(null); setErr(null); setRawMode(false);
    if (node.type === 'file' && node.originalPath) {
      setLoading(true);
      try {
        const f = await fetchFile(node.originalPath);
        setFileContent(f.content);
        if (f.entity_id) await loadEntity(f.entity_id);
      } catch { setErr('Could not load file.'); }
      finally { setLoading(false); }
    }
  };

  const doSearch = () => {
    if (!query.trim()) return;
    setSearching(true); setHasSearched(true); setSideTab('results');
    search(query).then(d => setResults(d.results || [])).catch(() => setResults([])).finally(() => setSearching(false));
  };

  const clearSearch = () => { setQuery(''); setResults([]); setHasSearched(false); setSideTab('files'); };

  const handleResolve = async (rid: string, choice: string) => {
    try { await resolveReview(rid, choice); refresh(); if (entity) loadEntity(entity.entity.id); }
    catch { setErr('Could not resolve review.'); }
  };

  const handleEditFact = async (fid: string) => {
    if (!entity) return;
    try { await editFact(fid, { value: editVal }); setEditingFact(null); refresh(); loadEntity(entity.entity.id); }
    catch { setErr('Could not edit fact.'); }
  };

  const handleDeleteFact = async (fid: string) => {
    if (!entity) return;
    try { await deleteFact(fid); refresh(); loadEntity(entity.entity.id); }
    catch { setErr('Could not delete fact.'); }
  };

  const handleDeleteEntity = async () => {
    if (!entity || !confirm('Delete this entity and all its facts?')) return;
    try { await deleteEntity(entity.entity.id); setEntity(null); setNeighbors([]); setFileContent(null); refresh(); }
    catch { setErr('Could not delete entity.'); }
  };

  const openReviews = reviews.filter(r => r.status === 'open');
  const entityReviews = entity ? openReviews.filter(r => r.entity_id === entity.entity.id) : [];

  return (
    <div className="shell">
      {/* Top Bar */}
      <header className="topbar">
        <div className="topbar-brand"><Hexagon size={20} />Qontext</div>
        <nav className="topbar-nav">
          <button className={view === 'dashboard' ? 'active' : ''} onClick={() => setView('dashboard')}>Dashboard</button>
          <button className={view === 'browser' ? 'active' : ''} onClick={() => setView('browser')}>Context Browser</button>
        </nav>
        <div className="topbar-stats">
          {stats && <>
            <span className="topbar-stat"><strong>{stats.entities?.toLocaleString()}</strong> entities</span>
            <span className="topbar-stat"><strong>{stats.facts?.toLocaleString()}</strong> facts</span>
            {stats.open_reviews > 0 && <span className="review-badge"><AlertTriangle size={12} />{stats.open_reviews} conflicts</span>}
          </>}
        </div>
      </header>

      <div className="shell-body">
        {view === 'dashboard' ? <Dashboard /> : (
          <div className="layout-3col">
            {/* Sidebar */}
            <aside className="col-sidebar">
              <div className="sidebar-search">
                <div className="search-input-wrap">
                  <Search size={14} />
                  <input placeholder="Search context…" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && doSearch()} />
                  {hasSearched && <button className="btn-xs" onClick={clearSearch}><X size={12} /></button>}
                </div>
              </div>
              <div className="sidebar-tabs">
                <button className={sideTab === 'files' ? 'active' : ''} onClick={() => setSideTab('files')}>Files</button>
                <button className={sideTab === 'results' ? 'active' : ''} onClick={() => setSideTab('results')}>
                  Results{hasSearched && ` (${results.length})`}
                </button>
              </div>
              <div className="sidebar-list">
                {sideTab === 'files' ? (
                  tree.map(n => <TreeNode key={n.id} node={n} level={0} onSelect={selectNode} selectedId={selectedNode?.id} />)
                ) : (
                  searching ? <div className="loading-center"><div className="spinner" /></div> :
                  results.length === 0 && hasSearched ? <div style={{ padding: 16, fontSize: 13, color: 'var(--muted)' }}>No results found.</div> :
                  results.map((r, i) => (
                    <div key={i} className="search-result" onClick={() => r.entity_id && loadEntity(r.entity_id)}>
                      <div className="search-result-name">{r.name || r.path}</div>
                      <div className="search-result-snippet">{r.snippet}</div>
                    </div>
                  ))
                )}
              </div>
            </aside>

            {/* Main content */}
            <main className="col-main">
              <div className="main-toolbar">
                <span className="main-toolbar-path">{selectedNode ? selectedNode.id : 'No file selected'}</span>
                <div className="main-toolbar-actions">
                  {fileContent && <>
                    <button className={`btn-sm ${!rawMode ? 'btn-primary' : ''}`} onClick={() => setRawMode(false)}><Eye size={13} /> Preview</button>
                    <button className={`btn-sm ${rawMode ? 'btn-primary' : ''}`} onClick={() => setRawMode(true)}><Code size={13} /> Raw</button>
                  </>}
                  <button className="btn-sm" onClick={refresh}><RefreshCw size={13} /></button>
                  <button className="btn-sm btn-primary" onClick={() => setShowCreateModal(true)}><Plus size={13} /> Entity</button>
                </div>
              </div>
              <div className="main-body">
                {loading ? <div className="loading-center"><div className="spinner" /></div> :
                 fileContent && !entity ? (
                   <div className="doc-card">{rawMode ? <pre className="raw-view">{fileContent}</pre> : <MarkdownRenderer content={fileContent} />}</div>
                 ) : entity ? (
                   <GraphView entity={entity} neighbors={neighbors} onNodeClick={loadEntity} fileContent={fileContent} rawMode={rawMode} />
                 ) : (
                   <div className="empty-state"><Folder size={36} /><p>Select a file from the VFS or search for an entity to begin.</p></div>
                 )}
              </div>
            </main>

            {/* Inspector */}
            <aside className="col-inspector">
              {entity ? <>
                <div className="inspector-section">
                  <div className="entity-header">
                    <div className="entity-icon"><Hexagon size={18} /></div>
                    <div>
                      <div className="entity-name">{entity.entity.name}</div>
                      <span className="entity-type">{entity.entity.type}</span>
                    </div>
                  </div>
                  <div className="entity-id">{entity.entity.id}</div>
                  {entity.entity.summary && <div className="entity-summary">{entity.entity.summary}</div>}
                  <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
                    <button className="btn-sm btn-danger" onClick={handleDeleteEntity}><Trash2 size={12} /> Delete</button>
                  </div>
                </div>

                {entityReviews.length > 0 && (
                  <div className="inspector-section">
                    <h3><AlertTriangle size={13} style={{ display: 'inline', verticalAlign: -2 }} /> Conflicts ({entityReviews.length})</h3>
                    {entityReviews.map(r => {
                      const cands = JSON.parse(r.candidates_json);
                      return (
                        <div key={r.id} className="conflict-card">
                          <div className="conflict-header">{r.predicate}</div>
                          {cands.map((c: any) => (
                            <div key={c.choice_id} className="conflict-option">
                              <div><div>{c.value}</div><div className="conflict-option-meta">Confidence: {Math.round(c.confidence * 100)}%</div></div>
                              <button className="btn-xs btn-primary" onClick={() => handleResolve(r.id, c.choice_id)}>Accept</button>
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="inspector-section">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <h3 style={{ margin: 0 }}>Facts ({entity.facts.length})</h3>
                    <button className="btn-xs btn-primary" onClick={() => setShowAddFactModal(true)}><Plus size={11} /> Add</button>
                  </div>
                  {entity.facts.length === 0 && <div style={{ fontSize: 13, color: 'var(--muted)' }}>No facts.</div>}
                  {entity.facts.map((f: any) => {
                    const conf = Math.round(f.confidence * 100);
                    const confClass = conf >= 90 ? 'high' : conf >= 60 ? 'medium' : 'low';
                    return (
                      <div key={f.id} className="fact-card">
                        <div className="fact-header">
                          <span className="fact-predicate">{f.predicate}</span>
                          <span className={`fact-confidence ${confClass}`}>{conf}%</span>
                        </div>
                        <div className="fact-value">
                          {editingFact === f.id ? (
                            <input value={editVal} onChange={e => setEditVal(e.target.value)} autoFocus style={{ marginTop: 4 }} />
                          ) : (f.value || f.object_entity_id || '—')}
                        </div>
                        {f.source_id && <div className="fact-source" onClick={() => fetchFactSources(f.id).then(d => setSourcePanel(d.fact)).catch(() => {})}>{f.source_id}</div>}
                        <div className="fact-actions">
                          {editingFact === f.id ? <>
                            <button className="btn-icon" onClick={() => handleEditFact(f.id)} title="Save"><Save size={13} /></button>
                            <button className="btn-icon" onClick={() => setEditingFact(null)} title="Cancel"><X size={13} /></button>
                          </> : <button className="btn-icon" onClick={() => { setEditingFact(f.id); setEditVal(f.value || ''); }} title="Edit"><Edit3 size={13} /></button>}
                          <button className="btn-icon" onClick={() => handleDeleteFact(f.id)} title="Delete"><Trash2 size={13} /></button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {neighbors.length > 0 && (
                  <div className="inspector-section">
                    <h3>Graph Neighbors ({neighbors.length})</h3>
                    {neighbors.map((n, i) => (
                      <div key={i} className="search-result" onClick={() => loadEntity(n.entity_id)} style={{ cursor: 'pointer' }}>
                        <div className="search-result-name">{n.name}</div>
                        <div className="search-result-snippet">{n.relation} · {n.type}</div>
                      </div>
                    ))}
                  </div>
                )}

                {openReviews.length > 0 && entityReviews.length === 0 && (
                  <div className="inspector-section">
                    <h3>All Open Reviews ({openReviews.length})</h3>
                    {openReviews.slice(0, 10).map(r => (
                      <div key={r.id} className="search-result" onClick={() => loadEntity(r.entity_id)} style={{ cursor: 'pointer' }}>
                        <div className="search-result-name">{r.entity_id}</div>
                        <div className="search-result-snippet">{r.predicate}</div>
                      </div>
                    ))}
                    {openReviews.length > 10 && <div style={{ fontSize: 12, color: 'var(--muted)', padding: '6px 10px' }}>+ {openReviews.length - 10} more</div>}
                  </div>
                )}
              </> : (
                <div className="inspector-section">
                  <div className="empty-state" style={{ padding: '40px 16px' }}>
                    <Search size={28} /><p>Select an entity to inspect its properties, facts, and provenance.</p>
                  </div>
                  {openReviews.length > 0 && (
                    <div style={{ padding: '0 16px 16px' }}>
                      <h3 style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted)', marginBottom: 10 }}>
                        Open Reviews ({openReviews.length})
                      </h3>
                      {openReviews.slice(0, 8).map(r => (
                        <div key={r.id} className="search-result" onClick={() => loadEntity(r.entity_id)} style={{ cursor: 'pointer' }}>
                          <div className="search-result-name">{r.entity_id}</div>
                          <div className="search-result-snippet">{r.predicate}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </aside>
          </div>
        )}
      </div>

      {err && (
        <div style={{ position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)', background: '#dc2626', color: '#fff', padding: '8px 16px', borderRadius: 8, fontSize: 13, display: 'flex', gap: 10, alignItems: 'center', zIndex: 100 }}>
          {err} <button onClick={() => setErr(null)} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer' }}><X size={14} /></button>
        </div>
      )}

      {sourcePanel && (
        <div className="source-panel">
          <header>
            <h3>Source Record</h3>
            <button className="btn-sm" onClick={() => setSourcePanel(null)}><X size={13} /></button>
          </header>
          <pre>{JSON.stringify(sourcePanel, null, 2)}</pre>
        </div>
      )}

      {showCreateModal && <CreateEntityModal onClose={() => setShowCreateModal(false)} onCreated={(id) => { setShowCreateModal(false); refresh(); loadEntity(id); }} />}
      {showAddFactModal && entity && <AddFactModal entityId={entity.entity.id} onClose={() => setShowAddFactModal(false)} onAdded={() => { setShowAddFactModal(false); refresh(); loadEntity(entity.entity.id); }} />}
    </div>
  );
}

/* ── Graph View ── */
function GraphView({ entity, neighbors, onNodeClick, fileContent, rawMode }: any) {
  if (!entity) return null;

  const graphWidth = Math.max(760, Math.min(1400, 520 + neighbors.length * 56));
  const graphHeight = Math.max(420, Math.min(900, 360 + neighbors.length * 18));
  const cx = graphWidth / 2;
  const cy = graphHeight / 2;
  const rx = Math.max(240, graphWidth / 2 - 140);
  const ry = Math.max(135, graphHeight / 2 - 96);
  const nodePosition = (index: number) => {
    const angle = (index / neighbors.length) * Math.PI * 2 - Math.PI / 2;
    return {
      x: cx + Math.cos(angle) * rx,
      y: cy + Math.sin(angle) * ry,
    };
  };

  return (
    <div className="entity-content">
      {fileContent && <div className="doc-card">{rawMode ? <pre className="raw-view">{fileContent}</pre> : <MarkdownRenderer content={fileContent} />}</div>}
      {neighbors.length > 0 && (
        <div className="doc-card graph-card">
          <div className="graph-card-header">Relationship Graph</div>
          <div className="graph-scroller">
            <div className="graph-surface" style={{ width: graphWidth, height: graphHeight }}>
              <svg
                viewBox={`0 0 ${graphWidth} ${graphHeight}`}
                className="graph-edges"
                aria-hidden="true"
              >
              {neighbors.map((_n: any, i: number) => {
                const { x, y } = nodePosition(i);
                return (
                  <line
                    key={i}
                    x1={cx}
                    y1={cy}
                    x2={x}
                    y2={y}
                    stroke="#e4e7ec"
                    strokeWidth="1.5"
                  />
                );
              })}
              </svg>
              <div className="graph-center-node" style={{ left: cx, top: cy }}>
                <div className="name">{entity.entity.name}</div>
                <div className="type">{entity.entity.type}</div>
              </div>
              {neighbors.map((n: any, i: number) => {
                const { x, y } = nodePosition(i);
                return (
                  <div
                    key={i}
                    className="graph-neighbor"
                    onClick={() => onNodeClick(n.entity_id)}
                    style={{ left: x, top: y }}
                    title={`${n.name} (${n.relation})`}
                  >
                    <div className="name">{n.name}</div>
                    <div className="type">{n.relation}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
      {neighbors.length === 0 && (
        <div className="doc-card graph-card">
          <div className="graph-card-header">Relationship Graph</div>
          <div className="graph-empty">
            <div className="graph-center-node static">
              <div className="name">{entity.entity.name}</div>
              <div className="type">{entity.entity.type}</div>
            </div>
            <div className="graph-empty-text">No graph neighbors.</div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Tree Node ── */
function TreeNode({ node, level, onSelect, selectedId }: any) {
  const [open, setOpen] = useState(node.isOpen || false);
  const isFolder = node.type === 'folder';
  const LIMIT = 100;
  return (
    <div>
      <div className={`tree-item ${node.id === selectedId ? 'active' : ''}`} style={{ paddingLeft: level * 16 + 8 }}
        onClick={e => { e.stopPropagation(); isFolder ? setOpen(!open) : onSelect(node); }}>
        {isFolder ? (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <span style={{ width: 14 }} />}
        {isFolder ? <Folder size={14} color="var(--accent)" /> : <FileText size={14} color="var(--muted)" />}
        <span className="tree-label" title={node.name}>{node.name}</span>
      </div>
      {isFolder && open && node.children && <>
        {node.children.slice(0, LIMIT).map((c: any) => <TreeNode key={c.id} node={c} level={level + 1} onSelect={onSelect} selectedId={selectedId} />)}
        {node.children.length > LIMIT && <div className="tree-more" style={{ paddingLeft: (level + 1) * 16 + 8 }}>+ {node.children.length - LIMIT} more</div>}
      </>}
    </div>
  );
}

/* ── Create Entity Modal ── */
function CreateEntityModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [form, setForm] = useState({ entity_id: '', entity_type: '', name: '', summary: '' });
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (!form.entity_id || !form.entity_type || !form.name) return;
    setSaving(true);
    try { const r = await createEntity({ ...form, summary: form.summary || undefined }); onCreated(r.entity_id); }
    catch { alert('Failed to create entity.'); }
    finally { setSaving(false); }
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <h2>Create Entity</h2>
        <div className="field"><label>Entity ID</label><input placeholder="e.g. employee:john-doe" value={form.entity_id} onChange={e => setForm({ ...form, entity_id: e.target.value })} /></div>
        <div className="field"><label>Type</label><input placeholder="e.g. employee, customer, product" value={form.entity_type} onChange={e => setForm({ ...form, entity_type: e.target.value })} /></div>
        <div className="field"><label>Name</label><input placeholder="Display name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
        <div className="field"><label>Summary (optional)</label><textarea placeholder="Brief description…" value={form.summary} onChange={e => setForm({ ...form, summary: e.target.value })} /></div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>{saving ? 'Creating…' : 'Create'}</button>
        </div>
      </div>
    </div>
  );
}

/* ── Add Fact Modal ── */
function AddFactModal({ entityId, onClose, onAdded }: { entityId: string; onClose: () => void; onAdded: () => void }) {
  const [form, setForm] = useState({ predicate: '', value: '', object_entity_id: '', confidence: '1.0' });
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (!form.predicate) return;
    setSaving(true);
    try {
      await addFact(entityId, { predicate: form.predicate, value: form.value || undefined, object_entity_id: form.object_entity_id || undefined, confidence: parseFloat(form.confidence) || 1.0 });
      onAdded();
    } catch { alert('Failed to add fact.'); }
    finally { setSaving(false); }
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <h2>Add Fact to {entityId}</h2>
        <div className="field"><label>Predicate</label><input placeholder="e.g. role, department, email" value={form.predicate} onChange={e => setForm({ ...form, predicate: e.target.value })} /></div>
        <div className="field"><label>Value</label><input placeholder="Fact value" value={form.value} onChange={e => setForm({ ...form, value: e.target.value })} /></div>
        <div className="field"><label>Object Entity ID (optional)</label><input placeholder="Link to another entity" value={form.object_entity_id} onChange={e => setForm({ ...form, object_entity_id: e.target.value })} /></div>
        <div className="field"><label>Confidence</label><input type="number" min="0" max="1" step="0.05" value={form.confidence} onChange={e => setForm({ ...form, confidence: e.target.value })} /></div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>{saving ? 'Adding…' : 'Add Fact'}</button>
        </div>
      </div>
    </div>
  );
}
