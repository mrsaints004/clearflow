import React, { useState, useEffect } from "react";
import { apiClient } from "../hooks/useApi";
import type { RegisteredParty } from "../types";

export default function PrivacyBreachDemo() {
  const [parties, setParties] = useState<RegisteredParty[]>([]);
  const [attacker, setAttacker] = useState("");
  const [target, setTarget] = useState("");
  const [results, setResults] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [animating, setAnimating] = useState(false);

  useEffect(() => {
    apiClient.getParties().then((data) => {
      setParties(data);
      const lenders = data.filter((p) => p.role === "lender");
      const sellers = data.filter((p) => p.role === "seller");
      if (lenders.length > 0) setAttacker(lenders[0].displayName);
      if (lenders.length > 1) setTarget(lenders[1].displayName);
      else if (sellers.length > 0) setTarget(sellers[0].displayName);
    }).catch(() => {});
  }, []);

  const attackerOptions = parties.filter((p) => p.role !== "operator");
  const targetOptions = parties.filter((p) => p.role !== "operator");

  const runTest = async () => {
    setLoading(true);
    setAnimating(true);
    setResults(null);

    try {
      const data = await apiClient.privacyBreachTest(attacker, target);
      setResults(data);
    } catch (e: any) {
      setResults({ error: e.message });
    } finally {
      setLoading(false);
      setTimeout(() => setAnimating(false), 500);
    }
  };

  return (
    <div className="view breach-view" style={{ borderTopColor: "#dc2626" }}>
      <div className="view-header">
        <h2>Privacy Breach Simulation</h2>
        <span className="role-badge" style={{ background: "#dc2626" }}>
          Security Test
        </span>
      </div>

      <div className="card breach-setup-card">
        <div className="card-title">Configure Attack Scenario</div>
        <p className="breach-description">
          Simulate an unauthorized party attempting to access another party's private data.
          Canton's sub-transaction privacy ensures data physically does not exist on
          unauthorized participant nodes.
        </p>

        <div className="breach-config">
          <div className="breach-field">
            <label>Attacker (unauthorized party)</label>
            <select value={attacker} onChange={(e) => setAttacker(e.target.value)}>
              {attackerOptions.map((p) => (
                <option key={p.displayName} value={p.displayName}>
                  {p.displayName} ({p.role})
                </option>
              ))}
            </select>
          </div>
          <div className="breach-arrow">
            {animating ? (
              <span className="breach-blocked">BLOCKED</span>
            ) : (
              <span>tries to access</span>
            )}
          </div>
          <div className="breach-field">
            <label>Target (data owner)</label>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {targetOptions.map((p) => (
                <option key={p.displayName} value={p.displayName}>
                  {p.displayName} ({p.role})
                </option>
              ))}
            </select>
          </div>
        </div>

        <button
          onClick={runTest}
          className="btn btn-danger"
          disabled={loading || attacker === target || !attacker || !target}
          style={{ marginTop: 16 }}
        >
          {loading ? "Simulating Attack..." : "Simulate Privacy Breach"}
        </button>
      </div>

      {results && !results.error && (
        <div className="card breach-results-card">
          <div className="card-title">
            {results.allBlocked ? (
              <span className="breach-result-pass">ALL ATTEMPTS BLOCKED</span>
            ) : (
              <span className="breach-result-fail">BREACH DETECTED</span>
            )}
          </div>

          <div className="breach-mode">
            Mode: <strong>{results.mode}</strong>
          </div>

          {results.results.map((r: any, i: number) => (
            <div key={i} className={`breach-attempt breach-${r.result.toLowerCase()}`}>
              <div className="attempt-header">
                <span className={`attempt-result result-${r.result.toLowerCase()}`}>
                  {r.result}
                </span>
                <span className="attempt-description">{r.attempt}</span>
              </div>
              <div className="attempt-reason">{r.reason}</div>
              <div className="attempt-data">
                <span className="data-label">Data returned:</span>
                <span className="data-value">{r.dataReturned}</span>
              </div>
              <div className="attempt-protection">
                Protection level: <strong>{r.protectionLevel}</strong>
                {r.protectionLevel === "protocol" && (
                  <span className="protection-badge">Canton Protocol Enforced</span>
                )}
              </div>
            </div>
          ))}

          <div className="breach-explanation">
            <h4>How Canton Prevents This</h4>
            <p>{results.explanation}</p>
          </div>
        </div>
      )}

      {!results && (
        <div className="card breach-info-card">
          <div className="card-title">Canton Privacy Architecture</div>
          <div className="privacy-layers">
            <div className="privacy-layer">
              <div className="layer-number">1</div>
              <div className="layer-content">
                <strong>Separate Participant Nodes</strong>
                <p>Each party runs on an isolated Canton participant. No shared state.</p>
              </div>
            </div>
            <div className="privacy-layer">
              <div className="layer-number">2</div>
              <div className="layer-content">
                <strong>Signatory/Observer Model</strong>
                <p>Contracts are only delivered to nodes hosting signatories or observers.</p>
              </div>
            </div>
            <div className="privacy-layer">
              <div className="layer-number">3</div>
              <div className="layer-content">
                <strong>Sub-Transaction Privacy</strong>
                <p>Each step in a transaction is only visible to involved parties. No global ledger.</p>
              </div>
            </div>
            <div className="privacy-layer">
              <div className="layer-number">4</div>
              <div className="layer-content">
                <strong>Data Non-Existence</strong>
                <p>Unauthorized data doesn't just have access controls — it physically
                doesn't exist on the unauthorized node.</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
