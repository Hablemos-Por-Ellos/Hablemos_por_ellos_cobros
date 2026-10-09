# Reapertura 0.4.0 - Verificada el 2026-10-09

2026-10-09 Colombia. SQL ya aplicada y datos originales verificados.
El titular confirmo el panel actualizado, autorizo la reapertura y guardo los
controles/redeploy. Las instrucciones siguientes quedan como runbook, no como
pasos pendientes ni autorizacion para repetir un corte.
Los pasos de ESCRITURA siguientes no se ejecutan automaticamente por un push.
Requieren confirmacion explicita del titular y comprobar su ingreso con MFA
al panel 0.4.0. No recrear cuentas ni enrolar nuevamente Authenticator.

## Evidencia de Reapertura

- Production READY `7A3XJdXDc5ifxMxxxBUHvjgBKF1D`, main/ba11768,
  creado a las 12:08:45 UTC / 07:08:45 Colombia. Configuracion Vercel guardada
  por el titular, no por el asistente. No se cambiaron llaves ni Preview.
- Dominio canonico: donar/login 200, admin sin sesion 307 hacia login y
  acceptance 200 con ambos enlaces legales HTTPS. No se aceptaron terminos
  ni se ingresaron tarjetas. POST donations con `{}` devuelve 400 antes del
  cliente DB; bootstrap anonimo devuelve 403. Sondas negativas, no aportes.
- Seis tablas privadas rechazan GET anonimo con 42501, cero filas expuestas.
  Inventory nativo reconoce v040 sin fallback y no contacta Wompi.
- GitHub Environment Production verificado active/true; Monthly Charges,
  Keepalive y Refresh Repository Activity verificados active. Inventory manual
  `37928759265`, main/ba11768, success a las 12:15:07 UTC: due/failed/charged/
  sent/reserved/retriesDue cero. Los dos outstanding son historicos ya
  verificados, no dos nuevos cargos inciertos. No se hizo dispatch de charge.
- Keepalive manual `37928938775`, main/ba11768, success: endpoint autenticado
  devuelve `{"ok":true}` despues de una lectura a subscriptions. No invoca
  mantenimiento v1 ni cambia estados, historial o importes.
- El cron sigue 12:00 UTC / 07:00 Colombia. Esta reapertura fue posterior a
  la hora nominal del dia 9; no se ejecuto un catch-up financiero manual y
  no habia cobros vencidos en la lectura. La primera ejecucion programada
  posterior y su eventual aprobacion bancaria deben comprobarse por separado.
- La ejecucion inventory avisa de la futura actualizacion de ubuntu-latest
  y una deprecacion url.parse() de setup-node. No fallaron los pasos; no se
  alteraron runners ni dependencias dentro de esta reapertura.

Esta evidencia no reproduce todos los flujos Auth ni una nueva operacion
financiera real. La confirmacion del panel es del titular; no se leyeron sus
cookies, QR, contrasenas o codigos para validarla.

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
