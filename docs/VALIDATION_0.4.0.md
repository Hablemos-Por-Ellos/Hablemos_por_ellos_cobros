# Validacion 0.4.0 - Local y Corte Productivo

Fecha: 2026-10-08. Rama: `codex/monthly-payment-retry`. Base: `46ffa2b`.
Estado de la validacion local: cambios entonces SIN commit, push, release,
despliegue ni SQL productivo. Produccion quedo fuera de esas pruebas.
Checkpoint historico de preparacion: autorizacion recibida el 8 de octubre;
preflight productivo de solo lectura correcto y 66 archivos preparados en Git.
Monthly/Repository Activity pausados, GitHub cutover/false y cero runs activos.
FINAL/publicacion/SQL estaban pendientes en ese checkpoint. Se completaron
el 9 de octubre, con evidencia operativa distinta al final de este documento
y en CUTOVER_0.4.0.md. Reapertura e ingreso actualizado siguen pendientes.

## Evidencia y limites

| Comprobacion | Resultado local |
|---|---|
| Vitest | 1.213 pruebas correctas en 46 archivos; un archivo con seis pruebas SQL opt-in omitido por defecto. |
| Rutas HTTP -> PostgreSQL | Seis pruebas opt-in correctas contra SQL final. Auth/Wompi inyectados, rollback; no SSR ni Auth real. |
| Job/recibos -> PostgreSQL | Quince escenarios, 313 comprobaciones, 182 RPC (106 desde job/recibos); cero fetch externos, rollback y hashes originales preservados. |
| ESLint y TypeScript | Correctos; build Next valida tipos tambien. |
| Build | Launcher demo con variables ficticias: Next 15.5.27, consumidores Auth/financieros fijados a fixtures, finanzas false. No es un despliegue ni acredita un sandbox OS. |
| PostgreSQL | Regresion SQL, preflight/postflight, reapply mismo digest y contenido original de las cinco tablas correctos en fixture. |
| Desconexion antes del COMMIT | Rollback observado desde una conexion nueva; contenido original identico. |
| Desconexion despues del COMMIT | Marcador/digest observados desde una conexion nueva; no se repite la SQL automaticamente. |
| Herramienta operativa | Entrada nueva 0.4.0 selecciona solo SQL/preflight/postflight nuevos. Ensayo real con copia ficticia cifrada/restaurada: 13 tablas/7 filas, contenido/permisos cobertura 5, cero diferencias; preservacion bajo locks antes de COMMIT correcta. No es el respaldo productivo FINAL. |
| Concurrencia real | 26 comprobaciones, ocho reservas/claims simultaneos y seis carreras cancelar/enviar. Solo un ganador del envio. |
| Navegador | 94 comprobaciones, 21 capturas ficticias, desktop 1440, tablet 768, movil 390 y 320 px. Sin overflow horizontal, filtros/estado vacio, confirmacion y cancelacion demo; /donar abre y su API rechaza cargos con 503. |
| Trafico | Docker red none, sin puertos. Playwright permite solo 127.0.0.1:3000; cero solicitudes exteriores observadas. No llamadas financieras reales. |
| Datos | 66 archivos modificados/nuevos revisados: cero archivos sensibles y cero candidatos a secretos literales en el chequeo dirigido. Fixtures/capturas y copia cifrada son ficticias; no se leyeron .env ni dumps productivos. El ensayo operativo usa solo credenciales inventadas fuera de Git. No es una auditoria exhaustiva. |

Ultimo laboratorio ficticio: `hpe_retry_lab_1791517849626`, contenedor
`hpe-retry-v040-local`, imagen `postgres:16`, sin red ni puertos publicados.
Digest SQL comprobado:
`dbb0b98ca4d44f0d999d0f7a77b28d9e88fb6d71799e577a0a65491533f3b34d`.
No equivale a restauracion del respaldo productivo; solo se comparan fixtures.
El contenedor conserva sus bases ficticias, sin eliminaciones. Docker Desktop
se cerro durante la repeticion final y las pruebas se detuvieron antes de SQL.
Se recupero el motor; PostgreSQL completo recovery y se verifico de nuevo el
marcador. Concurrencia y seis contratos HTTP/SQL se repitieron correctamente.
En ese cierre local el indice Git estaba vacio. En la preparacion posterior
del corte se prepararon 66 archivos; todavia sin commit ni push en ese checkpoint.

La ultima copia FICTICIA se creo a `2026-10-09T04:00:01.039Z` (8 de octubre
Colombia), se restauro a `2026-10-09T04:00:15.951Z`: manifiesto 5, 13 tablas/7
filas, cero diferencias en IDs/contenido/esquema/ACL. Se conservo cifrada fuera
de Git. El runner nuevo migro su origen ficticio separado `_before` con esa
copia verificada. El ensayo no certifica datos/Auth/Storage reales.

## Revision independiente

La primera ronda de QA rechazo cuatro cruces API/job/SQL, todos corregidos y
verificados en la segunda ronda independiente:

- Una revision historica ligada a una suscripcion no debe bloquear globalmente
  los cobros. Su caso individual sigue protegido por SQL; recibos ambiguos o
  fallos operativos siguen deteniendo nuevos envios.
- Un ciclo recien reservado debe conservar `retryEnabled` y su `cycle_id` al
  aplicar el primer GET. Sin esa evidencia, no se debe inferir consentimiento.
- La conciliacion administrativa debe enviar el envelope completo dentro de
  `transaction`, incluida fuente, metodo, ambiente y motivo verificado.
- Un aporte unico v2 se identifica por ordinal de intento aunque no tenga ciclo;
  su webhook conserva/aplica el pago sin depender de que vuelva el navegador.

La integracion tambien corrigio la reserva de checkout: consume el ID anidado
de `attempt` y exige que coincida con `dispatchSnapshot`, como devuelve SQL.

La segunda ronda todavia RECHAZO la version `e173965e...`: el fingerprint de
conciliacion incluia estado/fecha variables del proveedor. Se corrigio despues
para usar solo la solicitud del administrador; la reproduccion PostgreSQL
pendiente -> aprobado con el mismo requestId devuelve la respuesta confirmada
y una sola auditoria. Cambiar el motivo conserva el conflicto; la API responde
409, no 500. Una revision especializada posterior reforzo replay antes del
GET/SELECT, needsReview confirmado, importes historicos con referencia exacta,
cycleId obligatorio al cancelar adicional y consentimiento antiguo desconocido.
La prueba cruzada detecto 402 al repetir confirmacion aun con retry_wait: SQL
ahora retorna retryQueued desde el ciclo durable y la API conserva 202, un POST.

La nueva revision independiente primero RECHAZO el cierre por no disponer de
aislamiento OS verificable para reproducirlas. La unica ronda correctiva de
infraestructura resolvio ese bloqueo sin instalar dependencias ni servicios.
QA ahora APRUEBA LOCAL con alcance limitado y sin defectos bloqueantes
confirmados en su lectura/reproduccion. No es una aprobacion productiva.

Reproduccion independiente: seis casos de rutas, 126 aserciones, 72 RPC reales,
28 consultas y seis rollbacks; quince escenarios job/SQL, 313 comprobaciones,
182 RPC y 17 errores SQL esperados. Ambos procesos terminaron 0, sin timeout
ni fetch externos; preservacion y hashes de fuente verificados.

El executor de rutas es alternativo (TypeScript 6 + node:assert), NO Vitest
nativo; conserva los seis casos, hooks y aserciones y falla ante API no
soportada. La unica transformacion del test identifica su backend fisico
privado. La inspeccion interna es una atestacion del supervisor; QA inspecciono
por separado el aislamiento real. No se copio ni transformo codigo de producto.

Perfil comprobado: codigo/toolchain RO, sin .env/.git/home/secretos ni socket
Docker; env -i con allowlist, namespace loopback privado con backend network
none, CPU 1, RAM 512 MiB, 64 procesos, archivo 16 MiB, scratch runtime 64 MiB,
scratch PG 256 MiB y deadline runtime 90 s. Se uso Node 22.23.2 de una imagen
local existente fijada por digest, sin descargar herramientas. Replica SQL
exclusivamente ficticia, UTF8, con marcador final exacto. Los controladores
temporales permanecen fuera de Git; no son componentes de la aplicacion.
Los dos laboratorios se detuvieron al terminar para liberar recursos. No se
elimino la base ficticia principal ni las copias cifradas. La replica privada
de QA usaba scratch tmpfs volatil y se debe reconstruir antes de otro rerun;
los comandos de QA registrados no funcionan con el backend detenido.

Concurrencia, herramienta operativa/COMMIT y copia ficticia mantienen evidencia
del integrador, NO fueron repetidas por la QA final. Auth/TOTP/SSR reales,
Wompi HTTP, cambios exactos del reloj, despliegue y configuracion productiva
permanecen fuera de esa aprobacion. Las nueve alertas dev siguen documentadas.

## Dependencias

Actualizaciones locales sin salto mayor: Next/eslint-config-next 15.5.27,
sharp 0.35.5 y source-map-js 1.2.2. `npm audit --omit=dev` da cero alertas.
El audit completo conserva nueve alertas transitivas de herramientas de
desarrollo (braces/chokidar/micromatch/fast-glob y postcss-selector-parser).
No se uso `npm audit fix --force` ni se salto a Tailwind 4. Los patrones,
selectores y fuentes de build se mantienen locales/confiables. La revision
especializada delimito los avisos al parsing de entradas no confiables en
herramientas; no encontro esa via en solicitudes de ejecucion de esta app.
No se declaran resueltos: alcance y fuentes en `docs/DEPENDENCIES_0.4.0.md`.
Una copia externa con `npm ci --omit=dev` cargo el entry point e inventory
con fixtures, cero fetch y escrituras. No certifica el job en produccion.

Referencias primarias de los parches:
[Next](https://github.com/advisories/GHSA-mcj8-r9mp-w47p),
[sharp](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) y
[source-map-js](https://github.com/advisories/GHSA-68fv-2mgg-jv7q).
La ausencia de alertas runtime no demuestra ausencia de vulnerabilidades.

## Estado por fases

1. Interfaz local: implementada y ejercitada con datos ficticios.
2. Reglas locales: implementadas y probadas con reloj/GET/POST ficticios.
3. SQL/laboratorio: preparados/probados; QA local aprobada con el alcance anterior.
4. Explicacion/autorizacion y FINAL: completados el 9 de octubre; copia real
   cifrada/restaurada/comparada, 50 tablas/490 filas y cero diferencias.
5. Publicacion/migracion productiva: aplicadas y comprobadas en mantenimiento.
   Reapertura financiera y nuevo ingreso del titular: pendientes de confirmacion.

La autorizacion posterior no sustituye escritores pausados/drenados,
respaldo fresco cifrado/restaurado/comparado y
confirmacion explicita aqui inmediatamente antes de SQL. No reutilizar estas
pruebas ficticias como evidencia de respaldo final, Auth/RLS real, integracion
Wompi Sandbox ni cobros productivos. No volver al esquema/codigo anterior a
ciegas ni restaurar una copia antigua sobre movimientos posteriores.

## Evidencia Operativa Productiva - 2026-10-09

Esta evidencia es posterior y distinta de la QA local anterior. No convierte
la reproduccion ficticia en una prueba de pagos reales o Auth remoto.
Codigo 2769a11/0.4.0 READY en Preview dev y Production. FINAL real restaurado
y comparado antes del mensaje obligatorio y SQL; marcador exacto confirmado
a las 05:40:17.068 UTC, postflight fresco y originales con cero diferencias.

Job nativo contra PostgREST actual, schema v040 explicito: inventory correcto,
sin fallback/errores, cuatro GET y dos RPC readiness de solo lectura. Dos
historicos necesitan verificacion de evidencia nueva; reconcile hizo dos GET
Wompi y dos RPC de resultados, reconciled=2, failed=0, charged=0 y sent=0.
Una barrera HTTP independiente impidio POST al proveedor y reservas/envios.
No habia originales vencidos, ciclos nuevos ni recibos v1 por conciliar.
Postflight posterior a reconcile: todos los registros originales con cero
diferencias, unicamente dos eventos canonicos nuevos de verificacion; total89.
Seis GET anonimos a tablas privadas rechazados con 42501, cero filas expuestas.
Bootstrap sin sesion 403 y APIs financieras invalidas en cutover 503.
QA independiente aprueba DB/mantenimiento tras inspeccionar codigo/digest y
proof JSON; no reprodujo cifrado, contenedor ni cloud y no aprueba reapertura.

El login sirve 0.4.0, donar mantiene la redireccion y acceptance rechaza con
503. No se probaron mutaciones sobre donantes reales ni cargos de prueba.
Cuentas/factores existentes conservados; confirmacion del ingreso actualizado,
reapertura y primera ejecucion normal siguen pendientes. Recuperacion y limites
del laboratorio/backup Auth externo: `CUTOVER_0.4.0.md`.
