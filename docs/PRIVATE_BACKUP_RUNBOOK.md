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

El aplicador es dueno de una sola transaccion READ COMMITTED. Descubre tablas
existentes y toma ACCESS EXCLUSIVE con limite de bloqueo de cinco segundos;
las lecturas/escrituras concurrentes pueden esperar durante esta ventana.
Compara inventario fresco, contenido y metadatos completos antes del DDL.
Una diferencia fuera de recibos v1 nuevos detiene el proceso sin confirmar.
Los recibos admitidos pasan a formar parte del baseline protegido: no se
pueden perder durante SQL. Restablece search_path y verifica preservacion de
columnas originales, marcador y postflight antes del unico COMMIT.

El watchdog limita a 300 segundos la fase escritora; no incluye descifrar el
backup ni la observacion posterior de recuperacion. Los wrappers exteriores
solo se extraen de los tres archivos SQL versionados reconocidos. El archivo
de migracion original y su digest permanecen intactos.

Los locks no impiden cambios globales de roles/funciones ni crear otros objetos:
la exclusion de escritores DDL/ACL sigue siendo un requisito operativo. El
inventario de filas cubre tablas ordinarias; no certificar cobertura universal
de foreign tables, vistas materializadas o particiones sin un ensayo especifico.

Un marcador preexistente con el mismo digest acredita una version aplicada,
no necesariamente el COMMIT del intento actual. En cualquier fallo el resultado
sigue siendo no verificado, conserva cutover y no reintenta automaticamente.
El ensayo local del guard utiliza un manifiesto ficticio en memoria y transporte
local; no sustituye la prueba de descifrado/restauracion del respaldo final real.
