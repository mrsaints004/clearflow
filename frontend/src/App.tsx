import React, { useState, useEffect, useCallback } from "react";
import SellerView from "./components/SellerView";
import LenderView from "./components/LenderView";
import OperatorView from "./components/OperatorView";
import DebtorView from "./components/DebtorView";
import PrivacyAuditView from "./components/PrivacyAuditView";
import LivePrivacyPanel from "./components/LivePrivacyPanel";

import PrivacyBreachDemo from "./components/PrivacyBreachDemo";
import TransactionLog from "./components/TransactionLog";
import ErrorBoundary from "./components/ErrorBoundary";
import { ToastProvider } from "./components/Toast";
import { apiClient, setAuthToken, clearAuthToken } from "./hooks/useApi";
import { type TransactionEntry, type AuthSession } from "./types";
import "./App.css";

type OperatorTab = "verify" | "privacy" | "livePrivacy" | "breach";
type AuthView = "login" | "register";

const DEMO_STEPS = [
  { step: 1, role: "operator", action: "Sign in as Operator (operator-secret). Seed demo data via the script or register parties manually." },
  { step: 2, role: "seller", action: "Switch to Seller view. Create an invoice with debtor, amount, and sector. Note: only the seller sees the full invoice." },
  { step: 3, role: "operator", action: "Switch to Operator. Approve the invoice in the Verification tab." },
  { step: 4, role: "debtor", action: "Switch to Debtor view. Confirm the obligation." },
  { step: 5, role: "seller", action: "Switch back to Seller. Start a blind auction on the confirmed invoice." },
  { step: 6, role: "lender", action: "Register as LenderA. Submit a sealed bid. Note: you see only anonymized metadata (amount bucket, sector) — never the debtor name or exact amount." },
  { step: 7, role: "lender", action: "Register as LenderB. Submit a different bid. You cannot see LenderA's bid — it physically does not exist on your participant node." },
  { step: 8, role: "seller", action: "Close the auction. The lowest discount rate wins." },
  { step: 9, role: "operator", action: "Go to Breach Test tab. Select LenderA as attacker, LenderB as target. Run the simulation — all attempts are BLOCKED at the protocol level." },
  { step: 10, role: "operator", action: "Check the Privacy Audit tab to see the full visibility matrix of who can see what." },
];

function App() {
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [ledgerMode, setLedgerMode] = useState<string>("connecting...");
  const [transactions, setTransactions] = useState<TransactionEntry[]>([]);
  const [currentAuctionStatus, setCurrentAuctionStatus] = useState<"open" | "closed" | "settled" | null>(null);
  const [currentInvoiceStatus, setCurrentInvoiceStatus] = useState<"pending" | "verified" | "confirmed" | null>(null);
  const [resetting, setResetting] = useState(false);
  const [operatorTab, setOperatorTab] = useState<OperatorTab>("verify");
  const [showDemoGuide, setShowDemoGuide] = useState(true);

  // Auth form state
  const [authView, setAuthView] = useState<AuthView>("login");
  const [loginParty, setLoginParty] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [regName, setRegName] = useState("");
  const [regRole, setRegRole] = useState("seller");
  const [regPassword, setRegPassword] = useState("");
  const [regConfirm, setRegConfirm] = useState("");

  useEffect(() => {
    apiClient.getHealth().then((h: any) => setLedgerMode(h.mode)).catch(() => setLedgerMode("offline"));
  }, []);

  useEffect(() => {
    if (!authSession) return;
    const interval = setInterval(async () => {
      try {
        const auctions = await apiClient.getAuctions() as any[];
        if (auctions.length > 0) {
          setCurrentAuctionStatus(auctions[auctions.length - 1].status);
        } else {
          setCurrentAuctionStatus(null);
        }
        const invoices = await apiClient.getInvoices() as any[];
        if (invoices.length > 0) {
          setCurrentInvoiceStatus(invoices[invoices.length - 1].status || null);
        } else {
          setCurrentInvoiceStatus(null);
        }
      } catch {}
    }, 3000);
    return () => clearInterval(interval);
  }, [authSession]);

  const addTransaction = useCallback((tx: TransactionEntry) => {
    setTransactions((prev) => [...prev, tx]);
  }, []);

  const handleLogin = async (party: string, password: string) => {
    setLoggingIn(true);
    setLoginError(null);
    try {
      const res = await apiClient.login(party, password);
      setAuthToken(res.token);
      setAuthSession({
        token: res.token,
        party: res.party,
        role: res.role,
        displayName: res.party,
      });
      setOperatorTab("verify");
    } catch (e: any) {
      setLoginError(e.message || "Login failed");
    } finally {
      setLoggingIn(false);
    }
  };

  const handleRegister = async () => {
    setLoginError(null);
    if (!regName.trim() || !regPassword) {
      setLoginError("Name and password are required");
      return;
    }
    if (regPassword !== regConfirm) {
      setLoginError("Passwords do not match");
      return;
    }
    if (regPassword.length < 8) {
      setLoginError("Password must be at least 8 characters");
      return;
    }
    setLoggingIn(true);
    try {
      await apiClient.register(regName.trim(), regRole, regPassword);
      // Auto-login after registration
      await handleLogin(regName.trim(), regPassword);
    } catch (e: any) {
      setLoginError(e.message || "Registration failed");
      setLoggingIn(false);
    }
  };

  // Role switcher: defaults to the user's primary role
  const [activeView, setActiveView] = useState<string | null>(null);

  // When auth session changes, reset activeView to the user's primary role
  useEffect(() => {
    if (authSession) {
      setActiveView(authSession.role);
    }
  }, [authSession?.role]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSignOut = () => {
    clearAuthToken();
    setAuthSession(null);
    setActiveView(null);
    setTransactions([]);
    setLoginParty("");
    setLoginPassword("");
    setRegName("");
    setRegPassword("");
    setRegConfirm("");
  };

  const handleReset = async () => {
    if (!window.confirm("Clear all data? This removes all invoices, auctions, and settlements.")) return;
    setResetting(true);
    try {
      await apiClient.reset();
      setTransactions([]);
      setCurrentAuctionStatus(null);
      setCurrentInvoiceStatus(null);
      addTransaction({
        id: `reset-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString(),
        action: "Ledger Reset",
        template: "System",
        actingParty: "Operator",
        details: "All contracts archived",
      });
    } catch (e: any) {
      alert("Reset failed: " + e.message);
    } finally {
      setResetting(false);
    }
  };

  const getRoleBadgeClass = (role: string) => {
    switch (role) {
      case "seller": return "role-badge role-seller";
      case "lender": return "role-badge role-lender";
      case "operator": return "role-badge role-operator";
      case "debtor": return "role-badge role-debtor";
      default: return "role-badge";
    }
  };

  // --- Login/Register Screen ---
  if (!authSession) {
    return (
      <div className="login-screen">
        <div className="login-container">
          <div className="login-header">
            <h1 className="login-logo">ClearFlow</h1>
            <p className="login-subtitle">Sealed-Bid Auctions with Protocol-Level Privacy</p>
            <p className="login-tagline">Where competing parties physically cannot see each other's data</p>
            <span className={`ledger-badge ${ledgerMode === "canton-ledger" ? "live" : ""}`}>
              {ledgerMode === "canton-ledger" ? "CANTON LEDGER" : ledgerMode === "local-ledger" ? "LOCAL LEDGER" : ledgerMode.toUpperCase()}
            </span>
          </div>

          <div className="login-cards">
            <div className="auth-tabs">
              <button
                className={`auth-tab ${authView === "login" ? "active" : ""}`}
                onClick={() => { setAuthView("login"); setLoginError(null); }}
              >
                Sign In
              </button>
              <button
                className={`auth-tab ${authView === "register" ? "active" : ""}`}
                onClick={() => { setAuthView("register"); setLoginError(null); }}
              >
                Register
              </button>
            </div>

            {authView === "login" ? (
              <div className="auth-form">
                <label>
                  <span>Party Name</span>
                  <input
                    type="text"
                    value={loginParty}
                    onChange={(e) => setLoginParty(e.target.value)}
                    placeholder="e.g. Operator"
                    onKeyDown={(e) => e.key === "Enter" && handleLogin(loginParty, loginPassword)}
                  />
                </label>
                <label>
                  <span>Password</span>
                  <input
                    type="password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    placeholder="Enter password"
                    onKeyDown={(e) => e.key === "Enter" && handleLogin(loginParty, loginPassword)}
                  />
                </label>
                <button
                  className="btn btn-primary auth-submit"
                  onClick={() => handleLogin(loginParty, loginPassword)}
                  disabled={loggingIn || !loginParty || !loginPassword}
                >
                  {loggingIn ? "Signing in..." : "Sign In"}
                </button>
              </div>
            ) : (
              <div className="auth-form">
                <label>
                  <span>Display Name</span>
                  <input
                    type="text"
                    value={regName}
                    onChange={(e) => setRegName(e.target.value)}
                    placeholder="e.g. MyCompany"
                  />
                </label>
                <label>
                  <span>Role</span>
                  <select value={regRole} onChange={(e) => setRegRole(e.target.value)}>
                    <option value="seller">Seller</option>
                    <option value="lender">Lender</option>
                    <option value="debtor">Debtor</option>
                  </select>
                </label>
                <label>
                  <span>Password</span>
                  <input
                    type="password"
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    placeholder="Min 8 characters"
                  />
                </label>
                <label>
                  <span>Confirm Password</span>
                  <input
                    type="password"
                    value={regConfirm}
                    onChange={(e) => setRegConfirm(e.target.value)}
                    placeholder="Re-enter password"
                    onKeyDown={(e) => e.key === "Enter" && handleRegister()}
                  />
                </label>
                <button
                  className="btn btn-primary auth-submit"
                  onClick={handleRegister}
                  disabled={loggingIn || !regName || !regPassword || !regConfirm}
                >
                  {loggingIn ? "Registering..." : "Register & Sign In"}
                </button>
              </div>
            )}
          </div>

          {loginError && (
            <div className="login-error">{loginError}</div>
          )}

          <div className="login-features">
            <div className="login-feature">
              <div className="login-feature-icon privacy">P</div>
              <div className="login-feature-text">
                <span className="login-feature-title">Sub-Transaction Privacy</span>
                <span className="login-feature-desc">Data physically absent from unauthorized nodes</span>
              </div>
            </div>
            <div className="login-feature">
              <div className="login-feature-icon sealed">S</div>
              <div className="login-feature-text">
                <span className="login-feature-title">Sealed-Bid Auctions</span>
                <span className="login-feature-desc">SHA-256 commit-reveal prevents bid collusion</span>
              </div>
            </div>
            <div className="login-feature">
              <div className="login-feature-icon audit">H</div>
              <div className="login-feature-text">
                <span className="login-feature-title">Hash-Chained Audit</span>
                <span className="login-feature-desc">Tamper-evident log with integrity verification</span>
              </div>
            </div>
            <div className="login-feature">
              <div className="login-feature-icon multi">4</div>
              <div className="login-feature-text">
                <span className="login-feature-title">Multi-Party Workflow</span>
                <span className="login-feature-desc">Seller, Lender, Operator, Debtor isolation</span>
              </div>
            </div>
          </div>

          <div className="login-footer">
            <span className="canton-badge">Canton Network</span>
            <span className="login-track-badge">Build on Canton Hackathon 2026</span>
          </div>
        </div>
      </div>
    );
  }

  // --- Authenticated View ---
  const resolvedRole = activeView || authSession.role;

  const renderView = () => {
    switch (resolvedRole) {
      case "seller":
        return <SellerView partyName={authSession.party} onTransaction={addTransaction} />;
      case "lender":
        return (
          <LenderView
            partyName={authSession.party}
            label={authSession.displayName}
            color="#475569"
            onTransaction={addTransaction}
          />
        );
      case "operator":
        return (
          <>
            <nav className="operator-sub-tabs">
              <button className={operatorTab === "verify" ? "active" : ""} onClick={() => setOperatorTab("verify")}>Verification</button>
              <button className={operatorTab === "privacy" ? "active" : ""} onClick={() => setOperatorTab("privacy")}>Privacy Audit</button>
              <button className={operatorTab === "livePrivacy" ? "active" : ""} onClick={() => setOperatorTab("livePrivacy")}>Live Privacy</button>
              <button className={operatorTab === "breach" ? "active" : ""} onClick={() => setOperatorTab("breach")}>Breach Test</button>
            </nav>
            {operatorTab === "verify" && <OperatorView onTransaction={addTransaction} />}
            {operatorTab === "privacy" && <PrivacyAuditView currentStatus={currentAuctionStatus} currentInvoiceStatus={currentInvoiceStatus} />}
            {operatorTab === "livePrivacy" && <LivePrivacyPanel />}
            {operatorTab === "breach" && <PrivacyBreachDemo />}
          </>
        );
      case "debtor":
        return <DebtorView partyName={authSession.party} onTransaction={addTransaction} />;
      default:
        return <div>Unknown role</div>;
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1>ClearFlow</h1>
          <span className="subtitle">
            Sealed-Bid Auctions with Protocol-Level Privacy
          </span>
        </div>
        <div className="header-right">
          {resolvedRole === "operator" && (
            <button
              className="btn btn-reset"
              onClick={handleReset}
              disabled={resetting}
            >
              {resetting ? "Clearing..." : "New Session"}
            </button>
          )}
          <div className="account-switcher-wrapper">
            <span className="account-avatar">{authSession.displayName.charAt(0)}</span>
            <span className="account-name">{authSession.displayName}</span>
            <span className={getRoleBadgeClass(authSession.role)}>{authSession.role}</span>
            <button className="btn btn-secondary" onClick={handleSignOut} style={{ marginLeft: 8 }}>
              Sign Out
            </button>
          </div>
          <span className={`ledger-badge ${ledgerMode === "canton-ledger" ? "live" : ""}`}>
            {ledgerMode === "canton-ledger" ? "CANTON LEDGER" : ledgerMode === "local-ledger" ? "LOCAL LEDGER" : ledgerMode.toUpperCase()}
          </span>
          <span className="canton-badge">Canton Network</span>
        </div>
      </header>

      {authSession.role !== "operator" && (
        <div className="role-switcher">
          <span className="role-switcher-hint">View as:</span>
          {(["seller", "lender", "debtor"] as const).map((r) => (
            <button
              key={r}
              className={`role-switcher-btn ${resolvedRole === r ? "active" : ""}`}
              onClick={() => setActiveView(r)}
            >
              {r.charAt(0).toUpperCase() + r.slice(1)}
              {r === authSession.role && <span className="role-switcher-primary">primary</span>}
            </button>
          ))}
        </div>
      )}

      {showDemoGuide && (
        <div className="demo-guide">
          <div className="demo-guide-header">
            <div className="demo-guide-title">
              <span className="demo-guide-icon">Demo Walkthrough</span>
              <span className="demo-guide-hint">Follow these steps to see Canton's privacy model in action</span>
            </div>
            <button className="demo-guide-close" onClick={() => setShowDemoGuide(false)}>Dismiss</button>
          </div>
          <div className="demo-guide-steps">
            {DEMO_STEPS.map((s) => (
              <div key={s.step} className={`demo-step ${s.role === (activeView || authSession.role) ? "current" : ""}`}>
                <span className="demo-step-number">{s.step}</span>
                <span className={`demo-step-role role-${s.role}`}>{s.role}</span>
                <span className="demo-step-action">{s.action}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <main className="main-content single-view">
        {renderView()}
      </main>

      <TransactionLog transactions={transactions} />
    </div>
  );
}

function WrappedApp() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ErrorBoundary>
  );
}

export default WrappedApp;
