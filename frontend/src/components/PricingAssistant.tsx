import React, { useMemo } from "react";
import type { InvoiceMetadata } from "../types";

interface Props {
  metadata: InvoiceMetadata;
  onUseRate: (rate: string) => void;
}

interface RiskFactor {
  label: string;
  adjustment: number;
  explanation: string;
}

function computeRiskFactors(metadata: InvoiceMetadata): RiskFactor[] {
  const factors: RiskFactor[] = [];

  // Base rate
  factors.push({
    label: "Base Rate",
    adjustment: 2.0,
    explanation: "Market baseline for invoice financing",
  });

  // Sector adjustment
  const sectorMap: Record<string, number> = {
    Manufacturing: -0.5,
    Healthcare: -0.3,
    Technology: 0.5,
    Retail: 0.3,
    Construction: 0.7,
  };
  const sectorAdj = sectorMap[metadata.sector] ?? 0;
  factors.push({
    label: `Sector: ${metadata.sector}`,
    adjustment: sectorAdj,
    explanation: sectorAdj < 0
      ? "Lower risk sector, reduces premium"
      : sectorAdj > 0
        ? "Higher volatility sector, increases premium"
        : "Neutral sector adjustment",
  });

  // Term premium
  const termAdj = (metadata.paymentTermDays - 30) * 0.01;
  factors.push({
    label: `Term: Net ${metadata.paymentTermDays}`,
    adjustment: parseFloat(termAdj.toFixed(2)),
    explanation: metadata.paymentTermDays > 30
      ? "Longer payment terms increase time-value cost"
      : "Standard 30-day terms, no adjustment",
  });

  // Rating adjustment
  const ratingMap: Record<string, number> = { A: -1.0, B: 0, C: 1.0 };
  const ratingAdj = ratingMap[metadata.reliabilityScore] ?? 0;
  factors.push({
    label: `Debtor Rating: ${metadata.reliabilityScore}`,
    adjustment: ratingAdj,
    explanation: ratingAdj < 0
      ? "High reliability debtor, lower default risk"
      : ratingAdj > 0
        ? "Lower rated debtor, higher default risk"
        : "Average debtor reliability",
  });

  return factors;
}

function getRiskLevel(rate: number): { level: string; color: string; width: string } {
  if (rate <= 1.5) return { level: "Low", color: "#10b981", width: "25%" };
  if (rate <= 3.0) return { level: "Medium", color: "#f59e0b", width: "55%" };
  return { level: "High", color: "#ef4444", width: "85%" };
}

export default function PricingAssistant({ metadata, onUseRate }: Props) {
  const factors = useMemo(() => computeRiskFactors(metadata), [metadata]);
  const suggestedRate = useMemo(
    () => Math.max(0.1, factors.reduce((sum, f) => sum + f.adjustment, 0)),
    [factors]
  );
  const annualizedYield = (suggestedRate / metadata.paymentTermDays) * 365;
  const risk = getRiskLevel(suggestedRate);

  return (
    <div className="pricing-assistant">
      <div className="pa-header">
        <h4>Pricing Assistant</h4>
        <span className="pa-badge">Risk Model</span>
      </div>

      {/* Risk factors */}
      <div className="pa-factors">
        {factors.map((f, i) => (
          <div key={i} className="pa-factor-row">
            <span className="pa-factor-label">{f.label}</span>
            <span className={`pa-factor-value ${f.adjustment >= 0 ? "positive" : "negative"}`}>
              {f.adjustment >= 0 ? "+" : ""}{f.adjustment.toFixed(2)}%
            </span>
          </div>
        ))}
        <div className="pa-factor-row total">
          <span className="pa-factor-label">Suggested Rate</span>
          <span className="pa-factor-value">{suggestedRate.toFixed(2)}%</span>
        </div>
      </div>

      {/* Risk gauge */}
      <div className="pa-risk-gauge">
        <div className="pa-gauge-label">
          Risk Level: <strong style={{ color: risk.color }}>{risk.level}</strong>
        </div>
        <div className="pa-gauge-track">
          <div className="pa-gauge-fill" style={{ width: risk.width, background: risk.color }} />
        </div>
      </div>

      {/* Yield calculator */}
      <div className="pa-yield">
        <div className="pa-yield-item">
          <span className="pa-yield-label">Annualized Yield</span>
          <span className="pa-yield-value">{annualizedYield.toFixed(1)}%</span>
        </div>
        <div className="pa-yield-item">
          <span className="pa-yield-label">Payment Terms</span>
          <span className="pa-yield-value">Net {metadata.paymentTermDays}</span>
        </div>
      </div>

      <button
        className="btn btn-primary pa-use-btn"
        onClick={() => onUseRate(suggestedRate.toFixed(1))}
      >
        Use Suggested Rate ({suggestedRate.toFixed(1)}%)
      </button>
    </div>
  );
}
