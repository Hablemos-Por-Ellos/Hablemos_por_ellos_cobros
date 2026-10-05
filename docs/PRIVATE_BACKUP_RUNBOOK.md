# Respaldo privado y restauracion local - v0.3.0

Este procedimiento no autoriza una migracion productiva. No incluye contrasenas,
URLs privadas, datos de donantes ni archivos de respaldo.

## Fuente y archivos

- La conexion PostgreSQL privada es distinta de la llave API de Supabase.
- Guardar conexion y CA en archivos `.local` ignorados por Git. No imprimirlos.
- El origen productivo usa TLS verificado y sesiones de solo lectura.
- Dump y manifiesto provienen del mismo snapshot REPEATABLE READ.
- Los archivos se cifran con AES-256-GCM y scrypt, y se comparan mediante SHA-256.
- Conservar la clave privada utilizada al crear la copia: cambiar la contrasena
  PostgreSQL despues no cambia la clave de archivos ya cifrados.
- Guardar fuera del repo y conservar una segunda copia privada. No hay borrado automatico.
- En Windows, verificar ACL NTFS y acceso del operador que va a restaurar;
  mode:0600 no acredita por si solo permisos NTFS. No abrir la copia a Todos.
  Si el proceso autorizado no puede leerla, detenerse y resolver el acceso con
  el titular antes de declarar la copia restaurable o crear mas destinos.
  Verificar tambien que existan los grants requeridos en cada archivo, no solo
  que no haya grants ajenos. Una DACL protegida vacia deniega la lectura normal.
  No aplicar recursivamente a archivos la retirada de herencia junto con flags
  de grant exclusivos de directorios. Los flags (OI)/(CI) son de directorio;
  verificar grants de archivo efectivos y lectura despues de cualquier ajuste.
- El dump contiene metadatos de Storage, no sus archivos. Si hay objetos, completar
  su respaldo separado; la herramienta no certifica una copia incompleta.

## Restauracion

ESCRITURA LOCAL: restaurar solo en una base nueva y vacia, dentro de un contenedor
de laboratorio etiquetado, con red `--internal`, sin puertos publicados ni acceso
desde Internet. Nunca apuntar la restauracion a Supabase productivo.

El instalador local conserva los propietarios originales de las extensiones.
Para esa fase aislada utiliza privilegio de instalacion y un ajuste temporal de
Supautils; ambos se restauran y comprueban antes de seguir con triggers. No copiar
contrasenas de los roles productivos. Los roles copiados no permiten login.

Restaurar ACL de schemas desde el manifiesto, incluidos permisos que pg_dump no
emite para schemas administrados. Comparar permisos de tablas y columnas, propietarios, roles,
restricciones, funciones, triggers, politicas, indices y privilegios por defecto.
No ignorar diferencias para obtener una marca verde.

PostgreSQL puede representar los mismos casts CHECK de forma distinta tras
pg_restore. Ambas definiciones se vuelven a parsear con el mismo motor en tablas
temporales revertidas; las definiciones originales siguen en el manifiesto.
Una regla realmente diferente sigue produciendo fallo.

La comparacion de datos verifica IDs y hashes del contenido de cada fila, no solo
conteos. La evidencia `verification.json` solo marca `restorationVerified=true`
cuando la comparacion de datos termina con cero diferencias. Para certificar
tambien todos los permisos y autorizar una migracion, exigir cobertura 5,
`columnPermissionsCompared=true` y `schemaAndPermissionsCompared=true`.
Las copias antiguas conservan su utilidad para recuperacion pero no certifican
los grants por columna. No se eliminan ni se aceptan como respaldo final.

El destino se valida por contencion real de rutas, incluidos junctions.
Un subdirectorio con nombre `..algo` sigue estando dentro del repo y se rechaza.

## Corte y recuperacion

- Una restauracion de ensayo no reemplaza una copia final fresca tras drenar escritores.
- Mantener pausados Monthly Charges, Keepalive y Repository Activity durante
  la preparacion del respaldo final y el corte, no solamente durante SQL.
  Comprobar ejecuciones en curso y excluir consumidores/escritores anteriores.
  Mantenimiento de paginas no bloquea por si solo APIs ni webhooks.
- Confirmar ubicacion, fecha, alcance y verificacion en el chat antes de SQL productiva.
- Comparar columnas originales antes y despues de migrar. Solo permitir recibos
  sanitizados v1 nuevos expresamente identificados, nunca perder o modificar historia.
- No repetir una migracion tras desconexion o COMMIT incierto; inspeccionar su marcador.
- Si algo falla, conservar mantenimiento y bloqueo financiero, copias y recibos nuevos.
- No restaurar una copia antigua encima de actividad posterior sin recuperar y
  conciliar esos cambios. Restaurar la DB no revierte cargos de Wompi.

## Guard del aplicador - 2026-10-04

El aplicador es dueno de una sola transaccion READ COMMITTED. Descubre las tablas
existentes de una lista cerrada de doce tablas public afectadas por esta SQL y
toma ACCESS EXCLUSIVE con limite de bloqueo de cinco segundos;
las lecturas/escrituras concurrentes pueden esperar durante esta ventana.
No solicita locks escritores de tablas gestionadas de Auth/Realtime/Storage.
Compara inventario fresco, contenido y metadatos completos de todas las tablas
respaldadas antes del DDL; reducir el scope del LOCK no reduce la comparacion.
Una diferencia fuera de recibos v1 nuevos detiene el proceso sin confirmar.
Los recibos admitidos pasan a formar parte del baseline protegido: no se
pueden perder durante SQL. Restablece search_path y verifica preservacion de
columnas originales, marcador y postflight antes del unico COMMIT.

El watchdog limita a 300 segundos la fase escritora; no incluye descifrar el
backup ni la observacion posterior de recuperacion. Los wrappers exteriores
solo se extraen de los tres archivos SQL versionados reconocidos. El contenido
logico de la migracion no se modifico; verificar la huella fisica del artefacto
exacto, incluyendo saltos de linea, antes de aplicarlo o comparar un marcador.

Los locks no impiden cambios globales de roles/funciones ni crear otros objetos:
la exclusion de escritores DDL/ACL sigue siendo un requisito operativo. El
inventario de filas cubre tablas ordinarias; no certificar cobertura universal
de foreign tables, vistas materializadas o particiones sin un ensayo especifico.

Un marcador preexistente con el mismo digest acredita una version aplicada,
no necesariamente el COMMIT del intento actual. En cualquier fallo el resultado
sigue siendo no verificado, conserva cutover y no reintenta automaticamente.
El ensayo local del guard utiliza un manifiesto ficticio en memoria y transporte
local; no sustituye la prueba de descifrado/restauracion del respaldo final real.

## Huella y verificacion operativa - 2026-10-04

El checkout Windows cambio los saltos de linea fisicos de la SQL a CRLF, sin
cambios de contenido registrados por Git. No confundir equivalencia normalizada
con identidad binaria: conservar el archivo exacto ensayado y registrar su SHA-256
al aplicar. El marcador y el observador utilizan esa huella, no una historica.

La nueva copia de preparacion del 4 de octubre se creo correctamente, pero su
primera restauracion quedo NO VERIFICADA por acceso denegado local a los archivos.
La lectura manual fuera de Codex reprodujo el error. Get-Acl confirmo una DACL
protegida vacia en los tres archivos, mientras la carpeta conserva los grants
de la cuenta creadora y SYSTEM. Es un error del ajuste NTFS, no un bloqueo de
sandbox demostrado. Tras autorizacion explicita se corrigieron solo los tres
archivos con grants de archivo del operador y SYSTEM, sin flags de directorio
ni recurrencia. Se verificaron grants requeridos, ausencia de grants ajenos,
lectura y coincidencia con los hashes cifrados originales.

La restauracion posterior termino con 43 tablas/409 filas y cero diferencias,
cobertura 5, comparacion de columnas originales y permisos de schema/columna.
La segunda copia se creo despues de actualizar verification.json: los tres
archivos coinciden por SHA-256. En su carpeta vacia se fijo primero una ACL
privada; los archivos copiados conservaron grants al desactivar herencia con
copia de ACEs, no retirandolas. Ambas copias siguen privadas y legibles.

Se ensayaron aplicacion/reaplicacion del artefacto SQL exacto en la copia Docker
restaurada, sin red externa. El laboratorio contiene ahora el esquema ensayado,
no una base vacia. No restaurar encima ni usarlo como destino del respaldo final.
El respaldo cifrado no se modifico por el ensayo. Las copias permanecen en el
mismo PC: no certifican una copia externa o recuperacion ante perdida del equipo.
Esto NO es el respaldo FINAL: antes del corte efectivo faltan excluir escritores,
crear/verificar una copia fresca y el mensaje obligatorio previo a SQL productiva.
Evidencia vigente: docs/CUTOVER_2026-10-04.md.

El laboratorio de preparacion se uso despues para ensayar conciliacion historica:
37 pagos existentes recibieron solo reference, approved_at, provider_effective_at
y billing_review_required verificados; se agregaron 37 eventos canonicos.
Sus agendas y campos originales permanecieron iguales. El ensayo y su repeticion
no modificaron los archivos cifrados: sus hashes originales y la segunda copia
se comprobaron nuevamente. No confundir el estado enriquecido del laboratorio
con el snapshot original ni con una conciliacion productiva. La restauracion
del respaldo final necesita otro destino vacio y aislado; no sobrescribir este.

Generar los manifiestos comparados dentro de transacciones con contexto
equivalente. databaseManifest usa SET LOCAL search_path=pg_catalog, que fuera
de una transaccion no fija ese contexto; en el diagnostico local produjo
diferencias de representacion en dependencies, triggers y policies sin cambios
reales. No omitir diferencias ni permitir escrituras para hacer pasar el guard:
corregir el contexto del ensayo y repetir la comparacion antes de COMMIT.

Restriccion posterior del titular: dejar las bases tal cual. No ejecutar mas
escrituras ni una migracion productiva sin nueva autorizacion. Conservar las
copias y el laboratorio ya ensayado, sin borrar ni restaurar automaticamente
para deshacer pruebas. Supabase productivo solo recibio consultas de lectura.

Continuacion autorizada posterior: el titular pidio completar el paquete
conservando todos los registros, IDs y estados. La restriccion historica anterior
no bloquea preparar el corte, pero no se autoriza reconstruir casos ambiguos,
omitir gates, cobrar ni reabrir. All Deployments fue guardado por el titular;
dos accesos publicos redirigen a autenticacion. Eso no revoca claves retenidas:
validar consumidores con la credencial exclusiva y retirar accesos antiguos
antes de crear el respaldo FINAL fresco. La creacion de esa llave y su guardado
privado por el titular siguen pendientes; no copiar valores a este documento.

El respaldo de preparacion y su gemela siguen intactos, no son el FINAL. Para
la nueva copia usar un destino vacio distinto, comprobar ACL requeridas y hashes,
restaurar/comparar contenido, IDs, esquema y permisos y conservar segunda copia.
Justo antes de SQL productiva, publicar la confirmacion obligatoria en el chat;
sin esa evidencia y mensaje no ejecutar la migracion. No restaurar encima del
laboratorio ya migrado/enriquecido ni sobrescribir actividad posterior.

Antes del snapshot FINAL, cutover por si solo no acredita ausencia de escrituras.
Mantener pausados keepalive y reconcile y excluir llamadas directas; la limpieza
de intents puede escribir cuando existe su RPC y Auth tiene operaciones mutantes.
Drenar procesos antes de retirar accesos: un job legacy que supero sus lecturas
puede enviar un cargo aunque la llave se revoque despues. Excluir tambien APIs
antiguas capaces de generar firmas sin DB. No reconstruir codigo antiguo con
la configuracion nueva ni reutilizar el nombre GitHub anterior para la llave nueva.
HEAD/GET SDK local y metadata cloud no acreditan el consumidor Production activo.

Instruccion posterior del titular: conservar llaves actuales y hacer respaldo/SQL
con los consumidores conocidos pausados/protegidos y codigo cutover/false. No
certificar retiro de credenciales ni exclusion universal de copias desconocidas.
El aplicador conserva comparacion fresca bajo locks, preservacion pre-COMMIT y
parada sin reintento ante cambios o respuesta incierta. Las carpetas padre de
backup no son necesariamente privadas: fijar ACL en el nuevo destino antes de
escribir, verificar grants de archivos y no alterar copias anteriores.

Respaldo FINAL del corte 2026-10-04 Colombia creado y restaurado el 5 de octubre
UTC: 43 tablas/410 filas, cobertura 5, contenido/IDs/esquema/permisos verificados
sin diferencias. Tres archivos cifrados/evidencia coinciden con la segunda copia
privada del mismo PC. Destinos y hashes en CUTOVER_2026-10-04.md. Aun exigir el
mensaje en el chat inmediatamente antes de SQL; no abrir cobros automaticamente.

El primer intento productivo del corte se detuvo sin quedar aplicado: observador
nuevo verifico parada del escritor, ausencia de marcador y preservacion. Causa:
el LOCK previo intentaba tablas internas sin privilegio escritor. La lista cerrada
de tablas de app corrige el aplicador, no la SQL ni permisos productivos. Ensayo
local con postgres no-superusuario reprodujo 42501 para la tabla interna y paso
el scope corregido. Para probar DDL como en origen, alinear el propietario de la
DB de laboratorio con el de origen: pg_database_owner depende de ese contexto.
No conceder permisos mas amplios al origen para compensar diferencias del lab.
El ensayo completo migro ahora la DB FINAL local; ya no es un destino vacio.
Conservarla y las copias cifradas; no restaurar encima. Nuevo intento productivo
solo tras inspeccion, correccion y pruebas, nunca como reintento automatico.

El nuevo intento controlado del corte confirmo COMMIT productivo el
2026-10-05T02:21:40.210Z, despues de reiterar la confirmacion del FINAL en chat.
Observacion independiente: marcador/digest exactos, 43 tablas originales con
cero diferencias y conteos preservados. Esta SQL ya esta aplicada; no repetirla
automaticamente al publicar el aplicador ni por nuevos pendientes de Auth.

El respaldo FINAL previo permanece cifrado y restaurado/comparado. Se conserva
ademas un snapshot posterior 2026-10-05T02:26:21.680Z, 50 tablas/411 filas y
dos copias privadas con hashes coincidentes. La copia posterior es consistente,
pero todavia NO restaurada. Destinos/digests en CUTOVER_2026-10-04.md. Mantener
ambos snapshots y los laboratorios; no restaurar encima de produccion ni perder
registros posteriores. La migracion de datos no revierte dinero en Wompi.

Nueva pareja posterior a la conciliacion: snapshot 2026-10-05T03:35:24.362Z,
50 tablas/448 filas. Tres SHA-256 coincidentes entre D: y C:, permisos privados
heredables comprobados antes de generar/copiar y grants de cada archivo
verificados despues. Destinos/digests en CUTOVER_2026-10-04.md. Conservar las
copias previas; ninguna se sobrescribio ni se restauro encima del laboratorio.
Esta copia nueva tiene snapshotConsistent=true y restorationVerified=false:
no convertir igualdad de hashes o creacion exitosa en prueba de restauracion.
