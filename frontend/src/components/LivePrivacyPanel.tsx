import React, { useState, useEffect, useCallback } from "react";
import { apiClient } from "../hooks/useApi";
import { useToast } from "./Toast";

interface PrivacyScopeData {
  party: string;
  role: string;
  visibleData: Record<string, any>;
}

export default function LivePrivacyPanel() {
  const { addToast } = useToast();
  const [partyList, setPartyList] = useState<Array<{ key: string; name: string; role: string }>>([]);
  const [selectedParty, setSelectedParty] = useState("");
  const [scopeData, setScopeData] = useState<PrivacyScopeData | null>(null);
  const [allScopes, setAllScopes] = useState<Map<string, PrivacyScopeData>>(new Map());
  const [compareMode, setCompareMode] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    apiClient.getParties().then((data) => {
      const list = data.map((p, i) => ({
        key: `${p.role}-${i}`,
        name: p.displayName,
        role: p.role.charAt(0).toUpperCase() + p.role.slice(1),
      }));
      setPartyList(list);
      if (list.length > 0 && !selectedParty) {
        setSelectedParty(list[0].name);
      }
    }).catch((e: any) => { addToast("error", e.message || "Failed to load parties"); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchScope = useCallback(async (party: string) => {
    try {
      const data = await apiClient.getPrivacyScope(party);
      return data as PrivacyScopeData;
    } catch {
      return null;
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      const results = await Promise.all(
        partyList.map(async (p) => {
          const data = await fetchScope(p.name);
          return [p.name, data] as const;
        })
      );
      const map = new Map<string, PrivacyScopeData>();
      for (const [name, data] of results) {
        if (data) map.set(name, data);
      }
      setAllScopes(map);
      if (map.has(selectedParty)) {
        setScopeData(map.get(selectedParty)!);
      }
    } finally {
      setLoading(false);
    }
  }, [fetchScope, selectedParty, partyList]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refreshAll();
    const interval = setInterval(refreshAll, 4000);
    return () => clearInterval(interval);
  }, [refreshAll]);

  useEffect(() => {
    if (allScopes.has(selectedParty)) {
      setScopeData(allScopes.get(selectedParty)!);
    }
  }, [selectedParty, allScopes]);

  const renderValue = (value: any, depth = 0): React.ReactNode => {
    if (typeof value === "string") {
      const isDenied = value.includes("ACCESS DENIED");
      return (
        <span className={isDenied ? "privacy-denied" : "privacy-allowed"}>
          {isDenied ? "\u26D4 " : ""}{value}
        </span>
      );
    }
    if (Array.isArray(value)) {
      if (value.length === 0) return <span className="privacy-empty">[] (empty)</span>;
      return (
        <div className="privacy-array">
          {value.map((item, i) => (
            <div key={i} className="privacy-array-item">
              {typeof item === "object" ? renderObject(item, depth + 1) : renderValue(item, depth + 1)}
            </div>
          ))}
        </div>
      );
    }
    if (typeof value === "object" && value !== null) {
      return renderObject(value, depth + 1);
    }
    return <span>{String(value)}</span>;
  };

  const renderObject = (obj: Record<string, any>, depth = 0): React.ReactNode => {
    return (
      <div className={`privacy-object ${depth > 0 ? "nested" : ""}`}>
        {Object.entries(obj).map(([k, v]) => (
          <div key={k} className="privacy-field">
            <span className="privacy-key">{k}:</span>
            {renderValue(v, depth)}
          </div>
        ))}
      </div>
    );
  };

  const countVisible = (data: Record<string, any>): { visible: number; denied: number } => {
    let visible = 0, denied = 0;
    for (const v of Object.values(data)) {
      if (typeof v === "string" && v.includes("ACCESS DENIED")) denied++;
      else if (Array.isArray(v)) visible += v.length;
      else visible++;
    }
    return { visible, denied };
  };

  return (
    <div className="live-privacy-panel">
      <div className="view-header">
        <h2>Live Privacy Proof</h2>
        <span className="role-badge" style={{ background: "#1e3a5f" }}>Real-Time</span>
      </div>

      <p className="audit-intro">
        Switch between parties to see exactly what data each participant can access right now.
        Data sections marked ACCESS DENIED physically do not exist on that party's Canton node.
      </p>

      <div className="privacy-controls">
        <div className="privacy-party-selector">
          {partyList.map((p) => {
            const scope = allScopes.get(p.name);
            const stats = scope ? countVisible(scope.visibleData) : null;
            return (
              <button
                key={p.key}
                className={`privacy-party-btn ${selectedParty === p.name ? "active" : ""}`}
                onClick={() => setSelectedParty(p.name)}
              >
                <span className="party-btn-name">{p.name}</span>
                <span className="party-btn-role">{p.role}</span>
                {stats && (
                  <span className="party-btn-stats">
                    {stats.denied > 0 && <span className="stat-denied">{stats.denied} denied</span>}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <button
          className={`btn btn-secondary compare-toggle ${compareMode ? "active" : ""}`}
          onClick={() => setCompareMode(!compareMode)}
        >
          {compareMode ? "Single View" : "Compare All"}
        </button>
      </div>

      {loading && !scopeData && <p className="empty">Loading privacy scopes...</p>}

      {!compareMode && scopeData && (
        <div className="privacy-scope-view">
          <div className="scope-header">
            <h3>Viewing as: {scopeData.party}</h3>
            <span className="scope-role-badge">{scopeData.role}</span>
          </div>
          <div className="scope-sections">
            {Object.entries(scopeData.visibleData).map(([section, data]) => (
              <div key={section} className="scope-section">
                <h4 className="scope-section-title">{section}</h4>
                <div className="scope-section-content">
                  {renderValue(data)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {compareMode && (
        <div className="privacy-compare-grid">
          {partyList.map((p) => {
            const scope = allScopes.get(p.name);
            if (!scope) return null;
            return (
              <div key={p.key} className="compare-column">
                <div className="compare-column-header">
                  <strong>{p.name}</strong>
                  <span className="scope-role-badge">{scope.role}</span>
                </div>
                <div className="compare-column-body">
                  {Object.entries(scope.visibleData).map(([section, data]) => {
                    const isDenied = typeof data === "string" && data.includes("ACCESS DENIED");
                    return (
                      <div key={section} className={`compare-section ${isDenied ? "denied" : "allowed"}`}>
                        <span className="compare-section-label">{section}</span>
                        {isDenied ? (
                          <span className="privacy-denied-compact">{"\u26D4"} DENIED</span>
                        ) : Array.isArray(data) ? (
                          <span className="privacy-count">{data.length} records</span>
                        ) : (
                          <span className="privacy-count">Visible</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
