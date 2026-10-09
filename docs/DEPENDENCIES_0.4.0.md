# Dependencias del candidato 0.4.0

Fecha: 2026-10-08 Colombia. Estado LOCAL, sin publicacion. Este documento
registra alcance y riesgo residual; no es una aprobacion productiva.

## Comprobado

- Next y eslint-config-next 15.5.27, sharp 0.35.5 y source-map-js 1.2.2
  se actualizaron sin un salto mayor del framework.
- `npm audit --omit=dev --json`: cero alertas en dependencias de ejecucion.
- El audit completo conserva nueve alertas transitivas: siete altas y dos
  moderadas en las familias de braces y postcss-selector-parser.
- El job solo importa modulos MJS, Node y Supabase. En una copia externa sin
  .env, `npm ci --omit=dev` instalo 36 paquetes, audit limpio; el entry point
  cargo y ejecuto inventory con fixtures inyectadas, cero fetch y escrituras.
  No demuestra conectividad del job productivo. El workflow candidato usa
  esa instalacion, sin modificar cron, concurrencia, llaves ni controles.

## Alcance de las alertas restantes

| Familia | Alcance comprobado y decision |
|---|---|
| braces <=3.0.3 | Patrones profundamente anidados pueden agotar la pila. La ficha no publica version corregida. En este arbol se usa para globs de herramientas con patrones del repositorio, no para interpretar entradas de donantes en rutas HTTP. |
| postcss-selector-parser <7.1.6 | Selectores hostiles pueden consumir CPU. El mantenedor delimita el riesgo a selectores no confiables procesados en solicitudes; el build con fuentes confiables no tiene esa via. Tailwind 3 consume la familia 6.x; no se impuso 7.x fuera de su contrato. |

Fuentes primarias consultadas: [braces GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
y [postcss-selector-parser GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf).
La inferencia de alcance se basa en el grafo instalado y la inspeccion de
consumidores del repo: no se encontro parsing de globs/selectores del usuario
en rutas de ejecucion. No equivale a demostrar que toda configuracion cloud
este aislada ni que no existan otras vulnerabilidades.

## Limites antes de publicar

- Conservar los patrones literales de Tailwind y fuentes de build confiables.
  No admitir CSS, selectores o patrones aportados por visitantes en el servidor.
- Revisar la confianza de ramas/PR y Preview antes del corte. Construcciones
  no confiables no deben recibir credenciales productivas; restringir recursos
  y tiempo. Ese estado cloud no se verifico ni cambio durante esta fase local.
- No usar `npm audit fix --force`, Chokidar 4, Tailwind 4 ni un override de
  parser 7.x sin su propio cambio y pruebas de compatibilidad.
- Repetir audit y revisar avisos antes de publicar; las alertas de desarrollo
  permanecen como riesgo residual documentado, no como vulnerabilidades resueltas.

No se contrataron servicios, instalaron conectores ni cambiaron cuentas.
