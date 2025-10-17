const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://wmzbqsegsyagcjgxefqs.supabase.co/functions/v1/webhook-whatsapp-personal';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'your-secret-key-here';
const MICROSERVICE_SECRET = process.env.MICROSERVICE_SECRET || 'your-secret-key-here';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || '*';

// Middleware
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());

// Storage for clients and QR codes
const clients = new Map();
const qrCodes = new Map();

// Helper function to destroy a client completely
async function destroyClient(agentId) {
  console.log(`🗑️ Destroying client for ${agentId}`);
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
  console.log(`📱 Initializing WhatsApp client for agent: ${agentId}`);
  
  return new Promise((resolve, reject) => {
    const client = new Client({
      authStrategy: new LocalAuth({ clientId: agentId }),
      puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu'
        ]
      }
    });

    // QR Code generation
    client.on('qr', async (qr) => {
      console.log(`📲 QR Code generated for ${agentId}`);
      try {
        const qrImage = await QRCode.toDataURL(qr);
        qrCodes.set(agentId, qrImage);
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

    // Incoming message handler
    client.on('message', async (msg) => {
      console.log(`📨 Message received from ${msg.from}:`, msg.body);
      
      try {
        const contact = await msg.getContact();
        
        // Send webhook to Supabase
        const webhookResponse = await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${WEBHOOK_SECRET}`
          },
          body: JSON.stringify({
            agent_id: agentId,
            from: msg.from,
            body: msg.body,
            timestamp: msg.timestamp,
            has_media: msg.hasMedia,
            contact_name: contact.pushname || contact.name
          })
        });

        if (!webhookResponse.ok) {
          console.error('Webhook error:', await webhookResponse.text());
        } else {
          console.log('✅ Message forwarded to webhook');
        }
      } catch (error) {
        console.error('Error processing message:', error);
      }
    });

    // Error handling
    client.on('auth_failure', (msg) => {
      console.error(`❌ Auth failure for ${agentId}:`, msg);
      clients.delete(agentId);
      qrCodes.delete(agentId);
      reject(new Error(`Authentication failed: ${msg}`));
    });

    client.on('disconnected', (reason) => {
      console.log(`🔌 Client disconnected for ${agentId}:`, reason);
      clients.delete(agentId);
      qrCodes.delete(agentId);
    });

    // Initialize the client
    client.initialize().catch((error) => {
      console.error(`❌ Failed to initialize client for ${agentId}:`, error);
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
    version: '1.0.0',
    activeClients: clients.size
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    activeClients: clients.size,
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

    // If client already exists, destroy it first to ensure clean state
    let client = clients.get(agent_id);
    if (client) {
      console.log(`🔄 Destroying existing client for ${agent_id} before creating new one`);
      await destroyClient(agent_id);
    }
    
    // Always create a fresh client
    console.log(`📱 Creating fresh client for ${agent_id} (after cleanup delay)`);
    
    try {
      client = await initializeClient(agent_id);
      clients.set(agent_id, client);
      
      // At this point, QR should be ready
      const qrCode = qrCodes.get(agent_id);
      
      if (!qrCode) {
        throw new Error('QR code not generated after initialization');
      }
      
      return res.json({
        success: true,
        qr_code: qrCode,
        session_id: agent_id
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

// Legacy code path - now simplified since we always reinitialize
/* Old logic removed - we now always destroy and recreate
    } else {
      console.log(`♻️ Client already exists for ${agent_id}, checking state...`);
      
      // Client exists, try to check if it's ready
      try {
        const state = await client.getState();
*/

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
    if (!to.includes('@c.us')) {
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
    const client = clients.get(agent_id);
    
    if (!client) {
      return res.json({ success: true, message: 'Client not found' });
    }
    
    console.log(`🔌 Disconnecting client for ${agent_id}`);
    
    await client.destroy();
    clients.delete(agent_id);
    qrCodes.delete(agent_id);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error disconnecting:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 WhatsApp Microservice running on port ${PORT}`);
  console.log(`📍 Webhook URL: ${WEBHOOK_URL}`);
  console.log(`🔐 Auth configured: ${MICROSERVICE_SECRET !== 'your-secret-key-here'}`);
});
