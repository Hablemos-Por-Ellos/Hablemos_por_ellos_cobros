# Reapertura manual - 0.3.1

Fecha: 2026-10-04 Colombia. Este ajuste no necesita otra migracion.
No modifica registros, agendas, fuentes tokenizadas, jobs ni webhooks.
La publicacion conserva mantenimiento; los pasos siguientes son ESCRITURA
de configuracion y requieren decision del titular. No se ejecutan en el push.

## 1. Vercel Production

Solo despues de confirmar el despliegue READY de main/0.3.1 y el ingreso MFA:

| Variable existente | Valor para reabrir |
| --- | --- |
| APP_OPERATION_MODE | active |
| NEXT_PUBLIC_APP_OPERATION_MODE | active |
| FINANCIAL_OPERATIONS_ENABLED | true |
| MAINTENANCE_MODE | false |

Mantener llaves y URLs existentes, ADMIN_DEMO_MODE ausente/false en Production,
Preview demo desconectada y Standard Protection. No desactivar MFA/RLS.
Guardar y hacer Redeploy de la revision main/0.3.1 a Production: guardar
variables no cambia el despliegue que ya esta ejecutandose.

LECTURA posterior: /donar deja mantenimiento; /admin/login sigue disponible;
sin sesion /admin no expone registros. El admin mensual deja solo lectura
tras el nuevo deploy, pero guardar exige confirmacion, motivo, TOTP y version.
Unicos permanecen solo lectura; no convertir pendientes en activos.

## 2. GitHub Actions Production

Settings -> Environments -> Production -> Environment variables:

| Variable (no Secret) | Valor para calendario normal |
| --- | --- |
| APP_OPERATION_MODE | active |
| FINANCIAL_OPERATIONS_ENABLED | true |

Estas dos variables no existian en Production en la ultima consulta previa
al push; revisar antes de duplicarlas. No cambian al modificar Vercel.
No renombrar ni repetir los secretos de Supabase/Wompi ya configurados.

En Actions, seleccionar cada workflow -> menu de tres puntos -> Enable workflow:
Monthly Charges, Keepalive y Refresh Repository Activity.
Habilitar no equivale a Run workflow; un push tampoco los habilita.

Primera comprobacion manual: Monthly Charges -> Run workflow -> branch main ->
mode inventory. Es LECTURA, no cobra ni concilia. Revisar errores y resultados
antes del siguiente horario. No seleccionar charge ni repetir cobros de prueba.
El cron normal corre cada dia a las 12:00 UTC/7:00 Colombia; evalua fechas vencidas
con los controles de duplicados. Un resultado incierto bloquea un nuevo cargo.

## Pendientes que no requieren otro deploy

- Preparar la segunda invitacion privada cuando el titular lo solicite;
  cuenta, UUID/rol, contraseña y MFA no necesitan modificar codigo.
- Registros legacy ambiguos y pendientes conservados para seguimiento, no
  aprobados/activados automaticamente. Distinguir suscripcion de pago pendiente.
- Despues de la reapertura, comprobar salud y primera ejecucion real sin
  simular un cobro contra personas ni prometer que una prueba evita todo fallo.

## Recuperacion

Ante fallo, dejar workflows pausados y volver a cutover/false/mantenimiento
en el proyecto existente, con redeploy. Conservar esquema ya migrado y recibos;
no restaurar una copia vieja encima ni volver a 0.2.1. El despliegue previo
0.3.0 sigue siendo referencia de mantenimiento; inspeccionar compatibilidad.
