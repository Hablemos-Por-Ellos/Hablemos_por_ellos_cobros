import { z } from "zod";
import type { AdminDemoState, DemoPayment, DemoPaymentStatus } from "@/lib/admin-demo-data";

export type AdminPaymentStatus = DemoPaymentStatus | "review";
export type AdminDataState = Omit<AdminDemoState, "payments"> & {
  payments: (Omit<DemoPayment, "status"> & { status: AdminPaymentStatus })[];
};

export const confirmedSubscriptionSchema = z.object({ subscription: z.object({
  id: z.string().uuid(), amount: z.number().int().min(1500).max(21474836),
  status: z.enum(["active", "cancelled", "past_due", "pending"]),
  preferred_payment_day: z.union([z.literal(1), z.literal(6), z.literal(16), z.literal(28)]).nullable(),
  next_payment_date: z.string().nullable(), billing_version: z.number().int().min(0),
}) });

export const confirmedRecoverySchema = z.object({ recovery: z.object({
  result: z.enum(["recovered", "duplicate", "review"]), attemptId: z.string().uuid(),
  transactionId: z.string().min(1), providerStatus: z.string().nullable(), state: z.string(),
}), needsReview: z.boolean().optional() });

export const adminLogoutResultSchema = z.object({
  ok: z.boolean(), jwtRevocationConfirmed: z.boolean(), authSignOutConfirmed: z.boolean(), cookiesCleared: z.boolean(),
  message: z.string(),
});
