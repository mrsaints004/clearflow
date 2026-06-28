import React, { useState, useEffect, useCallback } from "react";
import { apiClient } from "../hooks/useApi";
import type { TransactionEntry } from "../types";
import { useToast } from "./Toast";
import LoadingSpinner from "./LoadingSpinner";

interface Props {
  onTransaction?: (tx: TransactionEntry) => void;
}

export default function AgentPanel({ onTransaction }: Props) {
  const { addToast } = useToast();
  const [agents, setAgents] = useState<any[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string>("");
  const [analysis, setAnalysis] = useState<any>(null);
  const [performance, setPerformance] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [actions, setActions] = useState<any[]>([]);

  const refresh = useCallback(async () => {
    try {
      const a = await apiClient.getAgents();
      setAgents(a);
      if (!selectedAgent && a.length > 0) setSelectedAgent(a[0].name);
    } catch (e: any) { addToast("error", e.message || "Failed to load agents"); }
  }, [selectedAgent]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Fetch performance when agent changes
  useEffect(() => {
    if (!selectedAgent) return;
    apiClient.getAgentPerformance(selectedAgent).then(setPerformance).catch(() => setPerformance(null));
  }, [selectedAgent, analysis]);

  const runAnalysis = async () => {
    if (!selectedAgent) return;
    setLoading(true);
    try {
      const result = await apiClient.agentAnalyze(selectedAgent) as any;
      setAnalysis(result);
      const acts = await apiClient.getAgentActions(selectedAgent) as any[];
      setActions(acts);
      setMessage(`Analysis complete: ${result.totalOpportunities} opportunities found`);
    } catch (e: any) {
      addToast("error", e.message || "Operation failed");
    } finally {
      setLoading(false);
    }
  };

  const autoBid = async (invoiceId: string) => {
    if (!selectedAgent) return;
    setLoading(true);
    try {
      const result = await apiClient.agentAutoBid(selectedAgent, invoiceId) as any;
      if (result.action === "bid_submitted") {
        setMessage(`Agent bid submitted: ${(result.discountRate * 100).toFixed(2)}% on ${invoiceId}`);
        onTransaction?.({
          id: `agent-bid-${Date.now()}`,
          timestamp: new Date().toLocaleTimeString(),
          action: "Agent Auto-Bid",
          template: "Auction.SealedBid",
          actingParty: `${selectedAgent} (AI)`,
          details: `${(result.discountRate * 100).toFixed(2)}% on ${invoiceId}`,
        });
      } else {
        setMessage(`Agent skipped: ${result.reason}`);
      }
      runAnalysis();
    } catch (e: any) {
      addToast("error", e.message || "Operation failed");
    } finally {
      setLoading(false);
    }
  };

  const configureAgent = async (field: string, value: any) => {
    if (!selectedAgent) return;
    try {
      await apiClient.configureAgent(selectedAgent, { [field]: value });
      refresh();
    } catch (e: any) {
      addToast("error", e.message || "Operation failed");
    }
  };

  const agent = agents.find((a) => a.name === selectedAgent);

  return (
    <div className="view agent-view" style={{ borderTopColor: "#7c3aed" }}>
      <div className="view-header">
        <h2>AI Trading Agents</h2>
        <span className="role-badge" style={{ background: "#7c3aed" }}>
          Agentic Commerce
        </span>
      </div>

      {message && (
        <div className="message" onClick={() => setMessage("")}>
          {message}
        </div>
      )}

      <div className="agent-selector">
        <label>Active Agent:</label>
        <select
          value={selectedAgent}
          onChange={(e) => { setSelectedAgent(e.target.value); setAnalysis(null); setPerformance(null); }}
          aria-label="Select AI agent"
        >
          {agents.map((a) => (
            <option key={a.name} value={a.name}>
              {a.name} ({a.party}) — {a.strategy}
            </option>
          ))}
        </select>
      </div>

      {agent && (
        <div className="card agent-config-card">
          <div className="card-title">Agent Configuration</div>
          <div className="metadata-grid">
            <div className="meta-item">
              <label>Strategy</label>
              <select
                className="meta-value"
                value={agent.strategy}
                onChange={(e) => configureAgent("strategy", e.target.value)}
                aria-label="Agent strategy"
              >
                <option value="adaptive">Adaptive</option>
                <option value="value">Value</option>
                <option value="volume">Volume</option>
                <option value="selective">Selective</option>
              </select>
            </div>
            <div className="meta-item">
              <label>Risk Tolerance</label>
              <select
                className="meta-value"
                value={agent.riskTolerance}
                onChange={(e) => configureAgent("riskTolerance", e.target.value)}
                aria-label="Risk tolerance"
              >
                <option value="conservative">Conservative</option>
                <option value="moderate">Moderate</option>
                <option value="aggressive">Aggressive</option>
              </select>
            </div>
            <div className="meta-item">
              <label>Max Rate</label>
              <span className="meta-value">{(agent.maxDiscountRate * 100).toFixed(1)}%</span>
            </div>
            <div className="meta-item">
              <label>Min Rate</label>
              <span className="meta-value">{(agent.minDiscountRate * 100).toFixed(1)}%</span>
            </div>
            <div className="meta-item">
              <label>Party</label>
              <span className="meta-value">{agent.party}</span>
            </div>
            <div className="meta-item">
              <label>Status</label>
              <span className={`meta-value ${agent.enabled ? "status-active" : "status-disabled"}`}>
                {agent.enabled ? "Active" : "Disabled"}
              </span>
            </div>
          </div>
          <button
            onClick={runAnalysis}
            className="btn btn-primary"
            disabled={loading}
            style={{ marginTop: 12 }}
            aria-label="Run market analysis"
          >
            {loading ? <><LoadingSpinner size="sm" label="Analyzing" /> Analyzing...</> : "Run Market Analysis"}
          </button>
        </div>
      )}

      {/* Performance Dashboard */}
      {performance && performance.totalBids > 0 && (
        <div className="card">
          <div className="card-title">Performance Dashboard</div>
          <div className="analysis-summary">
            <div className="analysis-stat">
              <span className="stat-value">{performance.totalBids}</span>
              <span className="stat-label">Total Bids</span>
            </div>
            <div className="analysis-stat">
              <span className="stat-value highlight-green">{performance.wins}</span>
              <span className="stat-label">Wins</span>
            </div>
            <div className="analysis-stat">
              <span className="stat-value">{(performance.winRate * 100).toFixed(1)}%</span>
              <span className="stat-label">Win Rate</span>
            </div>
            <div className="analysis-stat">
              <span className="stat-value">{performance.sharpeRatio.toFixed(2)}</span>
              <span className="stat-label">Sharpe Ratio</span>
            </div>
            <div className="analysis-stat">
              <span className={`stat-value ${performance.profitLoss >= 0 ? "highlight-green" : "highlight-red"}`}>
                {performance.profitLoss >= 0 ? "+" : ""}{performance.profitLoss.toFixed(1)}
              </span>
              <span className="stat-label">P&L (bps)</span>
            </div>
            <div className="analysis-stat">
              <span className={`stat-value ${performance.recentTrend === "improving" ? "highlight-green" : performance.recentTrend === "declining" ? "highlight-red" : ""}`}>
                {performance.recentTrend === "improving" ? "\u2191" : performance.recentTrend === "declining" ? "\u2193" : "\u2192"} {performance.recentTrend}
              </span>
              <span className="stat-label">Trend</span>
            </div>
          </div>
        </div>
      )}

      {analysis && (
        <div className="card analysis-card">
          <div className="card-title">Market Analysis Report</div>
          <div className="analysis-summary">
            <div className="analysis-stat">
              <span className="stat-value">{analysis.totalOpportunities}</span>
              <span className="stat-label">Opportunities</span>
            </div>
            <div className="analysis-stat">
              <span className="stat-value highlight-green">{analysis.recommended}</span>
              <span className="stat-label">Recommended</span>
            </div>
            <div className="analysis-stat">
              <span className="stat-value highlight-yellow">{analysis.watching}</span>
              <span className="stat-label">Watch</span>
            </div>
            <div className="analysis-stat">
              <span className="stat-value highlight-red">{analysis.skipped}</span>
              <span className="stat-label">Skip</span>
            </div>
            <div className="analysis-stat">
              <span className="stat-value">{(analysis.avgSuggestedRate * 100).toFixed(2)}%</span>
              <span className="stat-label">Avg Rate</span>
            </div>
            <div className="analysis-stat">
              <span className={`stat-value risk-${analysis.portfolioRisk}`}>
                {analysis.portfolioRisk.toUpperCase()}
              </span>
              <span className="stat-label">Portfolio Risk</span>
            </div>
          </div>

          {analysis.analyses && analysis.analyses.length > 0 && (
            <div className="analysis-details">
              <h4>Per-Auction Analysis</h4>
              {analysis.analyses.map((a: any) => (
                <div key={a.invoiceId} className={`analysis-item rec-${a.recommendation}`}>
                  <div className="analysis-item-header">
                    <strong>{a.invoiceId}</strong>
                    <span className={`rec-badge rec-${a.recommendation}`}>
                      {a.recommendation.toUpperCase()}
                    </span>
                    <span className="confidence">
                      {(a.confidence * 100).toFixed(0)}% confidence
                    </span>
                    {a.winProbability != null && (
                      <span className="confidence" style={{ marginLeft: 8 }}>
                        Win: {(a.winProbability * 100).toFixed(0)}%
                      </span>
                    )}
                  </div>
                  <p className="analysis-reasoning">{a.reasoning.summary}</p>

                  {/* LLM Explanation */}
                  {a.llmExplanation && (
                    <div className="analysis-llm" style={{ padding: "8px 12px", background: "rgba(124, 58, 237, 0.1)", borderRadius: 6, margin: "8px 0", fontSize: 13 }}>
                      <strong style={{ color: "#a78bfa" }}>AI Insight ({a.llmExplanation.provider}):</strong>{" "}
                      <span style={{ color: "#cbd5e1" }}>{a.llmExplanation.reasoning}</span>
                      {a.llmExplanation.factors && a.llmExplanation.factors.length > 0 && (
                        <div style={{ marginTop: 4, color: "#94a3b8" }}>
                          {a.llmExplanation.factors.map((f: string, i: number) => (
                            <span key={i} style={{ display: "inline-block", marginRight: 8, fontSize: 12 }}>• {f}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="analysis-factors">
                    {a.reasoning.factors.map((f: any, i: number) => (
                      <div key={i} className={`factor factor-${f.impact}`}>
                        <span className="factor-name">{f.name}</span>
                        <span className="factor-detail">{f.detail}</span>
                      </div>
                    ))}
                  </div>
                  <div className="analysis-metrics">
                    <span>Risk: {a.riskAssessment.overallRisk} ({a.riskAssessment.score}/100)</span>
                    <span>Expected Return: ${a.riskAssessment.expectedReturn.toLocaleString()}</span>
                    <span>Sharpe: {a.riskAssessment.sharpeRatio}</span>
                    {a.adaptiveRate != null && (
                      <span>Adaptive Rate: {(a.adaptiveRate * 100).toFixed(2)}%</span>
                    )}
                  </div>
                  {a.recommendation === "bid" && (
                    <div className="analysis-action">
                      <span className="suggested-rate">
                        Suggested: {(a.suggestedRate * 100).toFixed(2)}%
                      </span>
                      <button
                        onClick={() => autoBid(a.invoiceId)}
                        className="btn btn-success btn-sm"
                        disabled={loading}
                        aria-label={`Execute agent bid on ${a.invoiceId}`}
                      >
                        Execute Agent Bid
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {actions.length > 0 && (
        <div className="card">
          <div className="card-title">Agent Activity Log</div>
          <div className="agent-actions">
            {actions.slice(-10).reverse().map((a) => (
              <div key={a.id} className="action-entry">
                <span className="action-time">
                  {new Date(a.timestamp).toLocaleTimeString()}
                </span>
                <span className={`action-type action-${a.action}`}>{a.action}</span>
                <span className="action-invoice">{a.invoiceId}</span>
                {a.details?.suggestedRate && (
                  <span className="action-rate">
                    {(a.details.suggestedRate * 100).toFixed(2)}%
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="privacy-note">
        <strong>Privacy-preserving agents:</strong> AI agents operate exclusively on
        anonymized metadata (amount buckets, sector, terms, reliability rating).
        They never access debtor identity, exact amounts, or other lenders' bids.
        All agent decisions respect Canton's sub-transaction privacy boundaries.
      </div>
    </div>
  );
}
