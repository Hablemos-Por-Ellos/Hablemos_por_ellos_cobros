# Validacion local 0.3.0

Fecha comercial: 2026-10-03, America/Bogota. Rama local:
`codex/admin-wompi-hardening`. Este informe no aprueba una release ni produccion.
Actualizacion operativa: 2026-10-04, America/Bogota. Las fechas anteriores
corresponden a los ensayos indicados, no a una migracion ni despliegue posterior.

## Estado vigente del cierre local

Consultar `LOCAL_CLOSURE_2026-10-04.md`: 897 pruebas/37 archivos, lint, build,
UI administrativa real y guard del aplicador ensayados. Auth paso dos
repeticiones de 66 checks despues de una incidencia MFA no reproducida, con
causa no demostrada. El ensayo financiero Sandbox anterior ya paso sus 20
checks; la entrega automatica del webhook externo sigue sin probarse.
Monthly Charges y Keepalive estan pausados segun confirmacion del usuario,
sin verificacion remota en este cierre. Respaldo final y corte siguen pendientes.

Las secciones siguientes conservan el historial de ensayos y restricciones de
sus respectivas etapas. Sus cifras/pendientes anteriores no sustituyen este
estado vigente ni autorizan publicar, migrar o abrir cobros.

## Evidencia historica completada

| Comprobacion | Resultado y alcance |
| --- | --- |
| Aplicacion | 824 pruebas en 36 archivos: incluidas 15 regresiones adicionales de inventory/CLI, cuatro casos de rechazo PEM, tres de DER sobrante y once de aislamiento de configuracion local/Docker; lint correcto. Se probaron ademas cuatro formatos equivalentes de PEM dentro del caso positivo existente. |
| Build | `next build`, comando de `npm run build`, correcto mediante `run-demo-local.mjs build`: modo demo, destinos locales y operaciones financieras deshabilitadas. Se permitio descargar Poppins tras un bloqueo de red del sandbox. No equivale a un despliegue. |
| Migracion de ensayo | Preflight, SQL y postflight en PostgreSQL aislado; los 409 registros originales de 43 tablas conservaron contenido e IDs. |
| Conciliacion integrada | Ocho escenarios de los runners de webhook y job contra RPC reales de PostgreSQL; todas las escrituras de escenario revertidas, cero cargos y cero llamadas Auth. |
| Revocacion concurrente | Tres regresiones ejecutadas contra PostgreSQL con datos ficticios. |
| Supabase Auth real local | 66 comprobaciones con GoTrue, PostgREST, Next y PostgreSQL: invitacion de un uso, contrasena propia, AAL1/AAL2, TOTP, recuperacion de enrolamientos interrumpidos preservando factores verificados/ajenos, allowlist, RLS, CSRF, auditoria, revocacion y logout. Datos ficticios, cero llamadas a proveedores externos y cero cargos. |
| COMMIT incierto | Desconexion real antes de COMMIT: `notapplied`; perdida de ACK despues de COMMIT: `commitverified`. Observador independiente/read-only, sin retry ni restauracion automatica; fuente intacta y recibos conservados. |
| Revision independiente | Tres revisores independientes aprobaron los cierres locales de pagos, respaldo y Auth tras corregir los casos encontrados. Sus revisiones y mocks no reejecutan todos los ensayos del parent. No hay aprobacion productiva ni validacion financiera Sandbox completa. |
| Wompi Sandbox | GET `/merchants/info` y `/tokens/keys/tokenization` respondieron 200. El descriptor real usa PEM en una linea con espacios; se corrigio solo el validador del ensayo, conservando RSA >= 2048 bits y JWE RSA-OAEP-256/A256GCM. El descriptor real paso y se cifro un dato ficticio solo en memoria. No se guardaron llaves ni cuerpos de respuesta; no se tokenizo ni se creo un cobro. |
| Tokenizacion Sandbox autorizada posteriormente | Tras la instruccion de usar la tarjeta ficticia oficial, una prueba puntual desde Node consulto `/tokens/keys/tokenization` (200), valido su descriptor y envio JWE RSA-OAEP-256/A256GCM a `/tokens/cards` (201 / CREATED). Se comprobo el prefijo de token de pruebas sin imprimirlo ni conservarlo. Dos solicitudes Sandbox, cero solicitudes productivas o a DB, cero fuentes y cero transacciones. No ejecuta el widget ni demuestra el flujo financiero completo o la entrega automatica del webhook. |
| Webhook HTTP local en cutover | Ensayo ampliado: 42 comprobaciones sobre ocho tablas, incluyendo payment_attempts, checkout_intents y admin_audit_logs, con dos recibos sinteticos nuevos y contenido anterior de esas tablas intacto. Las primeras ejecuciones de 25/27 solo observaron cinco tablas. GET 405, cuerpo vacio/JSON invalido 400, exceso de tamano 413, firma/ambiente invalidos 401 y recibos validos 200/queued. El perfil rechazo combinaciones financieras y se inicio bajo control del parent; el informe etiqueta expectedMode y no acredita por si solo la identidad/configuracion de otra app ni mide egreso. No prueba entrega automatica de Wompi, aplicacion financiera posterior ni preservacion de tablas no observadas. |
| Aislamiento del laboratorio | Credenciales locales existentes verificadas sin reescribirlas; el helper valida firma JWT, rol, emisor, audiencia y vigencia. Once pruebas offline cubren configuraciones invalidas y Docker --host local con variables remotas eliminadas; no invocan el daemon. Esto no modifica claves productivas ni garantiza que un proceso ajeno en el puerto 3001 use este perfil. |
| Cierre de revision de los ensayos | Tres revisores independientes confirmaron los cierres acotados de DER, JWT/Docker y medicion/documentacion tras las correcciones. Reproducciones en memoria, sin red/DB/secretos; no reejecutaron la suite del parent. Permanece la limitacion declarada de identidad/modo de una app ajena y egreso no medido. La lectura Compose con --host local tambien paso. No aprueba el flujo financiero externo ni produccion. |
| Panel | Demostracion desconectada, busqueda/estado vacio/filtros y confirmacion Antes/Despues. Revisiones a 320, 360, 768 y 1024 px. Se corrigio un desbordamiento de texto `sr-only` en tablas a 1024 px; no administra donantes reales. |
| CORS de laboratorio | Ocho pruebas del proxy loopback y prueba de navegador: solo permite localhost/127.0.0.1 en puerto 3001. Preflight 204 y login ficticio rechazado normalmente con 400, sin error CORS. |
| Inspeccion productiva de solo lectura | PostgreSQL respondio mediante TLS y transaccion repeatable-read/read-only el 2026-10-04 03:31 UTC. Sin nuevas tablas ni marcador de migracion; las suscripciones mensuales activas no estaban vencidas. Esto no certifica salud de todos los servicios de Supabase. No se escribieron registros. |
| Diagnostico previo de inventory | Antes de corregirlo, el transporte restringido permitio tres GET de Supabase y cero llamadas a Wompi. Suscripciones respondio 200; `payment_attempts` PGRST205 y pagos 42703. El CLI termino en error. No se repitio el codigo corregido contra produccion: la autorizacion posterior fue corregir y probar solo localmente. |
| Inventory corregido, integracion HTTP local | SDK real de Supabase contra servidor PostgREST simulado con datos ficticios: 205 pagos en tres paginas, seis GET, cero escrituras/cargos y cero llamadas a Wompi. Resultado `legacy_incomplete`, no readiness. Las pruebas cubren pagos vacios, errores distintos, fallo en pagina posterior y prohibicion del fallback en charge/reconcile. No equivale a PostgREST real ni a una nueva comprobacion productiva. |
| Inventory contra PostgREST real local | Ensayo adicional del 2026-10-04 con SDK, PostgREST y PostgreSQL locales existentes: tres GET, cero solicitudes a Wompi y ninguna solicitud no-GET. Conteos del runner contrastados mediante SQL de solo lectura. Comparacion antes/despues de contenido en 35 tablas public/auth: 244 filas intactas. Resultado `read_only_observation`, sin errores; no habia suscripciones vencidas ni pagos seleccionados en este fixture. Verifica transporte y ausencia de mutaciones, no cargos, paginacion poblada ni readiness productiva. El gateway temporal se cerro al terminar. |
| QA del fallback inventory | Revision estatica independiente sin defecto bloqueante. No ejecuto la reproduccion HTTP ni reensayo produccion. Confirmo que el estado incompleto no autoriza cargos; el CLI lo distingue explicitamente en su resumen. |
| Configuracion Vercel | La sesion correcta de Edge permitio consultar nombres y alcance: diez variables de proyecto en All Environments, sin variables compartidas vinculadas. No se revelaron valores ni se modifico configuracion. El paquete 0.3.0 no esta desplegado. |
| Configuracion Wompi Sandbox | El usuario inicio sesion en la cuenta de la fundacion. Se consulto Programadores en la vista Sandbox; la llave publica visible coincide con la seleccion local, comparada mediante hash sin guardarla en este informe. La URL de eventos apunta al webhook productivo. Bloquea la prueba financiera hasta aislar su destino; no se pulso Guardar ni se rotaron llaves. |
| Limite Data API | Consulta de la interfaz Supabase: Max rows = 1000, paginas del runner = 100. El limite configurado no es inferior al tamano solicitado. No se modifico ni guardo configuracion; no se probo truncamiento deliberado ni paginacion productiva con mas de 100 filas. |

## Revision operativa de solo lectura - 2026-10-04 UTC

- El preflight productivo vigente paso mediante PostgreSQL/TLS con
  `default_transaction_read_only=on`. Conteos observados: 33 donantes,
  27 suscripciones, 39 pagos y 44 eventos historicos; cero recibos v1 y sin
  tabla de marcador de migracion. Cero escrituras productivas. Se debe repetir
  el preflight despues de drenar los escritores para el corte.
- La interfaz del proyecto correcto de Supabase termino mostrando `Healthy`.
  Es una observacion puntual, no una garantia de disponibilidad ni una
  reparacion realizada por este trabajo.
- Los nueve runs mas recientes de GitHub consultados terminaron en `success`.
  `Monthly Charges`, `Keepalive` y `Refresh Repository Activity` figuraban
  `active`. El ultimo cobro programado observado inicio el 3 de octubre a las
  16:05 UTC; el ultimo Keepalive observado, el 1 de octubre a las 09:52 UTC.
  GitHub no garantiza iniciar exactamente a la hora del cron; los horarios
  observados no cambian el calendario comercial colombiano. No se dispararon,
  pausaron ni reintentaron jobs durante esta revision.
- `main` remoto mantiene `0.2.1`; el repositorio sigue publico. `0.3.0` solo
  existe en el arbol local sin commit ni archivos staged.
- Auditoria del registro npm actualizada: runtime, cero avisos conocidos;
  auditoria completa, siete avisos high de desarrollo derivados de `braces`.
  No se ejecuto `audit fix` ni se alteraron dependencias. Esto no demuestra
  ausencia de vulnerabilidades desconocidas o defectos propios del codigo.
- Revision de candidatos a publicacion: 164 archivos, 161 de texto; siete
  coincidencias revisadas corresponden a fixtures ficticios y al PEM privado
  deliberadamente invalido del caso negativo. Cero candidatos sin revisar.
  Este barrido no cubre todo el historial Git ni todos los formatos de secretos.
- Barrido adicional del historial disponible localmente: 661 objetos, 330 blobs,
  328 de texto, incluidas referencias automaticas de captura de Codex. Las seis
  coincidencias revisadas fueron contrasenas ficticias de Compose/tests y el
  PEM invalido del caso negativo. No es un examen del historial remoto aun no
  descargado ni una prueba de deteccion de todos los tipos de secretos.
- La comprobacion del contexto Docker encontro un daemon local sin overrides
  remotos. El pin de `--host` endurece el helper del laboratorio Auth; los
  helpers operativos de respaldo siguen dependiendo del contexto que se debe
  verificar antes de usarlos. No se modificaron contenedores en esta revision.
- El correo de Daniel todavia no esta disponible. No crear una cuenta o
  invitacion supuesta; su alta queda condicionada a recibirlo. La preparacion
  de Mauricio no exige inventar otra identidad ni omitir MFA.
- Sigue pendiente respuesta a la autorizacion para cambios controlados en
  Vercel. Consultar metadata no concede permiso para cambiar variables o
  desplegar; Cloudflare permanece expresamente prohibido.
- La instruccion posterior de usar la tarjeta ficticia autorizo la prueba
  puntual de tokenizacion Sandbox descrita arriba. No autoriza modificar la
  URL de eventos, desplegar, migrar ni mezclar recibos de prueba con produccion.
  Datos publicos de prueba y contrato de cifrado revalidados en documentacion
  oficial: https://docs.wompi.co/docs/colombia/datos-de-prueba-en-sandbox/ y
  https://docs.wompi.co/docs/colombia/metodos-de-pago/.

SQL del ensayo:
`supabase/migrations/202609190001_payment_and_admin_hardening.sql`.
SHA-256: `bfd9f0752b57668bf3f612a18a81de81a3b61ae0ad35d9586e71203c4ae1cfd7`.
Cambiar ese archivo exige repetir las comprobaciones afectadas.

## Respaldo verificado de ensayo

- Snapshot consistente, cifrado y restaurado: 43 tablas, 409 registros, cero
  diferencias de datos, esquema y permisos, incluidos grants por columna;
  manifiesto con cobertura 5. Una copia anterior con cobertura 4 no certifica
  todos los ACL y no sirve como evidencia de corte productivo.
- Copia privada: `D:\Backups\HablemosPorEllos\2026-10-04T03-03-30.963Z-18024`.
- Segunda copia cifrada verificada:
  `C:\Users\USER\PrivateBackups\HablemosPorEllos\2026-10-04T03-03-30.963Z-18024`.
- Ambas carpetas restringidas al usuario local, SYSTEM y administradores;
  hashes de las tres copias coincidentes. No se borraron copias anteriores.
- Restauracion nueva `hpe_restore_checked045`; migracion en otra copia nueva
  `hpe_restore_migration046`: los 409 registros originales de 43 tablas
  conservaron IDs y contenido. La copia restaurada no se migro.
- La fecha del directorio es UTC; en Colombia corresponde al 3 de octubre.
- Los datos originales permanecen en Supabase. No se ejecutaron escrituras
  productivas ni se eliminaron respaldos anteriores.
- Reverificacion de archivos el 2026-10-04: hashes de ambos archivos cifrados
  y del informe iguales en las dos copias; hashes primarios coincidentes con
  el informe. Este sigue registrando restauracion, comparacion de contenido,
  esquema/permisos y grants por columna correctos, cobertura 5 y cero diferencias.
  Fue una lectura de archivos, no una nueva restauracion ni un snapshot final.

Esto NO es el respaldo final del corte. Antes de SQL productiva se requiere
otro respaldo fresco, restauracion/comparacion, evidencia en el chat y la
autorizacion correspondiente. No restaurar una copia antigua sobre registros
posteriores sin recuperarlos y conciliar Wompi.

## Comandos de prueba con datos ficticios

`ESCRITURA LOCAL`: generan artefactos o usan transacciones reversibles en el
laboratorio. La URL siguiente contiene exclusivamente una clave ficticia de
fixture; no sustituirla por una conexion productiva.

```powershell
npm.cmd test
npm.cmd run lint
node scripts/integration/webhook-cutover-local-e2e.mjs
node supabase/tests/historical_cli_sql_smoke.mjs --lab-url postgresql://postgres:hpe-local-fixture-only@127.0.0.1:5432/hpe_lab --lab-container hpe-admin-lab-033
node supabase/tests/admin_revocation_concurrency.mjs --lab-url postgresql://postgres:hpe-local-fixture-only@127.0.0.1:5432/hpe_lab --lab-container hpe-admin-lab-033
```

El ensayo HTTP requiere el gateway local y Next en
`--cutover-webhook-fixture=yes` sobre el laboratorio existente. El perfil no
admite habilitar operaciones financieras ni cargar llaves Sandbox reales.
Conserva sus dos recibos ficticios; no contiene comandos de limpieza.
El modo se acredita mediante el lanzamiento controlado del perfil, no por el
resultado queued, que tambien puede aparecer si una app active no tiene el
esquema disponible. No hay una atestacion HTTP independiente de Next ni una
medicion de trafico saliente. No ejecutar el ensayo contra otro proceso ajeno.

## Pendientes antes de publicar

### Estado del corte productivo

| Etapa | Estado | Requisito restante |
| --- | --- | --- |
| Codigo y pruebas normales | Local y revision acotada cerrada; no publicado | Tests/lint/build correctos no prueban por si solos el flujo externo; no confundir con readiness productiva. |
| SQL de migracion | Preparada, ensayada y preflight productivo de lectura correcto | Repetirlo despues del drenaje y verificar el respaldo final; no ejecutar ahora. |
| Flujo financiero Wompi Sandbox | Pendiente | Prueba externa aislada no autorizada actualmente. No usar Cloudflare ni sustituirlo por otra exposicion sin autorizacion. |
| Preparacion productiva | No ejecutada | Autorizar ventana, cambios de configuracion y publicacion; detener/drenar cobros y excluir escritores anteriores. Vercel permanece prohibido por la instruccion actual. |
| Respaldo final | No creado | Copia fresca tras drenar, segunda copia, restauracion y comparacion correctas; confirmacion explicita en el chat inmediatamente antes de SQL. El ensayo previo no lo reemplaza. |
| Migracion y postflight | No ejecutados | Autorizacion del corte, transaccion acotada, marcador/digest y verificacion de historia/recibos nuevos; no repetir ciegamente si el COMMIT es incierto. |
| Cuentas y MFA productivos | No configurados | Preparar Mauricio tras autorizacion. Daniel queda pendiente de su correo, sin crear otra cuenta; invitaciones privadas, claves propias, TOTP, allowlist/RLS y pruebas de permisos. No compartir claves ni QR. |
| Publicacion y cobros | No ejecutados | Rama a dev/main, despliegue verificado, conciliacion sin nuevos cargos y autorizacion separada antes de abrir donaciones/reanudar jobs. |

Las restricciones actuales no permiten completar el paquete en produccion.
No tomar las pruebas normales locales como aprobacion para omitir los gates.

El objetivo completo queda bloqueado a la espera de autorizacion para el
destino externo de pruebas y los cambios controlados en Vercel. Usar una
tarjeta ficticia permitio comprobar tokenizacion, pero no revoco la prohibicion
de modificar Vercel ni autoriza enviar eventos Sandbox al sistema productivo.
No hay una migracion o publicacion completada. La lectura de Git actualizada
confirma `main` en 0.2.1; sus tres commits posteriores al HEAD local modifican
solamente la marca de actividad de README. Se descargaron las referencias,
sin integrarlas, crear commits o hacer push. Los procesos de laboratorio ya
terminaron; la demostracion local sigue respondiendo 200. Este bloqueo del
objetivo no significa que se hayan pausado jobs o servicios productivos.

### Instruccion posterior: solo recursos existentes y navegador

El usuario autorizo explorar la preparacion separada, pero despues indico
`no crees mas cosas` y `no uses conectores`. No crear proyectos, bases,
servicios ni recursos adicionales. Para las cuentas externas usar exclusivamente
la sesion correcta de Edge, no conectores ni CLI de cuentas. Se cancelo el
formulario nuevo de Supabase sin definir credenciales ni crear el proyecto.
No hubo cambios de configuracion remota ni despliegues. Los revisores de esta
alternativa se detuvieron; no emitieron una aprobacion integral de arquitectura.

El conector consultado pertenecia a la cuenta personal, no al equipo de la
fundacion; no se usara para continuar. La consulta CLI oficial termino sin
sesion autenticada y sin desplegar; no se repetira ese camino. La consulta de
documentacion verifico que proyectos Free pausados no cuentan hacia el limite,
pero no confirmo una plaza libre y no autoriza crear recursos. La prueba completa
de Sandbox sigue pendiente; la tokenizacion puntual no la sustituye.

Tras el nuevo ingreso del usuario se reviso Programadores en Edge: Sandbox
activo y llave publica coincidente con la seleccion local, comparada en memoria
sin conservarla aqui. La URL de Eventos sigue apuntando al webhook productivo.
El campo no tiene required/pattern/minlength en el DOM, pero eso no demuestra
que Wompi permita guardar un valor vacio. Se solicito confirmacion para intentar
quitar esa URL solamente en Sandbox y detenerse si Wompi no lo permite.
No se guardaron cambios ni se creo una transaccion. La URL productiva no se
modificara. Se mantienen los contenedores locales existentes y se verificaron
sus credenciales ficticias y la seleccion exclusiva de llaves Sandbox.

Esa prueba por etapas usaria consultas a Wompi y procesamiento local del evento;
no acredita la entrega automatica de un webhook desde Wompi a localhost. No
presentarla como cierre de esa comprobacion, ni como aprobacion productiva.

- Flujo financiero completo de Wompi Sandbox: tokenizacion, fuente, intento,
  webhook y conciliacion. La inspeccion del Dashboard confirmo que Sandbox
  comparte el destino productivo. No crear transacciones hasta configurar y
  verificar una URL separada autorizada. Se propuso un tunel temporal limitado
  al webhook local con datos ficticios; el usuario rechazo prepararlo y dejo
  esta prueba pendiente. No se creo ni publico ningun tunel ni se sustituira
  por otra exposicion sin autorizacion. Antes de cambiar la URL Sandbox, mostrar
  el destino exacto y obtener confirmacion; nunca alterar el destino productivo.
  La sesion volvio al login despues de la inspeccion: revalidar antes del cambio.
  La instruccion posterior es no usar Cloudflare y continuar con pruebas
  normales locales. No instalar, crear ni iniciar Cloudflare/tuneles ni crear
  pagos Sandbox mientras esa prueba permanezca pendiente. La tokenizacion
  puntual autorizada posteriormente no crea una transaccion ni levanta el
  requisito de aislar los eventos antes del recorrido completo.
- Completar QA integral externo, incluido el flujo financiero Sandbox.
- Audit runtime: cero vulnerabilidades. Audit completo: siete avisos high de
  desarrollo derivados de `braces@3.0.3`; sin parche publicado compatible.
  No usar patrones glob no confiables ni ejecutar tooling de PR no confiables
  con credenciales. No afirmar ausencia completa de vulnerabilidades.
- `inventory` es observacion, no un chequeo de readiness: el esquema anterior
  produce `legacy_incomplete`; el esquema sin errores produce
  `read_only_observation`. Un exit 0 no habilita operaciones financieras. Los
  errores operativos siguen produciendo salida de error. Si el servidor
  truncase paginas a menos de 100 filas, la paginacion podria subcontar. La
  interfaz confirma Max rows = 1000; no aplica ese escenario con el limite
  observado. Si se cambia a menos de 100, revalidar antes de operar. No afirmar
  que se ensayaron todas las configuraciones. Un fallo en pagina posterior si
  esta probado.
- El conector de Vercel respondio 403, pero la interfaz de Edge del equipo
  correcto si permite lectura. No hay autorizacion para modificar Vercel:
  variables, despliegues y configuracion permanecen intactos. Las previews
  futuras requieren aislamiento autorizado; no publicar una rama conectada
  mientras ese requisito siga sin comprobarse.
- QA integral, respaldo final y autorizaciones de corte y habilitacion financiera.

No hubo commit, push, merge, despliegue, cuentas productivas ni nuevos cobros.
Los automatismos productivos no se cambiaron desde las operaciones de prueba.
