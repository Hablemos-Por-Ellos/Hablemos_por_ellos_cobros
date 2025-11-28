# Pasos a Seguir: Setup de Supabase y Wompi

Guía paso a paso para preparar tu mini-app de donaciones para desarrollo y producción.

---

## 1. Crear proyecto en Supabase

1. Ve a [supabase.com](https://supabase.com)
2. Inicia sesión o regístrate
3. Crea un nuevo proyecto
4. Elige región más cercana a Colombia (preferiblemente `us-east-1` o similar)
5. Espera a que esté listo (~2 minutos)

---

## 2. Obtener credenciales de Supabase

1. En el panel de Supabase, ve a **Settings → API**
2. Copia los siguientes valores:
   - **Project URL** → será `SUPABASE_URL`
   - **anon public** (clave pública) → será `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **service_role secret** (clave privada) → será `SUPABASE_SERVICE_ROLE_KEY`

3. Crea el archivo `.env.local` en la raíz del proyecto:

```bash
# .env.local
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJxxxx...
SUPABASE_SERVICE_ROLE_KEY=eyJxxxx...
NEXT_PUBLIC_WOMPI_PUBLIC_KEY=pub_test_xxxxx
```

⚠️ **IMPORTANTE**: `.env.local` está en `.gitignore`, no lo commitees nunca a Git.

---

## 3. Crear las tablas en Supabase

1. En el panel de Supabase, ve a **SQL Editor** (lado izquierdo)
2. Crea una nueva query
3. Copia y pega el siguiente SQL:

```sql
-- ============================================
-- BORRAR TABLAS EXISTENTES (si las hay)
-- ============================================
DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS subscriptions CASCADE;
DROP TABLE IF EXISTS donors CASCADE;
DROP TABLE IF EXISTS audit_logs CASCADE;

-- ============================================
-- TABLA: donors
-- Guarda información de cada donante
-- ============================================
CREATE TABLE donors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) NOT NULL UNIQUE,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  phone VARCHAR(30) NOT NULL,
  document_type VARCHAR(10) NOT NULL,      -- CC, CE, PA, NIT
  document_number VARCHAR(50) NOT NULL,
  city VARCHAR(100) NOT NULL,
  wants_updates BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- TABLA: subscriptions
-- Cada donación mensual activa
-- ============================================
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  donor_id UUID NOT NULL REFERENCES donors(id) ON DELETE CASCADE,
  amount INT NOT NULL,                              -- monto en COP (sin decimales)
  currency VARCHAR(3) NOT NULL DEFAULT 'COP',
  frequency VARCHAR(20) NOT NULL DEFAULT 'monthly',
  status VARCHAR(30) NOT NULL DEFAULT 'active',    -- active, paused, cancelled
  payment_method_type VARCHAR(20),                 -- card, nequi
  wompi_payment_source_id VARCHAR(500),            -- token de Wompi para cobros
  wompi_masked_details VARCHAR(100),               -- ej: "Tarjeta •••• 4242"
  reference VARCHAR(100),                          -- UUID interno de referencia
  created_at TIMESTAMP DEFAULT NOW(),
  cancelled_at TIMESTAMP,
  next_payment_date TIMESTAMP
);

-- ============================================
-- TABLA: payments
-- Historial de cada cobro procesado
-- ============================================
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  amount INT NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'COP',
  status VARCHAR(30),                              -- pending, approved, declined
  wompi_transaction_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- TABLA: audit_logs (opcional)
-- Logs de acciones para debugging
-- ============================================
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  action VARCHAR(100) NOT NULL,
  subscription_id UUID REFERENCES subscriptions(id),
  donor_id UUID REFERENCES donors(id),
  details JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- HABILITAR ROW LEVEL SECURITY (RLS)
-- ============================================
ALTER TABLE donors ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- ============================================
-- POLÍTICAS RLS
-- ============================================
CREATE POLICY "Allow insert donors" ON donors FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow update donors" ON donors FOR UPDATE USING (true);
CREATE POLICY "Allow select donors" ON donors FOR SELECT USING (true);

CREATE POLICY "Allow insert subscriptions" ON subscriptions FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow select subscriptions" ON subscriptions FOR SELECT USING (true);

CREATE POLICY "Allow insert payments" ON payments FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow select payments" ON payments FOR SELECT USING (true);

CREATE POLICY "Allow insert audit_logs" ON audit_logs FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow select audit_logs" ON audit_logs FOR SELECT USING (true);
```

4. Presiona **RUN** o **Cmd+Enter**
5. Espera confirmación (debe decir "Success")

---

## 4. Verificar conexión desde la app

1. Abre una terminal en la carpeta del proyecto:

```bash
cd "d:\Visual Studio Code\mini-app_hablemospor ellos"
```

2. Inicia el servidor de desarrollo:

```bash
npm run dev
```

3. Abre en tu navegador: [http://localhost:3000/donar](http://localhost:3000/donar)

4. Verifica que **no haya errores en la consola del navegador** (F12 → Console)

---

## 5. Obtener credenciales de Wompi (Sandbox)

1. Ve a [comercios.wompi.co](https://comercios.wompi.co)
2. Crea cuenta o inicia sesión
3. Ve a **Desarrollador → Credenciales**
4. Copia:
   - **Public Key (Sandbox)** → `NEXT_PUBLIC_WOMPI_PUBLIC_KEY`
   - **Private Key (Sandbox)** → `WOMPI_PRIVATE_KEY` (para webhooks)

5. Actualiza `.env.local` con estas claves

---

## 6. Probar el flujo completo

En [http://localhost:3000/donar](http://localhost:3000/donar):

1. Llena el formulario:
   - Nombre, apellido, correo, teléfono
   - Tipo y número de documento
   - Ciudad
   - Selecciona un monto

2. Presiona **"Continuar con mi donación mensual"**

3. Verifica en Supabase → **Table Editor**:
   - Debe aparecer un registro en `donors`
   - Al confirmar pago, debe aparecer un registro en `subscriptions`

✅ Si las tablas se llenan correctamente, ¡todo funciona!

---

## 7. Estructura de las tablas

### `donors` — Datos del donante
| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | UUID | Identificador único |
| `email` | VARCHAR(255) | Correo (único, para upsert) |
| `first_name` | VARCHAR(100) | Nombre |
| `last_name` | VARCHAR(100) | Apellidos |
| `phone` | VARCHAR(30) | Teléfono con indicativo |
| `document_type` | VARCHAR(10) | CC, CE, PA, NIT |
| `document_number` | VARCHAR(50) | Número de documento |
| `city` | VARCHAR(100) | Ciudad / Departamento |
| `wants_updates` | BOOLEAN | Acepta recibir actualizaciones |
| `created_at` | TIMESTAMP | Fecha de creación |
| `updated_at` | TIMESTAMP | Última actualización |

### `subscriptions` — Donaciones mensuales
| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | UUID | Identificador único |
| `donor_id` | UUID | FK a donors |
| `amount` | INT | Monto en COP |
| `currency` | VARCHAR(3) | Moneda (default: COP) |
| `frequency` | VARCHAR(20) | Frecuencia (default: monthly) |
| `status` | VARCHAR(30) | active, paused, cancelled |
| `payment_method_type` | VARCHAR(20) | card, nequi |
| `wompi_payment_source_id` | VARCHAR(500) | Token de Wompi |
| `wompi_masked_details` | VARCHAR(100) | "Tarjeta •••• 4242" |
| `reference` | VARCHAR(100) | Referencia interna UUID |
| `created_at` | TIMESTAMP | Fecha de creación |
| `cancelled_at` | TIMESTAMP | Fecha de cancelación |
| `next_payment_date` | TIMESTAMP | Próximo cobro |

### `payments` — Historial de cobros
| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | UUID | Identificador único |
| `subscription_id` | UUID | FK a subscriptions |
| `amount` | INT | Monto cobrado |
| `currency` | VARCHAR(3) | Moneda |
| `status` | VARCHAR(30) | pending, approved, declined |
| `wompi_transaction_id` | VARCHAR(255) | ID de transacción Wompi |
| `created_at` | TIMESTAMP | Fecha del cobro |
| `updated_at` | TIMESTAMP | Última actualización |

---

## 8. Próximos pasos

Una vez confirmado que funciona:

1. **Integrar widget real de Wompi** en lugar del placeholder
2. **Configurar webhooks** para procesar pagos mensuales automáticos
3. **Automatizar correos** de confirmación y recibos
4. **Testear cancelaciones** desde panel admin o Supabase
5. **Preparar despliegue** a producción (Vercel, Netlify, etc.)

---

## Checklist Rápido

- [ ] Proyecto Supabase creado
- [ ] Credenciales en `.env.local`
- [ ] Tablas SQL ejecutadas sin errores
- [ ] RLS habilitado en todas las tablas
- [ ] `npm run dev` funciona sin errores
- [ ] Página `/donar` carga correctamente
- [ ] Formulario guarda datos en tabla `donors`
- [ ] Confirmación guarda datos en tabla `subscriptions`
- [ ] Credenciales Wompi obtenidas y añadidas

---

## Troubleshooting

**Error: "Cannot find module '@supabase/supabase-js'"**
```bash
npm install
```

**Error en consola: "Failed to connect to Supabase"**
- Revisa que `.env.local` exista en la raíz
- Verifica que las credenciales sean correctas
- Reinicia el servidor de desarrollo

**Error: "RLS violation"**
- Asegúrate de que las políticas RLS están creadas
- Ve a **Authentication → Policies** y verifica

**El formulario no guarda datos**
- Abre consola del navegador (F12)
- Busca mensajes de error en rojo
- Si dice "401 Unauthorized", revisa credenciales

---

> 📁 **Nota**: El archivo `PASOS_A_SEGUIR_LEGACY.md` contiene la versión anterior de esta guía (con esquema de BD desactualizado).
