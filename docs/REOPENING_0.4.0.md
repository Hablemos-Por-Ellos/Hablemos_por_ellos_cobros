# Reapertura 0.4.0 - Confirmacion Pendiente

2026-10-09 Colombia. SQL ya aplicada y datos originales verificados.
Los pasos de ESCRITURA siguientes no se ejecutan automaticamente por un push.
Requieren confirmacion explicita del titular y comprobar su ingreso con MFA
al panel 0.4.0. No recrear cuentas ni enrolar nuevamente Authenticator.

## Vercel - Intervencion del Titular

Editar las variables existentes del proyecto hablemos-por-ellos-cobros:

| Variable | Valor de reapertura |
|---|---|
| APP_OPERATION_MODE | active |
| NEXT_PUBLIC_APP_OPERATION_MODE | active |
| FINANCIAL_OPERATIONS_ENABLED | true |
| MAINTENANCE_MODE | false |

Las tres primeras son Production. MAINTENANCE_MODE se encontro en All
Environments: editar la existente, no crear un duplicado ni cambiar llaves.
Preview debe conservar APP_OPERATION_MODE/NEXT_PUBLIC_APP_OPERATION_MODE=demo,
ADMIN_DEMO_MODE=true, finanzas ausentes/false y sin secretos productivos.
Quitar mantenimiento global no conecta la demo a datos ni pagos reales.

Guardar y hacer Redeploy del ultimo main/0.4.0. Esperar READY y verificar el
dominio canonico: /donar muestra formulario, acceptance entrega terminos,
sin aceptar terminos, ingresar tarjeta o crear una transaccion de prueba.
/admin sin sesion redirige al login; acceso real exige sesion activa y AAL2.
No desactivar Standard Protection, RLS ni MFA.

## GitHub - Despues del Redeploy Verificado

ESCRITURA: Environment Production, variables existentes:
APP_OPERATION_MODE=active y FINANCIAL_OPERATIONS_ENABLED=true.
No reciben valores de Vercel y no son secretos nuevos.

Reanudar Monthly Charges, Keepalive y Refresh Repository Activity solo al
final de las verificaciones. Enable workflow no ejecuta un cobro inmediato;
no seleccionar Run workflow/charge para probar. Una ejecucion manual inventory
sirve para lectura; el cron normal charge conserva 12:00 UTC/07:00 Colombia.
GitHub puede retrasar su inicio, no es una garantia de minuto exacto.

Los activos historicos conservan sus originales. Reintentos nuevos requieren
consentimiento verificado; no se crean ciclos ni autorizaciones retrospectivas.
Pending y past_due no se activan para limpiar listas. Unicos no son recurrentes.

## Recuperacion

Si aparece un fallo, pausar workflows y volver a cutover/false/mantenimiento
con codigo 0.4.0 compatible. Conservar el esquema, recibos, pagos y copias.
No volver ciegamente a 0.3.1 ni restaurar un FINAL antiguo encima de actividad
nueva. La restauracion de DB no revierte dinero. No probar con cargos reales.
