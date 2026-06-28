import React, { useState, useEffect, useCallback } from "react";
import { apiClient } from "../hooks/useApi";
import type { TransactionEntry, AuditEntry } from "../types";

interface Props {
  transactions: TransactionEntry[];
}

export default function TransactionLog({ transactions }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [chainIntegrity, setChainIntegrity] = useState<{ valid: boolean; brokenAt?: number } | null>(null);
  const [chainHead, setChainHead] = useState<string>("");
  const [showMode, setShowMode] = useState<"chain" | "log">("chain");

  const fetchAudit = useCallback(async () => {
    try {
      const result = await apiClient.getAuditLog();
      setAuditEntries(result.entries || []);
      setChainIntegrity(result.integrity || null);
      setChainHead(result.chainHead || "");
    } catch {
      // API may not be up
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchAudit();
      const interval = setInterval(fetchAudit, 3000);
      return () => clearInterval(interval);
    }
  }, [isOpen, fetchAudit]);

  const totalCount = showMode === "chain" ? auditEntries.length : transactions.length;

  return (
    <div className={`transaction-log ${isOpen ? "open" : "collapsed"}`}>
      <div className="tlog-header" onClick={() => setIsOpen(!isOpen)}>
        <div className="tlog-title">
          <span className="tlog-icon">{isOpen ? "\u25BC" : "\u25B2"}</span>
          <span>Cryptographic Audit Chain</span>
          <span className="tlog-count">{totalCount}</span>
          {chainIntegrity && (
            <span className={`chain-integrity ${chainIntegrity.valid ? "valid" : "broken"}`}>
              {chainIntegrity.valid ? "CHAIN VALID" : "CHAIN BROKEN"}
            </span>
          )}
        </div>
        {!isOpen && auditEntries.length > 0 && (
          <span className="tlog-latest">
            Head: {chainHead.substring(0, 12)}...
          </span>
        )}
      </div>

      {isOpen && (
        <div className="tlog-body">
          <div className="tlog-mode-switch">
            <button
              className={showMode === "chain" ? "active" : ""}
              onClick={(e) => { e.stopPropagation(); setShowMode("chain"); }}
            >
              Hash Chain ({auditEntries.length})
            </button>
            <button
              className={showMode === "log" ? "active" : ""}
              onClick={(e) => { e.stopPropagation(); setShowMode("log"); }}
            >
              Event Log ({transactions.length})
            </button>
          </div>

          {showMode === "chain" ? (
            auditEntries.length === 0 ? (
              <p className="tlog-empty">No audit entries. Create an invoice to begin.</p>
            ) : (
              <table className="tlog-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Action</th>
                    <th>Party</th>
                    <th>Prev Hash</th>
                    <th>Hash</th>
                    <th>Data</th>
                  </tr>
                </thead>
                <tbody>
                  {[...auditEntries].reverse().map((entry) => (
                    <tr key={entry.sequenceNumber}>
                      <td className="tlog-time">{entry.sequenceNumber}</td>
                      <td className="tlog-action">{entry.action}</td>
                      <td className="tlog-party">{entry.party}</td>
                      <td>
                        <code className="tlog-hash">
                          {entry.prevHash.substring(0, 8)}...
                        </code>
                      </td>
                      <td>
                        <code className="tlog-hash tlog-hash-current">
                          {entry.hash.substring(0, 8)}...
                        </code>
                      </td>
                      <td className="tlog-details">
                        {Object.entries(entry.data)
                          .map(([k, v]) => `${k}: ${typeof v === "string" && v.length > 16 ? v.substring(0, 12) + "..." : v}`)
                          .join(", ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : (
            transactions.length === 0 ? (
              <p className="tlog-empty">No transactions recorded in this session.</p>
            ) : (
              <table className="tlog-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Action</th>
                    <th>Daml Template</th>
                    <th>Party</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {[...transactions].reverse().map((tx) => (
                    <tr key={tx.id}>
                      <td className="tlog-time">{tx.timestamp}</td>
                      <td className="tlog-action">{tx.action}</td>
                      <td><code className="tlog-template">{tx.template}</code></td>
                      <td className="tlog-party">{tx.actingParty}</td>
                      <td className="tlog-details">{tx.details || "\u2014"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}
        </div>
      )}
    </div>
  );
}
