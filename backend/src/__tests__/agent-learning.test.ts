import {
  recordOutcome,
  getPerformanceMetrics,
  computeWinProbability,
  getAdaptiveBaseRate,
  getPortfolioState,
  shouldBidForPortfolio,
  computeSharpeRatio,
  resetOutcomes,
  type AuctionOutcome,
} from "../agent-learning";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) { console.log(`  PASS: ${message}`); passed++; }
  else { console.error(`  FAIL: ${message}`); failed++; }
}

function test(name: string, fn: () => void): void {
  console.log(`\n${name}`);
  try { fn(); } catch (e: any) { console.error(`  ERROR: ${e.message}`); failed++; }
}

// Clean state
resetOutcomes();

function makeOutcome(overrides: Partial<AuctionOutcome> = {}): AuctionOutcome {
  return {
    invoiceId: `LRN-${Date.now()}`,
    agentName: "TestLearner",
    bidRate: 0.03,
    winningRate: 0.025,
    won: true,
    marketAvgRate: 0.028,
    bidCount: 3,
    sector: "Manufacturing",
    reliabilityScore: "A",
    amountBucket: "50K-100K",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ──

test("Record outcome", () => {
  resetOutcomes();
  recordOutcome(makeOutcome({ invoiceId: "LRN-001" }));
  const metrics = getPerformanceMetrics("TestLearner");
  assert(metrics.totalBids === 1, "One outcome recorded");
});

test("Metrics win rate calculation", () => {
  resetOutcomes();
  recordOutcome(makeOutcome({ won: true }));
  recordOutcome(makeOutcome({ won: false }));
  recordOutcome(makeOutcome({ won: true }));
  const metrics = getPerformanceMetrics("TestLearner");
  assert(metrics.totalBids === 3, "Three bids recorded");
  assert(Math.abs(metrics.winRate - 2/3) < 0.01, `Win rate is ~66%, got ${(metrics.winRate * 100).toFixed(1)}%`);
});

test("Win probability decreases with higher rate", () => {
  resetOutcomes();
  // Add enough data for probability computation
  for (let i = 0; i < 5; i++) {
    recordOutcome(makeOutcome({
      invoiceId: `PROB-${i}`,
      bidRate: 0.02 + i * 0.005,
      winningRate: 0.02,
      won: i === 0,
      sector: "Technology",
      reliabilityScore: "B",
    }));
  }
  const lowRateProb = computeWinProbability(0.015, "Technology", "B");
  const highRateProb = computeWinProbability(0.05, "Technology", "B");
  assert(lowRateProb >= highRateProb, `Low rate (${lowRateProb.toFixed(3)}) >= high rate (${highRateProb.toFixed(3)})`);
});

test("Adaptive fallback when insufficient data", () => {
  resetOutcomes();
  const fallback = getAdaptiveBaseRate("UnknownSector", "A", 0.025);
  assert(fallback === 0.025, "Returns fallback with no data");
});

test("Adaptive rate from historical data", () => {
  resetOutcomes();
  // Record 6 winning outcomes for Manufacturing/A
  for (let i = 0; i < 6; i++) {
    recordOutcome(makeOutcome({
      invoiceId: `ADPT-${i}`,
      bidRate: 0.02 + i * 0.002,
      winningRate: 0.02 + i * 0.002,
      won: true,
      sector: "Manufacturing",
      reliabilityScore: "A",
    }));
  }
  const rate = getAdaptiveBaseRate("Manufacturing", "A", 0.05);
  assert(rate !== 0.05, "Adaptive rate differs from fallback");
  assert(rate > 0 && rate < 0.1, `Adaptive rate is reasonable: ${rate}`);
});

test("Portfolio concentration via HHI", () => {
  const state = getPortfolioState("TestAgent", [
    { sector: "Manufacturing", amount: 50000 },
    { sector: "Manufacturing", amount: 50000 },
    { sector: "Technology", amount: 50000 },
  ]);
  assert(state.openPositions === 3, "3 open positions");
  assert(state.totalExposure === 150000, "Total exposure correct");
  // HHI: (2/3)^2 + (1/3)^2 = 4/9 + 1/9 = 5/9 ≈ 0.556
  assert(state.concentrationRisk > 0.5 && state.concentrationRisk < 0.6, `HHI ≈ 0.556, got ${state.concentrationRisk.toFixed(3)}`);
});

test("Portfolio rejection when concentration exceeded", () => {
  const state = getPortfolioState("TestAgent", [
    { sector: "Manufacturing", amount: 80000 },
    { sector: "Technology", amount: 20000 },
  ]);
  // Manufacturing is 80% of portfolio; adding more Manufacturing should be rejected at 40% max
  const shouldBid = shouldBidForPortfolio("Manufacturing", "50K-100K", state, 0.4);
  assert(shouldBid === false, "Rejected — Manufacturing would exceed 40% concentration");

  // Technology at 20K + 75K estimated = 95K out of 175K total = 54.3%, also exceeds 40%
  // Use a smaller bucket so it stays under limit
  const shouldBidTech = shouldBidForPortfolio("Technology", "Under 10K", state, 0.4);
  // (20000+5000)/(100000+5000) = 25000/105000 ≈ 23.8% — under 40%
  assert(shouldBidTech === true, "Accepted — Technology under concentration limit with small bucket");
});

test("Sharpe ratio computation", () => {
  resetOutcomes();
  const outcomes: AuctionOutcome[] = [];
  for (let i = 0; i < 5; i++) {
    outcomes.push(makeOutcome({ won: i % 2 === 0, bidRate: 0.02 + i * 0.005 }));
  }
  const sharpe = computeSharpeRatio(outcomes);
  assert(typeof sharpe === "number", "Sharpe is a number");
  assert(!isNaN(sharpe), "Sharpe is not NaN");
});

resetOutcomes();

console.log(`\nAgent Learning Tests: ${passed} passed, ${failed} failed`);
export { passed, failed };
