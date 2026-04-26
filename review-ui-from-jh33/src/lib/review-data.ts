// Mock data for the Conflict Review queue (Screen 1).
// Designed to map cleanly to a future backend conflict shape.

export type Severity = "HIGH" | "MED" | "LOW";
export type Verdict = "Reject" | "Accept" | "Escalate";

export interface PausedAgent {
  id: string;
  task: string;
  pausedFor: string;
}

export interface ConflictField {
  label: string;
  sourceA: { label: "Source A"; value: string; from?: string };
  sourceB: { label: "Source B"; value: string; from?: string };
  matches?: boolean;
}

export interface EvidenceDoc {
  side: "A" | "B";
  party: string;
  filename: string;
  pages: number;
  date: string;
  uploader: string;
  /** Quote with `{hl}…{/hl}` markers wrapping the diff value. */
  quote: string;
  highlight: string;
}

export interface AuditEntry {
  ts: string;
  actor: string;
  action: string;
}

export interface ConflictItem {
  id: string;
  severity: Severity;
  title: string;
  parties: [string, string];
  pausedAgentsCount: number;
  ageLabel: string;
  pausedAgents: PausedAgent[];
  unblockSummary: string;
  similarStat: string;
  verdict: Verdict;
  confidence: number;
  rationale: string;
  conflicts: ConflictField[];
  collapsedMatchCount: number;
  evidence: [EvidenceDoc, EvidenceDoc];
  audit: AuditEntry[];
  lensFocusId: string;
}

export const QUEUE_STATS = {
  reviewed: 12,
  total: 47,
  blockingWorkflows: 12,
  open: 10,
  avgResolutionSeconds: 42,
  agentHoursSavedToday: 14,
};

export const CONFLICTS: ConflictItem[] = [
  {
    id: "Q-2847",
    severity: "HIGH",
    title: "Contract value mismatch on MSA renewal — Acme vs. Beta",
    parties: ["Acme Corp", "Beta Holdings AG"],
    pausedAgentsCount: 2,
    ageLabel: "2h ago",
    pausedAgents: [
      { id: "sales-followup-agent", task: "Drafting Q2 renewal email for Acme Corp", pausedFor: "4m" },
      { id: "forecasting-agent", task: "Updating Q2 revenue forecast", pausedFor: "11m" },
    ],
    unblockSummary: "Resolving this conflict will unblock 2 workflows",
    similarStat: "4 similar · 75% rejected",
    verdict: "Reject",
    confidence: 0.87,
    rationale:
      "Amount delta of EUR 180k exceeds 10% tolerance. Source B figure unsupported by signed amendment log.",
    conflicts: [
      {
        label: "AMOUNT",
        sourceA: { label: "Source A", value: "EUR 1,240,000.00" },
        sourceB: { label: "Source B", value: "EUR 1,420,000.00" },
      },
      {
        label: "PARTY",
        sourceA: { label: "Source A", value: "Acme Corp" },
        sourceB: { label: "Source B", value: "Acme Corporation" },
      },
    ],
    collapsedMatchCount: 3,
    evidence: [
      {
        side: "A",
        party: "Acme Corp",
        filename: "MSA_Acme_2025_signed.pdf",
        pages: 12,
        date: "14 Mar 2025",
        uploader: "JM",
        quote:
          "...the total contract value shall be {hl}EUR 1,240,000.00{/hl} payable in four equal quarterly instalments...",
        highlight: "EUR 1,240,000.00",
      },
      {
        side: "B",
        party: "Acme Corporation",
        filename: "MSA_Acme_2025_amendment_v3.docx",
        pages: 4,
        date: "02 Apr 2025",
        uploader: "MK",
        quote: "...amended total contract value of {hl}EUR 1,420,000.00{/hl} effective Q2 2025...",
        highlight: "EUR 1,420,000.00",
      },
    ],
    audit: [
      { ts: "14 Mar 2025 09:42", actor: "system", action: "ingested from sys.primary" },
      { ts: "02 Apr 2025 11:18", actor: "MK", action: "amendment uploaded to sys.ledger" },
      { ts: "26 Apr 2026 08:33", actor: "qontext-ai", action: "flagged conflict, confidence 87%" },
    ],
    lensFocusId: "i_inv77",
  },
  {
    id: "Q-2846",
    severity: "MED",
    title: "Effective date divergence on supply agreement",
    parties: ["Müller GmbH", "Northwind Ltd"],
    pausedAgentsCount: 1,
    ageLabel: "3h ago",
    pausedAgents: [
      { id: "ops-scheduling-agent", task: "Booking Q3 shipment slots", pausedFor: "8m" },
    ],
    unblockSummary: "Resolving this conflict will unblock 1 workflow",
    similarStat: "2 similar · 50% accepted",
    verdict: "Accept",
    confidence: 0.74,
    rationale:
      "Source B effective date matches signed PDF on file. Source A timestamp is from a draft superseded on 18 Mar.",
    conflicts: [
      {
        label: "EFFECTIVE DATE",
        sourceA: { label: "Source A", value: "01 Apr 2025" },
        sourceB: { label: "Source B", value: "15 Apr 2025" },
      },
    ],
    collapsedMatchCount: 4,
    evidence: [
      {
        side: "A",
        party: "Müller GmbH",
        filename: "Supply_v1_draft.pdf",
        pages: 8,
        date: "12 Mar 2025",
        uploader: "JM",
        quote: "...effective on or about {hl}01 Apr 2025{/hl}, parties shall...",
        highlight: "01 Apr 2025",
      },
      {
        side: "B",
        party: "Northwind Ltd",
        filename: "Supply_v3_signed.pdf",
        pages: 9,
        date: "18 Mar 2025",
        uploader: "MK",
        quote: "...this Agreement shall take effect on {hl}15 Apr 2025{/hl}.",
        highlight: "15 Apr 2025",
      },
    ],
    audit: [
      { ts: "12 Mar 2025 10:05", actor: "system", action: "v1 ingested" },
      { ts: "18 Mar 2025 14:22", actor: "MK", action: "v3 signed copy uploaded" },
      { ts: "26 Apr 2026 06:11", actor: "qontext-ai", action: "flagged conflict, confidence 74%" },
    ],
    lensFocusId: "s_ship41",
  },
  {
    id: "Q-2845",
    severity: "HIGH",
    title: "Counterparty entity divergence — possible name swap",
    parties: ["Beta Holdings AG", "Beta Holdings SE"],
    pausedAgentsCount: 3,
    ageLabel: "4h ago",
    pausedAgents: [
      { id: "kyc-agent", task: "Re-verifying counterparty registration", pausedFor: "22m" },
      { id: "billing-agent", task: "Issuing Q2 invoice batch", pausedFor: "17m" },
      { id: "sales-followup-agent", task: "Drafting renewal terms", pausedFor: "15m" },
    ],
    unblockSummary: "Resolving this conflict will unblock 3 workflows",
    similarStat: "1 similar · escalated",
    verdict: "Escalate",
    confidence: 0.62,
    rationale:
      "Two registered legal entities share the brand name. LEI lookup returns both as active. Counsel decision required.",
    conflicts: [
      {
        label: "LEGAL ENTITY",
        sourceA: { label: "Source A", value: "Beta Holdings AG" },
        sourceB: { label: "Source B", value: "Beta Holdings SE" },
      },
      {
        label: "JURISDICTION",
        sourceA: { label: "Source A", value: "Switzerland" },
        sourceB: { label: "Source B", value: "Germany" },
      },
    ],
    collapsedMatchCount: 2,
    evidence: [
      {
        side: "A",
        party: "Beta Holdings AG",
        filename: "MSA_Beta_AG.pdf",
        pages: 14,
        date: "08 Jan 2025",
        uploader: "JM",
        quote: "...by and between Acme Corp and {hl}Beta Holdings AG{/hl}, a Swiss corporation...",
        highlight: "Beta Holdings AG",
      },
      {
        side: "B",
        party: "Beta Holdings SE",
        filename: "Order_Form_Beta_SE.pdf",
        pages: 3,
        date: "21 Mar 2025",
        uploader: "MK",
        quote: "...purchase order issued to {hl}Beta Holdings SE{/hl}, Hamburg, Germany.",
        highlight: "Beta Holdings SE",
      },
    ],
    audit: [
      { ts: "08 Jan 2025 09:00", actor: "system", action: "MSA ingested" },
      { ts: "21 Mar 2025 11:30", actor: "MK", action: "order form uploaded" },
      { ts: "26 Apr 2026 04:48", actor: "qontext-ai", action: "flagged conflict, confidence 62%" },
    ],
    lensFocusId: "v_atlas",
  },
  {
    id: "Q-2844",
    severity: "LOW",
    title: "Indemnity clause wording variance",
    parties: ["Helix Biotech", "Vertex Labs Inc"],
    pausedAgentsCount: 0,
    ageLabel: "5h ago",
    pausedAgents: [],
    unblockSummary: "No active workflows blocked",
    similarStat: "6 similar · 83% accepted",
    verdict: "Accept",
    confidence: 0.91,
    rationale:
      "Wording divergence is stylistic only. Substantive scope identical to template clause v4.",
    conflicts: [
      {
        label: "INDEMNITY CAP",
        sourceA: { label: "Source A", value: "12 months of fees" },
        sourceB: { label: "Source B", value: "twelve (12) months of fees" },
      },
    ],
    collapsedMatchCount: 5,
    evidence: [
      {
        side: "A",
        party: "Helix Biotech",
        filename: "MSA_Helix.pdf",
        pages: 11,
        date: "02 Feb 2025",
        uploader: "JM",
        quote: "...indemnity capped at {hl}12 months of fees{/hl} paid in the preceding period.",
        highlight: "12 months of fees",
      },
      {
        side: "B",
        party: "Vertex Labs Inc",
        filename: "MSA_Vertex.pdf",
        pages: 13,
        date: "11 Feb 2025",
        uploader: "MK",
        quote: "...indemnity capped at {hl}twelve (12) months of fees{/hl} paid in the prior 12-month period.",
        highlight: "twelve (12) months of fees",
      },
    ],
    audit: [
      { ts: "02 Feb 2025 12:00", actor: "system", action: "Helix MSA ingested" },
      { ts: "11 Feb 2025 12:00", actor: "system", action: "Vertex MSA ingested" },
      { ts: "26 Apr 2026 03:02", actor: "qontext-ai", action: "flagged variance, confidence 91%" },
    ],
    lensFocusId: "o_helix",
  },
  {
    id: "Q-2843",
    severity: "HIGH",
    title: "Governing law conflict on cross-border SaaS deal",
    parties: ["Orion Systems", "Sakura KK"],
    pausedAgentsCount: 2,
    ageLabel: "6h ago",
    pausedAgents: [
      { id: "legal-routing-agent", task: "Routing to APAC counsel", pausedFor: "28m" },
      { id: "billing-agent", task: "Currency selection for Q2 invoice", pausedFor: "19m" },
    ],
    unblockSummary: "Resolving this conflict will unblock 2 workflows",
    similarStat: "3 similar · 67% rejected",
    verdict: "Reject",
    confidence: 0.79,
    rationale:
      "Source B governing-law clause was not initialed by counterparty. Default to Source A (signed exhibit).",
    conflicts: [
      {
        label: "GOVERNING LAW",
        sourceA: { label: "Source A", value: "State of Delaware, USA" },
        sourceB: { label: "Source B", value: "Tokyo District Court, Japan" },
      },
    ],
    collapsedMatchCount: 3,
    evidence: [
      {
        side: "A",
        party: "Orion Systems",
        filename: "MSA_Orion_signed.pdf",
        pages: 16,
        date: "07 Jan 2025",
        uploader: "JM",
        quote: "...governed by and construed in accordance with the laws of {hl}State of Delaware, USA{/hl}.",
        highlight: "State of Delaware, USA",
      },
      {
        side: "B",
        party: "Sakura KK",
        filename: "Order_Form_Sakura_unsigned.pdf",
        pages: 2,
        date: "10 Mar 2025",
        uploader: "MK",
        quote: "...exclusive jurisdiction of the {hl}Tokyo District Court, Japan{/hl}.",
        highlight: "Tokyo District Court, Japan",
      },
    ],
    audit: [
      { ts: "07 Jan 2025 08:12", actor: "system", action: "signed MSA ingested" },
      { ts: "10 Mar 2025 09:45", actor: "MK", action: "order form uploaded (unsigned)" },
      { ts: "26 Apr 2026 02:30", actor: "qontext-ai", action: "flagged conflict, confidence 79%" },
    ],
    lensFocusId: "p_jdoe",
  },
  {
    id: "Q-2842",
    severity: "MED",
    title: "Payment terms differ — Net 30 vs Net 60",
    parties: ["Schmidt & Partner", "Quantum Freight"],
    pausedAgentsCount: 1,
    ageLabel: "7h ago",
    pausedAgents: [
      { id: "ar-agent", task: "Generating dunning schedule", pausedFor: "12m" },
    ],
    unblockSummary: "Resolving this conflict will unblock 1 workflow",
    similarStat: "8 similar · 50% rejected",
    verdict: "Escalate",
    confidence: 0.58,
    rationale:
      "Both versions executed within the same week. Counsel needed to determine controlling instrument.",
    conflicts: [
      {
        label: "PAYMENT TERMS",
        sourceA: { label: "Source A", value: "Net 30 days" },
        sourceB: { label: "Source B", value: "Net 60 days" },
      },
    ],
    collapsedMatchCount: 4,
    evidence: [
      {
        side: "A",
        party: "Schmidt & Partner",
        filename: "Frame_v1.pdf",
        pages: 7,
        date: "20 Feb 2025",
        uploader: "JM",
        quote: "...invoices payable {hl}Net 30 days{/hl} from invoice date.",
        highlight: "Net 30 days",
      },
      {
        side: "B",
        party: "Quantum Freight",
        filename: "Frame_v2.pdf",
        pages: 7,
        date: "24 Feb 2025",
        uploader: "MK",
        quote: "...invoices payable {hl}Net 60 days{/hl} from invoice date.",
        highlight: "Net 60 days",
      },
    ],
    audit: [
      { ts: "20 Feb 2025 09:14", actor: "system", action: "v1 ingested" },
      { ts: "24 Feb 2025 16:50", actor: "MK", action: "v2 uploaded" },
      { ts: "26 Apr 2026 01:15", actor: "qontext-ai", action: "flagged conflict, confidence 58%" },
    ],
    lensFocusId: "v_polaris",
  },
  {
    id: "Q-2841",
    severity: "LOW",
    title: "Renewal amount rounding discrepancy",
    parties: ["Acme Corp", "Linde Gas Solutions"],
    pausedAgentsCount: 0,
    ageLabel: "9h ago",
    pausedAgents: [],
    unblockSummary: "No active workflows blocked",
    similarStat: "11 similar · 100% accepted",
    verdict: "Accept",
    confidence: 0.95,
    rationale:
      "Difference of EUR 0.04 is below rounding tolerance threshold (0.5%). Default to Source A.",
    conflicts: [
      {
        label: "RENEWAL AMOUNT",
        sourceA: { label: "Source A", value: "EUR 12,480.50" },
        sourceB: { label: "Source B", value: "EUR 12,480.46" },
      },
    ],
    collapsedMatchCount: 6,
    evidence: [
      {
        side: "A",
        party: "Acme Corp",
        filename: "Renewal_2026_signed.pdf",
        pages: 4,
        date: "01 Mar 2025",
        uploader: "JM",
        quote: "...renewal amount of {hl}EUR 12,480.50{/hl} effective on the renewal date.",
        highlight: "EUR 12,480.50",
      },
      {
        side: "B",
        party: "Linde Gas Solutions",
        filename: "Renewal_calc_export.csv",
        pages: 1,
        date: "01 Mar 2025",
        uploader: "system",
        quote: "...computed renewal: {hl}EUR 12,480.46{/hl}",
        highlight: "EUR 12,480.46",
      },
    ],
    audit: [
      { ts: "01 Mar 2025 12:00", actor: "system", action: "signed renewal ingested" },
      { ts: "01 Mar 2025 12:01", actor: "system", action: "calc export ingested" },
      { ts: "25 Apr 2026 23:45", actor: "qontext-ai", action: "flagged variance, confidence 95%" },
    ],
    lensFocusId: "a_acc88",
  },
  {
    id: "Q-2839",
    severity: "MED",
    title: "Ambiguous counterparty alias on legacy NDA",
    parties: ["Nordic Steel A/S", "Nordic Steel Holding"],
    pausedAgentsCount: 1,
    ageLabel: "12h ago",
    pausedAgents: [
      { id: "kyc-agent", task: "Resolving entity to single legal record", pausedFor: "31m" },
    ],
    unblockSummary: "Resolving this conflict will unblock 1 workflow",
    similarStat: "5 similar · 60% accepted",
    verdict: "Accept",
    confidence: 0.71,
    rationale:
      "Alias 'Nordic Steel A/S' historically used on legacy paper. Same LEI as 'Nordic Steel Holding'.",
    conflicts: [
      {
        label: "COUNTERPARTY",
        sourceA: { label: "Source A", value: "Nordic Steel A/S" },
        sourceB: { label: "Source B", value: "Nordic Steel Holding" },
      },
    ],
    collapsedMatchCount: 3,
    evidence: [
      {
        side: "A",
        party: "Nordic Steel A/S",
        filename: "NDA_2019.pdf",
        pages: 3,
        date: "11 Sep 2019",
        uploader: "system",
        quote: "...by and between Acme Corp and {hl}Nordic Steel A/S{/hl}, a Danish stock corporation...",
        highlight: "Nordic Steel A/S",
      },
      {
        side: "B",
        party: "Nordic Steel Holding",
        filename: "MSA_2024_signed.pdf",
        pages: 11,
        date: "04 Nov 2024",
        uploader: "MK",
        quote: "...by and between Acme Corp and {hl}Nordic Steel Holding{/hl}, a Danish stock corporation...",
        highlight: "Nordic Steel Holding",
      },
    ],
    audit: [
      { ts: "11 Sep 2019 14:00", actor: "system", action: "NDA archived" },
      { ts: "04 Nov 2024 16:22", actor: "MK", action: "MSA uploaded" },
      { ts: "25 Apr 2026 20:15", actor: "qontext-ai", action: "flagged alias, confidence 71%" },
    ],
    lensFocusId: "p_jdoe2",
  },
];
