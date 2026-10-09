import { z } from "zod";

export const donorFormSchema = z.object({
  firstName: z.string().min(2, "Ingresa al menos 2 caracteres").max(100),
  lastName: z.string().min(2, "Ingresa al menos 2 caracteres").max(100),
  email: z.string().email("Correo inválido").max(254),
  phone: z
    .string()
    .min(10, "Incluye indicativo y número completo")
    .max(25)
    .regex(/^[0-9+\-\s]+$/, "Solo números y símbolos + -"),
  documentType: z.enum(["CC", "CE", "PA", "NIT"]),
  documentNumber: z.string().min(5, "Documento demasiado corto").max(50),
  city: z.string().min(2, "Ciudad inválida").max(100),
  wantsUpdates: z.boolean().default(false),
  isRecurring: z.boolean().default(true),
  retryAuthorizationConfirmed: z.boolean().optional(),
  preferredPaymentDay: z.union([z.literal(1), z.literal(6), z.literal(16), z.literal(28)]).default(16),
  amount: z
    .number({ invalid_type_error: "Selecciona un monto" })
    .int("Ingresa un monto entero en COP")
    .min(1500, "El monto mínimo es 1.500 COP")
    .max(21474836, "El monto excede el limite permitido"),
});

export type DonorFormValues = z.infer<typeof donorFormSchema>;

export const paymentAuthorizationSchema = z.object({
  token: z.string().min(8),
  paymentMethod: z.enum(["card", "nequi"]),
  maskedDetails: z.string(),
});

export type PaymentAuthorization = z.infer<typeof paymentAuthorizationSchema>;

export const subscriptionPayloadSchema = z.object({
  stage: z.enum(["draft", "checkout", "confirm"]),
  donor: donorFormSchema.omit({ amount: true }),
  amount: z.number().int().min(1500).max(21474836),
  checkoutToken: z.string().min(32).max(256).optional(),
  paymentMethod: z.enum(["card", "nequi"]).optional(),
  isRecurring: z.boolean().optional(),
  wompi: z
    .object({
      token: z.string().max(512).optional(), // legacy client alias; never trusted as a payment source id
      cardToken: z.string().min(8).max(512).optional(),
      paymentSourceType: z.string().max(20).optional(),
      paymentSourceId: z.string().max(128).optional(),
      transactionId: z.string().max(128).optional(),
      reference: z.string().min(8).max(100).optional(),
      maskedDetails: z.string().max(100).optional(),
    })
    .optional(),
});

export type SubscriptionPayload = z.infer<typeof subscriptionPayloadSchema>;
