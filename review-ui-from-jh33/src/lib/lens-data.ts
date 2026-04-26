// Mock data for Qontext Object Lens
// Shape designed to map to a real retrieval API later.

export type ObjectType =
  | "Person"
  | "Organization"
  | "Shipment"
  | "Vendor"
  | "Account"
  | "Document"
  | "Location"
  | "Invoice";

export interface GraphNode {
  id: string;
  label: string;
  type: ObjectType;
  // Layout in normalized 0..1 stage coords
  x: number;
  y: number;
  // Retrieval relevance: 0..1 — drives size + luminosity
  relevance: number;
  // Background = ambient cloud, foreground = highlighted in current scenario
  layer: "ambient" | "foreground";
}

export interface GraphLink {
  source: string;
  target: string;
  kind: string;
  weight: number; // 0..1
  highlighted?: boolean;
}

export interface InspectorProperty {
  key: string;
  value: string;
}

export interface InspectorRelation {
  targetId: string;
  label: string;
  kind: string;
}

export interface ProvenanceItem {
  source: string;
  detail: string;
  confidence: number;
}

export interface LensObject {
  id: string;
  name: string;
  type: ObjectType;
  summary: string;
  properties: InspectorProperty[];
  relations: InspectorRelation[];
  provenance: ProvenanceItem[];
}

export interface ResultItem {
  id: string;
  name: string;
  type: ObjectType;
  score: number;
  reason: string;
}

export interface Scenario {
  id: string;
  name: string;
  query: string;
  focusId: string;
  results: ResultItem[];
  // Which nodes/links are highlighted (foreground) for this scenario
  foregroundNodeIds: string[];
  highlightedLinks: Array<[string, string]>;
}

// ---------------- Object catalog ----------------

export const OBJECTS: Record<string, LensObject> = {
  "p_jdoe": {
    id: "p_jdoe",
    name: "Jonathan Doe",
    type: "Person",
    summary:
      "Likely the same individual as ‘J. Doe’ across the CRM and the KYC vault. Identity merge is supported by 4 corroborating signals across 3 systems.",
    properties: [
      { key: "Primary email", value: "jonathan.doe@helix-cap.com" },
      { key: "Aliases", value: "J. Doe · Jon Doe" },
      { key: "Country", value: "Switzerland" },
      { key: "First seen", value: "2019-03-12" },
      { key: "Risk tier", value: "Tier 2" },
    ],
    relations: [
      { targetId: "o_helix", label: "Helix Capital AG", kind: "employed_by" },
      { targetId: "p_jdoe2", label: "J. Doe (CRM)", kind: "alias_of" },
      { targetId: "a_acc88", label: "Account #88-4421", kind: "owns" },
    ],
    provenance: [
      { source: "KYC Vault", detail: "Passport CH-9921 matched on DOB + name", confidence: 0.94 },
      { source: "CRM", detail: "Email domain + phone last-4 overlap", confidence: 0.81 },
      { source: "Compliance log", detail: "Sign-in IP cluster 2024-Q3", confidence: 0.72 },
    ],
  },
  "p_jdoe2": {
    id: "p_jdoe2",
    name: "J. Doe",
    type: "Person",
    summary: "CRM contact record. Strong candidate alias of Jonathan Doe.",
    properties: [
      { key: "Source", value: "CRM" },
      { key: "Email", value: "j.doe@helix-cap.com" },
      { key: "Created", value: "2021-07-04" },
    ],
    relations: [
      { targetId: "p_jdoe", label: "Jonathan Doe", kind: "alias_of" },
      { targetId: "o_helix", label: "Helix Capital AG", kind: "contact_at" },
    ],
    provenance: [
      { source: "CRM export", detail: "Row 11,204", confidence: 1 },
    ],
  },
  "o_helix": {
    id: "o_helix",
    name: "Helix Capital AG",
    type: "Organization",
    summary: "Mid-cap asset manager headquartered in Zurich. 12 connected employees in graph.",
    properties: [
      { key: "LEI", value: "549300HELIX0042AG" },
      { key: "HQ", value: "Zurich, CH" },
      { key: "Employees (graph)", value: "12" },
    ],
    relations: [
      { targetId: "p_jdoe", label: "Jonathan Doe", kind: "employs" },
      { targetId: "v_atlas", label: "Atlas Logistics", kind: "vendor_of" },
    ],
    provenance: [
      { source: "GLEIF", detail: "Active LEI, last renewed 2024-09", confidence: 0.99 },
    ],
  },
  "s_ship41": {
    id: "s_ship41",
    name: "Shipment SHX-41992",
    type: "Shipment",
    summary:
      "Container flagged by anomaly model: weight delta of +14.5% vs. manifest, route diverged at Rotterdam.",
    properties: [
      { key: "Container", value: "SHXU-419-92-1" },
      { key: "Origin", value: "Shenzhen" },
      { key: "Destination", value: "Hamburg" },
      { key: "Manifest weight", value: "18,400 kg" },
      { key: "Sensor weight", value: "21,070 kg" },
      { key: "Status", value: "Held — review" },
    ],
    relations: [
      { targetId: "v_atlas", label: "Atlas Logistics", kind: "carrier" },
      { targetId: "l_rott", label: "Rotterdam hub", kind: "transit" },
      { targetId: "i_inv77", label: "Invoice INV-77231", kind: "billed_under" },
    ],
    provenance: [
      { source: "IoT sensor feed", detail: "Weight reading 2024-11-08 04:12 UTC", confidence: 0.97 },
      { source: "Customs scan", detail: "Rotterdam terminal C", confidence: 0.88 },
      { source: "Routing log", detail: "Deviation 41 nm from plan", confidence: 0.79 },
    ],
  },
  "v_atlas": {
    id: "v_atlas",
    name: "Atlas Logistics",
    type: "Vendor",
    summary:
      "Logistics provider used by 3 group entities. Overlapping invoices detected with Polaris Freight in same quarter.",
    properties: [
      { key: "Vendor ID", value: "VND-00417" },
      { key: "Country", value: "Netherlands" },
      { key: "Active contracts", value: "3" },
      { key: "Spend YTD", value: "€2.41M" },
    ],
    relations: [
      { targetId: "v_polaris", label: "Polaris Freight", kind: "overlaps_with" },
      { targetId: "o_helix", label: "Helix Capital AG", kind: "serves" },
      { targetId: "i_inv77", label: "Invoice INV-77231", kind: "issued" },
    ],
    provenance: [
      { source: "AP ledger", detail: "8 invoices in 2024", confidence: 0.99 },
      { source: "Contracts vault", detail: "MSA 2022-04", confidence: 0.92 },
    ],
  },
  "v_polaris": {
    id: "v_polaris",
    name: "Polaris Freight",
    type: "Vendor",
    summary: "Freight vendor with shared bank account suffix and overlapping invoice IDs vs. Atlas.",
    properties: [
      { key: "Vendor ID", value: "VND-00882" },
      { key: "Country", value: "Netherlands" },
      { key: "Bank acct ····", value: "····4419" },
    ],
    relations: [
      { targetId: "v_atlas", label: "Atlas Logistics", kind: "overlaps_with" },
      { targetId: "i_inv77", label: "Invoice INV-77231", kind: "duplicate_of" },
    ],
    provenance: [
      { source: "Bank match", detail: "IBAN suffix collision", confidence: 0.86 },
    ],
  },
  "a_acc88": {
    id: "a_acc88",
    name: "Account #88-4421",
    type: "Account",
    summary: "Brokerage account owned by Jonathan Doe.",
    properties: [
      { key: "Type", value: "Brokerage" },
      { key: "Opened", value: "2020-02-11" },
    ],
    relations: [{ targetId: "p_jdoe", label: "Jonathan Doe", kind: "owned_by" }],
    provenance: [{ source: "Core banking", detail: "Account master", confidence: 1 }],
  },
  "l_rott": {
    id: "l_rott",
    name: "Rotterdam Hub",
    type: "Location",
    summary: "Transit hub where shipment SHX-41992 deviated from plan.",
    properties: [
      { key: "Terminal", value: "C" },
      { key: "Country", value: "Netherlands" },
    ],
    relations: [{ targetId: "s_ship41", label: "Shipment SHX-41992", kind: "transit_for" }],
    provenance: [{ source: "AIS", detail: "Vessel ping 2024-11-07", confidence: 0.95 }],
  },
  "i_inv77": {
    id: "i_inv77",
    name: "Invoice INV-77231",
    type: "Invoice",
    summary: "Invoice billed by Atlas, also referenced by Polaris record. Possible double-billing.",
    properties: [
      { key: "Amount", value: "€184,200" },
      { key: "Issued", value: "2024-10-22" },
      { key: "Status", value: "Pending review" },
    ],
    relations: [
      { targetId: "v_atlas", label: "Atlas Logistics", kind: "issued_by" },
      { targetId: "v_polaris", label: "Polaris Freight", kind: "duplicated_in" },
      { targetId: "s_ship41", label: "Shipment SHX-41992", kind: "covers" },
    ],
    provenance: [{ source: "AP ledger", detail: "Doc ID 9921-X", confidence: 0.97 }],
  },
};

// ---------------- Graph (single shared graph, scenarios highlight subsets) ----------------

export const NODES: GraphNode[] = [
  // Identity cluster (left)
  { id: "p_jdoe", label: "Jonathan Doe", type: "Person", x: 0.32, y: 0.45, relevance: 1, layer: "foreground" },
  { id: "p_jdoe2", label: "J. Doe", type: "Person", x: 0.22, y: 0.62, relevance: 0.78, layer: "foreground" },
  { id: "o_helix", label: "Helix Capital AG", type: "Organization", x: 0.42, y: 0.28, relevance: 0.7, layer: "foreground" },
  { id: "a_acc88", label: "Account #88-4421", type: "Account", x: 0.18, y: 0.34, relevance: 0.55, layer: "foreground" },

  // Logistics cluster (center-right)
  { id: "s_ship41", label: "SHX-41992", type: "Shipment", x: 0.58, y: 0.5, relevance: 0.6, layer: "ambient" },
  { id: "l_rott", label: "Rotterdam Hub", type: "Location", x: 0.7, y: 0.36, relevance: 0.5, layer: "ambient" },
  { id: "i_inv77", label: "INV-77231", type: "Invoice", x: 0.66, y: 0.66, relevance: 0.55, layer: "ambient" },

  // Vendor cluster (right)
  { id: "v_atlas", label: "Atlas Logistics", type: "Vendor", x: 0.78, y: 0.55, relevance: 0.55, layer: "ambient" },
  { id: "v_polaris", label: "Polaris Freight", type: "Vendor", x: 0.86, y: 0.42, relevance: 0.5, layer: "ambient" },

  // Ambient filler nodes (background cloud)
  { id: "amb_1", label: "Contract MSA-22", type: "Document", x: 0.5, y: 0.18, relevance: 0.2, layer: "ambient" },
  { id: "amb_2", label: "K. Werner", type: "Person", x: 0.12, y: 0.78, relevance: 0.18, layer: "ambient" },
  { id: "amb_3", label: "ZRH Office", type: "Location", x: 0.36, y: 0.82, relevance: 0.16, layer: "ambient" },
  { id: "amb_4", label: "Vessel MSC-Lara", type: "Shipment", x: 0.64, y: 0.84, relevance: 0.18, layer: "ambient" },
  { id: "amb_5", label: "GLEIF record", type: "Document", x: 0.5, y: 0.72, relevance: 0.15, layer: "ambient" },
  { id: "amb_6", label: "BNP Paribas", type: "Organization", x: 0.92, y: 0.7, relevance: 0.18, layer: "ambient" },
  { id: "amb_7", label: "Hamburg Port", type: "Location", x: 0.88, y: 0.22, relevance: 0.18, layer: "ambient" },
  { id: "amb_8", label: "S. Ito", type: "Person", x: 0.06, y: 0.5, relevance: 0.14, layer: "ambient" },
  { id: "amb_9", label: "Audit-2024Q3", type: "Document", x: 0.28, y: 0.18, relevance: 0.16, layer: "ambient" },
];

export const LINKS: GraphLink[] = [
  // Identity
  { source: "p_jdoe", target: "p_jdoe2", kind: "alias_of", weight: 0.9, highlighted: true },
  { source: "p_jdoe", target: "o_helix", kind: "employed_by", weight: 0.7 },
  { source: "p_jdoe", target: "a_acc88", kind: "owns", weight: 0.6 },
  { source: "p_jdoe2", target: "o_helix", kind: "contact_at", weight: 0.55 },

  // Logistics
  { source: "s_ship41", target: "l_rott", kind: "transit", weight: 0.7 },
  { source: "s_ship41", target: "v_atlas", kind: "carrier", weight: 0.7 },
  { source: "s_ship41", target: "i_inv77", kind: "billed_under", weight: 0.6 },
  { source: "i_inv77", target: "v_atlas", kind: "issued_by", weight: 0.6 },

  // Vendor
  { source: "v_atlas", target: "v_polaris", kind: "overlaps_with", weight: 0.8 },
  { source: "v_polaris", target: "i_inv77", kind: "duplicate_of", weight: 0.7 },
  { source: "v_atlas", target: "o_helix", kind: "serves", weight: 0.5 },

  // Ambient connective tissue
  { source: "amb_1", target: "o_helix", kind: "contract", weight: 0.2 },
  { source: "amb_2", target: "o_helix", kind: "employed_by", weight: 0.18 },
  { source: "amb_3", target: "o_helix", kind: "located_at", weight: 0.16 },
  { source: "amb_4", target: "v_atlas", kind: "carrier", weight: 0.18 },
  { source: "amb_5", target: "o_helix", kind: "registry", weight: 0.15 },
  { source: "amb_6", target: "v_polaris", kind: "bank", weight: 0.18 },
  { source: "amb_7", target: "s_ship41", kind: "destination", weight: 0.18 },
  { source: "amb_8", target: "p_jdoe2", kind: "colleague", weight: 0.14 },
  { source: "amb_9", target: "o_helix", kind: "audited", weight: 0.16 },
  { source: "amb_4", target: "l_rott", kind: "transit", weight: 0.14 },
];

export const SCENARIOS: Scenario[] = [
  {
    id: "identity_merge",
    name: "Identity Merge",
    query: "Find candidate identity merges for ‘J. Doe’",
    focusId: "p_jdoe",
    foregroundNodeIds: ["p_jdoe", "p_jdoe2", "o_helix", "a_acc88"],
    highlightedLinks: [
      ["p_jdoe", "p_jdoe2"],
      ["p_jdoe", "o_helix"],
      ["p_jdoe2", "o_helix"],
      ["p_jdoe", "a_acc88"],
    ],
    results: [
      { id: "p_jdoe", name: "Jonathan Doe", type: "Person", score: 0.94, reason: "Passport + email match" },
      { id: "p_jdoe2", name: "J. Doe", type: "Person", score: 0.81, reason: "Domain + phone overlap" },
      { id: "o_helix", name: "Helix Capital AG", type: "Organization", score: 0.66, reason: "Shared employer" },
      { id: "a_acc88", name: "Account #88-4421", type: "Account", score: 0.58, reason: "Owned by Jonathan" },
    ],
  },
  {
    id: "logistics_signal",
    name: "Logistics Signal",
    query: "Why was shipment SHX-41992 flagged?",
    focusId: "s_ship41",
    foregroundNodeIds: ["s_ship41", "l_rott", "v_atlas", "i_inv77"],
    highlightedLinks: [
      ["s_ship41", "l_rott"],
      ["s_ship41", "v_atlas"],
      ["s_ship41", "i_inv77"],
    ],
    results: [
      { id: "s_ship41", name: "Shipment SHX-41992", type: "Shipment", score: 0.97, reason: "Weight delta +14.5%" },
      { id: "l_rott", name: "Rotterdam Hub", type: "Location", score: 0.79, reason: "Route deviation 41 nm" },
      { id: "v_atlas", name: "Atlas Logistics", type: "Vendor", score: 0.7, reason: "Carrier of record" },
      { id: "i_inv77", name: "Invoice INV-77231", type: "Invoice", score: 0.62, reason: "Billed against shipment" },
    ],
  },
  {
    id: "vendor_overlap",
    name: "Vendor Overlap",
    query: "Detect overlapping vendors with shared invoices",
    focusId: "v_atlas",
    foregroundNodeIds: ["v_atlas", "v_polaris", "i_inv77", "o_helix"],
    highlightedLinks: [
      ["v_atlas", "v_polaris"],
      ["v_polaris", "i_inv77"],
      ["i_inv77", "v_atlas"],
      ["v_atlas", "o_helix"],
    ],
    results: [
      { id: "v_atlas", name: "Atlas Logistics", type: "Vendor", score: 0.88, reason: "Issued INV-77231" },
      { id: "v_polaris", name: "Polaris Freight", type: "Vendor", score: 0.84, reason: "Bank IBAN suffix match" },
      { id: "i_inv77", name: "Invoice INV-77231", type: "Invoice", score: 0.77, reason: "Duplicate reference" },
      { id: "o_helix", name: "Helix Capital AG", type: "Organization", score: 0.55, reason: "Shared customer" },
    ],
  },
];
