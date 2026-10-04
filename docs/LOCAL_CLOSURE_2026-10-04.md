# Cierre local del paquete 0.3.0

Fecha comercial: 2026-10-04, America/Bogota. Rama:
`codex/admin-wompi-hardening`. Estado: cambios locales sin commit ni push.
Este informe actualiza los ensayos anteriores; no certifica una release,
despliegue, respaldo final ni migracion productiva.

## Resultados

| Comprobacion | Evidencia y alcance |
| --- | --- |
| Suite completa | 897 pruebas en 37 archivos, con dotenv deshabilitado y entorno hijo de valores permitidos. |
| Lint | Mismo comando de npm run lint, sin cache: correcto despues de los ultimos cambios de los ensayos. |
| Build | next build mediante run-demo-local.mjs build: correcto con demo, destinos loopback, llaves Wompi vacias y cobros bloqueados. No despliega. |
| Interfaz administrativa real | 544 comprobaciones, incluidas comparaciones de filas. Login con contrasena/TOTP, rechazo sin allowlist/AAL2, reload/logout y tres mutaciones ficticias. 35 tablas public/auth; 457 filas anteriores conservadas por contenido y multiplicidad. |
| Cambios administrativos UI | Monto 1500 a 1600, mes futuro/dia 6 a 12:00 UTC y cancelacion. Tres auditorias y cero pagos para esa suscripcion ficticia; volver sin confirmar no guarda. |
| Auth/API/RLS real local | Dos ejecuciones consecutivas de 66 comprobaciones pasaron despues de un rechazo MFA anterior. Invitacion, contrasena propia, TOTP, permisos, RLS, mutaciones, revocacion y logout. |
| Regresiones del aplicador | 53 pruebas del archivo de recuperacion/guard, incluidas 17 nuevas: drift de filas, tablas, columnas, PK, ACL/roles, recibos nuevos, lock timeout y unico COMMIT. Mocks; no son motor PostgreSQL. |
| Guard con PostgreSQL real, reapply | Ultima repeticion: 729 comprobaciones sobre 35 tablas y 672 filas originales conservadas. Un recibo concurrente entro antes del lock y se incluyo en el baseline. Se exigio la diferencia exacta de una fila en audit_logs para drift y SQLSTATE 55P03 del lock para timeout; ambos impidieron DDL. |
| Guard con PostgreSQL real, inicial | 33 comprobaciones en un contenedor ficticio offline existente, con seis tablas/seis filas originales preservadas por las columnas anteriores. Marcador inicialmente ausente, SQL aplicada, digest comprobado y esquema listo. |
| Revision independiente | Tres revisores de solo lectura aprobaron cierres locales acotados: selector UI, orden del guard y refutacion adversarial. No reejecutaron los ensayos del parent ni aprobaron produccion. |

## Correcciones

- El timeout UI ocurria antes del PATCH: el selector exacto buscaba Codigo sin
  tilde, frente al label con tilde del formulario. Se corrigieron solamente
  los tres selectores del harness y se anadieron etiquetas de etapa; no se
  retiraron TOTP, confirmacion, auditoria ni controles del producto.
- Se conserva Supabase Auth estandar elegido por el usuario. URL/llave publica
  son configuracion del cliente; las privadas permanecen en servidor. AAL2,
  UUID activo autorizado y RLS siguen siendo los limites de acceso.
- Cookies comparten politica Secure en Production. Middleware evita cache en
  rutas administrativas y conserva cookies/headers del SDK. Login elimina
  estado incompleto; un logout parcial confirmado oculta tablas privadas.
- Same-origin comprueba Host, protocolo y origen exactos. El perfil de
  integracion local explicito no confunde localhost con 127.0.0.1 ni debilita
  HTTPS productivo. La procedencia de headers en el ingress real queda pendiente.
- El aplicador mantiene locks y comparacion del backup en la misma transaccion,
  incluyendo metadatos/inventario antes de DDL y recibos admitidos en el baseline.
  Preservacion y postflight se comprueban antes del unico COMMIT. No se modifico
  el archivo SQL original ni su digest.

## Incidencias y limites

- Una repeticion Auth recibio 403 al verificar una mutacion con TOTP. No se
  conservo entonces la categoria de la respuesta; la causa no quedo probada.
  Se anadio diagnostico de status/categoria publicos sin imprimir cuerpo,
  contrasena, codigo, cookies o invitacion. Dos repeticiones posteriores pasaron.
  No afirmar que se demostro una causa de expiracion.
- El primer ensayo inicial comparo hashes de filas completas despues de anadir
  columnas, y fallo en su comprobacion externa. El aplicador ya habia comprobado
  columnas originales antes de COMMIT. Se corrigio la proyeccion del harness y
  se repitio en otro fixture existente; no se deshizo ni limpio ningun laboratorio.
- Se conservaron los registros ficticios nuevos del guard y las cuentas/filas
  de Auth/UI. Cero conexiones productivas en estos ensayos; no hay borrado,
  reset o restauracion encima de datos existentes.
- El guard ejercita una ruta de configuracion productiva ficticia con factory
  de clientes local y manifiesto en memoria. No prueba un backup real ni sus
  credenciales. El modo target=local normal no activa ese guard externo completo.
- QA endurecio las aserciones negativas: cualquier excepcion no cuenta como
  prueba de drift/timeout. La repeticion real mas reciente verifico el manifest
  completado con la diferencia exacta y la fase/codigo PostgreSQL del bloqueo.
  Esas aserciones reforzadas se repitieron en reapply; el ensayo inicial anterior
  acredita aplicacion, marcador y preservacion, no otra ejecucion de ese refuerzo.
- Las solicitudes no locales interceptadas del navegador fueron cero. No es
  una atestacion de todo el egreso de Node, Next, WebSockets o service workers.
  La revision de JS observado no equivale a un barrido completo de HTML/RSC.
- La UI reutiliza un factor enrolado por SDK: alta por QR/invitacion en la UI,
  renovacion automatica tras expirar y reactivacion con Wompi no se ensayaron en
  este cierre. El SDK prueba onboarding, no su presentacion completa en navegador.
- Para comparar preservacion, ejecutar los ensayos secuencialmente sin otro
  escritor de pruebas. Un ensayo anterior simultaneo con otro SDK produjo una
  comparacion invalida; no se interpreto como perdida de datos.
- Vite avisa sobre configuracion ESM/CommonJS; Node avisa sobre tipo de modulo;
  Supabase avisa sobre getSession en consultas de assurance. No se suprimieron
  avisos. La autorizacion del producto usa identidad/claims verificados.

## Ensayos anteriores relevantes

La prueba financiera anterior de Sandbox paso 20 comprobaciones con tarjeta y
registros ficticios: tokenizacion, fuente, transaccion aprobada y procesamiento
local de evento firmado. Se dejo vacia la URL Sandbox con autorizacion; el
destino productivo no cambio. No acredita entrega automatica de Wompi al
webhook ni se repitio aqui. No configurar pruebas con el destino productivo.

El respaldo cifrado y restaurado previo sigue siendo de ensayo. Este cierre no
creo otro respaldo ni verifico el respaldo final fresco del futuro corte.

## Siguiente fase, no ejecutada

1. Confirmar ventana/autorizacion, variables y despliegue del equipo correcto.
2. El usuario informa Monthly Charges y Keepalive pausados; falta comprobar
   ejecuciones en curso, Repository Activity y excluir escritores antiguos.
3. Desplegar el perfil de corte autorizado, conservando recibos sin aplicarlos.
4. Respaldo final fresco, segunda copia, restauracion/comparacion y mensaje
   explicito en el chat inmediatamente antes de SQL productiva.
5. Preflight/migracion/postflight, preservacion y conciliacion sin nuevos cargos.
6. Cuentas/MFA/RLS productivos y autorizacion separada antes de abrir donaciones
   y reanudar automatismos. El correo del segundo administrador sigue pendiente.

No se hicieron commits, push, deploy, cambios en Vercel ni SQL productiva.

## Comandos de laboratorio

ESCRITURA LOCAL, con servicios ficticios existentes verificados; no reemplazar
destinos por cloud ni ejecutar simultaneamente pruebas con comparacion de filas:

```powershell
node scripts/integration/auth-real-e2e.mjs
node scripts/integration/admin-ui-local-e2e.mjs --local-ui=yes --mutations=yes
node scripts/integration/migration-guard-local-e2e.mjs --local-guard=yes
```

La UI necesita HPE_PLAYWRIGHT_MODULE apuntando al runtime Playwright ya instalado
y app-lab con financial=yes, sin sandbox-config. Los perfiles iniciales legacy
solo aceptan fixtures offline concretos con marcador ausente: despues del ensayo
quedan migrados y no deben borrarse/resetearse para repetirlo.
