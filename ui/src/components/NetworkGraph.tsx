import { useRef, useEffect, useState, useCallback } from 'react';
import { Maximize2 } from 'lucide-react';
import * as d3 from 'd3';
import { readGraphTheme } from '../graphTheme';

const TYPE_COLORS: Record<string, string> = {
  employee: '#3B82F6', client: '#F59E0B', customer: '#EF4444',
  product: '#EC4899', project: '#10B981', ticket: '#F97316',
  policy: '#8B5CF6', email_thread: '#06B6D4', conversation: '#06B6D4',
  repo: '#6366F1',
};
const DEFAULT_COLOR = '#64748B';
function colorFor(type: string) { return TYPE_COLORS[type] || DEFAULT_COLOR; }

interface Neighbor { entity_id: string; name: string; type: string; relation: string; direction: string; }
interface GraphNode extends d3.SimulationNodeDatum { id: string; name: string; type: string; isCenter: boolean; isSummary?: boolean; summaryCount?: number; summaryType?: string; }
interface GraphLink extends d3.SimulationLinkDatum<GraphNode> { relation: string; }
interface Props { entity: { entity: { id: string; name: string; type: string } }; neighbors: Neighbor[]; onNodeClick: (entityId: string) => void; }

const MAX_PER_TYPE = 5;
const MAX_TOTAL = 30;
const NODE_W = 140, NODE_H = 48, CENTER_W = 170, CENTER_H = 56, FIT_PADDING = 60;

function buildGraphData(entity: Props['entity'], neighbors: Neighbor[]) {
  const center: GraphNode = { id: entity.entity.id, name: entity.entity.name, type: entity.entity.type, isCenter: true };
  const nodes: GraphNode[] = [center];
  const links: GraphLink[] = [];
  const seen = new Set([center.id]);

  if (neighbors.length > MAX_TOTAL) {
    const grouped = new Map<string, Neighbor[]>();
    for (const n of neighbors) { if (!grouped.has(n.relation)) grouped.set(n.relation, []); grouped.get(n.relation)!.push(n); }
    for (const [relation, group] of grouped) {
      const shown = group.slice(0, MAX_PER_TYPE);
      for (const n of shown) { if (seen.has(n.entity_id)) continue; seen.add(n.entity_id); nodes.push({ id: n.entity_id, name: n.name, type: n.type, isCenter: false }); links.push({ source: center.id, target: n.entity_id, relation }); }
      const remaining = group.length - shown.length;
      if (remaining > 0) { const sid = `__summary__${relation}`; nodes.push({ id: sid, name: `+${remaining} more`, type: group[0].type, isCenter: false, isSummary: true, summaryCount: remaining, summaryType: relation }); links.push({ source: center.id, target: sid, relation }); }
    }
  } else {
    for (const n of neighbors) { if (seen.has(n.entity_id)) continue; seen.add(n.entity_id); nodes.push({ id: n.entity_id, name: n.name, type: n.type, isCenter: false }); links.push({ source: center.id, target: n.entity_id, relation: n.relation }); }
  }
  return { nodes, links };
}

function curvedPath(sx: number, sy: number, tx: number, ty: number) {
  const dr = Math.sqrt((tx - sx) ** 2 + (ty - sy) ** 2) * 0.6;
  return `M${sx},${sy} A${dr},${dr} 0 0,1 ${tx},${ty}`;
}

export default function NetworkGraph({ entity, neighbors, onNodeClick }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; id: string; type: string } | null>(null);
  const simulationRef = useRef<d3.Simulation<GraphNode, GraphLink> | null>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const gRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const nodesDataRef = useRef<GraphNode[]>([]);

  const fitToView = useCallback((animated = true) => {
    const svg = svgRef.current; const container = containerRef.current; const zoomBehavior = zoomRef.current;
    if (!svg || !container || !zoomBehavior) return;
    const nodes = nodesDataRef.current; if (!nodes.length) return;
    const width = container.clientWidth; const height = container.clientHeight;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) { const hw = (n.isCenter ? CENTER_W : NODE_W) / 2 + 10; const hh = (n.isCenter ? CENTER_H : NODE_H) / 2 + 10; if (n.x! - hw < minX) minX = n.x! - hw; if (n.y! - hh < minY) minY = n.y! - hh; if (n.x! + hw > maxX) maxX = n.x! + hw; if (n.y! + hh > maxY) maxY = n.y! + hh; }
    const bw = maxX - minX; const bh = maxY - minY; if (bw <= 0 || bh <= 0) return;
    const scale = Math.min((width - FIT_PADDING * 2) / bw, (height - FIT_PADDING * 2) / bh, 2);
    const cx = (minX + maxX) / 2; const cy = (minY + maxY) / 2;
    const transform = d3.zoomIdentity.translate(width / 2, height / 2).scale(scale).translate(-cx, -cy);
    const sel = d3.select(svg);
    if (animated) sel.transition().duration(600).ease(d3.easeCubicOut).call(zoomBehavior.transform, transform);
    else sel.call(zoomBehavior.transform, transform);
  }, []);

  const handleNodeClick = useCallback((nodeId: string, isSummary?: boolean) => {
    if (isSummary || nodeId === entity.entity.id) return;
    onNodeClick(nodeId);
  }, [entity.entity.id, onNodeClick]);

  useEffect(() => {
    const svg = svgRef.current; const container = containerRef.current;
    if (!svg || !container) return;
    const width = container.clientWidth; const height = container.clientHeight;
    const t = readGraphTheme();

    const { nodes, links } = buildGraphData(entity, neighbors);
    nodesDataRef.current = nodes;

    const svgSel = d3.select(svg);
    svgSel.selectAll('*').remove();
    svgSel.attr('width', width).attr('height', height);
    const defs = svgSel.append('defs');

    for (const [type, color] of Object.entries(TYPE_COLORS)) {
      const f = defs.append('filter').attr('id', `glow-${type}`).attr('x', '-60%').attr('y', '-60%').attr('width', '220%').attr('height', '220%');
      f.append('feGaussianBlur').attr('in', 'SourceGraphic').attr('stdDeviation', '6').attr('result', 'blur');
      f.append('feFlood').attr('flood-color', color).attr('flood-opacity', t.glowOpacity);
      f.append('feComposite').attr('in2', 'blur').attr('operator', 'in').attr('result', 'glow');
      const m = f.append('feMerge'); m.append('feMergeNode').attr('in', 'glow'); m.append('feMergeNode').attr('in', 'SourceGraphic');
    }
    const cf = defs.append('filter').attr('id', 'glow-center').attr('x', '-60%').attr('y', '-60%').attr('width', '220%').attr('height', '220%');
    cf.append('feGaussianBlur').attr('in', 'SourceGraphic').attr('stdDeviation', '8').attr('result', 'blur');
    cf.append('feFlood').attr('flood-color', t.centerGlow.replace(/[\d.]+\)$/, '1)')).attr('flood-opacity', '0.45');
    cf.append('feComposite').attr('in2', 'blur').attr('operator', 'in').attr('result', 'glow');
    const cm = cf.append('feMerge'); cm.append('feMergeNode').attr('in', 'glow'); cm.append('feMergeNode').attr('in', 'SourceGraphic');

    const df = defs.append('filter').attr('id', 'glow-default').attr('x', '-60%').attr('y', '-60%').attr('width', '220%').attr('height', '220%');
    df.append('feGaussianBlur').attr('in', 'SourceGraphic').attr('stdDeviation', '6').attr('result', 'blur');
    df.append('feFlood').attr('flood-color', DEFAULT_COLOR).attr('flood-opacity', t.glowOpacity);
    df.append('feComposite').attr('in2', 'blur').attr('operator', 'in').attr('result', 'glow');
    const dm = df.append('feMerge'); dm.append('feMergeNode').attr('in', 'glow'); dm.append('feMergeNode').attr('in', 'SourceGraphic');

    defs.append('marker').attr('id', 'arrowhead').attr('viewBox', '0 -4 8 8').attr('refX', 8).attr('refY', 0).attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto').append('path').attr('d', 'M0,-3.5L8,0L0,3.5').attr('fill', t.arrow);
    defs.append('marker').attr('id', 'arrowhead-bright').attr('viewBox', '0 -4 8 8').attr('refX', 8).attr('refY', 0).attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto').append('path').attr('d', 'M0,-3.5L8,0L0,3.5').attr('fill', t.arrowBright);

    const g = svgSel.append('g'); gRef.current = g;
    const zoomBehavior = d3.zoom<SVGSVGElement, unknown>().scaleExtent([0.15, 5]).on('zoom', (event) => g.attr('transform', event.transform));
    zoomRef.current = zoomBehavior;
    svgSel.call(zoomBehavior);
    svgSel.call(zoomBehavior.transform, d3.zoomIdentity.translate(width / 2, height / 2));

    const nodeLinks = new Map<string, Set<number>>();
    links.forEach((l, i) => {
      const sid = typeof l.source === 'object' ? (l.source as GraphNode).id : l.source as string;
      const tid = typeof l.target === 'object' ? (l.target as GraphNode).id : l.target as string;
      if (!nodeLinks.has(sid)) nodeLinks.set(sid, new Set()); if (!nodeLinks.has(tid)) nodeLinks.set(tid, new Set());
      nodeLinks.get(sid)!.add(i); nodeLinks.get(tid)!.add(i);
    });

    const linkSel = g.append('g').selectAll<SVGPathElement, GraphLink>('path').data(links).join('path')
      .attr('fill', 'none').attr('stroke', t.edge).attr('stroke-width', 1.5).attr('marker-end', 'url(#arrowhead)');

    const labelSel = g.append('g').selectAll<SVGTextElement, GraphLink>('text').data(links).join('text')
      .text(d => d.relation).attr('text-anchor', 'middle').attr('fill', t.label)
      .attr('font-size', '9px').attr('font-family', 'Inter, sans-serif').attr('dy', -6).style('pointer-events', 'none');

    const nodeSel = g.append('g').selectAll<SVGGElement, GraphNode>('g').data(nodes, d => d.id).join('g')
      .attr('cursor', d => d.isSummary ? 'default' : 'pointer')
      .on('click', (_e, d) => handleNodeClick(d.id, d.isSummary))
      .on('mouseenter', function (event, d) {
        if (!d.isSummary) { const rect = container.getBoundingClientRect(); setTooltip({ x: event.clientX - rect.left, y: event.clientY - rect.top - 10, id: d.id, type: d.type }); }
        const cs = nodeLinks.get(d.id) || new Set<number>();
        linkSel.attr('stroke', (_l, i) => cs.has(i) ? t.edgeHover : t.edgeDim).attr('stroke-width', (_l, i) => cs.has(i) ? 2.2 : 1).attr('marker-end', (_l, i) => cs.has(i) ? 'url(#arrowhead-bright)' : 'url(#arrowhead)');
        labelSel.attr('fill', (_l, i) => cs.has(i) ? t.labelHover : t.labelDim);
        nodeSel.style('opacity', n => { if (n.id === d.id) return 1; return links.some((l, i) => cs.has(i) && (((l.source as GraphNode).id === n.id) || ((l.target as GraphNode).id === n.id))) ? 1 : 0.25; });
      })
      .on('mouseleave', () => { setTooltip(null); linkSel.attr('stroke', t.edge).attr('stroke-width', 1.5).attr('marker-end', 'url(#arrowhead)'); labelSel.attr('fill', t.label); nodeSel.style('opacity', 1); });

    nodeSel.each(function (d) {
      const el = d3.select(this);
      const w = d.isCenter ? CENTER_W : NODE_W; const h = d.isCenter ? CENTER_H : NODE_H;
      const color = d.isCenter ? t.centerStroke : colorFor(d.type);
      const filterName = d.isCenter ? 'url(#glow-center)' : TYPE_COLORS[d.type] ? `url(#glow-${d.type})` : 'url(#glow-default)';
      el.append('rect').attr('x', -w / 2).attr('y', -h / 2).attr('width', w).attr('height', h).attr('rx', 10)
        .attr('fill', d.isCenter ? t.centerFill : t.nodeFill).attr('stroke', color).attr('stroke-width', d.isCenter ? 2 : 1.5).attr('filter', filterName);
      if (!d.isSummary) el.append('text').text(d.type).attr('y', -h / 2 + 14).attr('text-anchor', 'middle').attr('fill', color).attr('font-size', '9px').attr('font-weight', '600').attr('font-family', 'Inter, sans-serif').style('text-transform', 'uppercase').style('pointer-events', 'none');
      const name = d.name.length > 20 ? d.name.slice(0, 19) + '\u2026' : d.name;
      el.append('text').text(name).attr('y', d.isSummary ? 4 : 8).attr('text-anchor', 'middle')
        .attr('fill', d.isCenter ? t.text : d.isSummary ? t.textMuted : t.text)
        .attr('font-size', d.isCenter ? '13px' : d.isSummary ? '11px' : '12px').attr('font-weight', d.isCenter ? '600' : '500').attr('font-family', 'Inter, sans-serif').style('pointer-events', 'none');
    });

    const drag = d3.drag<SVGGElement, GraphNode>()
      .on('start', (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end', (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; });
    nodeSel.call(drag);

    const simulation = d3.forceSimulation<GraphNode>(nodes)
      .force('link', d3.forceLink<GraphNode, GraphLink>(links).id(d => d.id).distance(170))
      .force('charge', d3.forceManyBody().strength(-450))
      .force('center', d3.forceCenter(0, 0))
      .force('collision', d3.forceCollide<GraphNode>().radius(d => d.isCenter ? 65 : 55))
      .alpha(1).alphaDecay(0.028);
    simulationRef.current = simulation;

    let hasFitted = false;
    simulation.on('tick', () => {
      linkSel.attr('d', d => {
        const s = d.source as GraphNode; const tgt = d.target as GraphNode;
        const dx = tgt.x! - s.x!; const dy = tgt.y! - s.y!; const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const offset = Math.min((tgt.isCenter ? CENTER_W : NODE_W) / 2, (tgt.isCenter ? CENTER_H : NODE_H) / 2) + 4;
        return curvedPath(s.x!, s.y!, tgt.x! - (dx / dist) * offset, tgt.y! - (dy / dist) * offset);
      });
      labelSel.attr('x', d => ((d.source as GraphNode).x! + (d.target as GraphNode).x!) / 2)
        .attr('y', d => { const s = d.source as GraphNode; const tgt = d.target as GraphNode; const dist = Math.sqrt((tgt.x! - s.x!) ** 2 + (tgt.y! - s.y!) ** 2) || 1; return (s.y! + tgt.y!) / 2 - dist * 0.08; });
      nodeSel.attr('transform', d => `translate(${d.x},${d.y})`);
      if (!hasFitted && simulation.alpha() < 0.15) { hasFitted = true; fitToView(true); }
    });

    return () => { simulation.stop(); simulationRef.current = null; };
  }, [entity, neighbors, handleNodeClick, fitToView]);

  return (
    <div ref={containerRef} className="network-graph-container">
      <svg ref={svgRef} />
      <button className="graph-fit-btn" onClick={() => fitToView(true)} title="Fit to view"><Maximize2 size={14} /></button>
      {tooltip && <div className="graph-tooltip" style={{ left: tooltip.x, top: tooltip.y }}><div className="graph-tooltip-id">{tooltip.id}</div><div className="graph-tooltip-type">{tooltip.type}</div></div>}
    </div>
  );
}
