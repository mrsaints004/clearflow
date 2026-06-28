import type { AuctionOutcome, PortfolioState } from "./agent-learning";

// ─── Config ─────────────────────────────────────────────────────────

interface LLMConfig {
  enabled: boolean;
  provider: "claude" | "openai" | null;
  apiKey: string | null;
  model: string;
  timeoutMs: number;
}

export function getLLMConfig(): LLMConfig {
  const provider = (process.env.LLM_PROVIDER as "claude" | "openai") || null;
  const claudeKey = process.env.CLAUDE_API_KEY || null;
  const openaiKey = process.env.OPENAI_API_KEY || null;
  const apiKey = provider === "claude" ? claudeKey : provider === "openai" ? openaiKey : (claudeKey || openaiKey);
  const resolvedProvider = provider || (claudeKey ? "claude" : openaiKey ? "openai" : null);

  return {
    enabled: !!apiKey && !!resolvedProvider,
    provider: resolvedProvider,
    apiKey,
    model: process.env.LLM_MODEL || (resolvedProvider === "claude" ? "claude-sonnet-4-20250514" : "gpt-4o-mini"),
    timeoutMs: parseInt(process.env.LLM_TIMEOUT_MS || "10000", 10),
  };
}

// ─── Analysis Types ─────────────────────────────────────────────────

interface AgentAnalysisContext {
  invoiceId: string;
  sector: string;
  reliabilityScore: string;
  amountBucket: string;
  paymentTermDays: number;
  suggestedRate: number;
  confidence: number;
  recommendation: string;
  winProbability?: number;
  riskScore: number;
}

export interface LLMExplanation {
  reasoning: string;
  confidence: number;
  factors: string[];
  provider: string;
  latencyMs: number;
}

export interface MarketInsight {
  summary: string;
  provider: string;
  latencyMs: number;
}

// ─── LLM API Calls ─────────────────────────────────────────────────

export async function explainBidRecommendation(
  analysis: AgentAnalysisContext,
  recentOutcomes: AuctionOutcome[],
  portfolioState: PortfolioState | null
): Promise<LLMExplanation> {
  const config = getLLMConfig();

  if (!config.enabled) {
    return fallbackExplanation(analysis);
  }

  const prompt = buildBidPrompt(analysis, recentOutcomes, portfolioState);
  const start = Date.now();

  try {
    const response = config.provider === "claude"
      ? await callClaude(config, prompt)
      : await callOpenAI(config, prompt);

    const latencyMs = Date.now() - start;

    return {
      reasoning: response.reasoning || response,
      confidence: analysis.confidence,
      factors: response.factors || extractFactors(response.reasoning || response),
      provider: config.provider!,
      latencyMs,
    };
  } catch (err: any) {
    console.warn(`LLM call failed: ${err.message}. Using fallback.`);
    return fallbackExplanation(analysis);
  }
}

export async function getMarketInsight(
  metrics: { totalAuctions: number; avgRate: number; topSectors: string[] }
): Promise<MarketInsight> {
  const config = getLLMConfig();

  if (!config.enabled) {
    return {
      summary: `Market overview: ${metrics.totalAuctions} active auctions with average discount rate of ${(metrics.avgRate * 100).toFixed(2)}%. Active sectors: ${metrics.topSectors.join(", ")}.`,
      provider: "rules-engine",
      latencyMs: 0,
    };
  }

  const prompt = `Provide a brief (2-3 sentence) market outlook for invoice financing:
- Active auctions: ${metrics.totalAuctions}
- Average discount rate: ${(metrics.avgRate * 100).toFixed(2)}%
- Top sectors: ${metrics.topSectors.join(", ")}
Be concise and professional.`;

  const start = Date.now();

  try {
    const response = config.provider === "claude"
      ? await callClaude(config, prompt)
      : await callOpenAI(config, prompt);

    return {
      summary: typeof response === "string" ? response : response.reasoning || JSON.stringify(response),
      provider: config.provider!,
      latencyMs: Date.now() - start,
    };
  } catch {
    return {
      summary: `Market overview: ${metrics.totalAuctions} active auctions with average discount rate of ${(metrics.avgRate * 100).toFixed(2)}%. Active sectors: ${metrics.topSectors.join(", ")}.`,
      provider: "rules-engine",
      latencyMs: 0,
    };
  }
}

// ─── Provider Implementations ───────────────────────────────────────

async function callClaude(config: LLMConfig, prompt: string): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Claude API returned ${res.status}`);
    }

    const data: any = await res.json();
    const text = data.content?.[0]?.text || "";

    try {
      return JSON.parse(text);
    } catch {
      return { reasoning: text, factors: extractFactors(text) };
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function callOpenAI(config: LLMConfig, prompt: string): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`OpenAI API returned ${res.status}`);
    }

    const data: any = await res.json();
    const text = data.choices?.[0]?.message?.content || "";

    try {
      return JSON.parse(text);
    } catch {
      return { reasoning: text, factors: extractFactors(text) };
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function buildBidPrompt(
  analysis: AgentAnalysisContext,
  recentOutcomes: AuctionOutcome[],
  portfolioState: PortfolioState | null
): string {
  const history = recentOutcomes.slice(-5).map((o) =>
    `${o.sector}/${o.reliabilityScore}: bid ${(o.bidRate * 100).toFixed(2)}%, won=${o.won}, winning=${(o.winningRate * 100).toFixed(2)}%`
  ).join("\n");

  const portfolio = portfolioState
    ? `Portfolio: ${portfolioState.openPositions} positions, concentration=${portfolioState.concentrationRisk.toFixed(3)}, sectors=${JSON.stringify(portfolioState.sectorExposure)}`
    : "No existing portfolio";

  return `Analyze this invoice financing bid recommendation and provide a brief JSON response:

Invoice: ${analysis.invoiceId}
Sector: ${analysis.sector}, Rating: ${analysis.reliabilityScore}, Amount: ${analysis.amountBucket}
Payment Terms: ${analysis.paymentTermDays} days
Suggested Rate: ${(analysis.suggestedRate * 100).toFixed(2)}%
Win Probability: ${analysis.winProbability ? (analysis.winProbability * 100).toFixed(1) : "unknown"}%
Risk Score: ${analysis.riskScore}/100
Recommendation: ${analysis.recommendation}

Recent History:
${history || "No history"}

${portfolio}

Respond in JSON: {"reasoning": "2-3 sentence explanation", "factors": ["factor1", "factor2", "factor3"]}`;
}

function fallbackExplanation(analysis: AgentAnalysisContext): LLMExplanation {
  const factors: string[] = [];
  if (analysis.reliabilityScore === "A") factors.push("High reliability debtor reduces default risk");
  if (analysis.reliabilityScore === "C") factors.push("Low reliability increases risk premium");
  if (analysis.paymentTermDays <= 30) factors.push("Short payment terms reduce exposure");
  if (analysis.paymentTermDays > 60) factors.push("Extended terms increase time-value cost");
  factors.push(`${analysis.sector} sector risk profile factored in`);
  if (analysis.winProbability && analysis.winProbability > 0.5) factors.push("Favorable win probability based on historical data");

  return {
    reasoning: `Based on rules-engine analysis: ${analysis.recommendation} at ${(analysis.suggestedRate * 100).toFixed(2)}% for ${analysis.sector} sector with ${analysis.reliabilityScore}-rated debtor. Confidence: ${(analysis.confidence * 100).toFixed(0)}%.`,
    confidence: analysis.confidence,
    factors,
    provider: "rules-engine",
    latencyMs: 0,
  };
}

function extractFactors(text: string): string[] {
  // Extract bullet points or numbered items from free text
  const lines = text.split(/[\n\r]+/).filter((l) => l.trim().match(/^[-•*\d]/));
  if (lines.length > 0) return lines.slice(0, 5).map((l) => l.replace(/^[-•*\d.)\s]+/, "").trim());
  // Fallback: split into sentences
  const sentences = text.split(/[.!]/).filter((s) => s.trim().length > 10);
  return sentences.slice(0, 3).map((s) => s.trim());
}
