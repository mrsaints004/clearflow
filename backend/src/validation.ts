import { z } from "zod";
import type { Request, Response, NextFunction } from "express";

// ─── Schemas ────────────────────────────────────────────────────────

export const LoginSchema = z.object({
  party: z
    .string()
    .min(1, "Party name is required")
    .max(50, "Party name must be 50 characters or fewer")
    .regex(/^[a-zA-Z0-9_-]+$/, "Party name must be alphanumeric with hyphens/underscores"),
  password: z
    .string()
    .min(1, "Password is required")
    .max(128, "Password must be 128 characters or fewer"),
});

export const RegisterSchema = z.object({
  displayName: z
    .string()
    .min(1, "Display name is required")
    .max(50, "Display name must be 50 characters or fewer")
    .regex(/^[a-zA-Z0-9_-]+$/, "Display name must be alphanumeric with hyphens/underscores"),
  role: z.enum(["seller", "lender", "debtor", "operator"], {
    error: "Role must be 'seller', 'lender', 'debtor', or 'operator'",
  }),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password must be 128 characters or fewer"),
});

export const InvoiceCreateSchema = z.object({
  invoiceId: z
    .string()
    .min(1, "Invoice ID is required")
    .max(50, "Invoice ID must be 50 characters or fewer")
    .regex(/^[a-zA-Z0-9\-_]+$/, "Invoice ID must be alphanumeric with hyphens/underscores"),
  seller: z.string().min(1, "Seller is required"),
  debtor: z
    .string()
    .min(1, "Debtor is required")
    .max(100, "Debtor name must be 100 characters or fewer"),
  amount: z
    .number({ error: "Amount must be a number" })
    .positive("Amount must be positive")
    .max(100_000_000, "Amount must be at most 100,000,000"),
  currency: z
    .string()
    .length(3, "Currency must be a 3-letter code")
    .default("USD"),
  sector: z.string().min(1, "Sector is required").default("Manufacturing"),
  paymentTermDays: z
    .number()
    .int()
    .min(1, "Payment terms must be at least 1 day")
    .max(365, "Payment terms must be at most 365 days")
    .default(30),
  issueDate: z.string().optional(),
  dueDate: z.string().optional(),
  reliabilityScore: z.enum(["A", "B", "C"]).default("B"),
});

export const BidSubmitSchema = z.object({
  lender: z.string().min(1, "Lender is required"),
  invoiceId: z
    .string()
    .min(1, "Invoice ID is required")
    .max(50, "Invoice ID must be 50 characters or fewer"),
  discountRate: z
    .number({ error: "Discount rate must be a number" })
    .gt(0, "Discount rate must be greater than 0")
    .lt(1, "Discount rate must be less than 1")
    .refine(
      (val) => Number(val.toFixed(4)) === val,
      "Discount rate must have at most 4 decimal places"
    ),
});

export const BidRevealSchema = z.object({
  lender: z.string().min(1, "Lender is required"),
  discountRate: z
    .number({ error: "Discount rate must be a number" })
    .gt(0, "Discount rate must be greater than 0")
    .lt(1, "Discount rate must be less than 1")
    .refine(
      (val) => Number(val.toFixed(4)) === val,
      "Discount rate must have at most 4 decimal places"
    ),
  nonce: z
    .string()
    .min(1, "Nonce is required")
    .max(64, "Nonce must be 64 characters or fewer")
    .regex(/^[a-f0-9]+$/i, "Nonce must be a hex string"),
});

export const AuctionCreateSchema = z.object({
  invoiceId: z
    .string()
    .min(1, "Invoice ID is required"),
});

export const DisputeSchema = z.object({
  reason: z
    .string()
    .min(1, "Dispute reason is required")
    .max(500, "Dispute reason must be 500 characters or fewer"),
});

export const ResolveDisputeSchema = z.object({
  resolution: z.enum(["upheld", "rejected"], {
    error: "Resolution must be 'upheld' or 'rejected'",
  }),
});

export const AgentCreateSchema = z.object({
  name: z.string().min(1, "Agent name is required").max(50),
  party: z.string().min(1, "Party is required").max(50),
  strategy: z.enum(["value", "volume", "selective", "adaptive"], {
    error: "Strategy must be 'value', 'volume', 'selective', or 'adaptive'",
  }),
  riskTolerance: z
    .enum(["conservative", "moderate", "aggressive"])
    .default("moderate"),
  maxDiscountRate: z.number().gt(0).lt(1).default(0.10),
  minDiscountRate: z.number().gte(0).lt(1).default(0.005),
  autoBid: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

export const AgentConfigureSchema = z.object({
  strategy: z.enum(["value", "volume", "selective", "adaptive"]).optional(),
  riskTolerance: z.enum(["conservative", "moderate", "aggressive"]).optional(),
  maxDiscountRate: z.number().gt(0).lt(1).optional(),
  minDiscountRate: z.number().gte(0).lt(1).optional(),
  autoBid: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

export const PortfolioCreateSchema = z.object({
  invoiceIds: z
    .array(z.string().min(1))
    .min(2, "Need at least 2 invoice IDs")
    .max(50, "Portfolio can contain at most 50 invoices"),
  seller: z.string().min(1, "Seller is required"),
});

export const SettleSchema = z.object({
  invoiceId: z.string().min(1, "Invoice ID is required"),
  lender: z.string().min(1, "Lender is required"),
});

export const PortfolioBidSchema = z.object({
  lender: z.string().min(1, "Lender is required"),
  discountRate: z
    .number()
    .gt(0, "Discount rate must be greater than 0")
    .lt(1, "Discount rate must be less than 1"),
});

export const PortfolioSettleSchema = z.object({
  lender: z.string().min(1, "Lender is required"),
});

export const PortfolioCloseSchema = z.object({
  seller: z.string().min(1, "Seller is required"),
});

export const AuctionCloseSchema = z.object({
  seller: z.string().min(1, "Seller is required"),
});

export const AgentAnalyzeSchema = z.object({
  invoiceId: z.string().optional(),
});

export const AgentAutoBidSchema = z.object({
  invoiceId: z.string().min(1, "Invoice ID is required"),
});

export const BreachTestSchema = z.object({
  attackerParty: z.string().min(1, "Attacker party is required"),
  targetParty: z.string().min(1, "Target party is required"),
  targetData: z.string().optional(),
});

// ─── Middleware Factory ─────────────────────────────────────────────

export function validate(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const issues = result.error.issues;
      const fieldErrors = issues.map((e: any) => ({
        field: e.path.join("."),
        message: e.message,
      }));
      res.status(400).json({
        error: "Validation failed",
        details: fieldErrors,
      });
      return;
    }
    req.body = result.data;
    next();
  };
}
