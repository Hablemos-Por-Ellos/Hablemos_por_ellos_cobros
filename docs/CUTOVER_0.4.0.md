# Corte 0.4.0: migracion aplicada, reapertura pendiente

Implementacion: 2026-10-08 Colombia. Corte: 2026-10-09.
Rama `codex/monthly-payment-retry`, publicada por dev/main.
NO ejecutar esta fase por disponer de un build correcto. El plan aprobado y
una solicitud general de continuar no sustituyen la autorizacion separada de publicacion
y corte, ni la confirmacion posterior de reapertura financiera.

## Corte productivo verificado - 2026-10-09 Colombia

- Codigo `2769a11`, rama/dev/main. Preview dev
  `AMvaV2XxQsqpFRSDrqg8jFff2uTS` READY, solo datos ficticios; Production
  `3HtXEsi6bGDz2oPtumDh1a2tvAnc` READY y asignada al dominio principal.
- Titular guardo mantenimiento y redeploy anterior 0.3.1 antes del push.
  APP_OPERATION_MODE/NEXT_PUBLIC_APP_OPERATION_MODE=cutover, finanzas false,
  MAINTENANCE_MODE=true. Esta ultima estaba en All Environments; Preview
  conserva demo/ADMIN_DEMO_MODE=true y no recibe secretos financieros.
- Monthly Charges, Keepalive y Repository Activity disabled_manually,
  Production cutover/false y cero runs no terminales durante FINAL/SQL.
  La URL archivada comprobada redirige al login de Vercel sin dar acceptance.
- FINAL a las 05:33:35.523 UTC: snapshot unico, 50 tablas/490 filas, dump y
  manifiesto cifrados, permisos privados, restauracion verificada a las
  05:39:31.306 UTC y cero diferencias; segunda copia con hashes coincidentes.
  Comparacion de IDs/contenido/importes, esquema, ACL, Auth/MFA y Storage vacio.
- Laboratorio offline PG17.6, imagen fijada por digest, red none, UID100,
  capabilities revocadas, CPU/RAM/PIDs limitados y sin puertos ni host mounts.
  Docker cp no admite el root RO ni el destino tmpfs de TOC: el laboratorio
  final uso root escribible y /tmp normal, sin habilitar red ni ampliar acceso
  al host. plpgsql heredaba al operador bootstrap local; se restauro unicamente
  su owner supabase_admin en el catalogo LOCAL y se repitio la comparacion
  completa. No se ajustaron datos ni metadatos productivos para hacerla pasar.
- Mensaje obligatorio emitido inmediatamente antes de SQL. Aplicador nuevo
  confirmo MIGRATION_VERIFIED/originalRecordsPreserved; marcador aplicado
  `2026-10-09T05:40:17.068Z`, digest
  `dbb0b98ca4d44f0d999d0f7a77b28d9e88fb6d71799e577a0a65491533f3b34d`.
  Conexion independiente: postflight correcto y originales con cero diferencias.
  34 donantes, 29 suscripciones, 41 pagos, 87 eventos y dos intentos antes
  de conciliacion; cero ciclos creados retroactivamente, dos cuentas/dos MFA.
- Inventory v040: cuatro GET Supabase y dos readiness RPC de solo lectura;
  charged/sent/failed/schemaUnknown cero, sin compatibilidad legacy ni Wompi.
  Dos historicos aparecen outstanding porque carecen de la evidencia nueva,
  no porque haya un cargo nuevo incierto. Reconcile verifica dos GET Wompi y
  dos RPC de resultados, sin POST al proveedor, sin nuevos cobros ni fallos.
- Postflight posterior a reconcile vuelve a comparar todos los IDs/contenidos
  originales: cero diferencias; unicamente dos eventos canonicos nuevos,
  identificados como verificaciones legacy procesadas. Total eventos 89.
  Acceso anonimo a donors/subscriptions/payments/payment_attempts/billing_cycles/
  admin_users rechazado con 42501; seis GET y cero datos expuestos.
  Sondas negativas: bootstrap sin sesion 403, donations en cutover 503,
  PATCH de suscripcion invalida en cutover 503. Esto no sustituye MFA real.
- Runtime: acceptance 503 de mantenimiento, donar redirige a mantenimiento,
  login 200 con 0.4.0. No demuestra aun una nueva sesion AAL2 del titular;
  acceso actualizado, reapertura y primera ejecucion financiera siguen pendientes.
  Procedimiento vigente: `REOPENING_0.4.0.md`.
- Copia POST a las 05:45:20.693 UTC, despues de conciliar: 51 tablas/493 filas,
  snapshot consistente, cifrado y segunda copia con hashes coincidentes;
  restauracion de esta copia posterior aun pendiente. No confundirla con el
  FINAL previo que SI fue restaurado.
- QA independiente aprobo cierre DB/mantenimiento, con alcance limitado:
  inspeccion de codigo/digest y JSON de verificacion identicos, no una
  reproduccion cloud ni del contenedor/cifrado. Reapertura/MFA no aprobados por QA.

Los ensayos ficticios no usaron esta copia ni datos reales como fixtures.
La copia offline verifica filas Auth/MFA, no la recuperacion independiente del
servicio Auth, su configuracion externa o llaves de cifrado del proveedor.
No se cambiaron cuentas, passwords, llaves ni enrolamientos MFA.

## Checkpoint de preparacion - 2026-10-08 Colombia

El titular cambio explicitamente el objetivo a terminar la migracion en
produccion y funcionando. Esto autoriza preparar/publicar el corte del plan,
no omitir el respaldo FINAL ni habilitar cobros sin la confirmacion posterior.
La configuracion Vercel sigue a cargo del titular. No cambiar llaves ni cuentas.

Preflight de PostgreSQL productivo de solo lectura correcto, identidad esperada
y TLS verificados; no se aplico SQL 0.4.0 ni se hicieron mutaciones financieras.
Storage vacio en la observacion: el respaldo de DB no sustituiria los bytes de
archivos si aparecieran objetos antes del snapshot FINAL. Auth y factores MFA
existentes se conservaran; la restauracion offline compara filas, no recrea el
servicio Auth ni acredita recuperar configuracion externa o secretos del proveedor.

GitHub: Monthly Charges y Refresh Repository Activity disabled_manually,
Production cutover/false, cero runs no terminales tras la pausa. Keepalive aun
activo; pausarlo/drenarlo durante la ventana FINAL/SQL porque la revision anterior
puede expirar checkouts. Vercel/mantenimiento y respaldo FINAL aun pendientes.
No hubo push ni despliegue en esta comprobacion. Este registro es un checkpoint,
no acredita por si solo que los controles sigan iguales al ejecutar la migracion.

## Cambios concretos de DB

| Objeto | Cambio | Informacion anterior |
|---|---|---|
| billing_cycles | Nueva tabla: agrupa original/adicional, autorizacion y snapshot inmutable; ventana colombiana, cierre y bloqueo. | No se crean ciclos para pagos historicos. |
| subscriptions | billing_authorization, billing_authorization_revoked_at, billing_hold_reason. | Filas anteriores permanecen intactas; no se infiere consentimiento. |
| checkout_intents | retry_authorization para consentimiento explicito y opcional del mensual. | No altera vigencia, importe, referencia ni checkouts anteriores. |
| payment_attempts | cycle_id, attempt_number, parent_attempt_id, verified_reason, verified_status_message, verified_finalized_at, verified_evidence, send_authorized_at, send_window_end, dispatch_snapshot. | Campos nuevos NULL en historicos; conserva transacciones y fuentes tokenizadas. |
| admin_audit_logs | request_fingerprint y committed_response para devolver cambios ya confirmados. | Conserva auditorias; autorizacion ausente se muestra como desconocida. |
| Indice mensual | Reemplaza payment_attempts_subscription_period_unique por unicidad parcial legacy, y agrega unicidad ciclo/numero y ciclo abierto. | No borra intentos. No habilita dos originales ni un tercer intento. |
| Constraints y triggers | Amplia estados con cancelled; protege ordinal, vinculos y snapshots inmutables. | Preflight debe comprobar compatibilidad antes de reemplazarlos. |
| Funciones y permisos | RPC v2 reservan, autorizan, concilian y auditan; revoca DML financiero directo y RPC v1 que eluden la barrera. | Conserva recepcion de webhooks y puente de resultados reales; no cambia cuentas, contrasenas ni MFA. |
| Marcador | billing-retry-v0.4.0 con SHA-256 exacto del archivo nuevo. | Marcador/SQL aplicada de 0.3.0 se conservan. |

No hay DELETE, TRUNCATE, DROP TABLE, fusion de donantes ni reescritura de
importes historicos. Los DROP de indice/constraint/trigger son reemplazos de
esquema dentro de la transaccion, no eliminaciones de registros.

El esquema actual impide dos intentos en un mismo periodo. Esta migracion es
necesaria para distinguir original y adicional, congelar su autorizacion y
evitar que un timeout, cancelacion o consumidor antiguo permita otro cargo.
La interfaz compacta, por si sola, no necesita migracion.

## Reglas sobre los existentes

- Los activos anteriores conservan sus originales programados. Sin evidencia
  verificable de autorizacion adicional, no se les agrega un reintento.
- Pending no se activa para limpiar listas. Past_due conserva su revision.
- Unicos siguen solo consulta y sin automatizacion recurrente.
- Monto, COP, fuente, dia y version quedan congelados por ciclo; no se cobran
  cambios al guardar. Reactivar necesita nueva autorizacion y fecha futura.
- Dinero real contradictorio se conserva y se revisa; no se oculta ni reembolsa.

## Herramienta de migracion

La entrada nueva es `scripts/ops/apply-billing-retry-migration.mjs`;
`apply-payment-migration.mjs` sigue apuntando a 0.3.0 y no debe usarse para
actualizar produccion. La nueva entrada exige destino explicito y en produccion
autoriza corte + confirmacion del respaldo en chat + copia restaurada reciente.

Comprueba identidad del proyecto, TLS, hashes cifrados, cobertura de manifiesto,
antiguedad menor de cuatro horas y comparacion del origen bajo locks. Solo admite
recibos nuevos preservables, no cambios silenciosos en tablas historicas.
Preflight, SQL nueva, postflight y contenido original se verifican antes del
COMMIT. Un marcador nuevo exacto no se confunde con perdida del marcador viejo.

Lock maximo 5 s, sentencia 120 s, ejecucion SQL 300 s. Ante respuesta incierta:
cerrar escritor, observar desde conexion nueva de solo lectura, inspeccionar
marcador/digest y contenido. Nunca repetir automaticamente. Mantener cutover.

## Puertas obligatorias

1. Aprobar revision local independiente y revisar interfaz/resultados/riesgos.
2. Autorizacion humana separada para publicar y efectuar corte. Sin ella, no
   commit, push, despliegue, cambios cloud ni SQL productiva.
3. Verificar configuracion real; pausar/drenar workflows y consumidores antiguos.
   Codigo compatible en cutover/false, conservando recibos. No cambiar llaves
   innecesariamente ni confiar solo en la pantalla de mantenimiento.
4. Crear respaldo FINAL privado/cifrado, conservar dos copias, restaurar y
   comparar IDs, contenido, importes, Auth y Storage utilizado. Las dos copias
   en un PC no sustituyen una copia externa privada contra perdida del equipo.
5. Inmediatamente antes de SQL comunicar aqui la confirmacion obligatoria del
   respaldo final, ubicacion, fecha y alcance, sin datos sensibles. Un ensayo
   con fixtures NO autoriza ese mensaje ni reemplaza el respaldo productivo.
6. Ejecutar preflight/migracion/postflight; verificar historicos, MFA, roles,
   RLS, auditoria, recibos acumulados y rechazo de consumidores antiguos.
7. Inventory y conciliacion sin nuevos cargos. Casos ambiguos siguen en revision.
8. Nueva confirmacion humana para abrir donar, finanzas y automatismos.
   No ejecutar charge productivo para probar. Verificar primeras ejecuciones.

## Recuperacion

Antes del COMMIT: rollback. Despues: conservar esquema, recibos y pagos nuevos
en cutover; corregir hacia adelante con codigo compatible. No volver ciegamente
a 0.3.1 ni restaurar una copia anterior encima de movimientos nuevos. Una
restauracion de DB no revierte dinero transferido. Conservar copias, evidencia,
digest, commit y despliegue para la publicacion que se autorice.

Resultados locales y limitaciones: `VALIDATION_0.4.0.md`.
Dependencias y riesgos residuales: `DEPENDENCIES_0.4.0.md`.
