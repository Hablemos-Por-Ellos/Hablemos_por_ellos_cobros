# Hablemos por Ellos Cobros

Mini-app de donaciones recurrentes para la Fundacion Hablemos por Ellos. La app permite registrar donantes, tokenizar tarjetas con Wompi y cobrar donaciones mensuales sin guardar datos sensibles de tarjeta en este repositorio ni en Supabase.

## Estado actual

- Este arbol prepara `0.3.0` localmente; no es una release ni un despliegue.
- La rama productiva `main` remota conserva `0.2.1`; la revision del despliegue
  activo sigue por verificar. Las funciones nuevas de este documento requieren
  completar la migracion y el corte antes de su habilitacion productiva.
- Revision operativa de solo lectura del 2026-10-04 UTC: `main` remoto sigue
  en `0.2.1`, Supabase mostro `Healthy` y los nueve runs mas recientes
  consultados terminaron correctamente. No son garantias futuras ni autorizan
  publicar. Evidencia y gates pendientes: `docs/VALIDATION_0.3.0_LOCAL.md`.
- El ensayo financiero anterior de Wompi Sandbox paso 20 comprobaciones con
  tarjeta y registros ficticios, incluyendo fuente y transaccion. La URL de
  eventos se dejo vacia solo en Sandbox con autorizacion; produccion no cambio.
  Se aplico un evento firmado localmente: la entrega automatica del webhook
  externo no esta validada.
- El job `inventory` tambien paso contra PostgREST real local: tres GET, cero
  llamadas a Wompi y 244 filas intactas en 35 tablas observadas. El fixture no
  tenia cobros vencidos; no acredita cargos ni readiness productiva.
- Cierre local del 2026-10-04: 897 pruebas en 37 archivos, lint y build demo
  correctos; interfaz Auth real, tres cambios administrativos ficticios y guard
  de migracion ensayados. Ver `docs/LOCAL_CLOSURE_2026-10-04.md` para evidencia,
  limitaciones y una incidencia MFA transitoria no reproducida posteriormente.
- Preparacion del corte del 2026-10-04: autorizados commit, push y despliegue en
  mantenimiento, sin reapertura financiera. Los tres workflows operativos
  figuran como disabled_manually en GitHub; no se ejecutaron cobros.
  El usuario configuro Production en cutover y los modos de Preview en demo;
  se verificaron cuatro credenciales privadas y CRON_SECRET solo en Production,
  y ADMIN_DEMO_MODE=true solo en Preview. Aun faltan la verificacion remota de
  Preview, exclusion de escritores y respaldo final/migracion.
  Ver `docs/CUTOVER_2026-10-04.md`.
- Restriccion posterior: no crear recursos adicionales; usar las cuentas desde
  la sesion correcta del navegador, sin conectores de cuentas. No se creo el
  entorno externo propuesto. Solo se pauso Repository Activity durante el corte;
  los datos productivos permanecen sin modificar.
- Ruta publica principal: `/donar`.
- Version visible en el footer: tomada desde `package.json`.
- Pagos mensuales: tarjeta debito/credito con tokenizacion Wompi.
- Nequi mensual: deshabilitado por ahora.
- Persistencia: Supabase.
- Deploy esperado: Vercel.
- Deploy de produccion: cada push a `main` activa Vercel.
- Cobros recurrentes: GitHub Actions `Monthly Charges`.
- Keepalive Supabase: GitHub Actions `Keepalive`.
- Panel administrativo: implementacion local pendiente de migracion y habilitacion explicita.

## Seguridad

Este repositorio es publico. No se deben commitear secretos, dumps de base de datos, backups de Supabase, archivos `.env*` reales ni capturas con llaves visibles.

La app no guarda numero de tarjeta, CVV ni datos completos del medio de pago. Wompi guarda la informacion sensible. En Supabase solo se guardan identificadores operativos como:

- `wompi_payment_source_id`
- `wompi_transaction_id`
- estado del pago/suscripcion
- datos enmascarados cuando Wompi los entrega

Los secrets deben vivir en Vercel y en GitHub Actions Environments, no en el codigo.

El acceso administrativo conserva Supabase Auth estandar: correo/contrasena,
TOTP y UUID activo autorizado, con AAL2 verificado en servidor y RLS. La URL y
llave publica de Supabase son visibles al cliente por diseno; no dan acceso
administrativo por si solas. Las llaves privadas permanecen exclusivamente en
servidor. No sustituir la llave publica por service_role/secret.

## Stack

- Next.js 15 App Router
- React 19
- Tailwind CSS
- Supabase JS
- Wompi Colombia
- Vitest
- GitHub Actions

## Instalacion local

`ESCRITURA LOCAL`: instala dependencias y genera artefactos en la maquina.

```powershell
npm install
```

No sobrescribas un archivo privado existente. Para crear la plantilla local
solamente si todavia no existe (`ESCRITURA LOCAL`):

```powershell
if (Test-Path -LiteralPath .env.local) {
  throw ".env.local ya existe: revisar su destino sin sobrescribirlo."
}
Copy-Item .env.example .env.local
```

Para revisar la maqueta sin cargar credenciales productivas, usa
`node scripts/integration/run-demo-local.mjs dev`. Para integrar Auth usa
el laboratorio descrito en `docs/LOCAL_AUTH_VALIDATION.md`. No conectes una
prueba de desarrollo a produccion ni supongas que una DB local esta vacia.

### Ensayo del webhook sin proveedores

Con el laboratorio Auth/Supabase local existente y verificado, el perfil
`node scripts/integration/start-app-lab.mjs --cutover-webhook-fixture=yes`
levanta Next solo en `127.0.0.1:3001`, modo `cutover` y cobros deshabilitados.
Elimina las llaves de Wompi del proceso y usa un secreto ficticio para eventos.
Rechaza combinar este perfil con `--financial=yes` o `--sandbox-config=yes`.

Con el gateway local del laboratorio activo, ejecutar en otra terminal
(`ESCRITURA LOCAL`, agrega dos recibos ficticios sin borrar datos anteriores):

```powershell
node scripts/integration/webhook-cutover-local-e2e.mjs
```

El ensayo compara los registros anteriores de ocho tablas operativas, incluidos
intentos, checkouts y auditoria administrativa. Rechaza firma/ambiente invalidos y
comprueba que los eventos validos se conserven sin cambiar pagos. No tokeniza
tarjetas, no envia cargos y **no prueba entrega automatica desde Wompi**. No
expone ninguna ruta a internet ni modifica Vercel. Ver
`docs/VALIDATION_0.3.0_LOCAL.md` para alcance y pendientes.

Para las pruebas recientes de interfaz y migracion, ver
`docs/LOCAL_CLOSURE_2026-10-04.md`. Usan laboratorios existentes con datos
ficticios, no copias reales de donantes. Los ensayos que comparan preservacion
deben ejecutarse de uno en uno, sin otro escritor modificando su baseline.

El perfil debe haber sido iniciado y verificado por quien ejecuta el ensayo:
el JSON informa `expectedMode`, no una atestacion remota de Next ni una medicion
del egreso de red. Las claves JWT del laboratorio se validan por firma, emisor,
rol y vigencia, sin regenerar ni sobrescribir un archivo existente. Docker se
fija al daemon local, sin heredar contextos/hosts remotos. No hay autorizacion
para Cloudflare, tuneles ni pruebas financieras externas en esta etapa.

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
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
NEXT_PUBLIC_WOMPI_ENV
NEXT_PUBLIC_WOMPI_PUBLIC_KEY_PROD
WOMPI_PRIVATE_KEY_PROD
WOMPI_INTEGRITY_SECRET_PROD
WOMPI_EVENTS_SECRET_PROD
CRON_SECRET
MAINTENANCE_MODE
CHECKOUT_TOKEN_PEPPER
APP_OPERATION_MODE
NEXT_PUBLIC_APP_OPERATION_MODE
FINANCIAL_OPERATIONS_ENABLED
ADMIN_DEMO_MODE
```

`ADMIN_DEMO_MODE=true` se usa solamente para el panel ficticio de Preview o del
laboratorio local, junto con `APP_OPERATION_MODE=demo`. No habilitarlo en
Production. Los modos demo no administran donantes reales ni autorizan cargos.

Limitar las credenciales productivas a Production evita entregarlas a futuros
despliegues de prueba; una credencial distinta del mismo proyecto no separa sus
datos. El alcance All Environments no implica por si mismo exposicion al
navegador. Los cambios guardados de entorno solo se aplican a nuevos despliegues;
no certifican la configuracion de un despliegue anterior.

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
- El workflow mensual fija `WOMPI_ENV=prod` directamente. El script falla si el ambiente no se declara como `prod` o `sandbox`; nunca asume produccion por defecto.
- `APP_OPERATION_MODE` y `FINANCIAL_OPERATIONS_ENABLED` tambien son variables
  del environment `Production` de GitHub Actions, no secretos. Sus valores por
  defecto en el nuevo workflow son `cutover` y `false`; publicar el archivo no
  habilita cobros. `NEXT_PUBLIC_APP_OPERATION_MODE` identifica la vista publica,
  pero no autoriza operaciones financieras.
- No modificar Vercel durante la preparacion actual. Antes de cualquier futura
  preview se debe autorizar y verificar que no herede credenciales productivas;
  un push a una rama conectada puede iniciar un despliegue automaticamente.

## Flujo de donacion

Flujo del paquete local `0.3.0`, pendiente de publicacion:

1. El donante llena sus datos en `/donar`.
2. El backend crea una intencion temporal con monto, moneda y referencia generados en servidor.
3. La firma de integridad se calcula sobre esa intencion; el navegador no decide esos valores.
4. El widget de Wompi tokeniza la tarjeta y devuelve un `cardToken`.
5. El backend pide tokens de aceptacion frescos a Wompi.
6. El backend crea una fuente de pago en Wompi (`payment_source_id`).
7. El backend crea el primer cobro.
8. Supabase reserva el intento antes de enviarlo, y guarda la suscripcion, el pago y los IDs operativos.
9. El webhook valida firma, consulta la transaccion directamente en Wompi y aplica el resultado de forma idempotente.

Los tokens de checkout vencen a los 30 minutos y se guardan unicamente como hash. Una referencia o un ID entregado por el navegador no basta para aprobar un pago.

## Cobros recurrentes

El workflow `.github/workflows/monthly-charges.yml` corre una vez al dia y no permite dos ejecuciones simultaneas:

- `concurrency = monthly-charges-production`
- un run en curso nunca se cancela por otro trigger

```txt
7:00 a.m. Colombia
12:00 UTC
```

El script `scripts/run-monthly-charges.mjs` busca suscripciones:

- `status = active`
- `frequency = monthly`
- `wompi_payment_source_id` no nulo
- `next_payment_date <= now()`

Todas las fechas se guardan en Supabase como UTC (`timestamptz`), pero las reglas comerciales usan `America/Bogota`: el mes empieza a las `00:00` Colombia (`05:00 UTC`) y termina al inicio del mes siguiente. Esto evita que un pago de la noche del ultimo dia colombiano se clasifique en el mes equivocado solo porque en UTC ya cambio de fecha.

Si encuentra una suscripcion vencida, el script crea una transaccion en Wompi con la fuente de pago guardada. Antes de hacerlo busca pagos `approved` o `pending` dentro del mes colombiano actual:

- un pago `pending` bloquea un nuevo intento hasta que Wompi confirme su estado;
- un pago `approved` con `next_payment_date` vencido repara automaticamente la siguiente fecha;
- si no puede comprobar pagos existentes, no cobra a ciegas y deja un registro en `audit_logs`.
- justo antes de enviar el cobro, una funcion atomica vuelve a validar estado, vencimiento, monto y version de la suscripcion;
- un intento incierto o previamente despachado sin ID de Wompi bloquea otro cobro, se audita y hace fallar el workflow para revision manual.

Los intentos `unknown` sin identificador y los `dispatching` sin identificador que lleven al menos 15 minutos aparecen en **Intentos por conciliar** dentro de `/admin`. El administrador debe localizar la referencia en el dashboard de Wompi e ingresar el ID exacto. La API consulta esa transaccion directamente en Wompi y valida ID, referencia, monto, moneda y, para cobros mensuales, la fuente tokenizada antes de aplicar el resultado. Esta accion no crea una transaccion ni permite elegir manualmente su estado; exige MFA, motivo y queda auditada.

Si la busqueda confirma que no existe ninguna transaccion, el admin puede cerrar el intento con una confirmacion explicita. El cierre no cobra ni reintenta: marca el intento como `failed`, deja la suscripcion `past_due`, incrementa su version y registra la decision. Una notificacion tardia verificada de Wompi puede conservarse como pago, pero no revierte automaticamente esa decision administrativa.

Las suscripciones mensuales pueden guardar `preferred_payment_day` con uno de estos valores: `1`, `6`, `16` o `28`. El primer cobro se realiza al crear la suscripcion; los siguientes cobros se programan desde el mes siguiente en el dia elegido, a las 7:00 a.m. Colombia.

En el workflow nuevo, `inventory` consulta sin escrituras, `reconcile` concilia
sin enviar cargos nuevos y `charge` puede enviar cobros reales si los bloqueos
lo permiten. `inventory` admite consultar el esquema anterior sin modificarlo:
si faltan tablas nuevas o `payments.billing_review_required`, muestra
`inventoryStatus=legacy_incomplete` y aumenta `schemaUnknown/blocked`. Solo esa
columna ausente permite consultar pagos `approved/pending` como alternativa;
errores de permisos, red u otras columnas siguen siendo fallos operativos.
Despues de migrar sigue usando el filtro completo de revisiones. El resultado
`read_only_observation` tampoco certifica readiness ni el estado en Wompi.
Un exit 0 del inventario nunca autoriza cobrar. Ver
`docs/VALIDATION_0.3.0_LOCAL.md`.

Para ejecutar manualmente desde GitHub despues de publicar y habilitar el paquete:

1. Actions
2. Monthly Charges
3. Run workflow
4. Branch `main`
5. Elegir el modo explicitamente; el valor inicial es `inventory`. No usar
   `charge` como prueba productiva.

## Keepalive

El workflow `.github/workflows/keepalive.yml` llama el endpoint
`/api/cron/keepalive` a las `03:00 UTC` los dias `1, 4, 7, ...` del mes
(`0 3 */3 * *`). No es un intervalo fijo de 72 horas al cambiar de mes. Usa:

```txt
CRON_SECRET
KEEPALIVE_URL
```

`KEEPALIVE_URL` debe apuntar al endpoint desplegado, por ejemplo:

```txt
https://TU_DOMINIO/api/cron/keepalive
```

## Webhook Wompi

Sandbox y Produccion deben tener URLs de eventos diferentes en el Dashboard de
Wompi. Cambiar las llaves locales no cambia ese destino. Nunca probar Sandbox
si sus eventos apuntan al webhook productivo. Ver
[Eventos Wompi](https://docs.wompi.co/docs/colombia/eventos/).

Configura el webhook de Wompi apuntando a:

```txt
https://TU_DOMINIO/api/wompi/webhook
```

El endpoint valida la firma del evento con `WOMPI_EVENTS_SECRET_PROD` y guarda una version sanitizada del evento en `webhook_events`.

La obtencion de contratos/tokens usa `GET /merchants/info` con `x-merchant-public-key`; no usa el endpoint de Wompi que se retira el 31 de octubre de 2026.

## Panel administrativo

Esta seccion describe el paquete local `0.3.0`, todavia no habilitado en
produccion. No usar la maqueta para administrar personas reales.

El panel se encuentra en `/admin` y requiere correo, contrasena, una cuenta allowlist y TOTP/AAL2. No ofrece registro publico. Los datos personales son de solo lectura; el admin puede cambiar el monto del siguiente cobro, cambiar dia/mes, cancelar o reactivar una suscripcion. La reactivacion exige confirmar que el donante la autorizo, registra esa atestacion en la auditoria y no genera un cargo inmediato. Cada mutacion exige motivo, un codigo TOTP actual, control de version y auditoria. La RPC de escritura no esta disponible para `anon` ni `authenticated`: solo la API del servidor puede invocarla con `service_role` y registra el UUID de la sesion administrativa ya validada.

La cancelacion se rechaza mientras exista un intento `dispatching`, `pending` o `unknown`. Esto evita que el job reserve un cobro, el admin cancele y luego la solicitud ya preparada se envie a Wompi. Cuando Wompi ofrece un reintento dentro de WebCheckout, cada transaccion se conserva por su ID: una nueva transaccion solo puede reemplazar a la actual si la anterior termino en `declined`, `error` o `voided`; nunca si ya existe una `pending` o `approved`.

Si el webhook del reintento llega antes que el cierre del intento anterior, el servidor consulta ambos IDs en Wompi, aplica primero el estado terminal verificado del anterior y despues el nuevo. Los eventos tardios rechazados se conservan como historial sin degradar una aprobacion posterior.

El mantenimiento del keepalive no borra filas operativas: marca como `expired` solo las intenciones `draft` o `checkout` vencidas. Los intentos `processing` se conservan para conciliacion o revision y bloquean otro cargo incierto del mismo donante.

La preparacion local y los pasos futuros estan en `docs/ADMIN_LOCAL_SETUP.md`.
Las comprobaciones reales de Auth local estan en `docs/LOCAL_AUTH_VALIDATION.md`;
el estado completo y los limites del ensayo estan en `docs/VALIDATION_0.3.0_LOCAL.md`.
El respaldo privado y su verificacion estan en `docs/PRIVATE_BACKUP_RUNBOOK.md`.
La migracion versionada se prepara en `supabase/migrations`, pero no debe ejecutarse
en produccion sin preflight, respaldo final restaurado/comparado, confirmacion en
el chat y autorizacion explicita. Este paquete permanece local y pendiente de publicacion.

## Tablas esperadas

- `donors`
- `subscriptions`
- `payments`
- `webhook_events`
- `audit_logs`
- `admin_users`
- `admin_invitations`
- `admin_audit_logs`
- `checkout_intents`
- `payment_attempts`
- `api_rate_limits`
- `payment_admin_migrations`

Despues de habilitar `0.3.0`, las cancelaciones deben hacerse desde el panel
administrativo. No cambiar `subscriptions.status` con un `UPDATE` directo:
omite MFA, bloqueo de cobros en curso, control de version y auditoria. El panel
local no sustituye todavia la operacion productiva anterior; cualquier ajuste
manual anterior al corte requiere revision y autorizacion especificas. El cron
de cobros solo procesa suscripciones mensuales `active` con fecha vencida.

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

<!-- repository-activity: 2026-10-01T18:54:35Z -->
