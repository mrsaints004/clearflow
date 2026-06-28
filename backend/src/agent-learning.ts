import { loadAgentOutcomes, saveAgentOutcomes } from "./persistence";

// ─── Types ──────────────────────────────────────────────────────────

export interface AuctionOutcome {
  invoiceId: string;
  agentName: string;
  bidRate: number;
  winningRate: number;
  won: boolean;
  marketAvgRate: number;
  bidCount: number;
  sector: string;
  reliabilityScore: string;
  amountBucket: string;
  timestamp: string;
}

export interface PeriodMetrics {
  period: string;
  wins: number;
  bids: number;
  avgReturn: number;
}

export interface PerformanceMetrics {
  totalBids: number;
  wins: number;
  winRate: number;
  avgReturn: number;
  avgBidDelta: number;
  sharpeRatio: number;
  profitLoss: number;
  recentTrend: "improving" | "stable" | "declining";
  byPeriod: PeriodMetrics[];
}

export interface PortfolioState {
  sectorExposure: Record<string, number>;
  concentrationRisk: number; // Herfindahl-Hirschman Index
  openPositions: number;
  totalExposure: number;
}

// ─── Storage ────────────────────────────────────────────────────────

let outcomes: AuctionOutcome[] = [];

function loadOutcomes(): void {
  const loaded = loadAgentOutcomes();
  if (loaded && Array.isArray(loaded)) {
    outcomes = loaded;
  }
}

function persistOutcomes(): void {
  saveAgentOutcomes(outcomes);
}

// Load on startup
loadOutcomes();

// ─── Core Functions ─────────────────────────────────────────────────

export function recordOutcome(outcome: AuctionOutcome): void {
  outcomes.push(outcome);
  persistOutcomes();
}

export function getOutcomes(): AuctionOutcome[] {
  return [...outcomes];
}

export function getPerformanceMetrics(agentName: string): PerformanceMetrics {
  const agentOutcomes = outcomes.filter((o) => o.agentName === agentName);

  if (agentOutcomes.length === 0) {
    return {
      totalBids: 0,
      wins: 0,
      winRate: 0,
      avgReturn: 0,
      avgBidDelta: 0,
      sharpeRatio: 0,
      profitLoss: 0,
      recentTrend: "stable",
      byPeriod: [],
    };
  }

  const wins = agentOutcomes.filter((o) => o.won);
  const totalBids = agentOutcomes.length;
  const winRate = wins.length / totalBids;

  // Average return: difference between bid rate and winning rate for wins
  const returns = wins.map((o) => o.bidRate - o.winningRate);
  const avgReturn = returns.length > 0
    ? returns.reduce((s, r) => s + r, 0) / returns.length
    : 0;

  // Average bid delta from market
  const deltas = agentOutcomes.map((o) => o.bidRate - o.marketAvgRate);
  const avgBidDelta = deltas.reduce((s, d) => s + d, 0) / deltas.length;

  // Sharpe ratio (rolling window of 20)
  const sharpeRatio = computeSharpeRatio(agentOutcomes);

  // Cumulative P&L
  const profitLoss = agentOutcomes.reduce((pnl, o) => {
    if (o.won) {
      return pnl + (o.bidRate - o.winningRate) * 100; // basis points * 100
    }
    return pnl;
  }, 0);

  // Recent trend: compare last 5 win rate vs previous 5
  const recentTrend = computeTrend(agentOutcomes);

  // Period metrics
  const byPeriod = computePeriodMetrics(agentOutcomes);

  return {
    totalBids,
    wins: wins.length,
    winRate,
    avgReturn,
    avgBidDelta,
    sharpeRatio,
    profitLoss,
    recentTrend,
    byPeriod,
  };
}

export function computeSharpeRatio(agentOutcomes: AuctionOutcome[]): number {
  const window = agentOutcomes.slice(-20);
  if (window.length < 2) return 0;

  const returns = window.map((o) => (o.won ? o.bidRate : -0.001));
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;
  return mean / stdDev;
}

function computeTrend(agentOutcomes: AuctionOutcome[]): "improving" | "stable" | "declining" {
  if (agentOutcomes.length < 10) return "stable";
  const recent = agentOutcomes.slice(-5);
  const previous = agentOutcomes.slice(-10, -5);
  const recentWinRate = recent.filter((o) => o.won).length / recent.length;
  const prevWinRate = previous.filter((o) => o.won).length / previous.length;
  const delta = recentWinRate - prevWinRate;
  if (delta > 0.1) return "improving";
  if (delta < -0.1) return "declining";
  return "stable";
}

function computePeriodMetrics(agentOutcomes: AuctionOutcome[]): PeriodMetrics[] {
  const byDay = new Map<string, AuctionOutcome[]>();
  for (const o of agentOutcomes) {
    const day = o.timestamp.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(o);
  }

  return Array.from(byDay.entries()).map(([period, outcomes]) => {
    const wins = outcomes.filter((o) => o.won);
    const avgReturn = wins.length > 0
      ? wins.reduce((s, o) => s + (o.bidRate - o.winningRate), 0) / wins.length
      : 0;
    return { period, wins: wins.length, bids: outcomes.length, avgReturn };
  });
}

// ─── Win Probability ────────────────────────────────────────────────

export function computeWinProbability(
  rate: number,
  sector: string,
  reliability: string
): number {
  // Filter relevant outcomes
  const relevant = outcomes.filter(
    (o) => o.sector === sector || o.reliabilityScore === reliability
  );

  if (relevant.length < 3) {
    // Fallback: simple estimate based on rate magnitude
    return 1 / (1 + Math.exp(5 * (rate - 0.03)));
  }

  const winningRates = relevant.filter((o) => o.won).map((o) => o.winningRate);
  if (winningRates.length === 0) {
    return 1 / (1 + Math.exp(5 * (rate - 0.03)));
  }

  const medianWinRate = median(winningRates);

  // Logistic approximation: P(win) = 1 / (1 + exp(k * (rate - medianWinRate)))
  // Lower rates are more competitive, so lower = higher P(win)
  const k = 50; // sensitivity
  return 1 / (1 + Math.exp(k * (rate - medianWinRate)));
}

// ─── Adaptive Rate ──────────────────────────────────────────────────

export function getAdaptiveBaseRate(
  sector: string,
  reliability: string,
  fallback: number
): number {
  const relevant = outcomes.filter(
    (o) => o.sector === sector && o.reliabilityScore === reliability && o.won
  );

  if (relevant.length < 5) return fallback;

  const rates = relevant.map((o) => o.winningRate);
  return median(rates);
}

// ─── Portfolio Analysis ─────────────────────────────────────────────

export function getPortfolioState(
  agentName: string,
  activePositions: Array<{ sector: string; amount: number }>
): PortfolioState {
  const sectorExposure: Record<string, number> = {};
  let totalExposure = 0;

  for (const pos of activePositions) {
    sectorExposure[pos.sector] = (sectorExposure[pos.sector] || 0) + pos.amount;
    totalExposure += pos.amount;
  }

  // Herfindahl-Hirschman Index
  const concentrationRisk = totalExposure > 0
    ? Object.values(sectorExposure).reduce((sum, exp) => {
        const share = exp / totalExposure;
        return sum + share * share;
      }, 0)
    : 0;

  return {
    sectorExposure,
    concentrationRisk,
    openPositions: activePositions.length,
    totalExposure,
  };
}

export function shouldBidForPortfolio(
  sector: string,
  amountBucket: string,
  portfolioState: PortfolioState,
  maxConcentration: number = 0.4
): boolean {
  if (portfolioState.totalExposure === 0) return true;

  const currentSectorExposure = portfolioState.sectorExposure[sector] || 0;
  const estimatedAmount = bucketToAmount(amountBucket);
  const newTotal = portfolioState.totalExposure + estimatedAmount;
  const newSectorShare = (currentSectorExposure + estimatedAmount) / newTotal;

  return newSectorShare <= maxConcentration;
}

// ─── Helpers ────────────────────────────────────────────────────────

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function bucketToAmount(bucket: string): number {
  const map: Record<string, number> = {
    "Under 10K": 5000,
    "10K-50K": 30000,
    "50K-100K": 75000,
    "100K-500K": 250000,
    "500K-1M": 750000,
    "Over 1M": 2000000,
  };
  return map[bucket] || 50000;
}

export function resetOutcomes(): void {
  outcomes = [];
}
