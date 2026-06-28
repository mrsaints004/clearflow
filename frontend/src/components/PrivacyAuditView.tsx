import React, { useState } from "react";

interface LifecycleStep {
  id: string;
  label: string;
  damlTemplate: string;
  signatories: string[];
  observers: string[];
  visibility: { operator: boolean; seller: boolean; lenderA: boolean; lenderB: boolean; debtor: boolean };
  hiddenFields: string[];
  description: string;
}

const LIFECYCLE_STEPS: LifecycleStep[] = [
  {
    id: "invoice-submitted",
    label: "Invoice Submitted",
    damlTemplate: "Invoice.Invoice",
    signatories: ["Operator", "Seller"],
    observers: [],
    visibility: { operator: true, seller: true, lenderA: false, lenderB: false, debtor: false },
    hiddenFields: ["All invoice fields hidden from lenders and debtor"],
    description: "Full invoice data (debtor name, exact amount, dates) exists only on the seller's and operator's participant nodes. No lender or debtor participant receives this contract yet.",
  },
  {
    id: "operator-approved",
    label: "Operator Approves",
    damlTemplate: "Invoice.Verification",
    signatories: ["Operator"],
    observers: ["Seller", "Debtor"],
    visibility: { operator: true, seller: true, lenderA: false, lenderB: false, debtor: true },
    hiddenFields: ["All invoice fields hidden from lenders"],
    description: "The operator verifies invoice authenticity. The debtor is now notified and can see the invoice to confirm they owe the amount. Lenders still cannot see any data.",
  },
  {
    id: "debtor-confirmed",
    label: "Debtor Confirms",
    damlTemplate: "Invoice.DebtorConfirmation",
    signatories: ["Operator", "Seller", "Debtor"],
    observers: [],
    visibility: { operator: true, seller: true, lenderA: false, lenderB: false, debtor: true },
    hiddenFields: ["All fields hidden from lenders — 3-party confirmation"],
    description: "Debtor confirms they owe the invoiced amount. This creates a 3-signatory contract (operator, seller, debtor) — the strongest proof of legitimacy. Invoice is now ready for auction.",
  },
  {
    id: "dispute-filed",
    label: "Dispute (if any)",
    damlTemplate: "Invoice.Dispute",
    signatories: ["Debtor"],
    observers: ["Operator", "Seller"],
    visibility: { operator: true, seller: true, lenderA: false, lenderB: false, debtor: true },
    hiddenFields: ["Dispute details hidden from lenders"],
    description: "If the debtor disputes the invoice, the operator mediates. Disputes are visible to seller and operator but never to lenders — maintaining auction integrity.",
  },
  {
    id: "auction-opened",
    label: "Auction Opened",
    damlTemplate: "Invoice.AuctionInvite",
    signatories: ["Operator", "Seller"],
    observers: ["Lender A", "Lender B"],
    visibility: { operator: true, seller: true, lenderA: true, lenderB: true, debtor: false },
    hiddenFields: ["debtor (Party)", "amount (exact)", "issueDate", "dueDate"],
    description: "Lenders see only InvoiceMetadata: amount bucket, sector, payment terms, reliability score. The AuctionInvite contract is shared, but contains no sensitive commercial data. Debtor is not involved in the auction.",
  },
  {
    id: "bid-a-submitted",
    label: "Lender A Bids",
    damlTemplate: "Auction.SealedBid",
    signatories: ["Operator", "Lender A"],
    observers: [],
    visibility: { operator: true, seller: false, lenderA: true, lenderB: false, debtor: false },
    hiddenFields: ["Bid invisible to Seller, Lender B, and Debtor"],
    description: "Each SealedBid is a separate contract with (operator, lender) as signatories. Canton's sub-transaction privacy ensures Lender B's participant never receives Lender A's bid contract.",
  },
  {
    id: "bid-b-submitted",
    label: "Lender B Bids",
    damlTemplate: "Auction.SealedBid",
    signatories: ["Operator", "Lender B"],
    observers: [],
    visibility: { operator: true, seller: false, lenderA: false, lenderB: true, debtor: false },
    hiddenFields: ["Bid invisible to Seller, Lender A, and Debtor"],
    description: "Same privacy guarantee: Lender A cannot see Lender B's discount rate. The operator evaluates both bids but each lender's view is isolated.",
  },
  {
    id: "auction-closed",
    label: "Auction Closed",
    damlTemplate: "Auction.AuctionResult + Auction.BidRejection",
    signatories: ["Operator", "Seller"],
    observers: ["Winning Lender only"],
    visibility: { operator: true, seller: true, lenderA: true, lenderB: true, debtor: false },
    hiddenFields: ["Losing lender sees BidRejection only (no winner identity, no winning rate)"],
    description: "AuctionResult (with winning rate and invoice amount) is visible only to the winner via the observer field. Losing lenders receive a BidRejection contract — they know they lost, nothing more.",
  },
  {
    id: "settlement",
    label: "Settlement",
    damlTemplate: "Auction.SettledInvoice",
    signatories: ["Operator", "Seller"],
    observers: ["Winning Lender"],
    visibility: { operator: true, seller: true, lenderA: true, lenderB: false, debtor: false },
    hiddenFields: ["Losing lender and debtor see nothing about settlement terms"],
    description: "SettledInvoice reveals full details (original amount, financed amount, discount rate) to the winning lender. The losing lender's participant never receives this contract.",
  },
  {
    id: "payment-redirect",
    label: "Payment Redirection",
    damlTemplate: "Settlement.PaymentNotification",
    signatories: ["Operator"],
    observers: ["Debtor", "Winning Lender"],
    visibility: { operator: true, seller: false, lenderA: true, lenderB: false, debtor: true },
    hiddenFields: ["Seller and losing lender do not see payment routing"],
    description: "Debtor receives a payment redirection notice: pay the winning lender instead of the original seller. Only the debtor, operator, and winner know the new payment routing.",
  },
];

const ROLE_LABELS = ["Operator", "Seller", "Lender A", "Lender B", "Debtor"] as const;
const PARTY_KEYS: Record<typeof ROLE_LABELS[number], keyof LifecycleStep["visibility"]> = {
  "Operator": "operator",
  "Seller": "seller",
  "Lender A": "lenderA",
  "Lender B": "lenderB",
  "Debtor": "debtor",
};

interface Props {
  currentStatus?: "open" | "closed" | "settled" | null;
  currentInvoiceStatus?: "pending" | "verified" | "confirmed" | null;
}

export default function PrivacyAuditView({ currentStatus, currentInvoiceStatus }: Props) {
  const [expandedStep, setExpandedStep] = useState<string | null>(null);

  const getStepState = (stepId: string): "completed" | "active" | "pending" => {
    const order = [
      "invoice-submitted",
      "operator-approved",
      "debtor-confirmed",
      "dispute-filed",
      "auction-opened",
      "bid-a-submitted",
      "bid-b-submitted",
      "auction-closed",
      "settlement",
      "payment-redirect",
    ];
    const stepIdx = order.indexOf(stepId);

    // Determine current progress index
    let currentIdx = -1;
    if (currentInvoiceStatus === "pending") currentIdx = 0;
    else if (currentInvoiceStatus === "verified") currentIdx = 1;
    else if (currentInvoiceStatus === "confirmed") currentIdx = 2;

    if (currentStatus === "open") currentIdx = 6; // bids happening
    else if (currentStatus === "closed") currentIdx = 7;
    else if (currentStatus === "settled") currentIdx = 9;

    if (currentIdx < 0 && !currentInvoiceStatus) return "pending";

    if (stepIdx < currentIdx) return "completed";
    if (stepIdx === currentIdx) return "active";
    return "pending";
  };

  return (
    <div className="privacy-audit-view">
      <div className="view-header">
        <h2>Privacy Audit</h2>
        <span className="role-badge" style={{ background: "#8b5cf6" }}>Canton Privacy Proof</span>
      </div>

      <p className="audit-intro">
        Each row shows a step in the invoice financing lifecycle. The visibility matrix reveals exactly which
        party's Canton participant node receives each Daml contract — derived from signatory and
        observer patterns in the smart contracts.
      </p>

      {/* Visibility Matrix Header */}
      <div className="matrix-header">
        <div className="matrix-step-label">Lifecycle Step</div>
        {ROLE_LABELS.map((p) => (
          <div key={p} className="matrix-party-label">{p}</div>
        ))}
      </div>

      {/* Timeline */}
      <div className="timeline">
        {LIFECYCLE_STEPS.map((step, idx) => {
          const state = getStepState(step.id);
          const isExpanded = expandedStep === step.id;

          return (
            <div key={step.id} className={`timeline-step ${state}`}>
              {/* Connector line */}
              {idx > 0 && <div className="timeline-connector" />}

              {/* Main row */}
              <div
                className="matrix-row"
                onClick={() => setExpandedStep(isExpanded ? null : step.id)}
              >
                <div className="matrix-step-cell">
                  <div className={`step-dot ${state}`} />
                  <span className="step-label">{step.label}</span>
                  <span className="expand-icon">{isExpanded ? "\u25B2" : "\u25BC"}</span>
                </div>
                {ROLE_LABELS.map((p) => (
                  <div key={p} className={`matrix-cell ${step.visibility[PARTY_KEYS[p]] ? "visible" : "hidden"}`}>
                    {step.visibility[PARTY_KEYS[p]] ? "\u2705" : "\u274C"}
                  </div>
                ))}
              </div>

              {/* Expanded details */}
              {isExpanded && (
                <div className="step-details">
                  <div className="detail-row">
                    <span className="detail-label">Daml Template:</span>
                    <code>{step.damlTemplate}</code>
                  </div>
                  <div className="detail-row">
                    <span className="detail-label">Signatories:</span>
                    <span>{step.signatories.join(", ")}</span>
                  </div>
                  <div className="detail-row">
                    <span className="detail-label">Observers:</span>
                    <span>{step.observers.length > 0 ? step.observers.join(", ") : "None"}</span>
                  </div>
                  <div className="detail-row">
                    <span className="detail-label">Hidden from non-parties:</span>
                    <span className="hidden-list">{step.hiddenFields.join("; ")}</span>
                  </div>
                  <p className="detail-description">{step.description}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="audit-footer">
        <strong>How Canton enforces this:</strong> Canton's sub-transaction privacy means each
        participant node only receives the contracts where its hosted party is a signatory or
        observer. There is no global ledger — data physically does not exist on unauthorized nodes.
      </div>
    </div>
  );
}
