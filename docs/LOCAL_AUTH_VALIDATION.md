# Supabase Auth real en laboratorio - 0.3.0

Fecha comercial: 2026-10-03. No es habilitacion de Auth productivo.

Actualizacion 2026-10-04: cierre vigente en `LOCAL_CLOSURE_2026-10-04.md`.
Se conserva el login estandar con URL/llave publica y secretos solo en servidor.
Auth paso dos ejecuciones consecutivas de 66 comprobaciones; hubo un rechazo
MFA anterior que no se reprodujo y cuya causa no quedo demostrada.

## Aislamiento

GoTrue y PostgREST reales, PostgreSQL con registros ficticios y Next en
`http://localhost:3001`. El proxy escucha solo en `127.0.0.1:54321`.
Los puertos de los contenedores se publican exclusivamente en loopback.
La demo de revision utiliza puerto 3000, separada de esta prueba; no se asume
que su servidor este iniciado.

`ESCRITURA LOCAL`: los comandos crean artefactos y cuentas ficticias. Nunca
sustituir el destino local por un proyecto cloud. No se borran datos existentes.
En un laboratorio existente no repetir inicializacion o arranque a ciegas:
verificar primero identidad, contenido y servicios. En el cierre actual se
reutilizaron los contenedores ya existentes.

```powershell
node scripts/integration/local-auth-lab.mjs start
node scripts/integration/local-auth-lab.mjs gateway
node scripts/integration/initialize-auth-lab.mjs
node scripts/integration/start-app-lab.mjs --financial=yes
node scripts/integration/auth-real-e2e.mjs
```

El iniciador del app deshabilita operaciones financieras y vacia todas las llaves
Wompi por defecto. La suite necesita `--financial=yes` para probar cambios
administrativos, manteniendo todas las llaves Wompi vacias: no usar
`--sandbox-config=yes` para la suite Auth. Sin esa opcion de mutaciones, la API
responde 503 por mantenimiento antes de validar la sesion. No comenta,
sobrescribe ni copia credenciales de produccion. Los
archivos de configuracion generados son locales e ignorados por Git.

## Evidencia

66 comprobaciones reales completadas: registro publico deshabilitado,
invitacion autorizada de un uso, definicion de contrasena propia, AAL1 rechazado,
enrolamiento/challenge/verificacion TOTP y AAL2 aceptado. Tambien se comprobo
que MFA sin allowlist no concede acceso, RLS no expone columnas sensibles,
mutaciones exigen origen/TOTP, cambios y auditoria son atomicos y guardar no cobra.

Revocar permisos rechaza page/API y acceso directo con un JWT anterior.
Logout invalida sesiones anteriores y refresh; un nuevo login exige MFA de nuevo.
Las cuentas y registros ficticios se conservan, sin datos de donantes reales.

El enrolamiento interrumpido se recupera eliminando solamente pendientes TOTP
propios con el nombre reconocido de la app. Se comprobaron dos interrupciones
seguidas, preservacion de un pendiente ajeno y reutilizacion del factor ya
verificado sin generar un nuevo QR ni exponer un nuevo secreto.

El proveedor local entrega hashes de invitacion de 56 caracteres (SHA-224).
El callback acepta ese contrato y el formato de 64 caracteres ya soportado;
la invitacion sigue guardandose mediante digest SHA-256, sin cambiar SQL.

El navegador detecto un fallo CORS del proxy de pruebas. Se corrigio para los
dos origenes locales del puerto 3001 y se comprobaron ocho casos. No se amplian
los permisos de Supabase cloud. No guardar capturas de QR, secretos TOTP ni cookies.

## Limites

La suite no prueba la configuracion Auth/RLS de produccion, el correo SMTP
productivo ni transacciones Wompi. Los GET Sandbox no prueban el flujo de cobro.
Ultima suite global: 897 pruebas en 37 archivos; lint y build de demostracion
correctos. La interfaz real tambien probo tres mutaciones con datos ficticios;
no prueba reactivacion externa, alta por QR en la UI ni refresh automatico.
Los dictamenes independientes no sustituyen los gates de corte productivo.
