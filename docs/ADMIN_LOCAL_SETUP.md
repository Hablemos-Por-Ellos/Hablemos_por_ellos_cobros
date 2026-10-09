# Panel administrativo: preparacion local

**0.4.0 en Production/reabierta (2026-10-09):** registro compacto,
filas moviles, historial y cancelacion confirmada del adicional. Codigo
2769a11 READY y SQL nueva aplicada despues del FINAL restaurado/comparado,
con originales y dos cuentas/MFA conservados. La demo sigue ficticia y
desconectada; no hubo cuentas nuevas ni cobros de prueba. Titular confirmo el
panel actualizado; reapertura e inventory verificados, workflows activos.
Evidencia del corte y reapertura: `CUTOVER_0.4.0.md` y
`REOPENING_0.4.0.md`. La historia 0.3.1 siguiente es un checkpoint anterior.
Ver `BILLING_RETRY_0.4.0.md` para reglas y protecciones del corte ya aplicado.

Version UI 0.3.1, esquema 0.3.0. El procedimiento siguiente explica el laboratorio local; no
autoriza crear cuentas reales ni habilitar cobros. Codigo y migracion SQL ya
publicados/aplicados en Production, con registros
originales preservados y conciliacion historica de 37 pagos aprobados completada
sin cargos. Primera cuenta super_admin e invitacion privada ya preparadas con
autorizacion expresa; titular confirma primer ingreso real despues de definir
contraseña y verificar TOTP. Activacion consumida y factor verificado tambien
comprobados por lectura independiente. Reapertura financiera verificada el
5 de octubre. Segunda cuenta preparada con autorizacion el 8 de octubre;
primer ingreso confirmado por el titular y activacion/contraseña/TOTP/sesion
aal2 verificados por lectura independiente el mismo dia.
No se ejercitaron mutaciones administrativas sobre donantes reales.
El archivo de activacion queda fuera de Git y no se envio
correo. Este documento no publica enlaces privados ni autoriza reabrir cobros.
Auth real se ensayo en el laboratorio local con cuentas ficticias; el ensayo
financiero Sandbox no demuestra entrega automatica del webhook ni produccion.
Ver `docs/LOCAL_AUTH_VALIDATION.md` y `docs/VALIDATION_0.3.0_LOCAL.md`.

## 1. Variables locales

Usa un archivo local ignorado por Git y comprueba la precedencia de Next.js.
Si existe un archivo con credenciales productivas, no lo cargues en tests ni lo
sobrescribas. El desarrollo debe apuntar exclusivamente al laboratorio:

```txt
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
CHECKOUT_TOKEN_PEPPER=
NEXT_PUBLIC_WOMPI_ENV=sandbox
ADMIN_DEMO_MODE=false
APP_OPERATION_MODE=active
FINANCIAL_OPERATIONS_ENABLED=false
```

`CHECKOUT_TOKEN_PEPPER` debe ser aleatorio y tener al menos 32 caracteres. No se comparte con el navegador.

Para la maqueta usa `APP_OPERATION_MODE=demo` y operaciones financieras
deshabilitadas. No conectes la preview de Vercel a Supabase productivo. Los tests
usan valores ficticios definidos en `vitest.setup.ts`.

## 2. Migracion local

1. `LECTURA`: ejecutar primero `supabase/preflight/payment_admin_preflight.sql`.
2. Revisar duplicados, tipos, grants y politicas encontradas.
3. Crear un respaldo local.
4. `ESCRITURA`: aplicar `supabase/migrations/202609190001_payment_and_admin_hardening.sql` solamente en una base local compatible.
5. `LECTURA`: ejecutar `supabase/postflight/payment_admin_postflight.sql`.
6. Confirmar que las tablas historicas conservan sus filas.

La migracion revoca los permisos amplios actuales y crea solamente seis politicas administrativas con nombres conocidos. Como medida de seguridad, se detiene si encuentra politicas RLS desconocidas; no las elimina de forma dinamica. Todos los cambios se aplican en una unica transaccion: si cualquier paso falla, PostgreSQL revierte la migracion completa.

La migracion no elimina filas de donantes, suscripciones, pagos, webhooks, auditorias ni tablas operativas. Reemplaza definiciones antiguas de indices, constraints, funciones y politicas por sus versiones endurecidas, pero no borra registros. El mantenimiento solo cambia a `expired` los estados `draft` o `checkout` vencidos; conserva `processing` para conciliacion o revision.

## 3. Crear administradores

1. Deshabilitar el registro publico en Supabase Auth.
2. Preparar una invitacion privada para un UUID autorizado. El administrador
   define su propia contrasena; nunca enviarla por chat ni establecerla por otra persona.
3. Registrar la autorizacion `admin_users` y la invitacion `admin_invitations`.
   La invitacion se almacena mediante hash, tiene un uso y una vigencia maxima
   de una hora. El callback verifica Supabase y la consume atomicamente.
4. `ESCRITURA LOCAL`: ejemplo de allowlist, usando un UUID de una cuenta ficticia:

```sql
insert into public.admin_users (user_id, role, active)
values ('UUID_DEL_USUARIO', 'super_admin', true);
```

El primer ingreso muestra un QR de TOTP. El administrador lo escanea con Google Authenticator y confirma el codigo. El QR y la clave manual no deben guardarse en el repositorio ni enviarse por chat.

Ambos roles requieren MFA. Admin y superadmin comparten la gestion operativa;
solo superadmin esta autorizado para gestionar accesos. Esta politica no implica
que exista ya una pantalla de gestion de permisos. Las APIs comprueban sesion,
UUID, rol, usuario activo, `aal2`, version y TOTP reciente en servidor.

Checkpoint historico al 2026-10-04: ambos correos administrativos estan confirmados privadamente.
No hay cuentas productivas creadas ni invitaciones enviadas por este paquete.
La Preview ficticia no usa Auth productivo ni envia enlaces a esos contactos.
Antes de preparar las invitaciones reales, comprobar URLs exactas del dominio
productivo para que nadie reciba un enlace de Preview. Cada titular define su
contrasena y enrola su propio Authenticator; no hacerlo en su nombre.

Comprobacion productiva posterior, 2026-10-04 Colombia: el titular guardo
`Site URL=https://hablemos-por-ellos-cobros.vercel.app` y el unico redirect
`https://hablemos-por-ellos-cobros.vercel.app/admin/auth/callback`. UI confirma
Save changes deshabilitado y Total URLs: 1; sin comodines, Preview o localhost.
Este paso no crea cuentas, no envia invitaciones ni prueba aun el primer ingreso.

Condicion posterior del titular: el administrador usara el enlace al recibirlo.
No generar/entregar su invitacion hasta completar configuracion, permisos y
prueba productiva con el superadministrador. Crear allowlist/registro de
invitacion antes de entregarla; las contrasenas y MFA son acciones personales.
El correo incorporado de Supabase solo entrega a miembros de la organizacion;
no prometer entrega externa sin SMTP. Puede generarse el enlace sin enviarlo
automaticamente para una entrega privada acordada al final, sin guardarlo en
el repositorio. Canal pendiente de confirmar; no enviar invitaciones todavia.

Guardar abre el resumen Antes/Despues y la confirmacion. Volver, cerrar o Escape
no guardan. Confirmar no genera un cobro ni modifica pagos anteriores.

Los intentos `unknown` sin ID y los `dispatching` sin ID estancados durante 15 minutos se muestran en el resumen administrativo. Para conciliarlos, el administrador localiza la referencia en Wompi, ingresa el ID y confirma con TOTP. El servidor vuelve a consultar Wompi; el formulario no permite indicar el estado ni genera un cobro. El resultado y el responsable se guardan atomicamente en la auditoria.

Si Wompi confirma que no existe una transaccion, el admin puede cerrar el intento con motivo, TOTP y confirmacion explicita. El cierre marca el intento como `failed`, la suscripcion como `past_due` y no programa un reintento. No debe usarse esta opcion mientras la busqueda en Wompi sea dudosa.

## 4. Recuperacion

La recuperacion se hace fuera de la aplicacion: verificar identidad, suspender
acceso y revocar sesiones antes de reemplazar los factores. Restablecer la
contrasena no debe desactivar MFA automaticamente. Cerrar sesion revoca el
umbral de sesiones en la DB antes de Auth; si esa revocacion falla, se informa
el fallo y no se afirma que los JWT anteriores hayan quedado invalidados.

## 5. Procedimiento historico de publicacion

Checkpoint previo a la reapertura: el usuario configuro Vercel personalmente. El asistente no guarda
variables ni cambia protecciones. Rama/dev/main publicados con autorizacion;
Preview permanece en demo sin credenciales privadas productivas. La migracion
productiva se aplico el 2026-10-05T02:21:40.210Z tras verificar el respaldo FINAL.
No repetir SQL por los pendientes de Auth. Registro publico deshabilitado por
el titular y guardado verificado; sin cuentas ni invitaciones. 37 pagos historicos
necesitan fechas verificadas
antes de abrir finanzas. Cobros deshabilitados y workflows operativos pausados.
La autorizacion de publicacion/migracion no abre donaciones ni habilita cargos.
Ver `docs/CUTOVER_2026-10-04.md` para evidencia y limites de las pruebas remotas.

1. Completar pruebas locales/sandbox y revision independiente. Un build correcto
   no prueba Auth, RLS ni Wompi externos.
2. Revisar el diff y secretos antes de commits o push. La preview en `dev` debe
   usar demostracion desconectada; `main` permanece intacta hasta autorizar el corte.
3. Pausar y drenar escritores, desplegar en `cutover` y mantener bloqueadas las
   operaciones financieras. `MAINTENANCE_MODE` por si solo no protege las APIs.
4. Crear un respaldo final fresco, restaurarlo y compararlo. Inmediatamente antes
   de SQL productiva, confirmar esa evidencia en el chat. Sin evidencia y
   autorizacion, no migrar.
5. Ejecutar preflight, migracion y postflight; conservar recibos y verificar
   preservacion. Un resultado de COMMIT incierto exige inspeccion, no repetir SQL.
6. Configurar las cuentas, probar MFA/RLS y conciliar sin nuevos cargos.
7. Solicitar confirmacion separada antes de abrir donaciones o habilitar cobros.

El procedimiento de respaldo esta en `docs/PRIVATE_BACKUP_RUNBOOK.md`. Una copia
verificada de ensayo no sustituye el respaldo final del corte. Despues de SQL,
mantener `cutover` ante fallos; no restaurar ciegamente una copia antigua ni
volver a codigo incompatible, porque restaurar la DB no revierte dinero.

## 6. Acceso secundario preparado - 2026-10-08

- El titular confirmo que el destinatario estaba listo y autorizo preparar su
  acceso. Registro publico deshabilitado revalidado; login real 200 con version
  0.3.1/revision 46ffa2b, sin demo. No requiere otro despliegue.
- Se creo una unica cuenta Auth mediante generateLink de tipo invite, sin correo
  automatico. Rol admin/allowlist e invitacion con hash se guardaron juntos en
  una transaccion; vigencia de 59 minutos desde la emision original, un solo uso.
- Los primeros bloqueos ocurrieron por la comprobacion de permisos con
  PowerShell 5 y por un identificador SQL reservado. La transaccion fallida se
  revirtio. Se completo el registro de la cuenta/invitacion existentes sin otro
  generateLink, sin borrar/recrear cuentas ni modificar tablas operativas.
- Lectura independiente confirma rol activo, invitacion sin consumir y vigente,
  cuenta aun sin activar/contraseña propia/MFA. El archivo de entrega y su
  verificacion quedan fuera de Git, con permisos exclusivos del operador/SYSTEM.
  No publicar URL, token, correo, QR ni contraseña en documentacion.
- Comparacion anterior/posterior de las cinco tablas operativas y del
  superadministrador existente: sin diferencias. Cero llamadas Wompi, cargos,
  modificaciones de Vercel/GitHub, commits o despliegues en esta preparacion.
- El titular debe enviar el enlace privadamente al destinatario antes de vencer.
  Solo el destinatario debe abrirlo y completar contraseña y Google Authenticator.
  Ingreso habitual posterior por /admin/login. No abrir/consumir el enlace en
  nombre del destinatario para probarlo.

## 7. Activacion secundaria verificada - 2026-10-08

El titular confirma el primer ingreso. Consulta independiente con PostgreSQL
forzado a READ ONLY, observacion `2026-10-08T23:41:14.128Z`: una cuenta autorizada
con rol admin activo, email activado, contraseña definida (solo booleano), un
factor TOTP verificado y ninguno sin verificar, una invitacion consumida, cero
invitaciones vigentes sin consumir y una sesion aal2. No se consultaron valores
de contraseñas, secretos TOTP, QR o tokens. No hubo escrituras en Supabase,
llamadas Wompi, pruebas de mutaciones financieras ni nuevo despliegue por esta
verificacion. El enlace de activacion ya no se reutiliza; ingreso habitual
por /admin/login con contraseña y codigo propios.
