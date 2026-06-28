import crypto from "crypto";
import bcrypt from "bcryptjs";
import type { Request, Response, NextFunction } from "express";
import { loadPasswordHashes, savePasswordHashes } from "./persistence";

const IS_PRODUCTION = process.env.NODE_ENV === "production";

const APP_SECRET = process.env.APP_SECRET || (
  IS_PRODUCTION ? "" : "clearflow-dev-secret-do-not-use-in-production"
);
const TOKEN_EXPIRY_HOURS = 24;

// Dynamic password store: party -> bcrypt hash
const passwordHashes: Map<string, string> = new Map();

// Load persisted hashes from disk
function loadPersistedPasswords(): void {
  const stored = loadPasswordHashes();
  for (const [party, hash] of Object.entries(stored)) {
    passwordHashes.set(party, hash);
  }
}

// Seed Operator password on startup
function seedOperatorPassword(): void {
  if (passwordHashes.has("Operator")) return;
  const operatorPw = process.env.OPERATOR_PASSWORD || (IS_PRODUCTION ? "" : "operator-secret");
  if (operatorPw) {
    const hash = bcrypt.hashSync(operatorPw, 10);
    passwordHashes.set("Operator", hash);
    persistPasswords();
  }
}

function persistPasswords(): void {
  const obj: Record<string, string> = {};
  for (const [party, hash] of passwordHashes) {
    obj[party] = hash;
  }
  savePasswordHashes(obj);
}

// Initialize on module load
loadPersistedPasswords();
seedOperatorPassword();

export function registerPartyPassword(party: string, password: string): void {
  const hash = bcrypt.hashSync(password, 10);
  passwordHashes.set(party, hash);
  persistPasswords();
}

function base64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64urlDecode(str: string): string {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
}

export function signAppToken(party: string, role: string): string {
  const header = base64url('{"alg":"HS256","typ":"JWT"}');
  const payload = base64url(
    JSON.stringify({
      sub: party,
      role,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_HOURS * 3600,
    })
  );
  const signature = base64url(
    crypto.createHmac("sha256", APP_SECRET).update(`${header}.${payload}`).digest()
  );
  return `${header}.${payload}.${signature}`;
}

export function verifyAppToken(token: string): { sub: string; role: string } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [header, payload, signature] = parts;

    // Verify signature
    const expected = base64url(
      crypto.createHmac("sha256", APP_SECRET).update(`${header}.${payload}`).digest()
    );
    if (signature !== expected) return null;

    // Decode and check expiry
    const data = JSON.parse(base64urlDecode(payload));
    if (data.exp && data.exp < Math.floor(Date.now() / 1000)) return null;

    return { sub: data.sub, role: data.role };
  } catch {
    return null;
  }
}

export function authenticateParty(party: string, password: string): boolean {
  const hash = passwordHashes.get(party);
  if (!hash) return false;
  return bcrypt.compareSync(password, hash);
}

declare global {
  namespace Express {
    interface Request {
      authenticatedParty?: string;
      authenticatedRole?: string;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    if (process.env.REQUIRE_AUTH === "true") {
      res.status(401).json({ error: "Authentication required. Call POST /api/auth/login first." });
      return;
    }
    next();
    return;
  }

  const token = authHeader.substring(7);
  const verified = verifyAppToken(token);

  if (!verified) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  req.authenticatedParty = verified.sub;
  req.authenticatedRole = verified.role;
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.authenticatedParty) {
    res.status(401).json({ error: "Authentication required. Call POST /api/auth/login first." });
    return;
  }
  next();
}

export function authorizeParty(getParty: (req: Request) => string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.authenticatedParty) {
      // If auth is not enforced, allow through
      if (process.env.REQUIRE_AUTH !== "true") {
        next();
        return;
      }
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const requestedParty = getParty(req);
    if (requestedParty && requestedParty !== req.authenticatedParty) {
      res.status(403).json({ error: `Not authorized to act as ${requestedParty}` });
      return;
    }

    next();
  };
}
