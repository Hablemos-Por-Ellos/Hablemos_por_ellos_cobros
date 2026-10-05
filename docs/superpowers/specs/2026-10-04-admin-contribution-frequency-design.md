# Tipo de aporte administrativo - diseno aprobado

Fecha: 2026-10-04 Colombia.
Version: 0.3.1; implementada localmente, validacion/publicacion en curso.
Base verificada: 0.3.0 publicada en main; rama de trabajo
codex/admin-wompi-hardening. Conservar todos los cambios documentales existentes.

## Alcance aprobado

- Autorizacion posterior del titular: implementar, validar, commitear y publicar
  por rama/dev/main; conservar mantenimiento y bloqueos financieros. Entregar
  los pasos manuales de reapertura, sin habilitar cobros en este ajuste.
- Mostrar columna y filtro Tipo de aporte: Todos, Mensual y Unico.
- Incluir registros one_time en la consulta administrativa de solo lectura;
  mantener frecuencia real y asociacion existente de pagos/donantes.
- Aportes unicos: consulta e historial, sin modificar monto, calendario,
  cancelacion o reactivacion, ni crear un nuevo cobro.
- No modificar tablas, funciones SQL, datos, Auth, Wompi o Vercel.
- No cargar datos o credenciales productivas en las pruebas o vista local.

## Alternativas consideradas

1. Mostrar Mensual/Unico y ambos tipos en el listado, con detalle unico de
   solo lectura. Permite reconocer el aporte sin consultar Supabase; requiere
   ajustar el DTO y los consumidores del listado. Opcion aprobada.
2. Mantener solo monthly y explicar el alcance mediante un titulo. Reduce el
   diff, pero no permite consultar el aporte unico desde Suscripciones.

## Datos y componentes

- src/lib/admin-data.ts: seleccionar monthly y one_time. Preservar el campo
  frequency; no inferirlo del numero de pagos ni inventar fechas para unicos.
- DTO/fixtures locales: soportar ambas frecuencias, fuente no expuesta,
  preferredPaymentDay nulo y nextPaymentDate nulo para el aporte unico ficticio.
- Suscripciones: columna Tipo de aporte en escritorio y etiqueta equivalente
  en movil/tablet; filtro compatible con busqueda y estado.
- Pagos: mostrar el tipo del registro relacionado. Si no hay vinculacion,
  mostrar Sin vincular, sin adivinar la frecuencia ni crear asociaciones.
- Detalle: aporte unico y pagos visibles, sin calendario ni acciones. Mantener
  controles mensuales existentes y contactos enmascarados.
- Resumen: contar active/cancelled/past_due recurrentes solo para monthly.
  No convertir un one_time active en una nueva suscripcion mensual activa.
- La API actual ya rechaza cambios sobre frequency distinta de monthly.
  Preservar ese guard y probarlo; no ampliar permisos ni RPC SQL.
- No cambiar etiquetas/contadores Por revisar en este ajuste: queda separado
  del problema de claridad observado previamente.

## Versionado y pruebas

- Actualizar package/lock a 0.3.1 y changelog fechado. Production permanece
  en 0.3.0 hasta verificar el despliegue nuevo autorizado por el titular.
- Añadir un aporte unico y pago ficticios deterministas al demo, sin datos reales.
- Probar proyeccion de frecuencia, contactos enmascarados, vinculacion de pagos,
  filtros combinados, estado vacio y contadores mensuales sin inflacion.
- Probar que el detalle unico no presenta ni dispara mutaciones, tambien cuando
  el estado del registro es active. Conservar las pruebas mensuales existentes.
- Ejecutar lint, tests y build demo aislado; no usar .env productivo en tests.
- Revisar localmente 320x700, 360x800, 768x1024, 1024x768 y escritorio:
  tipos legibles, filtros usables y sin scroll horizontal de pagina.
- Validar una demo local desconectada antes de publicar el cambio autorizado.
- Actualizar README y Obsidian con evidencia real y pendientes, sin secretos.

## Revision del diseno

- Alcance limitado a lectura/presentacion de aportes; no cambia el calendario.
- Aprobacion inicial del titular: preparar local sin publicar.
- Documento sin commit por restriccion expresa del titular.
- Revision del documento: el titular aclaro el alcance UI/consulta y despues
  autorizo expresamente cambiarlo, commitear y pushear. No autoriza cargos.
- Referencia previa verificada: 18 pruebas de admin-data, admin-demo-data y
  admin-confirmation, tres archivos; envDir=false y fixtures locales. Pasaron
  antes de cambiar el runtime; no validan todavia el nuevo aporte unico.
