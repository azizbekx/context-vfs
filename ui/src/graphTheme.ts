export interface GraphTheme {
  nodeFill: string;
  centerFill: string;
  text: string;
  textMuted: string;
  edge: string;
  edgeHover: string;
  edgeDim: string;
  label: string;
  labelHover: string;
  labelDim: string;
  arrow: string;
  arrowBright: string;
  centerStroke: string;
  centerGlow: string;
  glowOpacity: string;
}

export function readGraphTheme(): GraphTheme {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    nodeFill:     v('--graph-node-fill',     '#141620'),
    centerFill:   v('--graph-center-fill',   '#1A1D27'),
    text:         v('--graph-text',          '#E4E4E7'),
    textMuted:    v('--graph-text-muted',    '#9CA3AF'),
    edge:         v('--graph-edge',          'rgba(255,255,255,0.19)'),
    edgeHover:    v('--graph-edge-hover',    'rgba(255,255,255,0.6)'),
    edgeDim:      v('--graph-edge-dim',      'rgba(255,255,255,0.06)'),
    label:        v('--graph-label',         'rgba(255,255,255,0.30)'),
    labelHover:   v('--graph-label-hover',   'rgba(255,255,255,0.55)'),
    labelDim:     v('--graph-label-dim',     'rgba(255,255,255,0.08)'),
    arrow:        v('--graph-arrow',         'rgba(255,255,255,0.3)'),
    arrowBright:  v('--graph-arrow-bright',  'rgba(255,255,255,0.7)'),
    centerStroke: v('--graph-center-stroke', '#ffffff'),
    centerGlow:   v('--graph-center-glow',   'rgba(255,255,255,0.45)'),
    glowOpacity:  v('--graph-glow-opacity',  '0.35'),
  };
}
