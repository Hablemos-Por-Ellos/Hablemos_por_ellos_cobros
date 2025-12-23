# Mini-app Donaciones Mensuales · Fundación Hablemos por Ellos

Mini-aplicación web moderna, emocional y confiable para gestionar suscripciones de donación mensual. Está pensada para incrustarse en un sitio principal (por ejemplo Wix) como módulo independiente que guía al donante desde la captura de datos hasta la autorización segura con Wompi y persiste la suscripción en Supabase.
Debe ser completamente funcional y gratis el flujo final.

## Características principales

- Flujo `/donar` en tres pasos (datos → pago seguro → confirmación).
- UI tierna y minimalista con mensajes de transparencia, indicadores de seguridad y componentes optimizados para conversión.
- Selección de montos predefinidos (2.5k, 5k, 10k, 20k, 50k, 100k COP) + monto personalizado.
- Espacio visual y lógica preparada para incrustar el widget oficial de Wompi (tarjeta y Nequi).
- API Routes con Supabase para almacenar donantes, suscripciones y eventos de Wompi.
- Widget real de Wompi para tarjeta y Nequi (con firma de integridad).
- Tailwind CSS, componentes reutilizables y pruebas básicas con Vitest.

## Requisitos previos

- Node.js 18.18+ o 20.x.
- npm 9+.
- Cuenta Supabase (para persistencia real) y credenciales Wompi producción/sandbox.

## Configuración rápida

1. **Instalar dependencias**

```powershell
cd "d:\Visual Studio Code\HablemosPorEllos\mini-app-prod\Hablemos_por_ellos_cobros"
npm install
```

2. **Variables de entorno**
   - Copia `.env.example` a `.env.local` y completa las credenciales necesarias de Supabase y pasarela de pagos.
   - Nunca comitees `.env.local` al repositorio.

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
- `DonationWizard` controla estado de pasos y comunicación con la API.
- Componentes UI (`Button`, `AmountChip`, `Toast`, etc.) viven en `src/components/ui`.
- Integración con Supabase para almacenar donantes, suscripciones y eventos.
- Integración con pasarela de pagos para procesamiento seguro de transacciones.

## Integración con Pasarela de Pagos

1. Configura el widget de pago en `PaymentStep` según la documentación de tu proveedor.
2. Usa la información del donante (nombre, correo, documento, monto) para inicializar el widget.
3. En el callback de éxito, envía los datos de tokenización a tu backend.
4. Configura webhooks para actualizar estados de pagos y suscripciones.

## Modelo de datos en Supabase

- `donors`: información básica de donantes
- `subscriptions`: detalles de suscripciones mensuales/únicas
- `payments`: historial de transacciones
- `webhook_events`: bitácora de eventos para auditoría

### Baja de suscripciones (versión actual)

En esta primera versión, **la cancelación de donaciones mensuales se gestiona de forma manual por la fundación**. El flujo recomendado es:

- El donante escribe a un canal de soporte (correo, WhatsApp, redes) solicitando la cancelación.
- Un responsable interno ingresa a Supabase y marca la suscripción como cancelada en la tabla `subscriptions` (por ejemplo, cambiando `status` a `"canceled"` y llenando `cancelled_at`).
- Opcionalmente se registra la acción en una tabla de auditoría o en `payments`.
- La lógica de cobro recurrente (cron/función externa) **debe ignorar suscripciones con estado cancelado**, por lo que no se siguen intentando cobros.

> Importante: los tokens de pago pueden permanecer almacenados para fines de historial/auditoría; simplemente dejan de utilizarse una vez que la suscripción está cancelada.

## Seguridad del Webhook

El endpoint de webhooks incluye validaciones de seguridad estándar para pasarelas de pago.

## Embed en Wix

- Publica este mini-app (por ejemplo en Vercel) y embebe `https://tu-dominio/donar` mediante iframe.
