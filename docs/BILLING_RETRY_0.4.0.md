# Reintentos y admin 0.4.0

Implementacion local: 2026-10-08. Corte productivo: 2026-10-09.
Codigo 2769a11 publicado por `codex/monthly-payment-retry`/dev/main y READY
en Production; SQL 0.4.0 aplicada con FINAL restaurado/comparado y originales
intactos. El titular confirmo el panel y reabrio el portal con un redeploy;
runtime y inventory verificados, tres workflows activos, sin cargos de prueba.
Evidencia y limites en `CUTOVER_0.4.0.md` y `REOPENING_0.4.0.md`.

## Alcance

- Registro administrativo compacto, filtros Mensual/Unico y seguimiento separado
  de suscripciones pendientes, pagos pendientes, reintentos y revision manual.
- Escritorio: tabla y resumen lateral. Movil: filas de dos niveles y detalle
  en una columna. Contactos enmascarados, sin documentos, fuente ni `raw`.
- Historial independiente para pagos, intentos y auditoria. Cambios requieren
  Antes/Despues, motivo, version, requestId y TOTP real fuera de la demo.
- Demo ficticia, en memoria/localStorage exclusivamente ficticio; no usa Auth,
  donantes reales ni Wompi. Las mutaciones reales siguen pasando por servidor.

## Regla financiera

Cada ciclo autorizado admite un original y como maximo UN adicional. El
primer mensual sigue siendo inmediato; los siguientes originales respetan
el dia 1, 6, 16 o 28 a las 07:00 Colombia, con almacenamiento UTC.

Solo un GET autenticado de Wompi que coincida en ambiente, referencia, importe,
COP, fuente CARD y motivo exacto `Intente mas tarde - Fondos Insuficientes`
puede habilitar el adicional. Se normaliza NFKC y espacio exterior, sin
coincidencias parciales ni convertir cualquier DECLINED en falta de fondos.
La fuente debe verificarse disponible. La fecha debe ser `finalized_at` UTC
valida, nunca `created_at`, recepcion, reloj actual o fecha enviada por el navegador.

El adicional tiene ventana en el DIA SIGUIENTE colombiano: [07:00, medianoche).
Conserva monto, COP, fuente, periodo, dia y version del original. No existe
recuperacion automatica de una ventana perdida ni un tercer intento. Tras
rechazo adicional, agotamiento, falta de consentimiento o motivo incierto:
`past_due`, proxima fecha automatica nula y revision manual.

Pendiente, timeout y posible envio se concilian por GET sobre el mismo intento.
No se repite un POST financiero. Aportes unicos no se reintentan automaticamente.
La conciliacion de recibos distingue revisiones legacy con identidad de
suscripcion verificada de recibos ambiguos: los primeros bloquean su caso,
no todos los donantes. Un GET historico identico devuelve duplicate sin volver
a modificar el pago; las agendas historicas siguen protegidas.
Los registros antiguos permanecen sin nuevo consentimiento ni ciclos inventados;
sus originales activos siguen posibles, pero sin adicional automatico.

Reactivar exige nueva autorizacion del donante, motivo, MFA reciente, fuente
verificada y fecha futura. Crea otro UUID de ciclo, no reinicia uno agotado.
Guardar nunca cobra. Una aprobacion tardia siempre se registra como dinero real,
pero no revierte cancelaciones, bloqueo manual o cambios administrativos.
Si contradice otra aprobacion, se conserva y se bloquea la automatizacion;
no se oculta el segundo pago ni se reembolsa automaticamente.

## SQL Aplicada en Produccion - 2026-10-09

Nueva migracion: `supabase/migrations/202610080001_billing_retry_cycles.sql`.
La migracion aplicada de 0.3.0 NO se edita ni se vuelve a ejecutar en produccion.

| Objeto | Cambio y motivo |
|---|---|
| billing_cycles | Nueva tabla: periodo, origen, snapshot inmutable, consentimiento, ventana, estado y cierre. |
| payment_attempts | Vinculo de ciclo, numero 1/2, padre, evidencia privada y barrera de envio. Los historicos mantienen NULL en campos nuevos. |
| subscriptions | Autorizacion recurrente verificable, revocacion y motivo de bloqueo. Sin completar historicos por inferencia. |
| checkout_intents | Evidencia opcional de la casilla explicita de reintento, guardada al crear el checkout. No se amplia su vigencia de 30 minutos. |
| admin_audit_logs | Fingerprint de solicitud y respuesta confirmada para replay atomico. |
| Indices | Unicidad ciclo/numero y ciclo abierto; sustituir unicidad mensual antigua por una parcial exclusiva de filas legacy. |
| RPC y permisos | Reservas, barrera, resultados y cambios administrativos v2. Bloquear DML financiero directo y RPC v1 que eludan reglas; conservar recibos y resultados reales. |
| Marcador | Digest SHA-256 y marcador billing-retry-v0.4.0; reapply equivalente, preservacion y comprobaciones antes del COMMIT. |

No DELETE, TRUNCATE, DROP TABLE ni fusion automatica de registros. Se conservan
IDs, relaciones, importes, tarjetas tokenizadas, historiales y cuentas/MFA.
Los reemplazos de indices, triggers, funciones y privilegios son cambios de
esquema controlados, no borrados de donantes o movimientos.

## Barrera e idempotencia

La reserva preparada es cancelable. GET de fuente/aceptacion y preparacion del
request terminan antes de la autorizacion durable de envio. La DB vuelve a
comprobar reloj, ventana, version, snapshot, consentimiento, pendientes y pagos
del mes. Solo un ganador inicia el POST en menos de 15 segundos y antes del
fin de ventana. Perder la respuesta de esa RPC tambien es resultado incierto.

Cancelar antes de la barrera evita el envio; despues, el banco podria finalizar
el cargo ya enviado. No existe transaccion atomica entre PostgreSQL y Wompi.
No se libera una reserva incierta para permitir otro cargo a ciegas.

Replay administrativo: primero sesion, rol/UUID activo, aal2 y TOTP reciente;
despues requestId/fingerprint, antes de version, estado y fuente. Misma solicitud
devuelve respuesta previa; contenido diferente da conflicto. Cambio, auditoria
y respuesta se confirman en la misma transaccion. Cancelar un adicional exige
tambien el UUID del ciclo que el administrador estaba revisando.
La consulta de replay precede tambien cualquier GET Wompi o lectura de estado
actual, para funcionar aunque el proveedor este caido. SQL confirma needsReview
como parte de la misma respuesta guardada. Una diferencia de importe legacy
solo se admite contra un pago historico exactamente vinculado y con referencia
verificada, sin reescribir importes para forzar igualdad.
El fingerprint contiene la semantica solicitada por el administrador, no estado
o fecha variables de Wompi. La misma solicitud pendiente, luego consultada
como aprobada, conserva su respuesta confirmada; la conciliacion independiente
del job/webhook puede aplicar la transicion real sin repetir el cargo.

Keepalive pasa a ser estrictamente de lectura autenticada: ya no llama al RPC
de limpieza antiguo, revocado en este esquema, ni borra historiales.

## Verificacion local

**ESCRITURA LOCAL:** `node scripts/integration/run-demo-local.mjs dev` o `build`.
El launcher fija demo/false, datos ficticios y llaves vacias de Wompi; no cambia
`.env.local`. El build puede enumerar archivos .env, pero las variables usadas
por los consumidores financieros/Auth estan fijadas a valores de laboratorio.

**ESCRITURA LOCAL:** `npm test`, `npm run lint` y `tsc --noEmit` escriben caches
locales. Vitest tiene `envDir: false`; los contratos usan fixtures y mocks.
El contrato antiguo de checkout se conserva SOLO para pruebas comparativas en
`tests/contracts/donations-v030.ts`; no es una ruta ni fallback financiero.
Las pruebas de la ruta real 0.4.0 estan en `retry-route*.test.ts`.

**ESCRITURA LOCAL:** `node scripts/integration/billing-retry-local-e2e.mjs --local-retry-lab=yes`.
Solo acepta `hpe-retry-v040-local`, postgres:16, red `none`, sin puertos publicados.
Cada ejecucion crea una DB ficticia distinta. No carga dotenv, conexiones cloud,
datos restaurados, Auth real, backups ni fuentes reales. El esquema base y la
migracion antigua se aplican solo para construir esa fixture descartable.

La comprobacion visual local esta en `scripts/integration/admin-retry-demo-e2e.mjs`.
Usa el Playwright existente, bloquea trafico exterior y guarda solo capturas ficticias.
Mantenimiento/false produce 503 en la API financiera local.

## Parada antes de produccion

La entrega local por si sola no autoriza publicacion. QA local esta aprobada
con alcance limitado. Posteriormente, el 8 de octubre, el titular solicito
expresamente terminar el corte productivo. FINAL, publicacion y SQL se
completaron el 9 de octubre con las puertas obligatorias. La reapertura
financiera requirio una confirmacion posterior independiente y un nuevo
redeploy del titular; ambos se completaron y verificaron el 9 de octubre.
Procedimiento y evidencia en `REOPENING_0.4.0.md`.
No hay una prueba Sandbox real nueva: su webhook existente apunta a produccion;
no se enviaran transacciones alli desde el laboratorio.
Resultados y limites del candidato: `docs/VALIDATION_0.4.0.md`. Las correcciones
cruzadas se probaron por el integrador/especialistas; QA independiente repitio
rutas y job/SQL dentro de aislamiento OS verificable y aprobo ese alcance local.
No acredita Auth/proveedor/despliegue real. No se debe promover por tener
tests/build en verde.

Durante un corte autorizado: mantener codigo compatible en cutover/false,
pausar/drenar escritores, conservar webhooks y preparar copia privada cifrada.
Restaurar y comparar IDs, contenido, importes, Auth y Storage utilizados. Las
copias existentes no sustituyen una copia FINAL fresca.

Inmediatamente antes de SQL se debe comunicar:
**Respaldo final completado y verificado; restauracion y comparacion correctas**,
con ubicacion, fecha y alcance sin datos sensibles. Cualquier fallo detiene el corte.

SQL: lock 5 segundos, sentencia 120 segundos y presupuesto global 5 minutos.
Respuesta incierta: inspeccionar marcador/digest desde otra conexion, no repetir
a ciegas. Despues: postflight, historial, Auth/MFA/RLS, recibos e inventory y
conciliacion SIN cargos. Reabrir portal/finanzas/workflows requiere otra aprobacion.
Ante fallos post-SQL, conservar esquema y recibos en mantenimiento. No restaurar
una copia antigua encima de movimientos nuevos; restaurar DB no revierte dinero.

La entrada nueva es `scripts/ops/apply-billing-retry-migration.mjs`. Selecciona
solo la SQL nueva y no repite la anterior. El ensayo de copia restaurada usa
datos ficticios, no un respaldo real. Objetos concretos, controles y puertas:
`docs/CUTOVER_0.4.0.md`. No ejecutar SQL productiva sin completar sus puertas,
incluida la confirmacion del respaldo FINAL inmediatamente antes de SQL.

## Costos y proveedores

No se agregaron proveedores, suscripciones, SMS ni servicios de pago.
El objetivo sigue siendo cero costo adicional dentro de cuotas existentes,
sin prometer gratuidad ilimitada ni eliminar comisiones de Wompi.
Se mantiene `/merchants/info` con `x-merchant-public-key`, conforme a
[Wompi: tokens de aceptacion](https://docs.wompi.co/docs/colombia/tokens-de-aceptacion/).
