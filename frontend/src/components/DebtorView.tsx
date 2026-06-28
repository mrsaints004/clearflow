import React, { useState, useEffect, useCallback } from "react";
import { apiClient } from "../hooks/useApi";
import type { InvoiceData, PaymentNotification, TransactionEntry } from "../types";
import { useToast } from "./Toast";
import ConfirmDialog from "./ConfirmDialog";

interface Props {
  partyName: string;
  onTransaction?: (tx: TransactionEntry) => void;
}

const DISPUTE_REASONS = [
  "Amount is incorrect",
  "Service/goods not delivered",
  "Duplicate invoice",
  "Wrong debtor — not our obligation",
  "Payment terms are incorrect",
];

export default function DebtorView({ partyName, onTransaction }: Props) {
  const { addToast } = useToast();
  const [invoices, setInvoices] = useState<InvoiceData[]>([]);
  const [notifications, setNotifications] = useState<PaymentNotification[]>([]);
  const [message, setMessage] = useState("");
  const [disputeTarget, setDisputeTarget] = useState<string | null>(null);
  const [disputeReason, setDisputeReason] = useState("");
  const [customReason, setCustomReason] = useState("");
  const [confirmAction, setConfirmAction] = useState<{ invoiceId: string; type: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const invs = await apiClient.getInvoices();
      setInvoices(invs as InvoiceData[]);
      const notifs = await apiClient.getPaymentNotifications(partyName);
      setNotifications(notifs as PaymentNotification[]);
    } catch (e: any) { addToast("error", e.message || "Failed to load data"); }
  }, [partyName]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [refresh]);

  const confirm = async (invoiceId: string) => {
    try {
      await apiClient.confirmInvoice(invoiceId);
      setMessage(`Invoice ${invoiceId} confirmed — you acknowledge this debt`);
      onTransaction?.({
        id: `confirm-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString(),
        action: "Confirm Invoice",
        template: "Invoice.DebtorConfirmation",
        actingParty: partyName,
        details: `${invoiceId} confirmed`,
      });
      refresh();
    } catch (e: any) {
      addToast("error", e.message || "Operation failed");
    }
  };

  const submitDispute = async (invoiceId: string) => {
    const reason = disputeReason === "Other" ? customReason : disputeReason;
    if (!reason) {
      setMessage("Please select or enter a dispute reason");
      return;
    }
    try {
      await apiClient.disputeInvoice(invoiceId, reason);
      setMessage(`Dispute filed for ${invoiceId}: ${reason}`);
      onTransaction?.({
        id: `dispute-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString(),
        action: "Dispute Invoice",
        template: "Invoice.Dispute",
        actingParty: partyName,
        details: `${invoiceId}: ${reason}`,
      });
      setDisputeTarget(null);
      setDisputeReason("");
      setCustomReason("");
      refresh();
    } catch (e: any) {
      addToast("error", e.message || "Operation failed");
    }
  };

  const awaitingConfirmation = invoices.filter(
    (i) => i.status === "verified" && i.debtor === partyName
  );

  const disputed = invoices.filter(
    (i) => i.status === "disputed" && i.debtor === partyName
  );

  return (
    <div className="view debtor-view">
      <div className="view-header">
        <h2>{partyName}</h2>
        <span className="role-badge debtor-badge">Debtor</span>
      </div>

      {message && (
        <div className="message" onClick={() => setMessage("")}>
          {message}
        </div>
      )}

      <section>
        <h3>Invoices Awaiting Confirmation ({awaitingConfirmation.length})</h3>
        {awaitingConfirmation.length === 0 && (
          <p className="empty">No invoices require your confirmation.</p>
        )}
        <div className="card-grid">
          {awaitingConfirmation.map((inv) => (
            <div key={inv.invoiceId} className="card">
              <div className="card-title">
                {inv.invoiceId}
                <span className="invoice-status status-verified">VERIFIED</span>
              </div>
              <div className="card-detail">
                <span>Seller:</span> {inv.seller}
              </div>
              <div className="card-detail">
                <span>Amount:</span> ${inv.amount.toLocaleString()}
              </div>
              <div className="card-detail">
                <span>Due:</span> {inv.dueDate}
              </div>
              {inv.riskScore && (
                <div className="card-detail">
                  <span>Risk Grade:</span>{" "}
                  <strong className={`risk-grade grade-${inv.riskScore.grade}`}>
                    {inv.riskScore.grade}
                  </strong>{" "}
                  ({inv.riskScore.overall}/100)
                </div>
              )}
              <div className="card-actions">
                <button className="btn btn-primary" onClick={() => setConfirmAction({ invoiceId: inv.invoiceId, type: "confirm" })} aria-label={`Confirm invoice ${inv.invoiceId}`}>
                  Confirm — I Owe This
                </button>
                <button
                  className="btn btn-danger"
                  onClick={() => setDisputeTarget(disputeTarget === inv.invoiceId ? null : inv.invoiceId)}
                >
                  {disputeTarget === inv.invoiceId ? "Cancel" : "Dispute"}
                </button>
              </div>
              {disputeTarget === inv.invoiceId && (
                <div className="dispute-form">
                  <h4>File Dispute</h4>
                  <select
                    value={disputeReason}
                    onChange={(e) => setDisputeReason(e.target.value)}
                    className="dispute-select"
                  >
                    <option value="">Select reason...</option>
                    {DISPUTE_REASONS.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                    <option value="Other">Other (specify)</option>
                  </select>
                  {disputeReason === "Other" && (
                    <input
                      type="text"
                      placeholder="Enter dispute reason..."
                      value={customReason}
                      onChange={(e) => setCustomReason(e.target.value)}
                      className="dispute-input"
                    />
                  )}
                  <button
                    className="btn btn-danger"
                    onClick={() => submitDispute(inv.invoiceId)}
                    disabled={!disputeReason || (disputeReason === "Other" && !customReason)}
                  >
                    Submit Dispute
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {disputed.length > 0 && (
        <section>
          <h3>Disputed Invoices ({disputed.length})</h3>
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
                  <span>Amount:</span> ${inv.amount.toLocaleString()}
                </div>
                <div className="card-detail">
                  <span>Reason:</span> {inv.disputeReason}
                </div>
                <div className="card-detail card-detail-muted">
                  Awaiting operator review
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h3>Payment Instructions ({notifications.length})</h3>
        {notifications.length === 0 && (
          <p className="empty">No payment redirections yet.</p>
        )}
        <div className="card-grid">
          {notifications.map((n) => (
            <div key={n.invoiceId} className="payment-redirect-card">
              <div className="redirect-header">Payment Redirected</div>
              <div className="redirect-amount">${n.amount.toLocaleString()}</div>
              <div className="redirect-detail">
                Pay to <strong>{n.winningLender}</strong> <span className="redirect-was">(was {n.seller})</span>
              </div>
              <div className="redirect-detail">
                Due: <strong>{n.dueDate}</strong>
              </div>
              <div className="redirect-invoice">Invoice: {n.invoiceId}</div>
            </div>
          ))}
        </div>
      </section>

      <div className="privacy-note">
        <strong>Debtor role:</strong> As the debtor, you confirm that you owe the
        invoiced amount. You can dispute invoices you believe are incorrect.
        After settlement, you are notified to redirect payment to
        the winning lender instead of the original seller.
      </div>

      <ConfirmDialog
        open={confirmAction !== null}
        title={confirmAction?.type === "confirm" ? "Confirm Invoice" : "File Dispute"}
        message={
          confirmAction?.type === "confirm"
            ? `Confirm that you owe the amount on ${confirmAction?.invoiceId}? This acknowledges the debt.`
            : `File a dispute for ${confirmAction?.invoiceId}?`
        }
        confirmLabel={confirmAction?.type === "confirm" ? "Confirm Debt" : "File Dispute"}
        variant={confirmAction?.type === "confirm" ? "default" : "danger"}
        onConfirm={() => {
          if (confirmAction?.type === "confirm") confirm(confirmAction.invoiceId);
          else if (confirmAction?.type === "dispute") submitDispute(confirmAction.invoiceId);
          setConfirmAction(null);
        }}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}
