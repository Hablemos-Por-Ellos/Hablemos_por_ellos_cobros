# Hablemos por Ellos Cobros

Mini-app de donaciones recurrentes para la Fundacion Hablemos por Ellos. La app permite registrar donantes, tokenizar tarjetas con Wompi y cobrar donaciones mensuales sin guardar datos sensibles de tarjeta en este repositorio ni en Supabase.

## Estado actual

- Ruta publica principal: `/donar`.
- Version visible en el footer: tomada desde `package.json`.
- Pagos mensuales: tarjeta debito/credito con tokenizacion Wompi.
- Nequi mensual: deshabilitado por ahora.
- Persistencia: Supabase.
- Deploy esperado: Vercel.
- Cobros recurrentes: GitHub Actions `Monthly Charges`.
- Keepalive Supabase: GitHub Actions `Keepalive`.

## Seguridad

Este repositorio es publico. No se deben commitear secretos, dumps de base de datos, backups de Supabase, archivos `.env*` reales ni capturas con llaves visibles.

La app no guarda numero de tarjeta, CVV ni datos completos del medio de pago. Wompi guarda la informacion sensible. En Supabase solo se guardan identificadores operativos como:

- `wompi_payment_source_id`
- `wompi_transaction_id`
- estado del pago/suscripcion
- datos enmascarados cuando Wompi los entrega

Los secrets deben vivir en Vercel y en GitHub Actions Environments, no en el codigo.

## Stack

- Next.js 14 App Router
- React 18
- Tailwind CSS
- Supabase JS
- Wompi Colombia
- Vitest
- GitHub Actions

## Instalacion local

```powershell
npm install
```

Copia `.env.example` a `.env.local` y completa valores reales solo en tu maquina:

```powershell
Copy-Item .env.example .env.local
```

Comandos utiles:

```powershell
npm run dev
npm run lint
npm test
npm run build
npm start
```

## Variables de entorno

Variables principales para Vercel:

```txt
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
NEXT_PUBLIC_WOMPI_ENV
NEXT_PUBLIC_WOMPI_PUBLIC_KEY_PROD
WOMPI_PRIVATE_KEY_PROD
WOMPI_INTEGRITY_SECRET_PROD
WOMPI_EVENTS_SECRET_PROD
CRON_SECRET
MAINTENANCE_MODE
ALLOW_DEMO_MODE
```

Variables principales para GitHub Actions, environment `Production`:

```txt
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
NEXT_PUBLIC_WOMPI_PUBLIC_KEY_PROD
WOMPI_PRIVATE_KEY_PROD
WOMPI_INTEGRITY_SECRET_PROD
CRON_SECRET
KEEPALIVE_URL
```

Notas:

- `NEXT_PUBLIC_WOMPI_PUBLIC_KEY_PROD` puede estar expuesta al navegador porque es la llave publica de Wompi.
- `WOMPI_PRIVATE_KEY_PROD`, `WOMPI_INTEGRITY_SECRET_PROD`, `WOMPI_EVENTS_SECRET_PROD`, `SUPABASE_SERVICE_ROLE_KEY` y `CRON_SECRET` nunca deben tener prefijo `NEXT_PUBLIC_`.
- `NEXT_PUBLIC_WOMPI_ENV=prod` activa el modo produccion en la app web.
- El workflow mensual fija `WOMPI_ENV=prod` directamente.

## Flujo de donacion

1. El donante llena sus datos en `/donar`.
2. La app crea/actualiza el donante en Supabase.
3. Antes de abrir Wompi, la app crea una suscripcion `pending` con una `reference`.
4. El widget de Wompi tokeniza la tarjeta y devuelve un `cardToken`.
5. El backend pide tokens de aceptacion frescos a Wompi.
6. El backend crea una fuente de pago en Wompi (`payment_source_id`).
7. El backend crea el primer cobro.
8. Supabase guarda la suscripcion, el pago y los IDs operativos.
9. El webhook de Wompi confirma estados y registra eventos.

## Cobros recurrentes

El workflow `.github/workflows/monthly-charges.yml` corre una vez al dia:

```txt
7:00 a.m. Colombia
12:00 UTC
```

El script `scripts/run-monthly-charges.mjs` busca suscripciones:

- `status = active`
- `frequency = monthly`
- `wompi_payment_source_id` no nulo
- `next_payment_date <= now()`

Si encuentra una suscripcion vencida, crea una transaccion en Wompi con la fuente de pago guardada. El script evita duplicar cobros si ya existe un pago `approved` o `pending` en el mes actual.

Las suscripciones mensuales pueden guardar `preferred_payment_day` con uno de estos valores: `1`, `6`, `16` o `28`. El primer cobro se realiza al crear la suscripcion; los siguientes cobros se programan desde el mes siguiente en el dia elegido, a las 7:00 a.m. Colombia.

Para ejecutar manualmente desde GitHub:

1. Actions
2. Monthly Charges
3. Run workflow
4. Branch `main`

## Keepalive

El workflow `.github/workflows/keepalive.yml` llama el endpoint `/api/cron/keepalive` cada 3 dias. Usa:

```txt
CRON_SECRET
KEEPALIVE_URL
```

`KEEPALIVE_URL` debe apuntar al endpoint desplegado, por ejemplo:

```txt
https://TU_DOMINIO/api/cron/keepalive
```

## Webhook Wompi

Configura el webhook de Wompi apuntando a:

```txt
https://TU_DOMINIO/api/wompi/webhook
```

El endpoint valida la firma del evento con `WOMPI_EVENTS_SECRET_PROD` y guarda una version sanitizada del evento en `webhook_events`.

## Tablas esperadas

- `donors`
- `subscriptions`
- `payments`
- `webhook_events`
- `audit_logs`

Para cancelar una suscripcion manualmente:

```sql
update public.subscriptions
set status = 'cancelled',
    cancelled_at = now(),
    next_payment_date = null
where id = 'ID_DE_LA_SUSCRIPCION';
```

El cron de cobros solo procesa suscripciones `active`.

## Checklist antes de publicar cambios

```powershell
npm run lint
npm test
npm run build
```

Antes de hacer push a un repo publico:

- Verifica `git status --short`.
- No subas `.env.local`, backups `.backup`, dumps `.sql`, capturas con llaves ni archivos de Supabase descargados.
- Revisa que los workflows usen `environment: Production` si dependen de environment secrets.
