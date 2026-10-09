# Corte 0.4.0: preparacion autorizada, migracion pendiente

Fecha: 2026-10-08 Colombia. Rama local `codex/monthly-payment-retry`.
NO ejecutar esta fase por disponer de un build correcto. El plan aprobado y
una solicitud general de continuar no sustituyen la autorizacion separada de publicacion
y corte, ni la confirmacion posterior de reapertura financiera.

## Estado operativo - 2026-10-08 Colombia

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
