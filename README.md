# Mini-app Donaciones Mensuales · Fundación Hablemos por Ellos

Mini-aplicación web moderna, emocional y confiable para gestionar suscripciones de donación mensual. Está pensada para incrustarse en un sitio principal (por ejemplo Wix) como módulo independiente que guía al donante desde la captura de datos hasta la autorización segura con Wompi y persiste la suscripción en Supabase.

## Características principales

- Flujo `/donar` en tres pasos (datos → pago seguro → confirmación).
- UI tierna y minimalista con mensajes de transparencia, indicadores de seguridad y componentes optimizados para conversión.
- Selección de montos predefinidos (20k, 50k, 100k COP) + monto personalizado.
- Espacio visual y lógica preparada para incrustar el widget oficial de Wompi (tarjeta y Nequi).
- API Routes con Supabase para almacenar donantes, suscripciones y eventos de Wompi.
- Simulación local de tokenización para demos mientras se integra la pasarela real.
- Tailwind CSS, componentes reutilizables y pruebas básicas con Vitest.

## Requisitos previos

- Node.js 18.18+ o 20.x.
- npm 9+.
- Cuenta Supabase (para persistencia real) y credenciales Wompi producción/sandbox.

## Configuración rápida

1. **Instalar dependencias**

```powershell
cd "d:\Visual Studio Code\mini-app_hablemospor ellos"
npm install
```

2. **Variables de entorno**
   - Copia `.env.example` a `.env.local` y completa `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.
   - Añade tus llaves públicas/privadas de Wompi cuando hagas la integración real (por ejemplo `NEXT_PUBLIC_WOMPI_PUBLIC_KEY`).

3. **Comandos útiles**

```powershell
npm run dev      # servidor Next.js en modo desarrollo
npm run lint     # reglas ESLint/Next
npm run test     # pruebas unitarias con Vitest
npm run build    # compilación de producción
npm start        # modo producción después de build
```

## Arquitectura

- `src/app/donar/page.tsx` renderiza `DonationWizard`, cabecera emocional y hero card.
- `DonationWizard` controla estado de pasos y comunicación con `/api/donations`.
- Componentes UI (`Button`, `AmountChip`, `Toast`, etc.) viven en `src/components/ui`.
- `src/app/api/donations/route.ts` y `src/lib/supabase-server.ts` gestionan la persistencia en Supabase (`donors`, `subscriptions`, `webhook_events`).
- `src/app/api/wompi/webhook/route.ts` deja listo el endpoint para conectar los webhooks de Wompi.
- `src/lib/wompi.ts` contiene utilidades y simulación de tokenización para entornos locales.

## Integración con Wompi

1. Carga el script oficial (`https://checkout.wompi.co/widget.js`) dentro de `PaymentStep` y reemplaza el bloque de placeholder por el widget real.
2. Usa la información del donante (nombre, correo, documento, monto) para inicializar el widget.
3. En el callback `onSuccess`, envía `payment_method_type`, `payment_source_id` y `token` al endpoint `/api/donations` (ya preparado para recibirlos).
4. Configura los webhooks de Wompi apuntando a `/api/wompi/webhook` para actualizar estados de `payments`/`subscriptions`.

## Modelo de datos sugerido en Supabase

- `donors`: email único, nombres, teléfono, documento, ciudad, preferencias de comunicación.
- `subscriptions`: FK a `donors`, monto, frecuencia, estado, referencia Wompi, método de pago, fechas de inicio/renovación.
- `payments`: registros por cobro mensual (opcional) sincronizados por webhook.
- `webhook_events`: bitácora de eventos crudos de Wompi para auditoría.

## Embed en Wix

- Publica este mini-app (por ejemplo en Vercel) y embebe `https://tu-dominio/donar` mediante iframe.
- Usa parámetros de consulta (`?monto=50000&campana=navidad`) para precargar montos o trackear campañas.

## Próximos pasos sugeridos

1. Sustituir la simulación de Wompi en `PaymentStep` por el widget real.
2. Conectar Supabase con sus tablas definitivas y politicas RLS.
3. Añadir analytics/eventos (Meta Pixel, GA4) según las necesidades de la fundación.
4. Automatizar correos de confirmación usando la información retornada por Supabase/Wompi.
