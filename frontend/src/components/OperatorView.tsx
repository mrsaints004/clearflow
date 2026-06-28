import React, { useState, useEffect, useCallback } from "react";
import { apiClient } from "../hooks/useApi";
import type { InvoiceData, TransactionEntry } from "../types";
import { useToast } from "./Toast";
import ConfirmDialog from "./ConfirmDialog";

interface Props {
  onTransaction?: (tx: TransactionEntry) => void;
}

export default function OperatorView({ onTransaction }: Props) {
  const { addToast } = useToast();
  const [invoices, setInvoices] = useState<InvoiceData[]>([]);
  const [message, setMessage] = useState("");
  const [confirmAction, setConfirmAction] = useState<{ invoiceId: string; type: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const invs = await apiClient.getInvoices();
      setInvoices(invs as InvoiceData[]);
    } catch (e: any) { addToast("error", e.message || "Failed to load data"); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [refresh]);

  const approve = async (invoiceId: string) => {
    try {
      await apiClient.approveInvoice(invoiceId);
      setMessage(`Invoice ${invoiceId} verified`);
      onTransaction?.({
        id: `approve-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString(),
        action: "Approve Invoice",
        template: "Invoice.Verification",
        actingParty: "Operator",
        details: `${invoiceId} verified`,
      });
      refresh();
    } catch (e: any) {
      addToast("error", e.message || "Operation failed");
    }
  };

  const resolveDispute = async (invoiceId: string, resolution: "upheld" | "rejected") => {
    try {
      await apiClient.resolveDispute(invoiceId, resolution);
      setMessage(`Dispute ${resolution} for ${invoiceId}`);
      onTransaction?.({
        id: `resolve-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString(),
        action: "Resolve Dispute",
        template: "Invoice.DisputeResolution",
        actingParty: "Operator",
        details: `${invoiceId}: dispute ${resolution}`,
      });
      refresh();
    } catch (e: any) {
      addToast("error", e.message || "Operation failed");
    }
  };

  const pending = invoices.filter((i) => i.status === "pending");
  const verified = invoices.filter((i) => i.status === "verified");
  const confirmed = invoices.filter((i) => i.status === "confirmed");
  const disputed = invoices.filter((i) => i.status === "disputed");

  return (
    <div className="view operator-view">
      <div className="view-header">
        <h2>Operator</h2>
        <span className="role-badge operator-badge">Operator</span>
      </div>

      {message && (
        <div className="message" onClick={() => setMessage("")}>
          {message}
        </div>
      )}

      {disputed.length > 0 && (
        <section>
          <h3>Disputes Requiring Resolution ({disputed.length})</h3>
          <div className="card-grid">
            {disputed.map((inv) => (
              <div key={inv.invoiceId} className="card dispute-card">
                <div className="card-title">
                  {inv.invoiceId}
                  <span className="invoice-status status-disputed">DISPUTED</span>
                </div>
                <div className="card-detail">
                  <span>Seller:</span> {inv.seller}
                </div>
                <div className="card-detail">
                  <span>Debtor:</span> {inv.debtor}
                </div>
                <div className="card-detail">
                  <span>Amount:</span> ${inv.amount.toLocaleString()}
                </div>
                <div className="dispute-reason-box">
                  <span className="dispute-reason-label">Dispute Reason:</span>
                  <span className="dispute-reason-text">{inv.disputeReason}</span>
                </div>
                {inv.riskScore && (
                  <div className="card-detail">
                    <span>Risk:</span>{" "}
                    <strong className={`risk-grade grade-${inv.riskScore.grade}`}>
                      {inv.riskScore.grade}
                    </strong>{" "}
                    ({inv.riskScore.overall}/100)
                  </div>
                )}
                <div className="card-actions">
                  <button
                    className="btn btn-primary"
                    onClick={() => setConfirmAction({ invoiceId: inv.invoiceId, type: "rejectDispute" })}
                    title="Reject the dispute — invoice returns to confirmed status"
                    aria-label={`Reject dispute for ${inv.invoiceId}`}
                  >
                    Reject Dispute (Confirm Invoice)
                  </button>
                  <button
                    className="btn btn-danger"
                    onClick={() => setConfirmAction({ invoiceId: inv.invoiceId, type: "upholdDispute" })}
                    title="Uphold the dispute — invoice returns to pending for re-verification"
                    aria-label={`Uphold dispute for ${inv.invoiceId}`}
                  >
                    Uphold Dispute
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h3>Pending Verification ({pending.length})</h3>
        {pending.length === 0 && (
          <p className="empty">No invoices awaiting verification.</p>
        )}
        <div className="card-grid">
          {pending.map((inv) => (
            <div key={inv.invoiceId} className="card">
              <div className="card-title">
                {inv.invoiceId}
                <span className="invoice-status status-pending">PENDING</span>
              </div>
              <div className="card-detail">
                <span>Seller:</span> {inv.seller}
              </div>
              <div className="card-detail">
                <span>Debtor:</span> {inv.debtor}
              </div>
              <div className="card-detail">
                <span>Amount:</span> ${inv.amount.toLocaleString()}
              </div>
              <div className="card-detail">
                <span>Sector:</span> {inv.sector}
              </div>
              {inv.riskScore && (
                <div className="risk-score-compact">
                  <span className="risk-label">Risk Score:</span>
                  <span className={`risk-grade grade-${inv.riskScore.grade}`}>
                    {inv.riskScore.grade}
                  </span>
                  <span className="risk-number">{inv.riskScore.overall}/100</span>
                  <div className="risk-bar">
                    <div
                      className="risk-bar-fill"
                      style={{ width: `${inv.riskScore.overall}%` }}
                    />
                  </div>
                </div>
              )}
              <button className="btn btn-success" onClick={() => setConfirmAction({ invoiceId: inv.invoiceId, type: "approve" })} aria-label={`Approve invoice ${inv.invoiceId}`}>
                Approve Invoice
              </button>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3>Verified — Awaiting Debtor ({verified.length})</h3>
        {verified.length === 0 && (
          <p className="empty">No invoices awaiting debtor confirmation.</p>
        )}
        <div className="card-grid">
          {verified.map((inv) => (
            <div key={inv.invoiceId} className="card">
              <div className="card-title">
                {inv.invoiceId}
                <span className="invoice-status status-verified">VERIFIED</span>
              </div>
              <div className="card-detail">
                <span>Debtor:</span> {inv.debtor}
              </div>
              <div className="card-detail">
                <span>Amount:</span> ${inv.amount.toLocaleString()}
              </div>
              <div className="card-detail card-detail-muted">Waiting for debtor confirmation</div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3>Confirmed — Ready for Auction ({confirmed.length})</h3>
        {confirmed.length === 0 && (
          <p className="empty">No confirmed invoices yet.</p>
        )}
        <div className="card-grid">
          {confirmed.map((inv) => (
            <div key={inv.invoiceId} className="card">
              <div className="card-title">
                {inv.invoiceId}
                <span className="invoice-status status-confirmed">CONFIRMED</span>
              </div>
              <div className="card-detail">
                <span>Amount:</span> ${inv.amount.toLocaleString()}
              </div>
              {inv.riskScore && (
                <div className="card-detail">
                  <span>Risk:</span>{" "}
                  <strong className={`risk-grade grade-${inv.riskScore.grade}`}>{inv.riskScore.grade}</strong>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <div className="privacy-note">
        <strong>Operator role:</strong> The operator verifies invoice authenticity, resolves
        disputes between sellers and debtors, and oversees the auction pipeline. Full data
        visible as platform signatory.
      </div>

      <ConfirmDialog
        open={confirmAction !== null}
        title={
          confirmAction?.type === "approve" ? "Approve Invoice" :
          confirmAction?.type === "upholdDispute" ? "Uphold Dispute" :
          "Reject Dispute"
        }
        message={
          confirmAction?.type === "approve"
            ? `Verify and approve invoice ${confirmAction?.invoiceId}?`
            : confirmAction?.type === "upholdDispute"
            ? `Uphold the dispute for ${confirmAction?.invoiceId}? The invoice returns to pending.`
            : `Reject the dispute for ${confirmAction?.invoiceId}? The invoice will be confirmed.`
        }
        confirmLabel={
          confirmAction?.type === "approve" ? "Approve" :
          confirmAction?.type === "upholdDispute" ? "Uphold" : "Reject Dispute"
        }
        variant={confirmAction?.type === "upholdDispute" ? "danger" : "default"}
        onConfirm={() => {
          if (confirmAction?.type === "approve") approve(confirmAction.invoiceId);
          else if (confirmAction?.type === "upholdDispute") resolveDispute(confirmAction.invoiceId, "upheld");
          else if (confirmAction?.type === "rejectDispute") resolveDispute(confirmAction.invoiceId, "rejected");
          setConfirmAction(null);
        }}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}
