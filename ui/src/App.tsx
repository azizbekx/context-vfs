import React, { useState, useEffect } from 'react';
import { 
  Folder, FileText, ChevronRight, ChevronDown, 
  Search, Hexagon, Activity, AlertTriangle, Plus, Trash2, Save, X, Edit3
} from 'lucide-react';
import { motion } from 'framer-motion';
import {
  fetchTree,
  fetchEntity,
  fetchNeighbors,
  fetchFile,
  search,
  fetchReviews,
  resolveReview,
  createEntity,
  addFact,
  editFact,
  deleteFact,
  deleteEntity
} from './api';

// Utilities for VFS parsing
function buildTree(paths: string[]) {
  const root: any = { id: 'root', name: 'Company Data', type: 'folder', children: [], isOpen: true };
  const nodeMap = new Map<string, any>();
  nodeMap.set('root', root);
  
  for (const path of paths) {
    const parts = path.split('/');
    let currentId = 'root';
    let current = root;
    
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      const nodeId = currentId === 'root' ? part : `${currentId}/${part}`;
      
      let existing = nodeMap.get(nodeId);
      
      if (!existing) {
        existing = {
          id: nodeId,
          name: part,
          type: isFile ? 'file' : 'folder',
          children: isFile ? undefined : [],
          isOpen: false,
          originalPath: isFile ? path : undefined
        };
        nodeMap.set(nodeId, existing);
        current.children.push(existing);
      }
      currentId = nodeId;
      current = existing;
    }
  }
  return root.children;
}

export default function App() {
  const [treeData, setTreeData] = useState<any[]>([]);
  const [selectedNode, setSelectedNode] = useState<any | null>(null);
  const [entityData, setEntityData] = useState<any | null>(null);
  const [neighborsData, setNeighborsData] = useState<any[]>([]);
  const [fileContent, setFileContent] = useState<string | null>(null);
  
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  
  const [reviews, setReviews] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [entityForm, setEntityForm] = useState({ entity_id: '', entity_type: '', name: '', summary: '' });
  const [factForm, setFactForm] = useState({ predicate: '', value: '', object_entity_id: '', confidence: '1.0' });
  const [editingFactId, setEditingFactId] = useState<string | null>(null);
  const [editingFactValue, setEditingFactValue] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    refreshData();
  }, []);

  const refreshData = () => {
    fetchTree().then(data => {
      if (data && data.files) setTreeData(buildTree(data.files));
    }).catch(console.error);
    fetchReviews().then(data => {
      if (data && data.reviews) setReviews(data.reviews);
    }).catch(console.error);
  };

  const handleSearch = () => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setHasSearched(false);
      return;
    }
    setIsSearching(true);
    setHasSearched(true);
    search(searchQuery).then(data => {
      setSearchResults(data.results || []);
    }).catch(e => {
      console.error("Search failed", e);
      setSearchResults([]);
    }).finally(() => {
      setIsSearching(false);
    });
  };

  const clearSearch = () => {
    setSearchQuery('');
    setSearchResults([]);
    setHasSearched(false);
  };

  const loadEntity = async (entityId: string) => {
    setLoading(true);
    setFileContent(null);
    setActionError(null);
    try {
      const eData = await fetchEntity(entityId);
      setEntityData(eData);
      const nData = await fetchNeighbors(entityId);
      setNeighborsData(nData.neighbors || []);
    } catch (e) {
      console.error("Failed to load entity", e);
      setEntityData(null);
      setNeighborsData([]);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectNode = async (node: any) => {
    setSelectedNode(node);
    setEntityData(null);
    setNeighborsData([]);
    setFileContent(null);
    setActionError(null);
    
    if (node.type === 'file') {
      if (node.originalPath) {
        setLoading(true);
        try {
          const fData = await fetchFile(node.originalPath);
          setFileContent(fData.content);
          if (fData.entity_id) {
            await loadEntity(fData.entity_id);
          }
        } catch (e) {
          console.error("Failed to load file", e);
          setActionError("Could not load this VFS file.");
        } finally {
          setLoading(false);
        }
      }
    }
  };

  const handleResolve = async (reviewId: string, choice: string) => {
    try {
      await resolveReview(reviewId, choice);
      refreshData();
      if (entityData) {
        loadEntity(entityData.entity.id);
      }
    } catch (e) {
      console.error("Resolve failed", e);
      setActionError("Could not resolve this review.");
    }
  };

  const handleCreateEntity = async () => {
    if (!entityForm.entity_id.trim() || !entityForm.entity_type.trim() || !entityForm.name.trim()) return;
    try {
      const created = await createEntity({
        entity_id: entityForm.entity_id.trim(),
        entity_type: entityForm.entity_type.trim(),
        name: entityForm.name.trim(),
        summary: entityForm.summary.trim() || undefined
      });
      setEntityForm({ entity_id: '', entity_type: '', name: '', summary: '' });
      refreshData();
      loadEntity(created.entity_id);
    } catch (e) {
      console.error("Create entity failed", e);
      setActionError("Could not create entity. Check the ID is unique.");
    }
  };

  const handleAddFact = async () => {
    if (!entityData || !factForm.predicate.trim()) return;
    const confidence = Number.parseFloat(factForm.confidence);
    try {
      await addFact(entityData.entity.id, {
        predicate: factForm.predicate.trim(),
        value: factForm.value.trim() || undefined,
        object_entity_id: factForm.object_entity_id.trim() || undefined,
        confidence: Number.isFinite(confidence) ? confidence : 1.0
      });
      setFactForm({ predicate: '', value: '', object_entity_id: '', confidence: '1.0' });
      refreshData();
      loadEntity(entityData.entity.id);
    } catch (e) {
      console.error("Add fact failed", e);
      setActionError("Could not add fact. Provide a value or object entity ID.");
    }
  };

  const handleEditFact = async (factId: string) => {
    if (!entityData) return;
    try {
      await editFact(factId, { value: editingFactValue });
      setEditingFactId(null);
      setEditingFactValue('');
      refreshData();
      loadEntity(entityData.entity.id);
    } catch (e) {
      console.error("Edit fact failed", e);
      setActionError("Could not edit fact.");
    }
  };

  const handleDeleteFact = async (factId: string) => {
    if (!entityData) return;
    try {
      await deleteFact(factId);
      refreshData();
      loadEntity(entityData.entity.id);
    } catch (e) {
      console.error("Delete fact failed", e);
      setActionError("Could not delete fact.");
    }
  };

  const handleDeleteEntity = async () => {
    if (!entityData) return;
    try {
      await deleteEntity(entityData.entity.id);
      setEntityData(null);
      setNeighborsData([]);
      setFileContent(null);
      refreshData();
    } catch (e) {
      console.error("Delete entity failed", e);
      setActionError("Could not delete entity.");
    }
  };

  const activeReviews = entityData ? reviews.filter(r => r.entity_id === entityData.entity.id && r.status === 'open') : [];

  return (
    <div className="app-container">
      {/* Left Sidebar - VFS & Search */}
      <motion.div 
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: 1, x: 0 }}
        className="sidebar-left glass-panel"
        style={{ padding: '20px', display: 'flex', flexDirection: 'column' }}
      >
        <div className="app-header">
          <div className="logo-area">
            <Hexagon size={24} color="var(--accent-cyan)" />
            <span>Qontext AI</span>
          </div>
        </div>

        <div className="create-panel">
          <div className="heading-sm">Create Entity</div>
          <input
            type="text"
            placeholder="entity:id"
            value={entityForm.entity_id}
            onChange={e => setEntityForm({ ...entityForm, entity_id: e.target.value })}
          />
          <input
            type="text"
            placeholder="type"
            value={entityForm.entity_type}
            onChange={e => setEntityForm({ ...entityForm, entity_type: e.target.value })}
          />
          <input
            type="text"
            placeholder="name"
            value={entityForm.name}
            onChange={e => setEntityForm({ ...entityForm, name: e.target.value })}
          />
          <textarea
            placeholder="summary"
            value={entityForm.summary}
            onChange={e => setEntityForm({ ...entityForm, summary: e.target.value })}
          />
          <button className="action-button primary" onClick={handleCreateEntity}>
            <Plus size={14} />
            Add entity
          </button>
        </div>

        <div style={{ position: 'relative', marginBottom: '24px', display: 'flex', gap: '8px' }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <Search size={16} style={{ position: 'absolute', left: '12px', top: '10px', color: 'var(--text-tertiary)' }} />
            <input 
              type="text" 
              placeholder="Semantic Search..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSearch(); }}
              style={{
                width: '100%',
                padding: '8px 12px 8px 36px',
                background: 'rgba(0,0,0,0.2)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '8px',
                color: 'var(--text-primary)',
                outline: 'none',
                fontSize: '0.875rem'
              }}
            />
            {hasSearched && (
              <button 
                onClick={clearSearch}
                style={{ position: 'absolute', right: '8px', top: '8px', background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: '1rem' }}
              >
                ×
              </button>
            )}
          </div>
          <button 
            onClick={handleSearch}
            style={{
              background: 'var(--accent-cyan)',
              color: '#000',
              border: 'none',
              borderRadius: '8px',
              padding: '0 16px',
              fontWeight: 'bold',
              cursor: 'pointer',
              fontSize: '0.875rem'
            }}
          >
            Search
          </button>
        </div>

        {hasSearched ? (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <div className="heading-sm">Search Results</div>
            {isSearching && <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>Searching...</div>}
            {searchResults.map((res, i) => (
              <div 
                key={i} 
                onClick={() => res.entity_id ? loadEntity(res.entity_id) : null}
                style={{ 
                  padding: '10px', background: 'rgba(0,0,0,0.2)', marginBottom: '8px', 
                  borderRadius: '6px', cursor: 'pointer', border: '1px solid var(--border-subtle)'
                }}
              >
                <div style={{ color: 'var(--accent-cyan)', fontSize: '0.8rem', fontWeight: 'bold' }}>{res.name || res.path}</div>
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginTop: '4px' }}>{res.snippet}</div>
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="heading-sm">Virtual File System</div>
            <div className="tree-container" style={{ flex: 1, overflowY: 'auto' }}>
              {treeData.map(node => (
                <TreeNode key={node.id} node={node} level={0} onSelect={handleSelectNode} selectedId={selectedNode?.id} />
              ))}
            </div>
          </>
        )}
      </motion.div>

      {/* Main Content - Graph */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="main-content glass-panel"
      >
        <div style={{ padding: '20px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', zIndex: 10 }}>
          <h2 style={{ margin: 0, fontSize: '1.25rem', color: 'var(--text-primary)' }}>Context Graph</h2>
        </div>
        
        <div className="graph-canvas" style={{ position: 'relative', overflow: 'hidden', flex: 1, display: 'flex', flexDirection: 'column' }}>
          {fileContent && !entityData && !loading ? (
            <div style={{ padding: '24px', overflowY: 'auto', flex: 1, whiteSpace: 'pre-wrap', color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: '0.9rem', lineHeight: '1.5' }}>
              {fileContent}
            </div>
          ) : (
            <InteractiveGraph entityData={entityData} neighbors={neighborsData} loading={loading} onNodeClick={loadEntity} />
          )}
        </div>
      </motion.div>

      {/* Right Sidebar - Properties & Reviews */}
      <motion.div 
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: 0.2 }}
        className="sidebar-right glass-panel"
        style={{ padding: '20px', display: 'flex', flexDirection: 'column' }}
      >
        <div className="heading-sm">Inspector</div>

        {actionError && (
          <div className="error-banner">
            <span>{actionError}</span>
            <button onClick={() => setActionError(null)} aria-label="Dismiss error">
              <X size={14} />
            </button>
          </div>
        )}
        
        {!entityData && !fileContent && !loading && (
          <div style={{ textAlign: 'center', color: 'var(--text-secondary)', marginTop: '40px', fontSize: '0.875rem' }}>
            <Activity size={32} style={{ opacity: 0.5, margin: '0 auto 16px' }} />
            <div>Select a file or search for an entity to inspect.</div>
          </div>
        )}

        {entityData && (
          <div style={{ flex: 1, overflowY: 'auto', paddingRight: '4px' }}>
            <div style={{ textAlign: 'center', marginBottom: '24px', padding: '20px 0', borderBottom: '1px solid var(--border-subtle)' }}>
              <div style={{ width: '48px', height: '48px', background: 'rgba(0, 229, 255, 0.1)', color: 'var(--accent-cyan)', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
                <Hexagon size={24} />
              </div>
              <h3 style={{ margin: '0 0 4px 0', color: 'var(--text-primary)' }}>{entityData.entity.name}</h3>
              <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>{entityData.entity.type.toUpperCase()}</div>
            </div>

            {activeReviews.length > 0 && (
              <div className="prop-group" style={{ background: 'rgba(255, 152, 0, 0.1)', padding: '12px', borderRadius: '8px', border: '1px solid rgba(255, 152, 0, 0.3)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#ff9800', marginBottom: '12px', fontWeight: 'bold' }}>
                  <AlertTriangle size={18} />
                  Conflicts Detected
                </div>
                {activeReviews.map(r => {
                  const candidates = JSON.parse(r.candidates_json);
                  return (
                    <div key={r.id} style={{ marginBottom: '16px' }}>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-primary)', marginBottom: '8px' }}>
                        Predicate: <b>{r.predicate}</b>
                      </div>
                      {candidates.map((c: any) => (
                        <div key={c.choice_id} style={{ background: 'rgba(0,0,0,0.3)', padding: '8px', borderRadius: '6px', marginBottom: '4px', fontSize: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div>
                            <div style={{ color: 'var(--text-primary)' }}>{c.value}</div>
                            <div style={{ color: 'var(--text-tertiary)', fontSize: '0.65rem' }}>Conf: {Math.round(c.confidence*100)}%</div>
                          </div>
                          <button 
                            onClick={() => handleResolve(r.id, c.choice_id)}
                            style={{ background: 'var(--accent-cyan)', color: '#000', border: 'none', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.7rem' }}
                          >
                            Resolve
                          </button>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="prop-group">
              <div className="heading-sm">Properties</div>
              <div className="prop-row">
                <span className="prop-label">ID</span>
                <span className="prop-value" style={{ fontSize: '0.75rem', maxWidth: '180px', wordBreak: 'break-all' }}>{entityData.entity.id}</span>
              </div>
              {entityData.entity.summary && (
                <div style={{ marginTop: '12px', fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  {entityData.entity.summary}
                </div>
              )}
              <button className="action-button danger" onClick={handleDeleteEntity}>
                <Trash2 size={14} />
                Delete entity
              </button>
            </div>

            <div className="prop-group">
              <div className="heading-sm">Add Fact</div>
              <input
                type="text"
                placeholder="predicate"
                value={factForm.predicate}
                onChange={e => setFactForm({ ...factForm, predicate: e.target.value })}
              />
              <input
                type="text"
                placeholder="value"
                value={factForm.value}
                onChange={e => setFactForm({ ...factForm, value: e.target.value })}
              />
              <input
                type="text"
                placeholder="object entity id"
                value={factForm.object_entity_id}
                onChange={e => setFactForm({ ...factForm, object_entity_id: e.target.value })}
              />
              <input
                type="number"
                min="0"
                max="1"
                step="0.05"
                placeholder="confidence"
                value={factForm.confidence}
                onChange={e => setFactForm({ ...factForm, confidence: e.target.value })}
              />
              <button className="action-button primary" onClick={handleAddFact}>
                <Plus size={14} />
                Add fact
              </button>
            </div>

            <div className="prop-group">
              <div className="heading-sm">Provenance (Facts)</div>
              {entityData.facts.map((fact: any) => (
                <ProvenanceItem
                  key={fact.id}
                  source={fact.source_id}
                  factId={fact.id}
                  predicate={fact.predicate}
                  value={fact.value || fact.object_entity_id || ''}
                  confidence={Math.round(fact.confidence * 100)}
                  editing={editingFactId === fact.id}
                  editingValue={editingFactValue}
                  onStartEdit={() => {
                    setEditingFactId(fact.id);
                    setEditingFactValue(fact.value || '');
                  }}
                  onCancelEdit={() => {
                    setEditingFactId(null);
                    setEditingFactValue('');
                  }}
                  onChangeEdit={setEditingFactValue}
                  onSaveEdit={() => handleEditFact(fact.id)}
                  onDelete={() => handleDeleteFact(fact.id)}
                />
              ))}
              {entityData.facts.length === 0 && <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>No facts available.</div>}
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}

// Custom Interactive Graph
function InteractiveGraph({ entityData, neighbors, loading, onNodeClick }: { entityData: any, neighbors: any[], loading: boolean, onNodeClick: (id: string) => void }) {
  if (loading) {
    return (
      <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}>
        <motion.div
          animate={{ rotate: 360, scale: [1, 1.2, 1] }}
          transition={{ duration: 2, repeat: Infinity }}
          style={{ width: '60px', height: '60px', borderRadius: '50%', border: '2px dashed var(--accent-cyan)' }}
        />
      </div>
    );
  }

  if (!entityData) return null;

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <svg style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        <defs>
          <linearGradient id="lineGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="var(--accent-cyan)" stopOpacity="0.5" />
            <stop offset="100%" stopColor="var(--accent-purple)" stopOpacity="0.5" />
          </linearGradient>
        </defs>
        {neighbors.map((n, i) => {
          const angle = (i / neighbors.length) * Math.PI * 2;
          const radius = 220;
          const x2 = 400 + Math.cos(angle) * radius;
          const y2 = 300 + Math.sin(angle) * radius;
          return (
            <g key={n.id || i}>
              <motion.line
                initial={{ opacity: 0, pathLength: 0 }}
                animate={{ opacity: 1, pathLength: 1 }}
                transition={{ duration: 1, delay: i * 0.1 }}
                x1="400" y1="300" x2={x2} y2={y2}
                stroke="url(#lineGrad)"
                strokeWidth="2"
              />
              <motion.text
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.5 + i * 0.1 }}
                x={400 + Math.cos(angle) * (radius / 2)}
                y={300 + Math.sin(angle) * (radius / 2) - 10}
                fill="var(--text-tertiary)"
                fontSize="10"
                textAnchor="middle"
              >
                {n.relation}
              </motion.text>
            </g>
          );
        })}
      </svg>

      {/* Central Node */}
      <motion.div 
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        style={{
          position: 'absolute', left: '400px', top: '300px', transform: 'translate(-50%, -50%)',
          background: 'rgba(0, 229, 255, 0.1)', border: '2px solid var(--accent-cyan)',
          padding: '16px 24px', borderRadius: '12px', zIndex: 10, boxShadow: '0 0 30px rgba(0, 229, 255, 0.2)',
          textAlign: 'center'
        }}
      >
        <h3 style={{ margin: 0, color: 'var(--accent-cyan)' }}>{entityData.entity.name}</h3>
        <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{entityData.entity.type}</span>
      </motion.div>

      {/* Neighbor Nodes */}
      {neighbors.map((n, i) => {
        const angle = (i / neighbors.length) * Math.PI * 2;
        const radius = 220;
        const x = 400 + Math.cos(angle) * radius;
        const y = 300 + Math.sin(angle) * radius;
        return (
          <motion.div
            key={n.id || i}
            initial={{ opacity: 0, scale: 0 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.5 + i * 0.1 }}
            whileHover={{ scale: 1.1, zIndex: 20, border: '1px solid var(--accent-cyan)' }}
            onClick={() => onNodeClick(n.entity_id)}
            style={{
              position: 'absolute', left: `${x}px`, top: `${y}px`, transform: 'translate(-50%, -50%)',
              background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)',
              padding: '10px 14px', borderRadius: '8px', fontSize: '0.75rem',
              color: 'var(--text-primary)', cursor: 'pointer', zIndex: 5,
              whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', maxWidth: '180px',
              textAlign: 'center'
            }}
          >
            <div>{n.name}</div>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', marginTop: '2px' }}>{n.type}</div>
          </motion.div>
        );
      })}
    </div>
  );
}

function TreeNode({ node, level, onSelect, selectedId }: { node: any, level: number, onSelect: (n: any) => void, selectedId?: string }) {
  const [isOpen, setIsOpen] = useState(node.isOpen || false);
  const isFolder = node.type === 'folder';
  const isActive = node.id === selectedId;
  const DISPLAY_LIMIT = 100;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isFolder) setIsOpen(!isOpen);
    else onSelect(node);
  };

  return (
    <div>
      <div 
        className={`tree-item ${isActive ? 'active' : ''}`}
        style={{ paddingLeft: `${level * 16 + 12}px`, userSelect: 'none' }}
        onClick={handleClick}
      >
        {isFolder ? (
          isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />
        ) : (
          <span style={{ width: 14, display: 'inline-block' }} />
        )}
        
        {isFolder ? (
          <Folder size={14} color="var(--accent-blue)" style={{ minWidth: 14 }} />
        ) : (
          <FileText size={14} color="var(--text-secondary)" style={{ minWidth: 14 }} />
        )}
        
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={node.name}>
          {node.name}
        </span>
      </div>
      
      {isFolder && isOpen && node.children && (
        <div style={{ display: 'block' }}>
          {node.children.slice(0, DISPLAY_LIMIT).map((child: any) => (
            <TreeNode key={child.id} node={child} level={level + 1} onSelect={onSelect} selectedId={selectedId} />
          ))}
          {node.children.length > DISPLAY_LIMIT && (
            <div style={{ paddingLeft: `${(level + 1) * 16 + 12}px`, color: 'var(--text-tertiary)', fontSize: '0.75rem', paddingTop: '6px' }}>
              + {node.children.length - DISPLAY_LIMIT} more
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProvenanceItem({
  source,
  factId,
  predicate,
  value,
  confidence,
  editing,
  editingValue,
  onStartEdit,
  onCancelEdit,
  onChangeEdit,
  onSaveEdit,
  onDelete
}: {
  source: string;
  factId: string;
  predicate: string;
  value: string;
  confidence: number;
  editing: boolean;
  editingValue: string;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onChangeEdit: (value: string) => void;
  onSaveEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div style={{ background: 'var(--bg-surface)', padding: '10px', borderRadius: '8px', marginBottom: '8px', border: '1px solid var(--border-subtle)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
        <span style={{ fontSize: '0.72rem', color: 'var(--accent-cyan)', overflowWrap: 'anywhere' }}>{source}</span>
        <span style={{ fontSize: '0.75rem', color: confidence >= 90 ? '#4caf50' : '#ff9800' }}>{confidence}%</span>
      </div>
      <div style={{ fontSize: '0.875rem', color: 'var(--text-primary)', wordBreak: 'break-word' }}>
        <b>{predicate}</b>: {editing ? (
          <input
            type="text"
            value={editingValue}
            onChange={e => onChangeEdit(e.target.value)}
            style={{ marginTop: '8px' }}
          />
        ) : value}
      </div>
      <div className="fact-actions">
        <button onClick={editing ? onSaveEdit : onStartEdit} title={editing ? 'Save fact' : 'Edit fact'}>
          {editing ? <Save size={13} /> : <Edit3 size={13} />}
        </button>
        {editing && (
          <button onClick={onCancelEdit} title="Cancel edit">
            <X size={13} />
          </button>
        )}
        <button onClick={onDelete} title="Delete fact">
          <Trash2 size={13} />
        </button>
      </div>
      <div style={{ marginTop: '6px', color: 'var(--text-tertiary)', fontSize: '0.65rem', overflowWrap: 'anywhere' }}>{factId}</div>
    </div>
  );
}
