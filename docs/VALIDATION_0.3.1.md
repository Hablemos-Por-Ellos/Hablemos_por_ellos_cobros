# Validacion administrativa - 0.3.1

Fecha: 2026-10-04 Colombia. Base main/dev/rama 255e6e2, runtime 0.3.0.
Titular autoriza implementar, commit/push y publicar el ajuste Mensual/Unico.
No autoriza al asistente a cambiar Vercel ni hacer cargos con este ajuste.

## Implementacion y pruebas locales

- DTO y SELECT autenticado admiten monthly/one_time; sin fuentes/documentos.
- Listado y pagos filtran por frecuencia y estado, con resultados vacios.
  Donantes/detalle muestran frecuencia; pagos sin relacion no la inventan.
- Detalle unico sin monto editable/calendario/cancelacion/reactivacion incluso
  en estado active. Contadores recurrentes siguen contando solo monthly.
- Guard API original conservado; regresiones de las cuatro acciones one_time.
- Dos especialistas independientes agregaron pruebas en archivos disjuntos:
  50 tests lectura/API y 45 tests UI, todos correctos, sin red ni datos reales.
- npm run lint correcto. npm test: 968/968, 38 archivos, envDir=false.
- Build mediante run-demo-local.mjs: Supabase loopback/ficticio, llaves Wompi
  vacias, demo y FINANCIAL_OPERATIONS_ENABLED=false. Dos builds correctos,
  incluido typecheck de los nuevos tests. No prueba servicios productivos.
- Navegador local en 127.0.0.1:3005: filtro Unico, detalle sin acciones, pagos
  filtrados y estado vacio. Suscripciones 320/360/768/1024 y escritorio,
  pagos 320/768/1024/1280: sin overflow horizontal de pagina; filtros 44px.
  Capturas de escritorio/movil inspeccionadas con datos ficticios.
- Escaneo de lineas nuevas/nuevos archivos: cero patrones de llaves, JWT,
  URL PostgreSQL con contraseña, token de activacion o correos reales detectados.
  Es una comprobacion focal, no garantia universal; revisar diff antes de add.
- No cambios en SQL, pagos/webhook/job, auth, workflows o diseño /donar.

## Publicacion y controles

QA independiente APRUEBA el patch contra 255e6e2, sin hallazgos bloqueantes:
110 pruebas focales/regresiones y 17 casos adversariales en memoria correctos,
sin red, ediciones ni comandos pendientes. Alcance focal, no certificacion
de todo el paquete/cloud/RLS/Wompi.

- Commit de codigo f45b007 publicado en rama, dev y main por fast-forward.
- Preview dev: En7g5UAXyyTx5gwcCkDHVQrVaWSh, deployment GitHub 6851611036,
  success, URL j5f1uq4vl. Admin abierto con sesion normal de Vercel muestra
  fixtures, ambos tipos y 0.3.1; nunca donantes reales.
- Production: CfHEeuAy83ACwbUwdhacThHAcoPk, deployment GitHub 6851632923,
  success 2026-10-05T04:54:23Z; URL generada o1380ar61. Dominio estable:
  https://hablemos-por-ellos-cobros.vercel.app. Vercel no expone imagen Docker;
  identificadores de deployment y commit son referencias verificables.
- GET dominio estable: admin/login 200 con 0.3.1, sin demo; admin 307 login;
  donar 307 mantenimiento; acceptance 503 con mensaje mantenimiento.
- Tras recargar la sesion existente del titular: heading Aportes y suscripciones,
  filtros Todos/Mensual/Unico, MFA activo, 0.3.1, unico visible, sin demo y
  operaciones financieras deshabilitadas. No ejecutar acciones sobre donantes.
- Revision de recuperacion anterior 255e6e2 conservada (deployment GitHub
  6850361960). El tag/release se registra sobre la revision documental final,
  sin modificar otra vez el codigo validado; volver a verificar ese deploy.
No confundir compilacion local con deploy READY ni push con reanudacion.

GitHub consultado: tres workflows operativos disabled_manually. Variables
APP_OPERATION_MODE/FINANCIAL_OPERATIONS_ENABLED ausentes en Environment
Production al consultar. Mantener el bloqueo hasta handoff al titular.

Despliegue anterior observado en Vercel: main/255e6e2, READY, dominio estable.
Preservarlo para recuperacion en mantenimiento; no borrar snapshots ni datos.
No hubo migracion ni llamadas de cobro en esta version.
