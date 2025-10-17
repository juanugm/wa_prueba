# WhatsApp Personal Microservice

Microservicio Node.js para integrar WhatsApp Personal con Lovable usando whatsapp-web.js.

## 📋 Requisitos

- Node.js 18+ 
- Cuenta en Railway.app, Render.com, o servidor con Node.js
- WhatsApp instalado en tu teléfono

## 🚀 Deployment en Railway.app (Recomendado)

### Paso 1: Preparar el repositorio

1. Crea un nuevo repositorio en GitHub
2. Copia los archivos de `whatsapp-microservice/` a tu repositorio:
   - `server.js`
   - `package.json`
   - `README.md`

### Paso 2: Configurar Railway

1. Ve a [Railway.app](https://railway.app) y crea una cuenta
2. Click en "New Project" → "Deploy from GitHub repo"
3. Selecciona tu repositorio
4. Railway detectará automáticamente que es un proyecto Node.js

### Paso 3: Configurar Variables de Entorno

En Railway, ve a Variables y agrega:

```bash
PORT=3000
WEBHOOK_URL=https://wmzbqsegsyagcjgxefqs.supabase.co/functions/v1/webhook-whatsapp-personal
WEBHOOK_SECRET=tu_secreto_compartido_aqui
MICROSERVICE_SECRET=tu_secreto_compartido_aqui
ALLOWED_ORIGINS=https://59b94a8e-262e-4c13-b768-0d9ba61d4a73.lovableproject.com
```

**IMPORTANTE:** Genera secretos fuertes:
```bash
# En tu terminal local:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Paso 4: Configurar Secrets en Supabase

1. Ve a tu proyecto Supabase → Settings → Edge Functions
2. Agrega estos secrets:
   - `WHATSAPP_MICROSERVICE_URL`: URL de tu servicio en Railway (ej: `https://tu-app.railway.app`)
   - `WHATSAPP_MICROSERVICE_SECRET`: El mismo secreto que usaste en Railway

### Paso 5: Deploy

Railway desplegará automáticamente tu servicio. Espera a que termine y copia la URL generada.

## 🔧 Deployment Alternativo: Render.com

1. Ve a [Render.com](https://render.com)
2. Crea un nuevo "Web Service"
3. Conecta tu repositorio de GitHub
4. Configuración:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. Agrega las mismas variables de entorno que en Railway

## 💻 Testing Local

```bash
# Instalar dependencias
npm install

# Configurar .env
cp .env.example .env
# Editar .env con tus valores

# Ejecutar
npm run dev
```

## 📡 Endpoints del Microservicio

### POST /init
Inicia una nueva sesión de WhatsApp y genera QR.

```bash
curl -X POST https://tu-servicio.railway.app/init \
  -H "Authorization: Bearer tu-secret" \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "uuid-del-agente"}'
```

### GET /status/:agent_id
Verifica el estado de conexión.

```bash
curl https://tu-servicio.railway.app/status/uuid-del-agente \
  -H "Authorization: Bearer tu-secret"
```

### POST /send
Envía un mensaje de WhatsApp.

```bash
curl -X POST https://tu-servicio.railway.app/send \
  -H "Authorization: Bearer tu-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "uuid-del-agente",
    "to": "1234567890",
    "content": "Hola desde el microservicio"
  }'
```

### POST /disconnect/:agent_id
Desconecta una sesión de WhatsApp.

```bash
curl -X POST https://tu-servicio.railway.app/disconnect/uuid-del-agente \
  -H "Authorization: Bearer tu-secret"
```

## 🔒 Seguridad

1. **Secrets Fuertes**: Genera secretos criptográficamente seguros
2. **HTTPS Only**: El microservicio debe usar HTTPS en producción
3. **Rate Limiting**: Considera agregar rate limiting en producción
4. **Monitoring**: Configura alertas para caídas del servicio

## 🐛 Troubleshooting

### Error: "QR code generation timeout"
- El cliente de WhatsApp puede tardar en inicializar
- Verifica que Puppeteer tenga suficiente memoria
- En Railway, considera aumentar los recursos

### Error: "Client not connected"
- La sesión puede haber expirado
- Vuelve a escanear el QR desde el panel de Lovable
- Verifica que el teléfono tenga internet

### Mensajes no llegan
- Verifica que `WEBHOOK_URL` sea correcta
- Comprueba que `WEBHOOK_SECRET` coincida en ambos lados
- Revisa los logs del edge function en Supabase

## 📊 Monitoreo

Railway proporciona logs automáticos. Para ver los logs:

1. Ve a tu proyecto en Railway
2. Click en el servicio
3. Tab "Logs"

Busca estos mensajes clave:
- `✅ WhatsApp client ready` - Conexión exitosa
- `📨 Message received` - Mensaje entrante
- `📤 Sending message` - Mensaje saliente
- `❌` - Errores que requieren atención

## 💰 Costos Estimados

### Railway.app
- Free Tier: $5/mes de crédito gratis
- Uso típico: ~$10-15/mes para uso moderado
- Incluye: 500 horas de ejecución

### Render.com
- Free Tier: Servicio "duerme" después de inactividad (no recomendado)
- Starter: $7/mes - Siempre activo

### VPS Alternativo (DigitalOcean, AWS Lightsail)
- $5-6/mes
- Requiere más configuración manual

## 🔄 Mantenimiento

1. **Backup de sesiones**: Railway guarda las sesiones automáticamente
2. **Updates**: Mantén whatsapp-web.js actualizado
3. **Monitoreo**: Configura alertas si el servicio cae

## 📚 Recursos

- [whatsapp-web.js Documentation](https://wwebjs.dev/)
- [Railway Documentation](https://docs.railway.app/)
- [Express.js Guide](https://expressjs.com/)