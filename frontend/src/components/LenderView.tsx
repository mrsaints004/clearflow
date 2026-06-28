import React, { useState, useEffect, useCallback } from "react";
import { apiClient } from "../hooks/useApi";
import type { LenderAuctionView, AuctionView, Settlement, TransactionEntry } from "../types";
import PricingAssistant from "./PricingAssistant";
import SettlementFlowDiagram from "./SettlementFlowDiagram";
import ConfirmDialog from "./ConfirmDialog";
import LoadingSpinner from "./LoadingSpinner";
import { useToast } from "./Toast";

interface Props {
  partyName: string;
  label: string;
  color: string;
  onTransaction?: (tx: TransactionEntry) => void;
}

export default function LenderView({ partyName, label, color, onTransaction }: Props) {
  const { addToast } = useToast();
  const [auctions, setAuctions] = useState<AuctionView[]>([]);
  const [auctionDetails, setAuctionDetails] = useState<
    Map<string, LenderAuctionView>
  >(new Map());
  const [bidRates, setBidRates] = useState<Map<string, string>>(new Map());
  const [showPricing, setShowPricing] = useState<Map<string, boolean>>(new Map());
  const [settlementMap, setSettlementMap] = useState<Map<string, Settlement>>(new Map());
  const [portfolios, setPortfolios] = useState<any[]>([]);
  const [portfolioDetails, setPortfolioDetails] = useState<Map<string, any>>(new Map());
  const [portfolioBidRates, setPortfolioBidRates] = useState<Map<string, string>>(new Map());
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ id: string; type: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const aucs = (await apiClient.getAuctions()) as AuctionView[];
      setAuctions(aucs);
      const details = new Map<string, LenderAuctionView>();
      await Promise.all(
        aucs.map(async (a) => {
          const d = (await apiClient.getAuction(
            a.invoiceId,
            partyName,
            "lender"
          )) as LenderAuctionView;
          details.set(a.invoiceId, d);
        })
      );
      setAuctionDetails(details);

      const sMap = new Map<string, Settlement>();
      await Promise.all(
        aucs
          .filter((a) => {
            const d = details.get(a.invoiceId);
            return d?.status === "settled" && d?.won;
          })
          .map(async (a) => {
            try {
              const s = await apiClient.getSettlement(a.invoiceId, partyName);
              sMap.set(a.invoiceId, s as Settlement);
            } catch (e: any) { addToast("error", e.message || "Operation failed"); }
          })
      );
      setSettlementMap(sMap);

      // Portfolio auctions
      try {
        const pfs = await apiClient.getPortfolioAuctions();
        setPortfolios(pfs);
        const pfDetails = new Map<string, any>();
        await Promise.all(
          (pfs as any[]).map(async (pf) => {
            try {
              const d = await apiClient.getPortfolioAuction(pf.portfolioId, partyName, "lender");
              pfDetails.set(pf.portfolioId, d);
            } catch (e: any) { addToast("error", e.message || "Operation failed"); }
          })
        );
        setPortfolioDetails(pfDetails);
      } catch {}
    } catch (e: any) {
      addToast("error", e.message || "Failed to connect to API");
    }
  }, [partyName]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [refresh]);

  const submitBid = async (invoiceId: string) => {
    const rateStr = bidRates.get(invoiceId);
    if (!rateStr) return;
    const rate = parseFloat(rateStr) / 100;
    if (isNaN(rate) || rate <= 0 || rate >= 100) {
      setMessage("Enter a valid discount rate (0-100%)");
      return;
    }
    setLoading(true);
    try {
      await apiClient.submitBid(partyName, invoiceId, rate);
      setMessage(`Bid submitted: ${rateStr}% discount on ${invoiceId}`);
      onTransaction?.({
        id: `bid-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString(),
        action: "Submit Sealed Bid",
        template: "Auction.SealedBid",
        actingParty: partyName,
        details: `${rateStr}% on ${invoiceId}`,
      });
      setBidRates((prev) => {
        const next = new Map(prev);
        next.delete(invoiceId);
        return next;
      });
      setShowPricing((prev) => {
        const next = new Map(prev);
        next.delete(invoiceId);
        return next;
      });
      refresh();
    } catch (e: any) {
      addToast("error", e.message || "Operation failed");
    } finally {
      setLoading(false);
    }
  };

  const submitPortfolioBid = async (portfolioId: string) => {
    const rateStr = portfolioBidRates.get(portfolioId);
    if (!rateStr) return;
    const rate = parseFloat(rateStr) / 100;
    if (isNaN(rate) || rate <= 0 || rate >= 100) {
      setMessage("Enter a valid discount rate (0-100%)");
      return;
    }
    setLoading(true);
    try {
      await apiClient.submitPortfolioBid(partyName, portfolioId, rate);
      setMessage(`Portfolio bid submitted: ${rateStr}% on ${portfolioId}`);
      onTransaction?.({
        id: `pf-bid-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString(),
        action: "Submit Portfolio Bid",
        template: "Auction.PortfolioBid",
        actingParty: partyName,
        details: `${rateStr}% on ${portfolioId}`,
      });
      setPortfolioBidRates((prev) => {
        const next = new Map(prev);
        next.delete(portfolioId);
        return next;
      });
      refresh();
    } catch (e: any) {
      addToast("error", e.message || "Operation failed");
    } finally {
      setLoading(false);
    }
  };

  const settleTrade = async (invoiceId: string) => {
    try {
      const result = await apiClient.settle(invoiceId, partyName);
      setMessage(
        `Settled! Financed $${(result as any).financedAmount.toLocaleString()}`
      );
      onTransaction?.({
        id: `settle-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString(),
        action: "Settle Trade",
        template: "Auction.SettledInvoice",
        actingParty: partyName,
        details: `$${(result as any).financedAmount.toLocaleString()} for ${invoiceId}`,
      });
      refresh();
    } catch (e: any) {
      addToast("error", e.message || "Operation failed");
    }
  };

  const settlePortfolio = async (portfolioId: string) => {
    try {
      const result = await apiClient.settlePortfolio(portfolioId, partyName);
      const total = (result as any).settlements.reduce((s: number, t: any) => s + t.financedAmount, 0);
      setMessage(`Portfolio settled! Total financed: $${total.toLocaleString()}`);
      onTransaction?.({
        id: `pf-settle-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString(),
        action: "Settle Portfolio",
        template: "Auction.PortfolioSettlement",
        actingParty: partyName,
        details: `$${total.toLocaleString()} for ${portfolioId}`,
      });
      refresh();
    } catch (e: any) {
      addToast("error", e.message || "Operation failed");
    }
  };

  return (
    <div className="view lender-view" style={{ borderTopColor: color }}>
      <div className="view-header">
        <h2>{partyName}</h2>
        <span className="role-badge" style={{ background: color }}>
          {label}
        </span>
      </div>

      {message && (
        <div className="message" onClick={() => setMessage("")}>
          {message}
        </div>
      )}

      <section>
        <h3>Available Auctions</h3>
        {auctions.length === 0 && portfolios.length === 0 && (
          <p className="empty">
            No open auctions. Awaiting seller submissions.
          </p>
        )}
        {auctions.map((a) => {
          const detail = auctionDetails.get(a.invoiceId);
          const hasBid = detail?.myBid != null;
          const status = detail?.status || a.status;
          const isOpen = status === "open";
          const won = detail?.won;

          return (
            <div key={a.invoiceId} className="card">
              <div className="card-title">{a.invoiceId}</div>

              <div className="metadata-grid">
                <div className="meta-item">
                  <label>Amount Range</label>
                  <span className="meta-value">{a.metadata.amountBucket}</span>
                </div>
                <div className="meta-item">
                  <label>Sector</label>
                  <span className="meta-value">{a.metadata.sector}</span>
                </div>
                <div className="meta-item">
                  <label>Terms</label>
                  <span className="meta-value">Net {a.metadata.paymentTermDays}</span>
                </div>
                <div className="meta-item">
                  <label>Debtor Rating</label>
                  <span className="meta-value">{a.metadata.reliabilityScore}</span>
                </div>
                <div className="meta-item">
                  <label>Currency</label>
                  <span className="meta-value">{a.metadata.currency}</span>
                </div>
                <div className="meta-item">
                  <label>Total Bids</label>
                  <span className="meta-value">{detail?.totalBidCount ?? a.bidCount}</span>
                </div>
              </div>

              <div className="hidden-fields">
                <span className="lock-icon">&#128274;</span>
                Debtor identity, exact amount, invoice document — hidden until
                you win
              </div>

              {isOpen && !hasBid && (
                <>
                  <div className="bid-form">
                    <input
                      type="number"
                      step="0.1"
                      min="0.1"
                      max="99"
                      placeholder="Discount rate %"
                      aria-label={`Discount rate for ${a.invoiceId}`}
                      value={bidRates.get(a.invoiceId) || ""}
                      onChange={(e) =>
                        setBidRates((prev) =>
                          new Map(prev).set(a.invoiceId, e.target.value)
                        )
                      }
                    />
                    <button
                      onClick={() => setConfirmAction({ id: a.invoiceId, type: "bid" })}
                      className="btn btn-primary"
                      disabled={loading || !bidRates.get(a.invoiceId)}
                      aria-label={`Submit bid for ${a.invoiceId}`}
                    >
                      {loading ? <><LoadingSpinner size="sm" label="Submitting bid" /> Submitting...</> : "Submit Sealed Bid"}
                    </button>
                    <button
                      onClick={() =>
                        setShowPricing((prev) => {
                          const next = new Map(prev);
                          next.set(a.invoiceId, !prev.get(a.invoiceId));
                          return next;
                        })
                      }
                      className="btn btn-secondary"
                      title="Toggle pricing assistant"
                    >
                      {showPricing.get(a.invoiceId) ? "Hide" : "Pricing"}
                    </button>
                  </div>
                  <PricingAssistant
                    metadata={a.metadata}
                    onUseRate={(rate) =>
                      setBidRates((prev) =>
                        new Map(prev).set(a.invoiceId, rate)
                      )
                    }
                  />
                </>
              )}

              {hasBid && (
                <div className="my-bid">
                  Your bid:{" "}
                  <strong>
                    {((detail!.myBid!.discountRate) * 100).toFixed(1)}% discount
                  </strong>
                  {isOpen && <span className="bid-status"> (sealed)</span>}
                  {(detail!.myBid as any)?.commitHash && (
                    <div className="crypto-hash" style={{ marginTop: 6 }}>
                      <span className="hash-label">Commitment:</span>
                      <code className="hash-value">
                        {(detail!.myBid as any).commitHash.substring(0, 20)}...
                      </code>
                      {(detail!.myBid as any).verified && (
                        <span className="commit-badge verified">VERIFIED</span>
                      )}
                    </div>
                  )}
                </div>
              )}

              {status !== "open" && (
                <div className={`result ${won ? "won" : "lost"}`}>
                  {won ? (
                    <>
                      <strong>You won!</strong> Winning rate:{" "}
                      {(detail!.winningRate! * 100).toFixed(1)}%
                      {status === "closed" && (
                        <button
                          onClick={() => setConfirmAction({ id: a.invoiceId, type: "settle" })}
                          className="btn btn-success"
                          aria-label={`Settle auction ${a.invoiceId}`}
                        >
                          Settle Now
                        </button>
                      )}
                      {status === "settled" && (
                        <>
                          <span className="settled-badge">SETTLED</span>
                          {settlementMap.get(a.invoiceId) && (
                            <SettlementFlowDiagram
                              settlement={settlementMap.get(a.invoiceId)!}
                              debtorName={settlementMap.get(a.invoiceId)!.debtor || "Debtor"}
                            />
                          )}
                        </>
                      )}
                    </>
                  ) : (
                    <span>Auction closed — you did not win this bid.</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </section>

      {/* Portfolio Auctions */}
      {portfolios.length > 0 && (
        <section>
          <h3>Portfolio Auctions</h3>
          {portfolios.map((pf: any) => {
            const detail = portfolioDetails.get(pf.portfolioId);
            const hasBid = detail?.myBid != null;
            const isOpen = pf.status === "open";
            const won = detail?.won;

            return (
              <div key={pf.portfolioId} className="card portfolio-card">
                <div className="card-title">
                  {pf.portfolioId}
                  <span className="portfolio-badge">PORTFOLIO</span>
                </div>

                <div className="metadata-grid">
                  <div className="meta-item">
                    <label>Invoices</label>
                    <span className="meta-value">{pf.metadata.invoiceCount}</span>
                  </div>
                  <div className="meta-item">
                    <label>Total Range</label>
                    <span className="meta-value">{pf.metadata.totalAmountBucket}</span>
                  </div>
                  <div className="meta-item">
                    <label>Sectors</label>
                    <span className="meta-value">{pf.metadata.sectors.join(", ")}</span>
                  </div>
                  <div className="meta-item">
                    <label>Avg Terms</label>
                    <span className="meta-value">Net {pf.metadata.avgPaymentTermDays}</span>
                  </div>
                  <div className="meta-item">
                    <label>Risk Grade</label>
                    <span className={`meta-value risk-grade grade-${pf.metadata.avgRiskGrade}`}>
                      {pf.metadata.avgRiskGrade}
                    </span>
                  </div>
                  {pf.metadata.currencies && pf.metadata.currencies.length > 1 && (
                    <div className="meta-item">
                      <label>Currencies</label>
                      <span className="meta-value">{pf.metadata.currencies.join(", ")}</span>
                    </div>
                  )}
                  <div className="meta-item">
                    <label>Total Bids</label>
                    <span className="meta-value">{detail?.totalBidCount ?? pf.bidCount}</span>
                  </div>
                </div>

                {pf.metadata.netting && (
                  <div className="netting-info">
                    <div className="netting-header">Cross-Currency Netting</div>
                    <div className="netting-grid">
                      <div className="netting-item">
                        <span className="netting-label">Gross Exposure</span>
                        <span className="netting-value">${pf.metadata.netting.grossExposure.toLocaleString()}</span>
                      </div>
                      <div className="netting-item">
                        <span className="netting-label">Net Exposure</span>
                        <span className="netting-value highlight-green">${pf.metadata.netting.netExposure.toLocaleString()}</span>
                      </div>
                      <div className="netting-item">
                        <span className="netting-label">Netting Benefit</span>
                        <span className="netting-value highlight-green">-${pf.metadata.netting.nettingBenefit.toLocaleString()}</span>
                      </div>
                      <div className="netting-item">
                        <span className="netting-label">Netting Ratio</span>
                        <span className="netting-value">{(pf.metadata.netting.nettingRatio * 100).toFixed(1)}%</span>
                      </div>
                    </div>
                  </div>
                )}

                <div className="hidden-fields">
                  <span className="lock-icon">&#128274;</span>
                  Individual invoice details hidden — only portfolio metadata visible
                </div>

                {isOpen && !hasBid && (
                  <div className="bid-form">
                    <input
                      type="number"
                      step="0.1"
                      min="0.1"
                      max="99"
                      placeholder="Portfolio discount rate %"
                      value={portfolioBidRates.get(pf.portfolioId) || ""}
                      onChange={(e) =>
                        setPortfolioBidRates((prev) =>
                          new Map(prev).set(pf.portfolioId, e.target.value)
                        )
                      }
                    />
                    <button
                      onClick={() => submitPortfolioBid(pf.portfolioId)}
                      className="btn btn-primary"
                      disabled={loading}
                    >
                      {loading ? "Submitting..." : "Submit Portfolio Bid"}
                    </button>
                  </div>
                )}

                {hasBid && (
                  <div className="my-bid">
                    Your bid:{" "}
                    <strong>
                      {(detail.myBid.discountRate * 100).toFixed(1)}% discount
                    </strong>
                    {isOpen && <span className="bid-status"> (sealed)</span>}
                  </div>
                )}

                {pf.status !== "open" && (
                  <div className={`result ${won ? "won" : "lost"}`}>
                    {won ? (
                      <>
                        <strong>You won the portfolio!</strong> Rate: {(detail?.winningRate * 100).toFixed(1)}%
                        {pf.status === "closed" && (
                          <button
                            onClick={() => settlePortfolio(pf.portfolioId)}
                            className="btn btn-success"
                          >
                            Settle Portfolio
                          </button>
                        )}
                        {pf.status === "settled" && (
                          <span className="settled-badge">SETTLED</span>
                        )}
                      </>
                    ) : (
                      <span>Portfolio auction closed — you did not win.</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}

      <div className="privacy-note">
        <strong>Visibility scope:</strong> Anonymized metadata only. Counterparty
        bids, debtor identity, and exact invoice amounts are cryptographically
        isolated on separate participant nodes. Full details disclosed to winner
        post-settlement via Daml observer rights.
      </div>

      <ConfirmDialog
        open={confirmAction !== null}
        title={confirmAction?.type === "bid" ? "Submit Sealed Bid" : confirmAction?.type === "settle" ? "Settle Trade" : "Settle Portfolio"}
        message={
          confirmAction?.type === "bid"
            ? `Submit a sealed bid of ${bidRates.get(confirmAction?.id || "") || "?"}% on ${confirmAction?.id}? This cannot be changed.`
            : `Settle ${confirmAction?.id}? This finalizes the trade.`
        }
        confirmLabel={confirmAction?.type === "bid" ? "Submit Bid" : "Settle"}
        variant="danger"
        onConfirm={() => {
          if (confirmAction?.type === "bid") submitBid(confirmAction.id);
          else if (confirmAction?.type === "settle") settleTrade(confirmAction.id);
          else if (confirmAction?.type === "settlePortfolio") settlePortfolio(confirmAction.id);
          setConfirmAction(null);
        }}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}
