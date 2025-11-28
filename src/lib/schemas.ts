import { z } from "zod";

export const donorFormSchema = z.object({
  firstName: z.string().min(2, "Ingresa al menos 2 caracteres"),
  lastName: z.string().min(2, "Ingresa al menos 2 caracteres"),
  email: z.string().email("Correo inválido"),
  phone: z
    .string()
    .min(10, "Incluye indicativo y número completo")
    .regex(/^[0-9+\-\s]+$/, "Solo números y símbolos + -"),
  documentType: z.enum(["CC", "CE", "PA", "NIT"]),
  documentNumber: z.string().min(5, "Documento demasiado corto"),
  city: z.string().min(2, "Ciudad inválida"),
  wantsUpdates: z.boolean().default(false),
  amount: z
    .number({ invalid_type_error: "Selecciona un monto" })
    .min(10000, "El monto mínimo es $10.000"),
});

export type DonorFormValues = z.infer<typeof donorFormSchema>;

export const paymentAuthorizationSchema = z.object({
  token: z.string().min(8),
  paymentMethod: z.enum(["card", "nequi"]),
  maskedDetails: z.string(),
});

export type PaymentAuthorization = z.infer<typeof paymentAuthorizationSchema>;

export const subscriptionPayloadSchema = z.object({
  stage: z.enum(["draft", "confirm"]),
  donor: donorFormSchema.omit({ amount: true }),
  amount: z.number().min(10000),
  paymentMethod: z.enum(["card", "nequi"]).optional(),
  wompi: z
    .object({
      token: z.string().optional(),
      maskedDetails: z.string().optional(),
    })
    .optional(),
});

export type SubscriptionPayload = z.infer<typeof subscriptionPayloadSchema>;
