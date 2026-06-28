const API_BASE = process.env.REACT_APP_API_URL || "http://localhost:3002/api";

let authToken: string | null = null;

export function setAuthToken(token: string) {
  authToken = token;
}

export function clearAuthToken() {
  authToken = null;
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    headers,
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export const apiClient = {
  // Auth
  login: (party: string, password: string) =>
    api<{ token: string; party: string; role: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ party, password }),
    }),

  // Registration
  register: (displayName: string, role: string, password: string) =>
    api<{ displayName: string; role: string; registeredAt: string }>("/parties/register", {
      method: "POST",
      body: JSON.stringify({ displayName, role, password }),
    }),

  // Parties
  getParties: () =>
    api<Array<{ displayName: string; role: string; partyId: string; registeredAt?: string }>>("/parties"),

  // Health
  getHealth: () => api<any>("/health"),

  // Invoices
  createInvoice: (data: any) =>
    api("/invoices", { method: "POST", body: JSON.stringify(data) }),
  getInvoices: (seller?: string) =>
    api<any[]>(`/invoices${seller ? `?seller=${seller}` : ""}`),

  // Auctions
  createAuction: (invoiceId: string) =>
    api("/auctions", { method: "POST", body: JSON.stringify({ invoiceId }) }),
  getAuctions: () => api<any[]>("/auctions"),
  getAuction: (invoiceId: string, party: string, role: string) =>
    api<any>(`/auctions/${invoiceId}?party=${party}&role=${role}`),
  closeAuction: (invoiceId: string, seller: string) =>
    api(`/auctions/${invoiceId}/close`, {
      method: "POST",
      body: JSON.stringify({ seller }),
    }),

  // Bids
  submitBid: (lender: string, invoiceId: string, discountRate: number) =>
    api("/bids", {
      method: "POST",
      body: JSON.stringify({ lender, invoiceId, discountRate }),
    }),

  // Settlements
  settle: (invoiceId: string, lender: string) =>
    api("/settlements", {
      method: "POST",
      body: JSON.stringify({ invoiceId, lender }),
    }),
  getSettlement: (invoiceId: string, party: string) =>
    api<any>(`/settlements/${invoiceId}?party=${party}`),
  getSettlements: () => api<any[]>("/settlements"),

  // Invoice approval / confirmation
  approveInvoice: (invoiceId: string) =>
    api(`/invoices/${invoiceId}/approve`, { method: "POST" }),
  confirmInvoice: (invoiceId: string) =>
    api(`/invoices/${invoiceId}/confirm`, { method: "POST" }),

  // Payment notifications
  getPaymentNotifications: (debtor?: string) =>
    api<any[]>(`/payment-notifications${debtor ? `?debtor=${debtor}` : ""}`),

  // Audit chain
  getAuditLog: () => api<any>("/audit-log"),
  verifyAuditChain: () => api<any>("/audit-log/verify"),

  // Privacy scope
  getPrivacyScope: (party: string) => api<any>(`/privacy-scope/${party}`),

  // Risk scoring
  getRiskScore: (invoiceId: string) => api<any>(`/risk-score/${invoiceId}`),

  // Disputes
  disputeInvoice: (invoiceId: string, reason: string) =>
    api(`/invoices/${invoiceId}/dispute`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  resolveDispute: (invoiceId: string, resolution: "upheld" | "rejected") =>
    api(`/invoices/${invoiceId}/resolve-dispute`, {
      method: "POST",
      body: JSON.stringify({ resolution }),
    }),

  // Portfolio auctions
  createPortfolioAuction: (invoiceIds: string[], seller: string) =>
    api("/portfolio-auctions", {
      method: "POST",
      body: JSON.stringify({ invoiceIds, seller }),
    }),
  getPortfolioAuctions: () => api<any[]>("/portfolio-auctions"),
  getPortfolioAuction: (portfolioId: string, party?: string, role?: string) =>
    api<any>(`/portfolio-auctions/${portfolioId}${party ? `?party=${party}&role=${role || "seller"}` : ""}`),
  submitPortfolioBid: (lender: string, portfolioId: string, discountRate: number) =>
    api(`/portfolio-auctions/${portfolioId}/bid`, {
      method: "POST",
      body: JSON.stringify({ lender, discountRate }),
    }),
  closePortfolioAuction: (portfolioId: string, seller: string) =>
    api(`/portfolio-auctions/${portfolioId}/close`, {
      method: "POST",
      body: JSON.stringify({ seller }),
    }),
  settlePortfolio: (portfolioId: string, lender: string) =>
    api(`/portfolio-auctions/${portfolioId}/settle`, {
      method: "POST",
      body: JSON.stringify({ lender }),
    }),

  // Agents (automated bidding)
  getAgents: () => api<any[]>("/agents"),
  getAgent: (name: string) => api<any>(`/agents/${name}`),
  configureAgent: (name: string, config: any) =>
    api(`/agents/${name}/configure`, {
      method: "POST",
      body: JSON.stringify(config),
    }),
  agentAnalyze: (agentName: string, invoiceId?: string) =>
    api(`/agents/${agentName}/analyze`, {
      method: "POST",
      body: JSON.stringify({ invoiceId }),
    }),
  agentAutoBid: (agentName: string, invoiceId: string) =>
    api(`/agents/${agentName}/auto-bid`, {
      method: "POST",
      body: JSON.stringify({ invoiceId }),
    }),
  getAgentActions: (agentName: string) => api<any[]>(`/agents/${agentName}/actions`),
  getAgentPerformance: (agentName: string) => api<any>(`/agents/${agentName}/performance`),
  getAgentPortfolioState: (agentName: string) => api<any>(`/agents/${agentName}/portfolio-state`),

  // Privacy breach test
  privacyBreachTest: (attackerParty: string, targetParty: string, targetData?: string) =>
    api("/privacy-breach-test", {
      method: "POST",
      body: JSON.stringify({ attackerParty, targetParty, targetData }),
    }),

  // Reset
  reset: () => api("/reset", { method: "POST" }),
};
