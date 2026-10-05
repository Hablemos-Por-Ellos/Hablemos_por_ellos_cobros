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
de todo el paquete/cloud/RLS/Wompi. Despliegue pendiente de registrar.
No confundir compilacion local con deploy READY ni push con reanudacion.

GitHub consultado: tres workflows operativos disabled_manually. Variables
APP_OPERATION_MODE/FINANCIAL_OPERATIONS_ENABLED ausentes en Environment
Production al consultar. Mantener el bloqueo hasta handoff al titular.

Despliegue anterior observado en Vercel: main/255e6e2, READY, dominio estable.
Preservarlo para recuperacion en mantenimiento; no borrar snapshots ni datos.
No hubo migracion ni llamadas de cobro en esta version.
