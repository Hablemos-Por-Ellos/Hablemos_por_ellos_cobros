# Panel administrativo: preparacion local

Version 0.3.0, preparacion y Preview ficticia. Este documento no autoriza aplicar
la migracion productiva, crear cuentas reales ni habilitar cobros. Auth real se
ensayo en el laboratorio local con cuentas ficticias; el ensayo financiero
Sandbox paso, pero no demuestra entrega automatica del webhook ni produccion.
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

Estado al 2026-10-04: ambos correos administrativos estan confirmados privadamente.
No hay cuentas productivas creadas ni invitaciones enviadas por este paquete.
La Preview ficticia no usa Auth productivo ni envia enlaces a esos contactos.
Antes de preparar las invitaciones reales, comprobar URLs exactas del dominio
productivo para que nadie reciba un enlace de Preview. Cada titular define su
contrasena y enrola su propio Authenticator; no hacerlo en su nombre.

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

## 5. Publicacion futura

Estado vigente: el usuario configuro Vercel personalmente. El asistente no guarda
variables ni cambia protecciones. La publicacion de rama y dev fue autorizada;
sus despliegues Preview estan en demo, sin credenciales privadas productivas.
main permanece intacta y el corte productivo sigue pendiente. La autorizacion
de Preview no permite habilitar cobros ni enviar invitaciones productivas.
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
