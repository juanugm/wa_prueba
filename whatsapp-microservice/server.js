const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const cors = require('cors');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://wmzbqsegsyagcjgxefqs.supabase.co/functions/v1/webhook-whatsapp-personal';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'your-secret-key-here';
const MICROSERVICE_SECRET = process.env.MICROSERVICE_SECRET || 'your-secret-key-here';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || '*';

// ⚙️ OPTIMIZATION SETTINGS
const MAX_CONCURRENT_SESSIONS = 5; // Límite de sesiones simultáneas
const QR_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutos para escanear QR
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Limpieza cada 5 minutos

// Middleware
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());

// Storage for clients, QR codes, and timeouts
const clients = new Map();
const qrCodes = new Map();
const qrTimeouts = new Map(); // 🆕 Track QR timeouts per agent

// Cleanup all Chrome temp directories on startup
const cleanupAllTempDirs = () => {
  const tmpDir = '/tmp';
  
  try {
    const files = fsSync.readdirSync(tmpDir);
    const chromeDirs = files.filter(f => f.startsWith('chrome-user-data-'));
    
    chromeDirs.forEach(dir => {
      const fullPath = path.join(tmpDir, dir);
      console.log(`🗑️ Cleaning up old Chrome directory: ${fullPath}`);
      try {
        fsSync.rmSync(fullPath, { recursive: true, force: true });
      } catch (error) {
        console.error(`⚠️ Error cleaning ${fullPath}:`, error.message);
      }
    });
    
    console.log(`✅ Cleaned up ${chromeDirs.length} old Chrome directories`);
  } catch (error) {
    console.error('❌ Error during startup cleanup:', error);
  }
};

// Cleanup Chrome temp directory for specific agent
const cleanupTempDirs = async (agentId) => {
  const chromeTempDir = `/tmp/chrome-user-data-${agentId}`;
  
  try {
    if (fsSync.existsSync(chromeTempDir)) {
      console.log(`🗑️ Deleting Chrome temp dir at: ${chromeTempDir}`);
      fsSync.rmSync(chromeTempDir, { recursive: true, force: true });
      console.log('✅ Chrome temp dir deleted');
    }
  } catch (error) {
    console.error('❌ Error cleaning Chrome temp dir:', error);
  }
};

// 🆕 Clear QR timeout for an agent
function clearQrTimeout(agentId) {
  const timeout = qrTimeouts.get(agentId);
  if (timeout) {
    clearTimeout(timeout);
    qrTimeouts.delete(agentId);
    console.log(`⏰ QR timeout cleared for ${agentId}`);
  }
}

// Helper function to destroy a client completely
async function destroyClient(agentId) {
  console.log(`🗑️ Destroying client for ${agentId}`);
  
  // 🆕 Clear any pending QR timeout
  clearQrTimeout(agentId);
  
  const client = clients.get(agentId);
  
  if (client) {
    try {
      await client.destroy();
      console.log(`✅ Client destroyed in memory`);
    } catch (error) {
      console.error(`⚠️ Error destroying client for ${agentId}:`, error.message);
    }
  }
  
  // Delete LocalAuth data from disk
  try {
    const authPath = path.join(__dirname, '.wwebjs_auth', agentId);
    console.log(`🗑️ Deleting LocalAuth data at: ${authPath}`);
    await fs.rm(authPath, { recursive: true, force: true });
    console.log(`✅ LocalAuth data deleted`);
  } catch (error) {
    console.error(`⚠️ Error deleting LocalAuth data:`, error.message);
  }
  
  clients.delete(agentId);
  qrCodes.delete(agentId);
  
  // Wait for full cleanup
  await new Promise(resolve => setTimeout(resolve, 2000));
  console.log(`⏱️ Waited for full cleanup`);
}

// Auth middleware
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${MICROSERVICE_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Helper function to initialize WhatsApp client
async function initializeClient(agentId) {
  // 🔧 Clean Chrome temp directories BEFORE initializing
  await cleanupTempDirs(agentId);
  
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable';
  console.log(`📱 Initializing WhatsApp client for agent: ${agentId}`);
  console.log(`🌐 Using Chrome at: ${execPath}`);
  
  return new Promise((resolve, reject) => {
    const client = new Client({
      authStrategy: new LocalAuth({ clientId: agentId }),
      puppeteer: {
        headless: true,
        executablePath: execPath,
        timeout: 90000,
        protocolTimeout: 180000,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-sync',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-crash-upload',
          '--headless=new',
          '--hide-scrollbars',
          '--disable-blink-features=AutomationControlled',
          `--user-data-dir=/tmp/chrome-user-data-${agentId}`,
          '--disable-features=VizDisplayCompositor',
          '--disable-breakpad',
          '--disable-component-update',
          '--disable-domain-reliability',
          '--disable-features=AudioServiceOutOfProcess',
          '--disable-features=IsolateOrigins,site-per-process',
          '--disable-features=TranslateUI',
          '--disable-ipc-flooding-protection',
          '--disable-renderer-backgrounding',
          '--enable-features=NetworkService,NetworkServiceInProcess',
          '--force-color-profile=srgb',
          '--js-flags=--max-old-space-size=460'
        ]
      }
    });

    // QR Code generation
    client.on('qr', async (qr) => {
      console.log(`📲 QR Code generated for ${agentId}`);
      try {
        const qrImage = await QRCode.toDataURL(qr);
        qrCodes.set(agentId, qrImage);
        
        // 🆕 Clear previous timeout and set new one
        clearQrTimeout(agentId);
        const timeout = setTimeout(async () => {
          console.log(`⏰ QR timeout expired for ${agentId} - destroying client to save resources`);
          await destroyClient(agentId);
        }, QR_TIMEOUT_MS);
        qrTimeouts.set(agentId, timeout);
        console.log(`⏰ QR timeout set for ${agentId} (${QR_TIMEOUT_MS / 1000}s)`);
        
        // Resolve the promise when QR is ready
        resolve(client);
      } catch (error) {
        console.error('Error generating QR:', error);
        reject(error);
      }
    });

    // Ready event
    client.on('ready', async () => {
      console.log(`✅ WhatsApp client ready for ${agentId}`);
      
      // 🆕 Clear QR timeout - client connected successfully
      clearQrTimeout(agentId);
      
      const info = client.info;
      const phoneNumber = info.wid.user;
      
      console.log(`📞 Phone number: ${phoneNumber}`);
      
      // Notify edge function about successful connection
      try {
        const response = await fetch('https://wmzbqsegsyagcjgxefqs.supabase.co/functions/v1/whatsapp-personal-connect', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action: 'connected',
            agent_id: agentId,
            phone_number: phoneNumber,
            session_id: agentId
          })
        });

        if (!response.ok) {
          console.error('Failed to notify edge function:', await response.text());
        } else {
          console.log('✅ Edge function notified of connection');
        }
      } catch (error) {
        console.error('Error notifying edge function:', error);
      }

      // Clear QR code after successful connection
      qrCodes.delete(agentId);
    });

    // Message handler (incoming and outgoing)
    client.on('message_create', async (msg) => {
      console.log(`📨 Message ${msg.fromMe ? 'SENT' : 'RECEIVED'} ${msg.fromMe ? 'to' : 'from'} ${msg.from}:`, msg.body?.substring(0, 50));
      
      try {
        // ✅ IMPORTANTE: Obtener el número correcto según la dirección del mensaje
        const conversationTarget = msg.fromMe ? msg.to : msg.from;
        
        // Detectar si es un mensaje de grupo
        const isGroup = conversationTarget.endsWith('@g.us');
        const participant = isGroup ? msg.author : null;
        
        // ✅ OBTENER EL NOMBRE CORRECTO SIEMPRE DESDE getChatById
        let contactName = 'Unknown';
        let senderName = null;
        
        try {
          const targetChat = await client.getChatById(conversationTarget);
          
          if (isGroup) {
            contactName = targetChat.name || 'Unknown Group';
            console.log(`📍 Group message: ${contactName}`);
            
            // Para grupos, obtener nombre del autor del mensaje (solo si NO es from_me)
            if (participant && !msg.fromMe) {
              try {
                const participantContact = await client.getContactById(participant);
                senderName = participantContact.pushname 
                          || participantContact.name 
                          || participantContact.verifiedName 
                          || participant.split('@')[0];
              } catch (err) {
                console.error('Error getting participant name:', err.message);
                senderName = participant.split('@')[0];
              }
            }
          } else {
            // Para contactos individuales - SIEMPRE usar el nombre del chat
            contactName = targetChat.name 
                       || targetChat.pushname 
                       || targetChat.verifiedName
                       || conversationTarget.split('@')[0];
            
            console.log(`📍 ${msg.fromMe ? '➡️ Sent to' : '⬅️ Received from'}: ${contactName} (${conversationTarget})`);
          }
        } catch (error) {
          console.error(`❌ Error getting chat name for ${conversationTarget}:`, error.message);
          // Fallback: usar el número/ID como nombre
          contactName = conversationTarget.split('@')[0];
        }
        
        // ✅ DETECTAR TIPO DE MENSAJE Y METADATA
        let messageType = 'text';
        let messageMetadata = {
          timestamp: msg.timestamp,
          from: conversationTarget,
          participant: participant,
          source: 'whatsapp_personal',
          from_me: msg.fromMe,
          ...(senderName && { sender_name: senderName })
        };
        
        // ✅ DESCARGA DE MULTIMEDIA (solo para mensajes recibidos)
        let mediaUrl = null;
        let mediaFileName = null;
        
        if (msg.hasMedia && !msg.fromMe) {
          try {
            console.log(`📥 Downloading media (type: ${msg.type})...`);
            const media = await msg.downloadMedia();
            
            if (media) {
              // Generar nombre de archivo único
              const timestamp = Date.now();
              const extension = media.mimetype.split('/')[1] || 'bin';
              mediaFileName = `whatsapp-${msg.id._serialized.replace(/[^a-zA-Z0-9]/g, '_')}-${timestamp}.${extension}`;
              
              // Subir a Supabase Storage
              const supabaseUrl = WEBHOOK_URL.replace('/functions/v1/webhook-whatsapp-personal', '');
              const storageUrl = `${supabaseUrl}/storage/v1/object/whatsapp-media/${mediaFileName}`;
              
              const storageResponse = await fetch(storageUrl, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${WEBHOOK_SECRET}`,
                  'Content-Type': media.mimetype,
                },
                body: Buffer.from(media.data, 'base64')
              });
              
              if (storageResponse.ok) {
                mediaUrl = `${supabaseUrl}/storage/v1/object/public/whatsapp-media/${mediaFileName}`;
                console.log(`✅ Media uploaded: ${mediaUrl}`);
              } else {
                const errorText = await storageResponse.text();
                console.error('❌ Failed to upload media:', errorText);
              }
            }
          } catch (error) {
            console.error('❌ Error downloading/uploading media:', error.message);
          }
        }
        
        // Detectar tipos especiales de mensaje
        if (msg.hasMedia) {
          messageType = 'media';
          messageMetadata.media_type = msg.type; // image, video, audio, document, sticker
          if (mediaUrl) {
            messageMetadata.media_url = mediaUrl;
            messageMetadata.media_filename = mediaFileName;
          }
        } else if (msg.type === 'ptt') {
          messageType = 'voice';
          messageMetadata.voice_duration = msg._data?.duration || null;
        } else if (msg.type === 'sticker') {
          messageType = 'sticker';
        } else if (msg.hasQuotedMsg) {
          messageType = 'reply';
          try {
            const quotedMsg = await msg.getQuotedMessage();
            messageMetadata.quoted_message = {
              id: quotedMsg.id._serialized,
              body: quotedMsg.body?.substring(0, 100),
              from: quotedMsg.from
            };
          } catch (error) {
            console.error('Error getting quoted message:', error);
          }
        }
        
        // Preparar el body del mensaje
        let messageBody = msg.body || '';
        if (messageType === 'voice') {
          messageBody = '🎤 Nota de voz';
        } else if (messageType === 'sticker') {
          messageBody = '🎨 Sticker';
        } else if (messageType === 'media') {
          const mediaTypeLabel = {
            'image': '📷 Imagen',
            'video': '🎥 Video',
            'audio': '🎵 Audio',
            'document': '📄 Documento'
          };
          messageBody = mediaTypeLabel[msg.type] || '📎 Archivo multimedia';
          if (msg.body) messageBody += `: ${msg.body}`;
        }
        
        // Send webhook to Supabase
        const webhookResponse = await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${WEBHOOK_SECRET}`
          },
          body: JSON.stringify({
            agent_id: agentId,
            from: conversationTarget,
            to: msg.to,
            participant: participant,
            body: messageBody,
            timestamp: msg.timestamp,
            has_media: msg.hasMedia,
            contact_name: contactName,
            is_group: isGroup,
            sender_name: senderName,
            from_me: msg.fromMe,
            message_type: messageType,
            message_metadata: messageMetadata
          })
        });

        if (!webhookResponse.ok) {
          console.error('Webhook error:', await webhookResponse.text());
        } else {
          console.log(`✅ Webhook sent (${msg.fromMe ? 'outgoing' : 'incoming'}, type: ${messageType})`);
        }
      } catch (error) {
        console.error('Error processing message:', error);
      }
    });

    // Error handling
    client.on('auth_failure', (msg) => {
      console.error(`❌ Auth failure for ${agentId}:`, msg);
      clearQrTimeout(agentId);
      clients.delete(agentId);
      qrCodes.delete(agentId);
      reject(new Error(`Authentication failed: ${msg}`));
    });

    client.on('disconnected', (reason) => {
      console.log(`🔌 Client disconnected for ${agentId}:`, reason);
      clearQrTimeout(agentId);
      clients.delete(agentId);
      qrCodes.delete(agentId);
    });

    // Initialize the client
    client.initialize().catch((error) => {
      console.error(`❌ Failed to initialize client for ${agentId}:`, error);
      clearQrTimeout(agentId);
      clients.delete(agentId);
      qrCodes.delete(agentId);
      reject(error);
    });
  });
}

// Routes

// Root endpoint for Railway health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'WhatsApp service running', 
    version: '1.1.0', // 🆕 Updated version
    activeClients: clients.size,
    maxClients: MAX_CONCURRENT_SESSIONS,
    qrTimeoutSeconds: QR_TIMEOUT_MS / 1000
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    activeClients: clients.size,
    maxClients: MAX_CONCURRENT_SESSIONS,
    pendingQRs: qrCodes.size,
    timestamp: new Date().toISOString()
  });
});

// Initialize connection
app.post('/init', authMiddleware, async (req, res) => {
  try {
    const { agent_id } = req.body;
    
    if (!agent_id) {
      return res.status(400).json({ error: 'agent_id is required' });
    }

    console.log(`🔄 Init request for agent: ${agent_id}`);

    // 🆕 Check if already connected - return early without regenerating QR
    let existingClient = clients.get(agent_id);
    if (existingClient) {
      try {
        const state = await existingClient.getState();
        if (state === 'CONNECTED') {
          console.log(`✅ Agent ${agent_id} already connected, returning existing info`);
          return res.json({
            success: true,
            already_connected: true,
            phone_number: existingClient.info?.wid?.user,
            state: 'CONNECTED'
          });
        }
      } catch (e) {
        console.log(`⚠️ Existing client for ${agent_id} in bad state, will recreate`);
      }
    }

    // 🆕 Check session limit BEFORE destroying existing client
    const activeConnectedClients = await countConnectedClients();
    if (activeConnectedClients >= MAX_CONCURRENT_SESSIONS && !existingClient) {
      console.log(`🚫 Session limit reached (${activeConnectedClients}/${MAX_CONCURRENT_SESSIONS})`);
      return res.status(503).json({ 
        error: 'Límite de sesiones alcanzado',
        active_clients: activeConnectedClients,
        max_clients: MAX_CONCURRENT_SESSIONS,
        hint: 'Desconecta otra cuenta de WhatsApp primero'
      });
    }

    // If client exists but not connected, destroy it first to ensure clean state
    if (existingClient) {
      console.log(`🔄 Destroying existing non-connected client for ${agent_id}`);
      await destroyClient(agent_id);
    }
    
    // Create a fresh client
    console.log(`📱 Creating fresh client for ${agent_id}`);
    
    try {
      const client = await initializeClient(agent_id);
      clients.set(agent_id, client);
      
      // At this point, QR should be ready
      const qrCode = qrCodes.get(agent_id);
      
      if (!qrCode) {
        throw new Error('QR code not generated after initialization');
      }
      
      return res.json({
        success: true,
        qr_code: qrCode,
        session_id: agent_id,
        timeout_seconds: QR_TIMEOUT_MS / 1000
      });
    } catch (initError) {
      console.error(`❌ Error during client initialization for ${agent_id}:`, initError);
      await destroyClient(agent_id);
      throw initError;
    }
  } catch (error) {
    console.error('❌ Error in /init endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// 🆕 Helper to count actually connected clients
async function countConnectedClients() {
  let count = 0;
  for (const [agentId, client] of clients) {
    try {
      const state = await client.getState();
      if (state === 'CONNECTED') {
        count++;
      }
    } catch (e) {
      // Client in bad state, don't count
    }
  }
  return count;
}

// Check status
app.get('/status/:agent_id', authMiddleware, async (req, res) => {
  try {
    const { agent_id } = req.params;
    const client = clients.get(agent_id);
    
    if (!client) {
      return res.json({ connected: false });
    }
    
    const state = await client.getState();
    
    if (state === 'CONNECTED') {
      const info = client.info;
      res.json({
        connected: true,
        phone_number: info.wid.user,
        state
      });
    } else {
      res.json({ connected: false, state });
    }
  } catch (error) {
    console.error('Error checking status:', error);
    res.json({ connected: false, error: error.message });
  }
});

// Send message
app.post('/send', authMiddleware, async (req, res) => {
  try {
    const { agent_id, to, content } = req.body;
    
    if (!agent_id || !to || !content) {
      return res.status(400).json({ error: 'agent_id, to, and content are required' });
    }
    
    const client = clients.get(agent_id);
    
    if (!client) {
      return res.status(404).json({ error: 'Client not found or not connected' });
    }
    
    const state = await client.getState();
    
    if (state !== 'CONNECTED') {
      return res.status(400).json({ error: 'Client not connected' });
    }
    
    console.log(`📤 Sending message to ${to}`);
    
    // Format phone number (ensure it has country code)
    let formattedNumber = to;
    
    // Solo formatear si NO es un grupo (los grupos ya vienen con @g.us)
    if (!to.includes('@g.us') && !to.includes('@c.us')) {
      // Remove any non-numeric characters
      formattedNumber = to.replace(/\D/g, '');
      formattedNumber = `${formattedNumber}@c.us`;
    }
    
    const result = await client.sendMessage(formattedNumber, content);
    
    console.log('✅ Message sent:', result.id.id);
    
    res.json({
      success: true,
      message_id: result.id.id
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all chats for an agent
app.get('/chats/:agent_id', authMiddleware, async (req, res) => {
  try {
    const { agent_id } = req.params;
    const client = clients.get(agent_id);
    
    if (!client || !client.info) {
      return res.status(404).json({ error: 'Client not connected' });
    }
    
    console.log(`📋 Fetching chats for agent: ${agent_id}`);
    const chats = await client.getChats();
    
    const chatList = chats.map(chat => ({
      id: chat.id._serialized,
      name: chat.name,
      isGroup: chat.isGroup,
      lastMessageTime: chat.timestamp,
      unreadCount: chat.unreadCount
    }));
    
    res.json({ chats: chatList });
  } catch (error) {
    console.error('Error getting chats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get messages for a specific chat
app.get('/messages/:agent_id/:chat_id', authMiddleware, async (req, res) => {
  try {
    const { agent_id, chat_id } = req.params;
    const { limit = 100 } = req.query;
    
    const client = clients.get(agent_id);
    
    if (!client || !client.info) {
      return res.status(404).json({ error: 'Client not connected' });
    }
    
    console.log(`💬 Fetching messages for ${agent_id} / ${chat_id}`);
    const chat = await client.getChatById(chat_id);
    const messages = await chat.fetchMessages({ limit: parseInt(limit) });
    
    const messageList = messages.map(msg => ({
      id: msg.id.id,
      body: msg.body,
      timestamp: msg.timestamp,
      fromMe: msg.fromMe,
      hasMedia: msg.hasMedia,
      from: msg.from,
      to: msg.to
    }));
    
    res.json({ messages: messageList });
  } catch (error) {
    console.error('Error getting messages:', error);
    res.status(500).json({ error: error.message });
  }
});

// Disconnect
app.post('/disconnect/:agent_id', authMiddleware, async (req, res) => {
  try {
    const { agent_id } = req.params;
    console.log(`🔌 Disconnect request for agent: ${agent_id}`);
    
    const client = clients.get(agent_id);
    
    if (client) {
      console.log(`🗑️ Destroying client for ${agent_id}`);
      clearQrTimeout(agent_id);
      await client.destroy();
      clients.delete(agent_id);
      qrCodes.delete(agent_id);
    }
    
    // 🔧 Clean LocalAuth data
    const authPath = path.join(__dirname, '.wwebjs_auth', agent_id);
    try {
      if (fsSync.existsSync(authPath)) {
        console.log(`🗑️ Deleting LocalAuth data at: ${authPath}`);
        fsSync.rmSync(authPath, { recursive: true, force: true });
        console.log('✅ LocalAuth data deleted');
      }
    } catch (error) {
      console.error('⚠️ Error cleaning LocalAuth:', error.message);
    }
    
    // 🔧 Clean Chrome temp directory
    await cleanupTempDirs(agent_id);
    
    res.json({ success: true, message: 'Client disconnected and cleaned up' });
  } catch (error) {
    console.error(`❌ Error disconnecting client for ${agent_id}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// 🆕 Automatic cleanup of inactive/disconnected clients every 5 minutes
setInterval(async () => {
  console.log(`🧹 Running automatic cleanup check... (${clients.size} clients, ${qrCodes.size} pending QRs)`);
  
  let cleanedUp = 0;
  
  for (const [agentId, client] of clients) {
    try {
      const state = await client.getState();
      
      if (state !== 'CONNECTED') {
        console.log(`🗑️ Cleaning up disconnected client: ${agentId} (state: ${state || 'unknown'})`);
        await destroyClient(agentId);
        cleanedUp++;
      }
    } catch (e) {
      console.log(`🗑️ Cleaning up errored client: ${agentId} (error: ${e.message})`);
      await destroyClient(agentId);
      cleanedUp++;
    }
  }
  
  if (cleanedUp > 0) {
    console.log(`✅ Cleaned up ${cleanedUp} inactive clients. Remaining: ${clients.size}`);
  } else {
    console.log(`✅ No inactive clients to clean up`);
  }
}, CLEANUP_INTERVAL_MS);

// Cleanup on startup
cleanupAllTempDirs();

// Start server
app.listen(PORT, () => {
  console.log(`🚀 WhatsApp Microservice running on port ${PORT}`);
  console.log(`📍 Webhook URL: ${WEBHOOK_URL}`);
  console.log(`🔐 Auth configured: ${MICROSERVICE_SECRET !== 'your-secret-key-here'}`);
  console.log(`⚙️ Max concurrent sessions: ${MAX_CONCURRENT_SESSIONS}`);
  console.log(`⏰ QR timeout: ${QR_TIMEOUT_MS / 1000} seconds`);
  console.log(`🧹 Cleanup interval: ${CLEANUP_INTERVAL_MS / 1000} seconds`);
});
