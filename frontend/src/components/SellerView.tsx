import React, { useState, useEffect, useCallback, useRef } from "react";
import { apiClient } from "../hooks/useApi";
import { type InvoiceData, type SellerAuctionView, type Settlement, type PortfolioAuctionView, type TransactionEntry, type RegisteredParty } from "../types";
import SettlementFlowDiagram from "./SettlementFlowDiagram";
import ConfirmDialog from "./ConfirmDialog";
import LoadingSpinner from "./LoadingSpinner";
import { useToast } from "./Toast";
import useDebounce from "../hooks/useDebounce";

const SECTORS = ["Manufacturing", "Technology", "Logistics", "Healthcare", "Energy", "Finance", "Retail", "Agriculture"];
const RELIABILITY_SCORES = ["A", "B", "C"];

function generateInvoiceId(): string {
  const now = new Date();
  const yr = now.getFullYear();
  const seq = String(Math.floor(Math.random() * 9000) + 1000);
  return `INV-${yr}-${seq}`;
}

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

function futureDateStr(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function truncatePartyId(partyId: string): string {
  const sep = partyId.indexOf("::");
  if (sep === -1 || partyId.length < sep + 12) return partyId;
  const name = partyId.slice(0, sep);
  const hex = partyId.slice(sep + 2);
  if (hex.length <= 8) return partyId;
  return `${name}::${hex.slice(0, 4)}...${hex.slice(-4)}`;
}

interface Props {
  partyName: string;
  onTransaction?: (tx: TransactionEntry) => void;
}

interface InvoiceFormState {
  invoiceId: string;
  debtor: string;
  amount: string;
  currency: string;
  sector: string;
  paymentTermDays: string;
  issueDate: string;
  dueDate: string;
  reliabilityScore: string;
}

const emptyForm = (): InvoiceFormState => ({
  invoiceId: generateInvoiceId(),
  debtor: "",
  amount: "",
  currency: "USD",
  sector: SECTORS[0],
  paymentTermDays: "30",
  issueDate: todayStr(),
  dueDate: futureDateStr(30),
  reliabilityScore: "A",
});

export default function SellerView({ partyName, onTransaction }: Props) {
  const { addToast } = useToast();
  const SELLER = partyName;
  const [invoices, setInvoices] = useState<InvoiceData[]>([]);
  const [auctions, setAuctions] = useState<SellerAuctionView[]>([]);
  const [settlements, setSettlements] = useState<Map<string, Settlement>>(new Map());
  const [portfolios, setPortfolios] = useState<PortfolioAuctionView[]>([]);
  const [allParties, setAllParties] = useState<RegisteredParty[]>([]);
  const [debtorSearch, setDebtorSearch] = useState("");
  const [debtorDropdownOpen, setDebtorDropdownOpen] = useState(false);
  const autocompleteRef = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [portfolioSelection, setPortfolioSelection] = useState<Set<string>>(new Set());
  const [showPortfolioBuilder, setShowPortfolioBuilder] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<InvoiceFormState>(emptyForm);
  const [confirmAction, setConfirmAction] = useState<{ invoiceId: string; type: string } | null>(null);
  const debouncedSearch = useDebounce(debtorSearch, 300);

  const refresh = useCallback(async () => {
    try {
      // Fetch all registered parties (excluding operator) for debtor selection
      try {
        const parties = await apiClient.getParties();
        setAllParties((parties as RegisteredParty[]).filter((p) => p.role !== "operator"));
      } catch (e: any) { addToast("error", e.message || "Operation failed"); }

      const invs = await apiClient.getInvoices(SELLER);
      setInvoices(invs as InvoiceData[]);

      const aucs = await apiClient.getAuctions();
      const detailed = await Promise.all(
        (aucs as any[]).map((a) =>
          apiClient.getAuction(a.invoiceId, SELLER, "seller")
        )
      );
      setAuctions(detailed as SellerAuctionView[]);

      const settledMap = new Map<string, Settlement>();
      await Promise.all(
        (detailed as SellerAuctionView[])
          .filter((a) => a.status === "settled")
          .map(async (a) => {
            try {
              const s = await apiClient.getSettlement(a.invoiceId, SELLER);
              settledMap.set(a.invoiceId, s as Settlement);
            } catch (e: any) { addToast("error", e.message || "Operation failed"); }
          })
      );
      setSettlements(settledMap);

      // Fetch portfolio auctions
      try {
        const pfs = await apiClient.getPortfolioAuctions();
        setPortfolios(pfs as PortfolioAuctionView[]);
      } catch (e: any) { addToast("error", e.message || "Operation failed"); }

    } catch (e: any) {
      setError(e.message || "Failed to connect to API");
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Click-away handler for debtor autocomplete
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (autocompleteRef.current && !autocompleteRef.current.contains(e.target as Node)) {
        setDebtorDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const filteredParties = allParties.filter((p) => {
    if (!debouncedSearch) return true;
    const q = debouncedSearch.toLowerCase();
    return (
      p.displayName.toLowerCase().includes(q) ||
      p.role.toLowerCase().includes(q) ||
      (p.partyId && p.partyId.toLowerCase().includes(q))
    );
  });

  const handleSubmitInvoice = async () => {
    if (!form.debtor || !form.amount || Number(form.amount) <= 0) {
      setMessage("A registered debtor party and a positive amount are required.");
      return;
    }
    setLoading(true);
    const invoice: Omit<InvoiceData, "seller"> = {
      invoiceId: form.invoiceId,
      debtor: form.debtor.trim(),
      amount: Number(form.amount),
      currency: form.currency,
      sector: form.sector,
      paymentTermDays: Number(form.paymentTermDays),
      issueDate: form.issueDate,
      dueDate: form.dueDate,
      reliabilityScore: form.reliabilityScore,
    };
    try {
      await apiClient.createInvoice({ ...invoice, seller: SELLER });
      setMessage(`Invoice ${invoice.invoiceId} tokenized and submitted to ledger`);
      onTransaction?.({
        id: `inv-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString(),
        action: "Create Invoice",
        template: "Invoice.Invoice",
        actingParty: SELLER,
        details: `${invoice.invoiceId} — $${invoice.amount.toLocaleString()}`,
      });
      setForm(emptyForm());
      setShowForm(false);
      refresh();
    } catch (e: any) {
      addToast("error", e.message || "Invoice creation failed");
    } finally {
      setLoading(false);
    }
  };

  const updateForm = (field: keyof InvoiceFormState, value: string) => {
    setForm((prev) => {
      const next = { ...prev, [field]: value };
      // Auto-update dueDate when paymentTermDays changes
      if (field === "paymentTermDays" && Number(value) > 0) {
        next.dueDate = futureDateStr(Number(value));
      }
      return next;
    });
  };

  const startAuction = async (invoiceId: string) => {
    try {
      await apiClient.createAuction(invoiceId);
      setMessage(`Blind auction started for ${invoiceId}`);
      onTransaction?.({
        id: `auc-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString(),
        action: "Start Auction",
        template: "Invoice.AuctionInvite",
        actingParty: SELLER,
        details: invoiceId,
      });
      refresh();
    } catch (e: any) {
      addToast("error", e.message || "Failed to start auction");
    }
  };

  const closeAuction = async (invoiceId: string) => {
    try {
      const result = await apiClient.closeAuction(invoiceId, SELLER);
      setMessage(
        `Auction closed! Winner: ${(result as any).winningLender} at ${((result as any).winningRate * 100).toFixed(1)}%`
      );
      onTransaction?.({
        id: `close-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString(),
        action: "Close Auction",
        template: "Auction.AuctionResult",
        actingParty: SELLER,
        details: `Winner: ${(result as any).winningLender} at ${((result as any).winningRate * 100).toFixed(1)}%`,
      });
      refresh();
    } catch (e: any) {
      addToast("error", e.message || "Failed to close auction");
    }
  };

  const createPortfolio = async () => {
    const ids = Array.from(portfolioSelection);
    if (ids.length < 2) {
      setMessage("Select at least 2 confirmed invoices for a portfolio auction");
      return;
    }
    try {
      const result = await apiClient.createPortfolioAuction(ids, SELLER);
      setMessage(`Portfolio auction created: ${(result as any).portfolioId}`);
      onTransaction?.({
        id: `pf-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString(),
        action: "Create Portfolio Auction",
        template: "Auction.PortfolioAuction",
        actingParty: SELLER,
        details: `${ids.length} invoices bundled`,
      });
      setPortfolioSelection(new Set());
      setShowPortfolioBuilder(false);
      refresh();
    } catch (e: any) {
      addToast("error", e.message || "Failed to create portfolio");
    }
  };

  const closePortfolio = async (portfolioId: string) => {
    try {
      const result = await apiClient.closePortfolioAuction(portfolioId, SELLER);
      setMessage(`Portfolio closed! Winner: ${(result as any).winningLender} at ${((result as any).winningRate * 100).toFixed(1)}%`);
      onTransaction?.({
        id: `pf-close-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString(),
        action: "Close Portfolio Auction",
        template: "Auction.PortfolioResult",
        actingParty: SELLER,
        details: `${portfolioId}: Winner ${(result as any).winningLender}`,
      });
      refresh();
    } catch (e: any) {
      addToast("error", e.message || "Failed to close portfolio");
    }
  };

  const activeInvoices = invoices.filter(
    (inv) => !auctions.some((a) => a.invoiceId === inv.invoiceId)
  );

  const confirmedForPortfolio = activeInvoices.filter(
    (inv) => (inv.status || "confirmed") === "confirmed"
  );

  const togglePortfolioSelect = (invoiceId: string) => {
    setPortfolioSelection((prev) => {
      const next = new Set(prev);
      if (next.has(invoiceId)) next.delete(invoiceId);
      else next.add(invoiceId);
      return next;
    });
  };

  return (
    <div className="view seller-view">
      <div className="view-header">
        <h2>{SELLER}</h2>
        <span className="role-badge seller-badge">Seller</span>
      </div>

      {error && (
        <div className="message" style={{ borderColor: "#ef4444", background: "#1c1917", color: "#f87171" }} onClick={() => setError("")}>
          {error}
        </div>
      )}

      {message && (
        <div className="message" onClick={() => setMessage("")}>
          {message}
        </div>
      )}

      <section>
        <h3>Create Invoice</h3>
        {!showForm ? (
          <button className="btn btn-primary" onClick={() => setShowForm(true)}>
            + New Invoice
          </button>
        ) : (
          <div className="card invoice-form-card">
            <div className="card-title">New Receivable — {form.invoiceId}</div>
            <div className="form-grid">
              <label>
                <span>Debtor (any registered party)</span>
                <div className="party-autocomplete-wrapper" ref={autocompleteRef}>
                  <input
                    type="text"
                    value={form.debtor ? form.debtor : debtorSearch}
                    onChange={(e) => {
                      setDebtorSearch(e.target.value);
                      updateForm("debtor", "");
                      setDebtorDropdownOpen(true);
                    }}
                    onFocus={() => setDebtorDropdownOpen(true)}
                    placeholder="Search by name, role, or party ID..."
                  />
                  {debtorDropdownOpen && (
                    <div className="party-autocomplete-dropdown">
                      {filteredParties.length === 0 ? (
                        <div className="party-autocomplete-empty">
                          {allParties.length === 0
                            ? "No parties registered yet. Register a party first."
                            : "No matching parties found."}
                        </div>
                      ) : (
                        filteredParties.map((p) => (
                          <div
                            key={p.displayName}
                            className="party-autocomplete-item"
                            onClick={() => {
                              updateForm("debtor", p.displayName);
                              setDebtorSearch("");
                              setDebtorDropdownOpen(false);
                            }}
                          >
                            <span className="party-item-name">{p.displayName}</span>
                            <span className={`role-badge role-${p.role}`}>{p.role}</span>
                            {p.partyId && (
                              <span className="party-item-id">{truncatePartyId(p.partyId)}</span>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </label>
              <label>
                <span>Amount</span>
                <input
                  type="number"
                  min="1"
                  value={form.amount}
                  onChange={(e) => updateForm("amount", e.target.value)}
                  placeholder="75000"
                />
              </label>
              <label>
                <span>Currency</span>
                <select value={form.currency} onChange={(e) => updateForm("currency", e.target.value)}>
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                  <option value="GBP">GBP</option>
                  <option value="CHF">CHF</option>
                  <option value="JPY">JPY</option>
                  <option value="CAD">CAD</option>
                  <option value="SGD">SGD</option>
                  <option value="HKD">HKD</option>
                </select>
              </label>
              <label>
                <span>Sector</span>
                <select value={form.sector} onChange={(e) => updateForm("sector", e.target.value)}>
                  {SECTORS.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Payment Terms (days)</span>
                <input
                  type="number"
                  min="1"
                  max="365"
                  value={form.paymentTermDays}
                  onChange={(e) => updateForm("paymentTermDays", e.target.value)}
                />
              </label>
              <label>
                <span>Issue Date</span>
                <input
                  type="date"
                  value={form.issueDate}
                  onChange={(e) => updateForm("issueDate", e.target.value)}
                />
              </label>
              <label>
                <span>Due Date</span>
                <input
                  type="date"
                  value={form.dueDate}
                  onChange={(e) => updateForm("dueDate", e.target.value)}
                />
              </label>
              <label>
                <span>Reliability Score</span>
                <select value={form.reliabilityScore} onChange={(e) => updateForm("reliabilityScore", e.target.value)}>
                  {RELIABILITY_SCORES.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="form-actions">
              <button
                className="btn btn-primary"
                onClick={handleSubmitInvoice}
                disabled={loading}
              >
                {loading ? <><LoadingSpinner size="sm" label="Submitting invoice" /> Submitting...</> : "Tokenize & Submit"}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => { setShowForm(false); setForm(emptyForm()); }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      {activeInvoices.length > 0 && (
        <section>
          <h3>Active Invoices</h3>
          {confirmedForPortfolio.length >= 2 && (
            <div className="portfolio-toggle">
              <button
                className={`btn btn-secondary ${showPortfolioBuilder ? "active" : ""}`}
                onClick={() => setShowPortfolioBuilder(!showPortfolioBuilder)}
              >
                {showPortfolioBuilder ? "Cancel Portfolio" : "Bundle as Portfolio"}
              </button>
              {showPortfolioBuilder && portfolioSelection.size >= 2 && (
                <button className="btn btn-primary" onClick={createPortfolio}>
                  Create Portfolio Auction ({portfolioSelection.size} invoices)
                </button>
              )}
            </div>
          )}
          {activeInvoices.map((inv) => {
            const status = inv.status || "confirmed";
            const isConfirmed = status === "confirmed";
            const isDisputed = status === "disputed";
            return (
              <div key={inv.invoiceId} className={`card ${isDisputed ? "dispute-card" : ""}`}>
                <div className="card-title">
                  {showPortfolioBuilder && isConfirmed && (
                    <input
                      type="checkbox"
                      checked={portfolioSelection.has(inv.invoiceId)}
                      onChange={() => togglePortfolioSelect(inv.invoiceId)}
                      className="portfolio-checkbox"
                    />
                  )}
                  {inv.invoiceId}
                  <span className={`invoice-status status-${status}`}>
                    {status.toUpperCase()}
                  </span>
                </div>
                <div className="card-row">
                  <div className="card-detail">
                    <span>Debtor:</span> {inv.debtor}
                  </div>
                  <div className="card-detail">
                    <span>Amount:</span> ${inv.amount.toLocaleString()}
                  </div>
                </div>
                {inv.riskScore && (
                  <div className="risk-score-compact">
                    <span className="risk-label">Risk:</span>
                    <span className={`risk-grade grade-${inv.riskScore.grade}`}>
                      {inv.riskScore.grade}
                    </span>
                    <span className="risk-number">{inv.riskScore.overall}/100</span>
                    <div className="risk-bar">
                      <div className="risk-bar-fill" style={{ width: `${inv.riskScore.overall}%` }} />
                    </div>
                  </div>
                )}
                {status === "pending" && (
                  <div className="card-detail card-detail-muted">Awaiting operator approval</div>
                )}
                {status === "verified" && (
                  <div className="card-detail card-detail-muted">Awaiting debtor confirmation</div>
                )}
                {isDisputed && (
                  <div className="dispute-reason-box">
                    <span className="dispute-reason-label">Dispute:</span>
                    <span className="dispute-reason-text">{inv.disputeReason}</span>
                  </div>
                )}
                {!showPortfolioBuilder && (
                  <button
                    onClick={() => startAuction(inv.invoiceId)}
                    className="btn btn-primary"
                    disabled={!isConfirmed}
                    title={!isConfirmed ? "Invoice must be confirmed before auction" : "Start blind auction"}
                  >
                    {isConfirmed ? "Start Blind Auction" : `Start Blind Auction (${status})`}
                  </button>
                )}
              </div>
            );
          })}
        </section>
      )}

      {/* Portfolio Auctions */}
      {portfolios.length > 0 && (
        <section>
          <h3>Portfolio Auctions</h3>
          {portfolios.map((pf) => (
            <div key={pf.portfolioId} className="card portfolio-card">
              <div className="card-title">
                {pf.portfolioId}
                <span className={`invoice-status status-${pf.status}`}>{pf.status.toUpperCase()}</span>
              </div>
              <div className="card-row">
                <div className="card-detail">
                  <span>Invoices:</span> {pf.metadata.invoiceCount}
                </div>
                <div className="card-detail">
                  <span>Total Range:</span> {pf.metadata.totalAmountBucket}
                </div>
              </div>
              <div className="card-row">
                <div className="card-detail">
                  <span>Sectors:</span> {pf.metadata.sectors.join(", ")}
                </div>
                <div className="card-detail">
                  <span>Avg Risk:</span>{" "}
                  <strong className={`risk-grade grade-${pf.metadata.avgRiskGrade}`}>
                    {pf.metadata.avgRiskGrade}
                  </strong>
                </div>
              </div>
              <div className="card-detail">
                <span>Bids:</span> {pf.bidCount}
              </div>
              {pf.status === "open" && (
                <button
                  onClick={() => setConfirmAction({ invoiceId: pf.portfolioId, type: "closePortfolio" })}
                  className="btn btn-secondary"
                  disabled={pf.bidCount < 2}
                  aria-label={`Close portfolio auction ${pf.portfolioId}`}
                >
                  Close Portfolio Auction{pf.bidCount < 2 ? ` (need ${2 - pf.bidCount} more bids)` : ""}
                </button>
              )}
              {pf.status !== "open" && pf.winningLender && (
                <div className="bids-reveal">
                  <div className="card-detail">
                    <span>Winner:</span> {pf.winningLender} at {(pf.winningRate! * 100).toFixed(1)}%
                  </div>
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      {auctions.length > 0 && (
        <section>
          <h3>Auctions</h3>
          {auctions.map((auction) => {
            const cachedInv = (auction as any).invoice;
            const matchedInv = invoices.find((i) => i.invoiceId === auction.invoiceId);
            const debtorDisplay =
              cachedInv?.debtor || matchedInv?.debtor || "—";
            const amount =
              cachedInv?.amount || matchedInv?.amount || 0;

            return (
              <div key={auction.invoiceId} className="card">
                <div className="card-title">{auction.invoiceId}</div>
                <div className="card-row">
                  <div className="card-detail">
                    <span>Debtor:</span> {debtorDisplay}
                  </div>
                  <div className="card-detail">
                    <span>Amount:</span> ${amount.toLocaleString()}
                  </div>
                </div>

                <div className="auction-status">
                  <div className="card-detail">
                    <span>Status:</span>{" "}
                    <strong className={`status-${auction.status}`}>
                      {auction.status.toUpperCase()}
                    </strong>
                  </div>
                  <div className="card-detail">
                    <span>Bids received:</span> {auction.bidCount}
                  </div>

                  {auction.status === "open" && (
                    <button
                      onClick={() => setConfirmAction({ invoiceId: auction.invoiceId, type: "closeAuction" })}
                      className="btn btn-secondary"
                      disabled={auction.bidCount < 2}
                      aria-label={`Close auction for ${auction.invoiceId}`}
                      title={
                        auction.bidCount < 2
                          ? "Need at least 2 bids"
                          : "Close auction and reveal winner"
                      }
                    >
                      Close Auction{" "}
                      {auction.bidCount < 2
                        ? `(need ${2 - auction.bidCount} more bids)`
                        : ""}
                    </button>
                  )}

                  {auction.status !== "open" && auction.bids && (
                    <div className="bids-reveal">
                      <h4>All Bids (revealed after close)</h4>
                      {auction.bids.map((b: any) => (
                        <div
                          key={b.lender}
                          className={`bid-row ${b.lender === auction.winningLender ? "winner" : ""}`}
                        >
                          <span>{b.lender}</span>
                          <span>
                            {(b.discountRate * 100).toFixed(1)}%
                          </span>
                          {b.commitHash && (
                            <span className={`commit-badge ${b.verified ? "verified" : "failed"}`}>
                              {b.verified ? "VERIFIED" : "FAILED"}
                            </span>
                          )}
                          {b.lender === auction.winningLender && (
                            <span className="winner-badge">WINNER</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {auction.status === "settled" && (
                    <div className="settled-indicator">
                      <span className="settled-badge">SETTLED</span>
                      {settlements.get(auction.invoiceId) && (
                        <SettlementFlowDiagram
                          settlement={settlements.get(auction.invoiceId)!}
                          debtorName={debtorDisplay}
                        />
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </section>
      )}

      {activeInvoices.length === 0 && auctions.length === 0 && portfolios.length === 0 && (
        <section>
          <p className="empty">
            No active invoices. Tokenize a receivable to begin financing.
          </p>
        </section>
      )}

      <div className="privacy-note">
        <strong>Visibility scope:</strong> Full invoice data as signatory. Sealed
        bids revealed only after auction close via AuctionResult contract.
        Settlement terms visible as signatory on SettledInvoice.
      </div>

      <ConfirmDialog
        open={confirmAction !== null}
        title={confirmAction?.type === "closeAuction" ? "Close Auction" : "Close Portfolio"}
        message={`Are you sure you want to close the auction for ${confirmAction?.invoiceId}? This action reveals the winner and cannot be undone.`}
        confirmLabel="Close Auction"
        variant="danger"
        onConfirm={() => {
          if (confirmAction?.type === "closeAuction") closeAuction(confirmAction.invoiceId);
          else if (confirmAction?.type === "closePortfolio") closePortfolio(confirmAction.invoiceId);
          setConfirmAction(null);
        }}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}
