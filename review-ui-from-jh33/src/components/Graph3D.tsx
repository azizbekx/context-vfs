import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, Line, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import {
  LINKS,
  NODES,
  OBJECTS,
  type GraphLink as DataLink,
  type GraphNode as DataNode,
  type ObjectType,
} from "@/lib/lens-data";

/** Verdict carried in from the Review screen. Drives the beacon color. */
export type Verdict = "Reject" | "Accept" | "Escalate";

const VERDICT_HEX: Record<Verdict, string> = {
  Reject: "#FF8A6B",   // coral
  Accept: "#9DD4B5",   // mint
  Escalate: "#E8C28A", // amber
};

const VERDICT_INTENSITY: Record<Verdict, number> = {
  Reject: 1.2,
  Accept: 1.0,
  Escalate: 1.1,
};

/* ============================================================
   Layer derivation
   core    = focus node
   direct  = 1-hop neighbours (or scenario foreground)
   context = 2-hop neighbours
   ambient = everything else
   ============================================================ */

export type Layer3D = "core" | "direct" | "context" | "ambient";

export interface Node3D extends DataNode {
  layer3d: Layer3D;
  pos: THREE.Vector3;
}

const TYPE_COLOR: Record<ObjectType, string> = {
  Person: "#F0D9A8",       // champagne
  Organization: "#E8E2D2", // ivory
  Shipment: "#E5C792",     // warm gold
  Vendor: "#D9B98A",
  Account: "#C9DDD2",
  Document: "#D6CFC2",
  Location: "#BFD3DE",
  Invoice: "#EBD49A",
};

function buildAdjacency(): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const l of LINKS) {
    if (!m.has(l.source)) m.set(l.source, new Set());
    if (!m.has(l.target)) m.set(l.target, new Set());
    m.get(l.source)!.add(l.target);
    m.get(l.target)!.add(l.source);
  }
  return m;
}

function deriveLayers(
  focusId: string,
  scenarioForeground: string[]
): Map<string, Layer3D> {
  const adj = buildAdjacency();
  const layers = new Map<string, Layer3D>();
  layers.set(focusId, "core");

  const direct = new Set<string>(adj.get(focusId) ?? []);
  scenarioForeground.forEach((id) => {
    if (id !== focusId) direct.add(id);
  });
  direct.forEach((id) => layers.set(id, "direct"));

  const context = new Set<string>();
  direct.forEach((id) => {
    (adj.get(id) ?? new Set()).forEach((nb) => {
      if (nb !== focusId && !direct.has(nb)) context.add(nb);
    });
  });
  context.forEach((id) => layers.set(id, "context"));

  for (const n of NODES) {
    if (!layers.has(n.id)) layers.set(n.id, "ambient");
  }
  return layers;
}

// Deterministic pseudo-random (so positions stay stable per id)
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

function layoutNodes(focusId: string, scenarioForeground: string[]): Node3D[] {
  const layers = deriveLayers(focusId, scenarioForeground);
  const direct = NODES.filter((n) => layers.get(n.id) === "direct");
  const context = NODES.filter((n) => layers.get(n.id) === "context");
  const ambient = NODES.filter((n) => layers.get(n.id) === "ambient");

  const out: Node3D[] = [];

  // Core
  const focus = NODES.find((n) => n.id === focusId)!;
  out.push({ ...focus, layer3d: "core", pos: new THREE.Vector3(0, 0, 0) });

  // Direct ring — spread on a sphere, radius ~3.2
  const R1 = 3.2;
  direct.forEach((n, i) => {
    const phi = Math.acos(1 - 2 * (i + 0.5) / Math.max(direct.length, 1));
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    out.push({
      ...n,
      layer3d: "direct",
      pos: new THREE.Vector3(
        R1 * Math.sin(phi) * Math.cos(theta),
        R1 * Math.cos(phi) * 0.65, // squash vertical for cinematic feel
        R1 * Math.sin(phi) * Math.sin(theta)
      ),
    });
  });

  // Context shell — radius ~6, jittered
  const R2 = 6;
  context.forEach((n, i) => {
    const phi = Math.acos(1 - 2 * (i + 0.5) / Math.max(context.length, 1));
    const theta = Math.PI * (1 + Math.sqrt(5)) * i + hash(n.id) * 0.6;
    const r = R2 + (hash(n.id + "r") - 0.5) * 1.2;
    out.push({
      ...n,
      layer3d: "context",
      pos: new THREE.Vector3(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi) * 0.7,
        r * Math.sin(phi) * Math.sin(theta)
      ),
    });
  });

  // Ambient cloud — radius ~10, wide jitter
  const R3 = 10;
  ambient.forEach((n) => {
    const a = hash(n.id) * Math.PI * 2;
    const b = (hash(n.id + "b") - 0.5) * Math.PI;
    const r = R3 + (hash(n.id + "r") - 0.5) * 3.5;
    out.push({
      ...n,
      layer3d: "ambient",
      pos: new THREE.Vector3(
        r * Math.cos(b) * Math.cos(a),
        r * Math.sin(b) * 0.85,
        r * Math.cos(b) * Math.sin(a)
      ),
    });
  });

  return out;
}

/* ============================================================
   Camera tween — smooth recenter
   ============================================================ */

function CameraRig({ focusPos }: { focusPos: THREE.Vector3 }) {
  const { camera } = useThree();
  const target = useRef(new THREE.Vector3(0, 0, 0));
  const desired = useRef(new THREE.Vector3(0, 0, 0));

  useEffect(() => {
    desired.current.copy(focusPos);
  }, [focusPos]);

  useFrame(() => {
    target.current.lerp(desired.current, 0.06);
    camera.lookAt(target.current);
  });

  return null;
}

/* ============================================================
   Node mesh
   ============================================================ */

function NodeMesh({
  node,
  isFocus,
  isHovered,
  opacityScale,
  onPointerOver,
  onPointerOut,
  onClick,
}: {
  node: Node3D;
  isFocus: boolean;
  isHovered: boolean;
  opacityScale: number;
  onPointerOver: () => void;
  onPointerOut: () => void;
  onClick: () => void;
}) {
  const ref = useRef<THREE.Mesh>(null);
  const haloRef = useRef<THREE.Mesh>(null);

  const baseSize =
    node.layer3d === "core"
      ? 0.42
      : node.layer3d === "direct"
      ? 0.22
      : node.layer3d === "context"
      ? 0.13
      : 0.07;

  const color =
    node.layer3d === "core"
      ? "#F2E6C9" // bright ivory-gold
      : node.layer3d === "direct"
      ? TYPE_COLOR[node.type]
      : node.layer3d === "context"
      ? "#C9BFA8"
      : "#7A7263";

  const opacity =
    node.layer3d === "core"
      ? 1
      : node.layer3d === "direct"
      ? 0.95
      : node.layer3d === "context"
      ? 0.7
      : 0.32;

  const emissive =
    node.layer3d === "core"
      ? "#FFE9B0"
      : node.layer3d === "direct"
      ? color
      : "#3A3429";

  const emissiveIntensity =
    node.layer3d === "core"
      ? 1.6
      : node.layer3d === "direct"
      ? 0.6
      : node.layer3d === "context"
      ? 0.18
      : 0.05;

  // Soft pulse on focus
  useFrame((state) => {
    if (!ref.current) return;
    const t = state.clock.elapsedTime;
    if (isFocus) {
      const s = 1 + Math.sin(t * 1.4) * 0.04;
      ref.current.scale.setScalar(s);
      if (haloRef.current) {
        haloRef.current.scale.setScalar(1 + Math.sin(t * 1.4) * 0.08);
        (haloRef.current.material as THREE.MeshBasicMaterial).opacity =
          0.18 + Math.sin(t * 1.4) * 0.05;
      }
    } else {
      const target = isHovered ? 1.25 : 1;
      ref.current.scale.lerp(new THREE.Vector3(target, target, target), 0.15);
    }
  });

  return (
    <group position={node.pos}>
      {/* Halo */}
      {(isFocus || node.layer3d === "direct") && (
        <mesh ref={haloRef}>
          <sphereGeometry args={[baseSize * (isFocus ? 2.6 : 1.9), 24, 24]} />
          <meshBasicMaterial
            color={isFocus ? "#FFE9B0" : color}
            transparent
            opacity={(isFocus ? 0.18 : 0.08) * opacityScale}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      )}

      {/* Core sphere */}
      <mesh
        ref={ref}
        onPointerOver={(e) => {
          e.stopPropagation();
          onPointerOver();
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          onPointerOut();
          document.body.style.cursor = "auto";
        }}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
      >
        <sphereGeometry args={[baseSize, 32, 32]} />
        <meshStandardMaterial
          color={color}
          emissive={emissive}
          emissiveIntensity={emissiveIntensity}
          roughness={0.35}
          metalness={0.15}
          transparent
          opacity={opacity * opacityScale}
        />
      </mesh>

      {/* Label */}
      {(isFocus || node.layer3d === "direct" || isHovered) && (
        <Html
          position={[0, baseSize + (isFocus ? 0.55 : 0.3), 0]}
          center
          distanceFactor={isFocus ? 9 : 12}
          style={{ pointerEvents: "none" }}
        >
          <div
            className={[
              "whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-medium tracking-tight backdrop-blur",
              isFocus
                ? "bg-[hsl(30_8%_5%/0.7)] text-[hsl(36_30%_95%)] ring-1 ring-[hsl(40_60%_70%/0.45)]"
                : "bg-[hsl(30_8%_5%/0.55)] text-[hsl(36_22%_88%)] ring-1 ring-[hsl(36_10%_25%/0.7)]",
            ].join(" ")}
            style={{ fontFamily: "Inter, system-ui, sans-serif" }}
          >
            {node.label}
            {isFocus && (
              <span className="ml-1.5 text-[hsl(40_60%_75%)]">· {node.type}</span>
            )}
          </div>
        </Html>
      )}
    </group>
  );
}

/* ============================================================
   Links
   ============================================================ */

function LinksLayer({
  positions,
  focusId,
  directIds,
  opacityScale,
}: {
  positions: Map<string, THREE.Vector3>;
  focusId: string;
  directIds: Set<string>;
  opacityScale: number;
}) {
  // Strong links: any link touching focus or between direct nodes
  const { strong, soft } = useMemo(() => {
    const s: DataLink[] = [];
    const f: DataLink[] = [];
    for (const l of LINKS) {
      const touchesFocus = l.source === focusId || l.target === focusId;
      const bothDirect = directIds.has(l.source) && directIds.has(l.target);
      if (touchesFocus || bothDirect) s.push(l);
      else f.push(l);
    }
    return { strong: s, soft: f };
  }, [focusId, directIds]);

  const buildGeom = (links: DataLink[]) => {
    const pts: number[] = [];
    for (const l of links) {
      const a = positions.get(l.source);
      const b = positions.get(l.target);
      if (!a || !b) continue;
      pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return g;
  };

  const strongGeom = useMemo(() => buildGeom(strong), [strong, positions]);
  const softGeom = useMemo(() => buildGeom(soft), [soft, positions]);

  return (
    <>
      <lineSegments geometry={softGeom}>
        <lineBasicMaterial
          color="#9C8E70"
          transparent
          opacity={0.10 * opacityScale}
          depthWrite={false}
        />
      </lineSegments>
      <lineSegments geometry={strongGeom}>
        <lineBasicMaterial
          color="#F0D9A8"
          transparent
          opacity={0.55 * opacityScale}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </lineSegments>
    </>
  );
}

/* ============================================================
   Scene
   ============================================================ */

interface SceneProps {
  focusId: string;
  scenarioForeground: string[];
  hoveredId: string | null;
  setHoveredId: (id: string | null) => void;
  onSelect: (id: string) => void;
  verdict: Verdict;
  conflictId: string;
  focusFromConflict: string;
}

/* ============================================================
   Dim driver — animates opacityScale and re-renders subtree
   ============================================================ */

function useOpacityScale(target: number) {
  const [value, setValue] = useState(target);
  const valRef = useRef(target);
  useFrame(() => {
    const next = THREE.MathUtils.lerp(valRef.current, target, 0.08);
    valRef.current = next;
    if (Math.abs(next - value) > 0.005) setValue(next);
    else if (Math.abs(target - value) < 0.005 && value !== target) setValue(target);
  });
  return value;
}

/* ============================================================
   Verdict beacon — auto-fires on Lens mount, no user interaction.
   Spawns at [6,2,0], lerps to focusFromConflict over 800ms,
   draws colored edges to all related nodes, fades after 4s.
   ============================================================ */

function VerdictBeacon({
  conflictId,
  verdict,
  focusFromConflict,
  positions,
  onArrived,
  liveCurrentPosRef,
}: {
  conflictId: string;
  verdict: Verdict;
  focusFromConflict: string;
  positions: Map<string, THREE.Vector3>;
  onArrived: () => void;
  liveCurrentPosRef: React.MutableRefObject<THREE.Vector3>;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshStandardMaterial>(null);
  const startPos = useRef(new THREE.Vector3(6, 2, 0));
  const currentPos = useRef(new THREE.Vector3(6, 2, 0));
  const spawnedAt = useRef<number>(performance.now());
  const arrivedRef = useRef(false);
  const [removed, setRemoved] = useState(false);

  const verdictColor = VERDICT_HEX[verdict];
  const verdictIntensity = VERDICT_INTENSITY[verdict];

  // Sync the live position ref so edges can read it
  useEffect(() => {
    liveCurrentPosRef.current = currentPos.current;
  }, [liveCurrentPosRef]);

  useFrame(() => {
    const g = groupRef.current;
    const m = meshRef.current;
    const mat = matRef.current;
    if (!g || !m || !mat) return;

    const elapsed = performance.now() - spawnedAt.current;

    // Phase 1 (0-800ms): travel from spawn to focus target
    const target = positions.get(focusFromConflict);
    if (target && !arrivedRef.current) {
      const t = Math.min(elapsed / 800, 1);
      const e = 1 - Math.pow(1 - t, 3);
      currentPos.current.lerpVectors(startPos.current, target, e);
      liveCurrentPosRef.current.copy(currentPos.current);
      g.position.copy(currentPos.current);
      if (t >= 1) {
        arrivedRef.current = true;
        onArrived();
      }
    } else {
      g.position.copy(currentPos.current);
    }

    // Phase 2 (3600-4000ms): fade out
    const fadeStart = 3600;
    const fadeEnd = 4000;
    if (elapsed > fadeStart) {
      const t = Math.min((elapsed - fadeStart) / (fadeEnd - fadeStart), 1);
      mat.opacity = 1 - t;
      if (t >= 1 && !removed) setRemoved(true);
    }
  });

  if (removed) return null;

  return (
    <group ref={groupRef} position={[6, 2, 0]}>
      <mesh ref={meshRef}>
        <sphereGeometry args={[0.5, 32, 32]} />
        <meshStandardMaterial
          ref={matRef}
          color={verdictColor}
          emissive={verdictColor}
          emissiveIntensity={verdictIntensity}
          roughness={0.3}
          metalness={0.1}
          transparent
          opacity={1}
        />
      </mesh>
      <Html position={[0, 1.0, 0]} distanceFactor={10} center style={{ pointerEvents: "none" }}>
        <div
          style={{
            background: "rgba(20, 20, 20, 0.85)",
            border: `1px solid ${verdictColor}`,
            color: verdictColor,
            padding: "2px 8px",
            borderRadius: 4,
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 10,
            letterSpacing: "0.08em",
            whiteSpace: "nowrap",
          }}
        >
          {conflictId} · {verdict}
        </div>
      </Html>
    </group>
  );
}

function VerdictEdges({
  verdict,
  focusFromConflict,
  positions,
  liveCurrentPosRef,
  arrived,
}: {
  verdict: Verdict;
  focusFromConflict: string;
  positions: Map<string, THREE.Vector3>;
  liveCurrentPosRef: React.MutableRefObject<THREE.Vector3>;
  arrived: boolean;
}) {
  const startTimeRef = useRef<number | null>(null);
  const [opacity, setOpacity] = useState(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (arrived) startTimeRef.current = performance.now();
  }, [arrived]);

  useFrame(() => {
    if (!arrived || startTimeRef.current == null) return;
    const elapsed = performance.now() - startTimeRef.current;
    const t = Math.min(elapsed / 600, 1);
    if (Math.abs(t - opacity) > 0.01) setOpacity(t);
    setTick((x) => (x + 1) % 1000);
  });

  if (!arrived) return null;
  const target = OBJECTS[focusFromConflict];
  if (!target) return null;
  const related = target.relations
    .map((r) => positions.get(r.targetId))
    .filter((p): p is THREE.Vector3 => !!p);

  const color = VERDICT_HEX[verdict];

  // `tick` is referenced in the key to force React to recreate the Line
  // each frame — drei's <Line> caches geometry, and we need it to re-read
  // liveCurrentPosRef while the beacon is still travelling.
  return (
    <>
      {related.map((p, i) => (
        <Line
          key={`${i}-${tick}`}
          points={[liveCurrentPosRef.current.clone(), p.clone()]}
          color={color}
          lineWidth={1.4}
          transparent
          opacity={opacity}
        />
      ))}
    </>
  );
}

function Scene({
  focusId,
  scenarioForeground,
  hoveredId,
  setHoveredId,
  onSelect,
  verdict,
  conflictId,
  focusFromConflict,
}: SceneProps) {
  const placed = useMemo(
    () => layoutNodes(focusId, scenarioForeground),
    [focusId, scenarioForeground]
  );

  const positions = useMemo(() => {
    const m = new Map<string, THREE.Vector3>();
    placed.forEach((n) => m.set(n.id, n.pos));
    return m;
  }, [placed]);

  const directIds = useMemo(
    () =>
      new Set(placed.filter((n) => n.layer3d === "direct").map((n) => n.id)),
    [placed]
  );

  const focusPos = positions.get(focusId) ?? new THREE.Vector3();

  const [arrived, setArrived] = useState(false);
  const liveCurrentPosRef = useRef(new THREE.Vector3(6, 2, 0));

  // Slight dim during the verdict beacon's travel (0.65), then restore.
  const dimTarget = arrived ? 1.0 : 0.65;
  const opacityScale = useOpacityScale(dimTarget);

  return (
    <>
      {/* Lighting — restrained, warm key + cool rim */}
      <ambientLight intensity={0.35} color="#fff5e0" />
      <pointLight position={[6, 5, 6]} intensity={1.1} color="#ffe7b3" distance={30} decay={1.6} />
      <pointLight position={[-8, -3, -6]} intensity={0.5} color="#bcd6e6" distance={25} decay={2} />
      <pointLight position={[0, 0, 0]} intensity={1.2} color="#fff0c0" distance={6} decay={2} />

      <CameraRig focusPos={focusPos} />

      <group>
        <LinksLayer
          positions={positions}
          focusId={focusId}
          directIds={directIds}
          opacityScale={opacityScale}
        />

        {placed.map((n) => (
          <NodeMesh
            key={n.id}
            node={n}
            isFocus={n.id === focusId}
            isHovered={hoveredId === n.id}
            opacityScale={opacityScale}
            onPointerOver={() => setHoveredId(n.id)}
            onPointerOut={() => setHoveredId(hoveredId === n.id ? null : hoveredId)}
            onClick={() => onSelect(n.id)}
          />
        ))}
      </group>

      <VerdictBeacon
        conflictId={conflictId}
        verdict={verdict}
        focusFromConflict={focusFromConflict}
        positions={positions}
        onArrived={() => setArrived(true)}
        liveCurrentPosRef={liveCurrentPosRef}
      />

      <VerdictEdges
        verdict={verdict}
        focusFromConflict={focusFromConflict}
        positions={positions}
        liveCurrentPosRef={liveCurrentPosRef}
        arrived={arrived}
      />
    </>
  );
}

/* ============================================================
   Public component
   ============================================================ */

export default function Graph3D({
  focusId,
  scenarioForeground,
  onSelect,
  verdict,
  conflictId,
  focusFromConflict,
}: {
  focusId: string;
  scenarioForeground: string[];
  onSelect: (id: string) => void;
  verdict: Verdict;
  conflictId: string;
  focusFromConflict: string;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  return (
    <div className="absolute inset-0">
      <Canvas
        camera={{ position: [0, 2.5, 11], fov: 42, near: 0.1, far: 100 }}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        dpr={[1, 2]}
      >
        <color attach="background" args={["#0A0907"]} />
        <fog attach="fog" args={["#0A0907", 12, 28]} />

        <Scene
          focusId={focusId}
          scenarioForeground={scenarioForeground}
          hoveredId={hoveredId}
          setHoveredId={setHoveredId}
          onSelect={onSelect}
          verdict={verdict}
          conflictId={conflictId}
          focusFromConflict={focusFromConflict}
        />

        <OrbitControls
          enablePan={false}
          enableDamping
          dampingFactor={0.08}
          rotateSpeed={0.55}
          zoomSpeed={0.6}
          minDistance={4}
          maxDistance={22}
          autoRotate
          autoRotateSpeed={0.35}
        />
      </Canvas>
    </div>
  );
}
