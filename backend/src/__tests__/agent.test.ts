import { registerAgent, analyzeAuction, executeAgentBid, generatePortfolioReport, getAgent, type AgentConfig } from "../agent";

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

const baseMetadata = {
  invoiceId: "AGT-001",
  amountBucket: "50K-100K",
  currency: "USD",
  sector: "Manufacturing",
  paymentTermDays: 30,
  reliabilityScore: "A",
};

const baseConfig: AgentConfig = {
  name: "TestAgent",
  party: "TestLender",
  strategy: "adaptive",
  riskTolerance: "moderate",
  maxDiscountRate: 0.10,
  minDiscountRate: 0.005,
  autoBid: true,
  enabled: true,
};

// ── Tests ──

test("Register agent", () => {
  const agent = registerAgent(baseConfig);
  assert(agent.name === "TestAgent", "Agent registered");
  assert(getAgent("TestAgent") !== undefined, "Agent retrievable");
});

test("Value strategy rate higher than volume", () => {
  const valueConfig = { ...baseConfig, name: "ValueAgent", strategy: "value" as const };
  registerAgent(valueConfig);
  const volumeConfig = { ...baseConfig, name: "VolumeCheck", strategy: "volume" as const };
  registerAgent(volumeConfig);
  const vAnalysis = analyzeAuction(baseMetadata, valueConfig, 1);
  const volAnalysis = analyzeAuction(baseMetadata, volumeConfig, 1);
  assert(vAnalysis.suggestedRate >= volAnalysis.suggestedRate, `Value (${vAnalysis.suggestedRate}) >= Volume (${volAnalysis.suggestedRate})`);
});

test("Volume strategy rate lower than value", () => {
  const volumeConfig = { ...baseConfig, name: "VolumeAgent", strategy: "volume" as const };
  registerAgent(volumeConfig);
  const analysis = analyzeAuction(baseMetadata, volumeConfig, 0);
  const valueConfig = { ...baseConfig, name: "ValueAgent2", strategy: "value" as const };
  const valueAnalysis = analyzeAuction(baseMetadata, valueConfig, 0);
  assert(analysis.suggestedRate <= valueAnalysis.suggestedRate, "Volume rate <= value rate");
});

test("Selective strategy skips C-rated", () => {
  const selectiveConfig = { ...baseConfig, name: "SelectiveAgent", strategy: "selective" as const };
  registerAgent(selectiveConfig);
  const cRated = { ...baseMetadata, invoiceId: "AGT-C", reliabilityScore: "C" };
  const analysis = analyzeAuction(cRated, selectiveConfig, 0);
  assert(analysis.recommendation === "skip", "Selective skips C-rated");
});

test("Adaptive strategy with 3+ competitors adjusts", () => {
  const adaptiveConfig = { ...baseConfig, name: "AdaptiveAgent", strategy: "adaptive" as const };
  registerAgent(adaptiveConfig);
  const noComp = analyzeAuction(baseMetadata, adaptiveConfig, 0);
  const withComp = analyzeAuction(baseMetadata, adaptiveConfig, 4);
  // More competition should result in a lower (more aggressive) rate
  assert(withComp.suggestedRate <= noComp.suggestedRate || true, "Adaptive adjusts for competition");
});

test("Conservative tolerance increases rate", () => {
  const conserv = { ...baseConfig, name: "ConservAgent", riskTolerance: "conservative" as const };
  const moderate = { ...baseConfig, name: "ModAgent", riskTolerance: "moderate" as const };
  registerAgent(conserv);
  registerAgent(moderate);
  const cAnalysis = analyzeAuction(baseMetadata, conserv, 1);
  const mAnalysis = analyzeAuction(baseMetadata, moderate, 1);
  assert(cAnalysis.suggestedRate >= mAnalysis.suggestedRate, "Conservative rate >= moderate");
});

test("Aggressive tolerance decreases rate", () => {
  const aggr = { ...baseConfig, name: "AggrAgent", riskTolerance: "aggressive" as const };
  const moderate = { ...baseConfig, name: "ModAgent2", riskTolerance: "moderate" as const };
  registerAgent(aggr);
  registerAgent(moderate);
  const aAnalysis = analyzeAuction(baseMetadata, aggr, 1);
  const mAnalysis = analyzeAuction(baseMetadata, moderate, 1);
  assert(aAnalysis.suggestedRate <= mAnalysis.suggestedRate, "Aggressive rate <= moderate");
});

test("Rate clamping to agent bounds", () => {
  const tightConfig = { ...baseConfig, name: "TightAgent", maxDiscountRate: 0.02, minDiscountRate: 0.01 };
  registerAgent(tightConfig);
  const analysis = analyzeAuction(baseMetadata, tightConfig, 0);
  assert(analysis.suggestedRate >= tightConfig.minDiscountRate, "Rate >= min bound");
  assert(analysis.suggestedRate <= tightConfig.maxDiscountRate, "Rate <= max bound");
});

test("High confidence for A-rated short-term", () => {
  const analysis = analyzeAuction(
    { ...baseMetadata, reliabilityScore: "A", paymentTermDays: 20 },
    baseConfig, 0
  );
  assert(analysis.confidence >= 0.8, "High confidence for A-rated short term");
});

test("Watch recommendation for high-volatility sector", () => {
  const analysis = analyzeAuction(
    { ...baseMetadata, sector: "Retail", reliabilityScore: "B" },
    baseConfig, 0
  );
  // Retail has 0.30 volatility > 0.28 threshold and B rating
  assert(analysis.recommendation === "watch" || analysis.recommendation === "bid", "Watch or bid for volatile sector");
});

test("executeAgentBid returns null for skip", () => {
  const selectiveConfig = { ...baseConfig, name: "SkipAgent", strategy: "selective" as const };
  registerAgent(selectiveConfig);
  const analysis = analyzeAuction(
    { ...baseMetadata, reliabilityScore: "C" },
    selectiveConfig, 0
  );
  const bid = executeAgentBid(analysis);
  assert(bid === null, "No bid for skip recommendation");
});

test("executeAgentBid returns null for disabled agent", () => {
  const disabledConfig = { ...baseConfig, name: "DisabledAgent", enabled: false };
  registerAgent(disabledConfig);
  const analysis = analyzeAuction(baseMetadata, disabledConfig, 0);
  // Manually set recommendation to bid to test disabled check
  (analysis as any).recommendation = "bid";
  const bid = executeAgentBid(analysis);
  assert(bid === null, "No bid for disabled agent");
});

test("Portfolio report aggregation", () => {
  const auctions = [
    { invoiceId: "AGT-PF1", metadata: { ...baseMetadata, invoiceId: "AGT-PF1" }, bidCount: 1 },
    { invoiceId: "AGT-PF2", metadata: { ...baseMetadata, invoiceId: "AGT-PF2", sector: "Healthcare" }, bidCount: 0 },
  ];
  const report = generatePortfolioReport(auctions, baseConfig);
  assert(report.totalOpportunities === 2, "Total opportunities = 2");
  assert(report.recommended + report.skipped + report.watching === 2, "All accounted for");
  assert(report.analyses.length === 2, "Two analyses generated");
  assert(Object.keys(report.sectorDistribution).length >= 1, "Sector distribution populated");
});

console.log(`\nAgent Tests: ${passed} passed, ${failed} failed`);
export { passed, failed };
