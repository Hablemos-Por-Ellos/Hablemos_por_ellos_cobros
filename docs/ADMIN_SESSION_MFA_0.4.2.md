# Admin 0.4.2: Authenticator solo al iniciar sesion

Fecha: 2026-10-10 Colombia. Estado: integral local correcta, funcion productiva
aplicada/verificada y codigo aun pendiente de publicacion. Rama `codex/admin-session-mfa`.
Ultima produccion verificada anteriormente: 0.4.1/ece238d; no se consultaron
credenciales ni donantes reales para las pruebas. Continuacion autorizada:
funcion/publicacion despues de la integral y del respaldo FINAL restaurado,
comparado y confirmado en chat. Preparacion del respaldo solo lee el origen;
Funcion aplicada tras el gate; publicacion del codigo todavia pendiente.

## Alcance aprobado

- Conservar correo/contrasena y Authenticator al entrar al panel.
- No pedir ni verificar otro codigo al cambiar monto/fecha, cancelar, cancelar
  un adicional, reactivar o conciliar un intento existente.
- Cada API sigue verificando usuario/UUID, JWT y sesion AAL2 vigente, expiracion,
  administrador activo, rol y umbral de revocacion. Una sesion invalida o
  revocada no gana acceso por enviar campos de identidad o TOTP en el body.
- Mantener CSRF, limites persistentes, motivo, confirmacion Antes/Despues,
  version esperada, requestId, cambio/auditoria atomicos y barreras financieras.
- Guardar no inicia un cargo. La reactivacion conserva autorizacion del donante,
  verificacion de la fuente y fecha futura; no elude incertidumbres existentes.

Esta decision elimina la barrera adicional de TOTP por accion. Una sesion
administrativa robada podria permitir acciones hasta expirar o ser revocada:
no se afirma que el riesgo sea identico al control anterior. No se introdujo
una ventana de cinco minutos ni una sesion permanente para sustituir el codigo.

## Cambios concretos

| Componente | Cambio |
| --- | --- |
| Admin UI | Retirar campos TOTP de confirmaciones y conciliacion. |
| API suscripciones | Usar el contexto AAL2 validado por servidor, sin desafio adicional. |
| API conciliacion | Misma politica en nueva conciliacion y replay. |
| Auth compartido | Retirar el helper de desafio por accion; login/enrolamiento intactos. |
| Funcion SQL | Reemplazar solo `public.assert_admin_mutation_context`. |
| Auditoria | Para las acciones nuevas, `totp_verified_at=NULL`, sin fabricar fechas. |

Las APIs aceptan opcionalmente `totpCode` de clientes anteriores, pero lo ignoran
para autorizar y no lo mandan al RPC, logs ni auditoria. No se guardan codigos.
Las funciones RPC conservan sus parametros anteriores para compatibilidad.

## Funcion de Supabase

Archivo: `supabase/migrations/202610100001_admin_session_mfa.sql`.
SHA-256: `ee32ec842c5c902664d2326ef3415b6b3a417b9fc0679354209ce97df2c92e0e`.

Firma conservada:
`assert_admin_mutation_context(uuid,text,timestamptz,timestamptz) RETURNS void`.
El preflight exige la funcion existente SECURITY DEFINER y sus privilegios
esperados: service_role puede ejecutarla, anon/authenticated no. CREATE OR
REPLACE conserva OID, propietario y ACL; el search_path se fija a pg_catalog,
public y la tabla administrativa se referencia con esquema explicito.

La funcion rechaza UUID/AAL/fecha de sesion invalidos, fechas no finitas/futuras,
cuentas inexistentes/inactivas y sesiones anteriores o iguales a la revocacion.
Bloquea la fila administrativa FOR SHARE hasta terminar el cambio auditado.
Los datos de contexto provienen del servidor, no del formulario. La expiracion
JWT se comprueba en el servidor; este RPC privado no es un verificador de JWT.

Se conserva el cuarto parametro, pero NULL ya no causa rechazo ni se exige
frescura de cinco minutos. Si un consumidor anterior aporta un timestamp, sigue
debiendo ser finito y no futuro; no modifica valores historicos almacenados.

No hay ALTER/CREATE/DROP TABLE, columnas nuevas, indices, grants, backfill,
INSERT/UPDATE/DELETE de registros ni cambios de cuentas. Las migraciones ya
aplicadas de 0.3.0 y 0.4.0 quedan byte-for-byte intactas. SQL transaccional con
lock_timeout=5s y statement_timeout=120s. Marcador identificable en la definicion:
`admin-session-mfa-v0.4.2`; no se inserta una fila de migracion operativa.

## Evidencia local

| Comprobacion | Resultado |
| --- | --- |
| Vitest completo | 1329 correctas, cero fallos; seis integrales opt-in omitidas. |
| ESLint / TypeScript | Sin errores. |
| Next build | Correcto; 13 paginas estaticas. |
| PostgreSQL real aislado | Funcion y RPC de monto/agenda con AAL2 y sin TOTP correctos. |
| Sesiones invalidas | AAL1, usuario inactivo/desconocido y revocacion rechazados. |
| Permisos SQL | Ejecucion real como anon/authenticated rechazada. |
| Preservacion | Definiciones y contenido completos de 14 tablas public/auth identicos. |
| Propietario/ACL | Firma, OID, propietario y permisos de la funcion conservados. |
| Replay/reapply | Mismo resultado, sin segunda auditoria; parche repetido equivalente. |
| Finanzas | Cero envios/cargos y ningun pago/intento/ciclo creado por guardar. |
| UI | Dialogos sin TOTP revisados en escritorio, tablet 768x1024 y movil 390x844. |
| Confirmaciones | Motivo, Antes/Despues y autorizacion de reactivacion conservados. |
| Auth/SSR/API/RLS real local | 66 comprobaciones correctas, incluidos revocacion y logout. |
| Navegador real local | 210 comprobaciones; login MFA y tres guardados sin otro codigo. |
| Desafios MFA al guardar | Cero; cero payloads TOTP, tres auditorias UI AAL2/NULL. |
| Laboratorio GoTrue | 36 tablas con contenido identico tras el parche; seis auditorias de pruebas. |

El ensayo SQL usa una base NUEVA ficticia con PostgreSQL16, imagen local fijada,
network=none, root read-only, UID999, sin capabilities, puertos, host mounts ni
volumenes persistentes, RAM384MiB/CPU1/PIDs64. Inicializa el esquema historico
solo en esa base nueva; toma las huellas despues de crear fixtures y antes del
parche. Todas las mutaciones de la regresion terminan en ROLLBACK. El contenedor
usa --rm y se retira al finalizar; no se hizo prune ni se borraron otros labs.

Vitest/lint/types/build se ejecutaron desde una copia permitida en
`D:\CodexScratch\HablemosPorEllos\admin-session-mfa-042`, sin archivos dotenv,
con entorno limpio, finanzas false y un bloqueo de red a nivel de aplicacion.
Esto NO es aislamiento OS completo para Node. El build y la demo usan una fuente
publica Poppins ya cacheada como fixture, sin descargas externas ni cambios al
archivo fuente de estilos. No prueban la descarga de fuentes del deploy futuro.
El reporte ficticio completo esta en `full-tests.json` de esa copia local.

La comprobacion visual usa la demo desconectada en 127.0.0.1:3042, sin tocar las
pestanas productivas. Se abrieron monto, fecha, cancelacion y reactivacion,
sin enviar guardados de navegador. El selector nativo de mes se comprobo con
teclado; el resumen correspondio a la fecha futura propuesta. Movil y tablet
sin desbordamiento horizontal del dialogo; override de viewport restablecido.

## Repetir el ensayo

`ESCRITURA LOCAL`: crea y elimina unicamente su contenedor temporal ficticio.
Requiere Docker y una imagen postgres:16 ya disponible; no descarga imagenes.

```powershell
node scripts/integration/admin-session-mfa-local-e2e.mjs --local-admin-session-mfa=yes
```

`LECTURA`: el resumen emitido incluye digest, tablas comparadas, ACL, resultados
y contadores de cargos. No emite donantes reales, claves ni valores TOTP.

La nueva integral `admin-session-auth-local-e2e.mjs` ejecuta los scripts reales
Auth/UI en su propia DB ficticia vacia. Usa imagenes locales fijadas, red Docker
internal sin puertos publicados, root read-only, sin capabilities ni volumenes
persistentes y recursos limitados. Relays del operador escuchan solo loopback;
Next y los drivers reciben entorno limpio, bloqueo TCP/fetch a nivel aplicacion,
credenciales nuevas ficticias y ningun secreto Wompi. El navegador bloquea todo
destino externo y comprueba que no se exponga la llave privilegiada ficticia.
No es un aislamiento OS completo del proceso Node/navegador en Windows.

En esta integral FINANCIAL_OPERATIONS_ENABLED=true solo en el proceso local
para ejercitar las acciones administrativas. No puede contactar Wompi: no hay
llaves, la app solo recibe sandbox y el guard bloquea la red externa. No se
ejecutan checkout, jobs ni POST proveedor. Se comprobaron cero payments,
payment_attempts y billing_cycles y seis auditorias AAL2/NULL (tres API y tres UI).
Authenticator se desafia al login, incluido un codigo ficticio incorrecto;
ninguna de las tres acciones UI envia codigo o provoca otro desafio.

La integral usa Chromium headless ya instalado con ruta explicita, sin descarga;
el runtime Playwright actual esperaba otro binario. Primeros arranques detectaron
puertos bloqueados por la red internal, el arranque de Edge y dos aliases SQL
de prueba en minusculas: se corrigio solo el harness, sin cambiar el producto
para hacer pasar esas comprobaciones. El resultado final completo es correcto.
Se retiraron contenedores/red, procesos propios y credenciales ficticias al salir;
no se hizo prune ni se borraron recursos anteriores. Reporte agregado, sin datos
reales: `D:\CodexScratch\HablemosPorEllos\hpe-session-auth-042-1791675277526\verification.json`.
Los seis contratos opt-in de rutas SQL siguen omitidos en Vitest; esta integral
separada no convierte los ensayos historicos de 0.4.0 en validacion de 0.4.2.

Para repetir, pasar `--local-session-auth=yes`, `--playwright-module=<ruta>`,
`--browsers-path=<cache existente>`, `--browser-executable=<binario existente>`
y `--cached-font=<woff2 publica cacheada>` al nuevo script. Nunca instalar un
browser, copiar dotenv productivo ni usar una DB restaurada privada como fixture.

## Limites y publicacion pendiente

GoTrue/SSR/cookies, login MFA y guardados reales quedaron probados de extremo a
extremo LOCALMENTE. No se comprobaron Wompi ni mutaciones productivas nuevas.
No se necesita otro proveedor, variable, llave, cuenta ni cambio de tablas.

La funcion productiva ANTERIOR rechazaba NULL: publicar solo el frontend habria
provocado guardados rechazados, no una autorizacion silenciosa. Ya se sustituyo
la funcion tras respaldo verificado; no volver a ejecutar el parche por el deploy.
La publicacion ya fue autorizada condicionalmente y requiere respaldo verificable y
coordinacion de codigo/funcion: conservar la definicion y ACL anteriores, aplicar
solo este parche bajo los controles acordados, comprobar marcador/permisos y
preservacion, y luego verificar el runtime compatible. No ejecutar esos pasos
antes de confirmar el FINAL en chat. Si la respuesta SQL es incierta, inspeccionar la
definicion antes de repetir.

La recuperacion consiste en restaurar la definicion anterior de la funcion y
usar codigo compatible; no restaurar una DB vieja sobre pagos nuevos ni borrar
auditorias NULL. No se ha realizado ningun rollback productivo. Funcion, copias,
postflight y publicacion: `RELEASE_0.4.2.md`.
