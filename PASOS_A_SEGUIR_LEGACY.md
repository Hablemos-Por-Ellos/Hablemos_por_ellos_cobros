# Pasos a Seguir: Setup de Supabase y Wompi

Guía paso a paso para preparar tu mini-app de donaciones para desarrollo y producción.

## 1. Crear proyecto en Supabase

1. Ve a [supabase.com](https://supabase.com)
2. Inicia sesión o regístrate
3. Crea un nuevo proyecto
4. Elige región más cercana a Colombia (preferiblemente `us-east-1` o similar disponible)
5. Espera a que esté listo (~2 minutos)

## 2. Obtener credenciales de Supabase

1. En el panel de Supabase, ve a **Settings → API**
2. Copia los siguientes valores:
   - **Project URL** → será `SUPABASE_URL`
   - **anon public** (clave pública) → será `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **service_role secret** (clave privada) → será `SUPABASE_SERVICE_ROLE_KEY`

3. Abre el archivo `.env.local` en la raíz del proyecto (crear si no existe):

```bash
# .env.local
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJxxxx...
SUPABASE_SERVICE_ROLE_KEY=eyJxxxx...
NEXT_PUBLIC_WOMPI_PUBLIC_KEY=pub_test_xxxxx
```

⚠️ **IMPORTANTE**: `.env.local` está en `.gitignore`, no lo commitees nunca a Git.

## 3. Crear las tablas en Supabase

1. En el panel de Supabase, ve a **SQL Editor** (lado izquierdo)
2. Crea una nueva query
3. Copia y pega el siguiente SQL:

```sql
-- Tabla de donantes
CREATE TABLE IF NOT EXISTS donors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  full_name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  phone VARCHAR(20),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tabla de suscripciones
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  donor_id UUID NOT NULL REFERENCES donors(id) ON DELETE CASCADE,
  amount_cop INT NOT NULL,
  payment_method VARCHAR(50),
  wompi_token VARCHAR(500),
  status VARCHAR(50) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  cancelled_at TIMESTAMP,
  next_payment_date TIMESTAMP
);

-- Tabla de pagos (historial)
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  amount_cop INT NOT NULL,
  status VARCHAR(50),
  wompi_transaction_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Tabla de auditoría (opcional pero recomendado)
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  action VARCHAR(255) NOT NULL,
  subscription_id UUID REFERENCES subscriptions(id),
  donor_id UUID REFERENCES donors(id),
  details JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Habilitar Row Level Security (RLS)
ALTER TABLE donors ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
```

4. Presiona **RUN** o **Cmd+Enter**
5. Espera confirmación (debe decir "Success")

## 4. Configurar Row Level Security (RLS)

Las políticas RLS permiten que la app escriba datos de forma controlada.

1. En el panel de Supabase, ve a **Authentication → Policies**
2. Para cada tabla (`donors`, `subscriptions`, `payments`, `audit_logs`), crea las siguientes políticas:

```sql
-- Política para tabla 'donors'
CREATE POLICY "Allow insert donors" ON donors
  FOR INSERT WITH CHECK (true);

-- Política para tabla 'subscriptions'
CREATE POLICY "Allow insert subscriptions" ON subscriptions
  FOR INSERT WITH CHECK (true);

-- Política para tabla 'payments'
CREATE POLICY "Allow service role payments" ON payments
  FOR INSERT WITH CHECK (true);

-- Política para tabla 'audit_logs'
CREATE POLICY "Allow service role audit" ON audit_logs
  FOR INSERT WITH CHECK (true);
```

3. Copia y pega en **SQL Editor** y ejecuta

## 5. Verificar conexión desde la app

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
   - Si aparece error de conexión a Supabase, revisa que las variables en `.env.local` sean correctas

## 6. Obtener credenciales de Wompi (Sandbox)

1. Ve a [wompi.co](https://wompi.co)
2. Crea cuenta o inicia sesión
3. Ve a **Desarrollador → Credenciales**
4. Copia:
   - **Public Key (Sandbox)** → guardar como `NEXT_PUBLIC_WOMPI_PUBLIC_KEY` en `.env.local`
   - **Private Key (Sandbox)** → guardar como `WOMPI_PRIVATE_KEY` si necesitas webhook validation

5. Actualiza `.env.local` con estas claves

## 7. Verificar que todo funciona

- En [http://localhost:3000/donar](http://localhost:3000/donar), intenta llenar el formulario:
  - Nombres, correo, teléfono, documento
  - Selecciona un monto
  - Presiona "Continuar con mi donación mensual"
  
- En el panel de Supabase, ve a **Table Editor** y verifica que aparezca un registro en la tabla `donors`

✅ Si la tabla se llena, ¡todo está funcionando!

## 8. Próximos pasos

Una vez confirmado que funciona:

1. **Integrar widget real de Wompi** en lugar del placeholder
2. **Configurar webhooks** para procesar pagos mensuales
3. **Automatizar correos** de confirmación y recibos
4. **Testear cancelaciones** manuales en Supabase
5. **Preparar despliegue** a producción (Vercel, Netlify, etc.)

---

## Checklist Rápido

- [ ] Proyecto Supabase creado
- [ ] Credenciales en `.env.local`
- [ ] Tablas SQL ejecutadas sin errores
- [ ] RLS habilitado en todas las tablas
- [ ] `npm run dev` funciona sin errores
- [ ] Página `/donar` carga correctamente
- [ ] Formulario guarda datos en `donors` table
- [ ] Credenciales Wompi obtenidas y añadidas

---

## Troubleshooting

**Error: "Cannot find module '@supabase/supabase-js'"**
```bash
npm install
```

**Error en consola del navegador: "Failed to connect to Supabase"**
- Revisa que `.env.local` exista en la raíz del proyecto
- Verifica que `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_ANON_KEY` sean correctos
- Recarga la página en el navegador

**Error: "RLS violation"**
- Asegúrate de que las políticas RLS están creadas
- Ve a **Authentication → Policies** y verifica que existan

**El formulario no guarda datos**
- Abre la consola del navegador (F12)
- Busca mensajes de error en rojo
- Si dice "Error 401 Unauthorized", revisa las credenciales en `.env.local`

---

¿Necesitas ayuda con algún paso? Pregunta sin dudarlo.
