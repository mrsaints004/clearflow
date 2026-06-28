/**
 * AI Agent Engine for ClearFlow
 *
 * Autonomous agents that can analyze invoice metadata, compute optimal bid strategies,
 * generate risk reports, and execute automated bidding — all while respecting
 * Canton's privacy model (agents only see anonymized metadata, never raw invoice data).
 *
 * This enables Track 3: "Agentic Commerce with Privacy"
 */

import { computeBidCommitment, generateNonce } from "./crypto";
import {
  recordOutcome,
  getPerformanceMetrics,
  computeWinProbability,
  getAdaptiveBaseRate,
  getPortfolioState,
  shouldBidForPortfolio,
  getOutcomes,
  type AuctionOutcome,
  type PerformanceMetrics,
  type PortfolioState,
} from "./agent-learning";
import { explainBidRecommendation, type LLMExplanation } from "./agent-llm";
import { loadAgentActions, saveAgentActions } from "./persistence";

// ─── Types ───────────────────────────────────────────────────────────

export interface AgentConfig {
  name: string;
  party: string;           // Which lender party this agent acts for
  strategy: AgentStrategy;
  riskTolerance: "conservative" | "moderate" | "aggressive";
  maxDiscountRate: number;  // Maximum rate the agent will bid (e.g., 0.05 = 5%)
  minDiscountRate: number;  // Minimum rate (floor)
  autoBid: boolean;         // Whether to auto-submit bids
  enabled: boolean;
}

export type AgentStrategy = "value" | "volume" | "selective" | "adaptive";

export interface AgentAnalysis {
  invoiceId: string;
  agent: string;
  party: string;
  timestamp: string;
  recommendation: "bid" | "skip" | "watch";
  suggestedRate: number;
  confidence: number;       // 0-1
  reasoning: AgentReasoning;
  riskAssessment: AgentRiskAssessment;
  marketContext: MarketContext;
  winProbability?: number;
  adaptiveRate?: number;
  llmExplanation?: LLMExplanation;
}

export interface AgentReasoning {
  factors: Array<{
    name: string;
    impact: "positive" | "negative" | "neutral";
    weight: number;
    detail: string;
  }>;
  summary: string;
}

export interface AgentRiskAssessment {
  overallRisk: "low" | "medium" | "high";
  score: number;            // 0-100
  maxExposure: number;      // Estimated max loss
  expectedReturn: number;   // Estimated return
  sharpeRatio: number;      // Risk-adjusted return
}

export interface MarketContext {
  avgMarketRate: number;
  competitorCount: number;
  sectorTrend: "expanding" | "stable" | "contracting";
  liquidityScore: number;   // 0-100
}

export interface AgentAction {
  id: string;
  agent: string;
  party: string;
  action: "analyze" | "bid" | "skip" | "alert";
  invoiceId: string;
  timestamp: string;
  details: any;
  result?: any;
}

// ─── Sector Intelligence ─────────────────────────────────────────────

const SECTOR_DATA: Record<string, {
  avgDefaultRate: number;
  trend: "expanding" | "stable" | "contracting";
  volatility: number;
  baseRate: number;
}> = {
  Manufacturing: { avgDefaultRate: 0.012, trend: "stable", volatility: 0.15, baseRate: 0.025 },
  Healthcare: { avgDefaultRate: 0.008, trend: "expanding", volatility: 0.10, baseRate: 0.020 },
  Technology: { avgDefaultRate: 0.018, trend: "expanding", volatility: 0.25, baseRate: 0.030 },
  Retail: { avgDefaultRate: 0.022, trend: "contracting", volatility: 0.30, baseRate: 0.035 },
  Construction: { avgDefaultRate: 0.035, trend: "stable", volatility: 0.35, baseRate: 0.040 },
  Energy: { avgDefaultRate: 0.015, trend: "stable", volatility: 0.20, baseRate: 0.028 },
  Finance: { avgDefaultRate: 0.010, trend: "expanding", volatility: 0.12, baseRate: 0.022 },
  Logistics: { avgDefaultRate: 0.016, trend: "expanding", volatility: 0.18, baseRate: 0.026 },
};

const AMOUNT_BUCKET_MIDPOINTS: Record<string, number> = {
  "Under 10K": 5000,
  "10K-50K": 30000,
  "50K-100K": 75000,
  "100K-500K": 250000,
  "500K+": 750000,
};

// ─── Agent Engine ────────────────────────────────────────────────────

const agents = new Map<string, AgentConfig>();
let actionLog: AgentAction[] = loadAgentActions() || [];

export function registerAgent(config: AgentConfig): AgentConfig {
  agents.set(config.name, config);
  return config;
}

export function getAgent(name: string): AgentConfig | undefined {
  return agents.get(name);
}

export function getAllAgents(): AgentConfig[] {
  return Array.from(agents.values());
}

export function getAgentActions(agentName?: string): AgentAction[] {
  if (agentName) return actionLog.filter((a) => a.agent === agentName);
  return [...actionLog];
}

function logAction(action: AgentAction): void {
  actionLog.push(action);
  // Keep last 1000 actions
  if (actionLog.length > 1000) actionLog.splice(0, actionLog.length - 1000);
  saveAgentActions(actionLog);
}

/**
 * Core agent analysis: given anonymized metadata (what a lender actually sees),
 * compute an optimal bid strategy.
 *
 * This demonstrates "agentic commerce with privacy" — the agent makes decisions
 * based ONLY on the anonymized metadata Canton exposes to lenders.
 */
export function analyzeAuction(
  metadata: {
    invoiceId: string;
    amountBucket: string;
    currency: string;
    sector: string;
    paymentTermDays: number;
    reliabilityScore: string;
  },
  agentConfig: AgentConfig,
  existingBidCount: number
): AgentAnalysis {
  const sectorInfo = SECTOR_DATA[metadata.sector] || SECTOR_DATA.Manufacturing;
  const estimatedAmount = AMOUNT_BUCKET_MIDPOINTS[metadata.amountBucket] || 50000;

  const factors: AgentReasoning["factors"] = [];

  // 1. Sector analysis
  const sectorRateAdj = sectorInfo.baseRate;
  factors.push({
    name: "Sector Risk Premium",
    impact: sectorInfo.avgDefaultRate < 0.015 ? "positive" : sectorInfo.avgDefaultRate < 0.025 ? "neutral" : "negative",
    weight: 0.25,
    detail: `${metadata.sector}: ${(sectorInfo.avgDefaultRate * 100).toFixed(1)}% avg default rate, trend: ${sectorInfo.trend}`,
  });

  // 2. Payment term analysis
  const termPremium = metadata.paymentTermDays <= 30 ? -0.005 :
    metadata.paymentTermDays <= 60 ? 0 :
    metadata.paymentTermDays <= 90 ? 0.005 : 0.01;
  factors.push({
    name: "Payment Term Duration",
    impact: metadata.paymentTermDays <= 30 ? "positive" : metadata.paymentTermDays <= 60 ? "neutral" : "negative",
    weight: 0.20,
    detail: `Net ${metadata.paymentTermDays} days — ${metadata.paymentTermDays <= 30 ? "short duration, lower risk" : "extended duration increases exposure"}`,
  });

  // 3. Debtor reliability
  const reliabilityAdj = metadata.reliabilityScore === "A" ? -0.008 :
    metadata.reliabilityScore === "B" ? 0 : 0.010;
  factors.push({
    name: "Debtor Reliability Rating",
    impact: metadata.reliabilityScore === "A" ? "positive" : metadata.reliabilityScore === "B" ? "neutral" : "negative",
    weight: 0.25,
    detail: `Rating ${metadata.reliabilityScore} — ${metadata.reliabilityScore === "A" ? "strong payment history" : metadata.reliabilityScore === "B" ? "adequate history" : "elevated counterparty risk"}`,
  });

  // 4. Competition analysis
  const competitionAdj = existingBidCount === 0 ? -0.003 :
    existingBidCount === 1 ? 0 : 0.002 * existingBidCount;
  factors.push({
    name: "Competition Intensity",
    impact: existingBidCount <= 1 ? "positive" : "negative",
    weight: 0.15,
    detail: `${existingBidCount} existing bids — ${existingBidCount === 0 ? "first mover advantage" : `competitive pressure from ${existingBidCount} bidders`}`,
  });

  // 5. Amount concentration
  const amountAdj = estimatedAmount < 50000 ? -0.002 :
    estimatedAmount < 200000 ? 0 : 0.003;
  factors.push({
    name: "Amount Exposure",
    impact: estimatedAmount < 50000 ? "positive" : estimatedAmount < 200000 ? "neutral" : "negative",
    weight: 0.15,
    detail: `${metadata.amountBucket} range — ${estimatedAmount < 50000 ? "manageable ticket size" : "larger exposure requires premium"}`,
  });

  // Compute base rate
  let suggestedRate = sectorRateAdj + termPremium + reliabilityAdj + competitionAdj + amountAdj;

  // Get adaptive base rate from historical data
  const adaptiveBaseRate = getAdaptiveBaseRate(metadata.sector, metadata.reliabilityScore, suggestedRate);
  const winProb = computeWinProbability(suggestedRate, metadata.sector, metadata.reliabilityScore);

  // Apply strategy adjustments
  let selectiveSkip = false;
  switch (agentConfig.strategy) {
    case "value":
      suggestedRate *= 1.15;
      break;
    case "volume":
      suggestedRate *= 0.85;
      break;
    case "selective":
      if (metadata.reliabilityScore === "C" || sectorInfo.avgDefaultRate > 0.025) {
        suggestedRate = 0;
        selectiveSkip = true;
      }
      break;
    case "adaptive":
      // Blend static and adaptive rates: 60% adaptive, 40% static
      suggestedRate = 0.6 * adaptiveBaseRate + 0.4 * suggestedRate;
      if (existingBidCount >= 3) {
        suggestedRate *= 0.90;
      }
      break;
  }

  // Apply risk tolerance
  const toleranceMultiplier = agentConfig.riskTolerance === "conservative" ? 1.2 :
    agentConfig.riskTolerance === "aggressive" ? 0.8 : 1.0;
  suggestedRate *= toleranceMultiplier;

  // Clamp to agent's configured bounds
  suggestedRate = Math.max(agentConfig.minDiscountRate, Math.min(agentConfig.maxDiscountRate, suggestedRate));
  suggestedRate = Math.round(suggestedRate * 10000) / 10000; // 4 decimal places

  // Determine recommendation
  let recommendation: "bid" | "skip" | "watch" = "bid";
  let confidence = 0.7;

  if (selectiveSkip || suggestedRate <= 0 || suggestedRate < agentConfig.minDiscountRate) {
    recommendation = "skip";
    confidence = 0.8;
  } else if (sectorInfo.volatility > 0.28 && metadata.reliabilityScore !== "A") {
    recommendation = "watch";
    confidence = 0.5;
  } else if (metadata.reliabilityScore === "A" && metadata.paymentTermDays <= 30) {
    confidence = 0.9;
  }

  // Risk assessment
  const expectedReturn = estimatedAmount * suggestedRate;
  const maxExposure = estimatedAmount * sectorInfo.avgDefaultRate;
  const sharpeRatio = maxExposure > 0 ? expectedReturn / maxExposure : 0;
  const riskScore = Math.round(
    (1 - sectorInfo.avgDefaultRate * 10) * 40 +
    (metadata.reliabilityScore === "A" ? 30 : metadata.reliabilityScore === "B" ? 20 : 10) +
    (metadata.paymentTermDays <= 30 ? 20 : metadata.paymentTermDays <= 60 ? 15 : 10) +
    (sectorInfo.trend === "expanding" ? 10 : sectorInfo.trend === "stable" ? 5 : 0)
  );

  const analysis: AgentAnalysis = {
    invoiceId: metadata.invoiceId,
    agent: agentConfig.name,
    party: agentConfig.party,
    timestamp: new Date().toISOString(),
    recommendation,
    suggestedRate,
    confidence,
    winProbability: winProb,
    adaptiveRate: adaptiveBaseRate,
    reasoning: {
      factors,
      summary: recommendation === "bid"
        ? `Agent recommends bidding at ${(suggestedRate * 100).toFixed(2)}% discount rate. ${metadata.sector} sector with ${metadata.reliabilityScore}-rated debtor and ${metadata.paymentTermDays}-day terms presents ${confidence > 0.7 ? "a favorable" : "an acceptable"} risk/return profile.`
        : recommendation === "skip"
        ? `Agent recommends skipping this auction. Risk factors exceed tolerance thresholds for ${agentConfig.strategy} strategy.`
        : `Agent recommends watching. Sector volatility (${(sectorInfo.volatility * 100).toFixed(0)}%) warrants monitoring before committing.`,
    },
    riskAssessment: {
      overallRisk: riskScore >= 70 ? "low" : riskScore >= 45 ? "medium" : "high",
      score: Math.min(100, Math.max(0, riskScore)),
      maxExposure: Math.round(maxExposure),
      expectedReturn: Math.round(expectedReturn),
      sharpeRatio: Math.round(sharpeRatio * 100) / 100,
    },
    marketContext: {
      avgMarketRate: sectorRateAdj,
      competitorCount: existingBidCount,
      sectorTrend: sectorInfo.trend,
      liquidityScore: Math.round(
        (sectorInfo.trend === "expanding" ? 80 : sectorInfo.trend === "stable" ? 60 : 40) -
        sectorInfo.volatility * 50 +
        (existingBidCount > 0 ? 10 : 0)
      ),
    },
  };

  logAction({
    id: `analysis-${Date.now()}`,
    agent: agentConfig.name,
    party: agentConfig.party,
    action: "analyze",
    invoiceId: metadata.invoiceId,
    timestamp: analysis.timestamp,
    details: {
      recommendation,
      suggestedRate,
      confidence,
      strategy: agentConfig.strategy,
    },
  });

  return analysis;
}

/**
 * Execute an agent bid: auto-generates the bid based on analysis.
 * Returns the bid parameters to be submitted via the normal bid endpoint.
 */
export function executeAgentBid(
  analysis: AgentAnalysis,
  activePositions?: Array<{ sector: string; amount: number }>
): { lender: string; invoiceId: string; discountRate: number; agentGenerated: boolean } | null {
  if (analysis.recommendation !== "bid") return null;

  const agent = agents.get(analysis.agent);
  if (!agent || !agent.autoBid || !agent.enabled) return null;

  // Portfolio concentration check
  if (activePositions && activePositions.length > 0) {
    const portfolioState = getPortfolioState(agent.name, activePositions);
    const metadata = analysis.marketContext;
    // Use invoiceId to look up amountBucket from analysis context — approximation
    if (!shouldBidForPortfolio(analysis.reasoning.factors[0]?.detail?.split(":")[0] || "Manufacturing", "50K-100K", portfolioState)) {
      logAction({
        id: `skip-portfolio-${Date.now()}`,
        agent: analysis.agent,
        party: analysis.party,
        action: "skip",
        invoiceId: analysis.invoiceId,
        timestamp: new Date().toISOString(),
        details: { reason: "Portfolio concentration limit exceeded" },
      });
      return null;
    }
  }

  logAction({
    id: `bid-${Date.now()}`,
    agent: analysis.agent,
    party: analysis.party,
    action: "bid",
    invoiceId: analysis.invoiceId,
    timestamp: new Date().toISOString(),
    details: {
      rate: analysis.suggestedRate,
      confidence: analysis.confidence,
    },
  });

  return {
    lender: analysis.party,
    invoiceId: analysis.invoiceId,
    discountRate: analysis.suggestedRate,
    agentGenerated: true,
  };
}

/**
 * Generate a risk report for a set of auctions visible to a lender.
 * This demonstrates agent intelligence operating on anonymized data.
 */
export function generatePortfolioReport(
  auctions: Array<{
    invoiceId: string;
    metadata: any;
    bidCount: number;
  }>,
  agentConfig: AgentConfig
): {
  totalOpportunities: number;
  recommended: number;
  skipped: number;
  watching: number;
  avgSuggestedRate: number;
  portfolioRisk: "low" | "medium" | "high";
  sectorDistribution: Record<string, number>;
  analyses: AgentAnalysis[];
} {
  const analyses = auctions.map((a) =>
    analyzeAuction(a.metadata, agentConfig, a.bidCount)
  );

  const recommended = analyses.filter((a) => a.recommendation === "bid");
  const skipped = analyses.filter((a) => a.recommendation === "skip");
  const watching = analyses.filter((a) => a.recommendation === "watch");

  const avgRate = recommended.length > 0
    ? recommended.reduce((sum, a) => sum + a.suggestedRate, 0) / recommended.length
    : 0;

  const sectorDistribution: Record<string, number> = {};
  for (const a of auctions) {
    sectorDistribution[a.metadata.sector] = (sectorDistribution[a.metadata.sector] || 0) + 1;
  }

  const avgRiskScore = analyses.reduce((sum, a) => sum + a.riskAssessment.score, 0) / (analyses.length || 1);

  return {
    totalOpportunities: auctions.length,
    recommended: recommended.length,
    skipped: skipped.length,
    watching: watching.length,
    avgSuggestedRate: Math.round(avgRate * 10000) / 10000,
    portfolioRisk: avgRiskScore >= 65 ? "low" : avgRiskScore >= 40 ? "medium" : "high",
    sectorDistribution,
    analyses,
  };
}

// ─── Learning Integration ───────────────────────────────────────────

export function recordAuctionOutcome(
  invoiceId: string,
  winningRate: number,
  allBids: Array<{ lender: string; discountRate: number }>,
  metadata: { sector: string; reliabilityScore: string; amountBucket: string }
): void {
  const marketAvgRate = allBids.length > 0
    ? allBids.reduce((s, b) => s + b.discountRate, 0) / allBids.length
    : winningRate;

  for (const agent of agents.values()) {
    const agentBid = allBids.find((b) => b.lender === agent.party);
    if (!agentBid) continue;

    const outcome: AuctionOutcome = {
      invoiceId,
      agentName: agent.name,
      bidRate: agentBid.discountRate,
      winningRate,
      won: agentBid.discountRate === winningRate,
      marketAvgRate,
      bidCount: allBids.length,
      sector: metadata.sector,
      reliabilityScore: metadata.reliabilityScore,
      amountBucket: metadata.amountBucket,
      timestamp: new Date().toISOString(),
    };

    recordOutcome(outcome);
  }
}

export function getAgentPerformance(name: string): PerformanceMetrics {
  return getPerformanceMetrics(name);
}

export function getAgentPortfolioState(
  name: string,
  activePositions: Array<{ sector: string; amount: number }>
): PortfolioState {
  return getPortfolioState(name, activePositions);
}

export async function getAnalysisWithLLM(
  analysis: AgentAnalysis
): Promise<AgentAnalysis> {
  const outcomes = getOutcomes().filter((o) => o.agentName === analysis.agent);
  const agent = agents.get(analysis.agent);
  const portfolioState = agent
    ? getPortfolioState(agent.name, [])
    : null;

  const explanation = await explainBidRecommendation(
    {
      invoiceId: analysis.invoiceId,
      sector: analysis.reasoning.factors[0]?.detail?.split(":")[0] || "Manufacturing",
      reliabilityScore: "B",
      amountBucket: "50K-100K",
      paymentTermDays: 30,
      suggestedRate: analysis.suggestedRate,
      confidence: analysis.confidence,
      recommendation: analysis.recommendation,
      winProbability: analysis.winProbability,
      riskScore: analysis.riskAssessment.score,
    },
    outcomes,
    portfolioState
  );

  return { ...analysis, llmExplanation: explanation };
}

export { getPerformanceMetrics, getPortfolioState as getPortfolioStateFromLearning } from "./agent-learning";

