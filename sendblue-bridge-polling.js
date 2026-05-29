#!/usr/bin/env node

/**
 * Sendblue ↔ Hermes Bridge (Polling Version)
 *
 * Polls the Sendblue API for new inbound SMS/iMessage messages and forwards
 * them to a Hermes Agent via the Hermes API bridge. Supports per-contact
 * personality prompts, SQLite conversation persistence, and read receipts.
 *
 * Requires: Node.js 18+, Sendblue account (sendblue.co), Hermes Agent
 *           with the hermes-api-bridge.py running on localhost:5000.
 *
 * Setup:
 *   1. cp .env.example .env   → fill in your Sendblue & Hermes API keys
 *   2. npm install
 *   3. node sendblue-bridge-polling.js
 */

const https = require('https');
const http  = require('http');
const path  = require('path');
const fs    = require('fs');
const initSqlJs = require('sql.js');

// ============================================================================
// Configuration
// ============================================================================

require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const config = {
  sendblue: {
    apiKeyId:     process.env.SENDBLUE_API_KEY_ID,
    apiSecretKey: process.env.SENDBLUE_API_SECRET_KEY,
    fromNumber:   process.env.SENDBLUE_FROM_NUMBER,
  },
  hermes: {
    url:    process.env.HERMES_API_SERVER_URL || 'http://localhost:5000/v1',
    apiKey: process.env.HERMES_API_SERVER_KEY,
  },
};

// Validate config
const requiredVars = [
  'SENDBLUE_API_KEY_ID',
  'SENDBLUE_API_SECRET_KEY',
  'SENDBLUE_FROM_NUMBER',
  'HERMES_API_SERVER_URL',
  'HERMES_API_SERVER_KEY',
];

const missingVars = requiredVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error(`❌ Missing environment variables: ${missingVars.join(', ')}`);
  process.exit(1);
}

// ============================================================================
// SQLite Conversation Persistence
// ============================================================================

let db = null;
const dbPath = path.join(__dirname, 'conversation-history.db');
const MAX_MESSAGES_PER_SENDER = 100;

async function initDatabase() {
  const SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS conversation_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_number TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_sender_number
    ON conversation_messages(sender_number)
  `);

  console.log('✓ Database initialized');
  saveDatabase();
}

function saveDatabase() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

function addMessage(senderNumber, role, content) {
  if (!db) return;

  db.run(
    'INSERT INTO conversation_messages (sender_number, role, content) VALUES (?, ?, ?)',
    [senderNumber, role, content]
  );

  // Keep only last MAX_MESSAGES_PER_SENDER per contact
  db.run(`
    DELETE FROM conversation_messages
    WHERE sender_number = ? AND id NOT IN (
      SELECT id FROM conversation_messages
      WHERE sender_number = ?
      ORDER BY id DESC
      LIMIT ?
    )
  `, [senderNumber, senderNumber, MAX_MESSAGES_PER_SENDER]);

  saveDatabase();
}

function getConversationHistory(senderNumber) {
  if (!db) {
    console.log(`  ❌ DB not initialized!`);
    return [];
  }

  const escapedNumber = senderNumber.replace(/'/g, "''");
  const query = `SELECT role, content FROM conversation_messages WHERE sender_number = '${escapedNumber}' ORDER BY id ASC`;

  const result = db.exec(query);

  if (!result || result.length === 0) {
    return [];
  }

  const messages = [];
  for (const row of result[0].values) {
    messages.push({ role: row[0], content: row[1] });
  }

  return messages;
}

function deleteLastMessageIfOrphaned(senderNumber) {
  if (!db) return;
  const escapedNumber = senderNumber.replace(/'/g, "''");
  const result = db.exec(
    `SELECT role FROM conversation_messages WHERE sender_number = '${escapedNumber}' ORDER BY id DESC LIMIT 1`
  );
  if (result.length > 0 && result[0].values.length > 0) {
    const lastRole = result[0].values[0][0];
    if (lastRole === 'user') {
      db.run(
        `DELETE FROM conversation_messages WHERE id = (SELECT MAX(id) FROM conversation_messages WHERE sender_number = '${escapedNumber}')`
      );
      saveDatabase();
      console.log(`  🧹 Cleaned up orphaned user message (no reply received)`);
    }
  }
}

// ============================================================================
// Deduplication
// ============================================================================

const dedupeFile = path.join(__dirname, '.sendblue-processed-messages');

function loadDedupeState() {
  try {
    const data = fs.readFileSync(dedupeFile, 'utf-8');
    return new Set(data.split('\n').filter(x => x));
  } catch (_) {
    // First run — no state file yet
  }
  return new Set();
}

const processedMessages = loadDedupeState();

function saveDedupeState() {
  const lines = Array.from(processedMessages).slice(-10000);
  fs.writeFileSync(dedupeFile, lines.join('\n'));
}

// ============================================================================
// Per-Contact Personalities
// ============================================================================
//
// Customize how your Hermes agent responds to different contacts.  Add entries
// with the contact's E.164 phone number as the key.  Unknown numbers get the
// 'default' personality.
//
// Each entry:
//   name         — display name (used in logs)
//   systemPrompt — system prompt injected before the conversation history
//   model        — (optional) override the LLM model for this contact

const personalityConfig = {
  // ─── Your contacts — add entries here ──────────────────────────────────
  // '+14085551234': {
  //   name: 'Alice',
  //   systemPrompt: `You're chatting with Alice, my close friend, over text.
  //     Be warm and casual — like a real text conversation. Keep it brief.
  //     Use web_search when she asks about current events or specific facts.`,
  //   model: 'anthropic/claude-sonnet-4-5',
  // },

  // ─── Default for unknown numbers ──────────────────────────────────────
  'default': {
    name: 'User',
    systemPrompt: `You're a helpful assistant responding via SMS. Be polite,
      concise, and professional. Keep responses brief since it's text messaging.
      Answer questions helpfully and directly.

      IMPORTANT: You have access to web_search. Whenever asked about current
      events, recent information, specific details about places/products/services,
      or anything time-sensitive, ALWAYS use web_search FIRST before responding.
      Never cite training data limitations — just search and provide the info.`,
  },
};

// ============================================================================
// API Requests
// ============================================================================

function sendblueRequest(method, endpoint, data) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, 'https://api.sendblue.co');
    const headers = {
      'sb-api-key-id':    config.sendblue.apiKeyId,
      'sb-api-secret-key': config.sendblue.apiSecretKey,
      'Content-Type':     'application/json',
    };

    const reqData = data ? JSON.stringify(data) : null;

    const req = https.request(url, { method, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`Invalid JSON response: ${body}`));
        }
      });
    });

    req.on('error', reject);
    if (reqData) req.write(reqData);
    req.end();
  });
}

function hermesRequest(method, endpoint, data) {
  return new Promise((resolve, reject) => {
    const fullUrl = `${config.hermes.url}${endpoint}`;
    const url = new URL(fullUrl);
    const headers = {
      Authorization: `Bearer ${config.hermes.apiKey}`,
      'Content-Type': 'application/json',
    };

    const reqData = data ? JSON.stringify(data) : null;

    // Use http or https based on URL protocol
    const client = fullUrl.startsWith('https') ? https : http;
    const req = client.request(url, { method, headers, timeout: 330000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`Invalid JSON response: ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Hermes request timeout'));
    });
    if (reqData) req.write(reqData);
    req.end();
  });
}

// ============================================================================
// Message Processing
// ============================================================================

async function handleInboundMessage(payload) {
  const {
    from_number: senderNumber,
    to_number: toNumber,
    content,
    media_url: mediaUrl,
    service,
    message_handle: messageHandle,
  } = payload;

  console.log(`\n📱 Inbound from ${senderNumber}: ${(content || '').substring(0, 50)}...`);

  // Deduplicate
  if (messageHandle && processedMessages.has(messageHandle)) {
    console.log(`  → Already processed (dedupe), skipping.`);
    return;
  }
  if (messageHandle) {
    processedMessages.add(messageHandle);
    saveDedupeState();
  }

  try {
    // Send read receipt
    await sendblueRequest('POST', '/api/mark-read', {
      number: senderNumber,
      from_number: config.sendblue.fromNumber,
    });

    // Send typing indicator
    await sendblueRequest('POST', '/api/send-typing-indicator', {
      number: senderNumber,
      from_number: config.sendblue.fromNumber,
    });

    // Get personality config for this sender
    const personality = personalityConfig[senderNumber] || personalityConfig['default'];

    // Persist user message
    addMessage(senderNumber, 'user', content);

    // Get conversation history
    const conversationHistory = getConversationHistory(senderNumber);

    // Build messages array
    const messages = [
      { role: 'system', content: personality.systemPrompt },
      ...conversationHistory,
    ];

    // Trim to last 34 messages + system prompt = 35 total
    if (messages.length > 35) {
      messages.splice(1, messages.length - 35);
    }

    // Choose model (per-contact override or default)
    const model = personality.model || 'deepseek/deepseek-v4-flash';

    // Send to Hermes
    const hermesPayload = {
      model: model,
      messages: messages,
      max_tokens: 1024,
    };

    console.log(`  → Calling Hermes API (${personality.name}, ${model})...`);
    const hermesResponse = await hermesRequest('POST', '/chat/completions', hermesPayload);

    if (!hermesResponse.choices || !hermesResponse.choices[0]) {
      throw new Error(`Invalid Hermes response: ${JSON.stringify(hermesResponse)}`);
    }

    const replyText = hermesResponse.choices[0].message.content;
    addMessage(senderNumber, 'assistant', replyText);

    console.log(`  → Hermes replied: ${replyText.substring(0, 50)}...`);

    // Send reply via Sendblue
    const sendResult = await sendblueRequest('POST', '/api/send-message', {
      number: senderNumber,
      from_number: config.sendblue.fromNumber,
      content: replyText,
    });
    console.log(`  ✓ Sent (message_id: ${sendResult.id || 'unknown'})`);
  } catch (error) {
    console.error(`  ✗ Error processing message: ${error.message}`);

    // Remove orphaned user message so it doesn't contaminate future context
    deleteLastMessageIfOrphaned(senderNumber);

    try {
      await sendblueRequest('POST', '/api/send-message', {
        number: senderNumber,
        from_number: config.sendblue.fromNumber,
        content: `Sorry, I encountered an error processing your message. Please try again.`,
      });
    } catch (err) {
      console.error(`  ✗ Failed to send error message: ${err.message}`);
    }
  }
}

// ============================================================================
// Polling
// ============================================================================

let lastPolledDate = new Date('2000-01-01'); // Process all existing messages on startup

async function pollMessages() {
  try {
    const response = await sendblueRequest(
      'GET',
      '/api/v2/messages?is_outbound=false&limit=50',
      null
    );

    if (!response.data || !Array.isArray(response.data)) {
      console.error(`Invalid API response: ${JSON.stringify(response)}`);
      return;
    }

    const newMessages = response.data.filter((msg) => {
      const msgDate = new Date(msg.date_sent);
      return msgDate > lastPolledDate && !msg.is_outbound;
    });

    if (newMessages.length > 0) {
      console.log(`[${new Date().toISOString()}] Found ${newMessages.length} new message(s)`);
      for (const msg of newMessages) {
        await handleInboundMessage(msg);
      }
    }

    lastPolledDate = new Date();
  } catch (error) {
    console.error(`❌ Poll error: ${error.message}`);
    if (error.stack) console.error(`Stack: ${error.stack}`);
  }
}

// ============================================================================
// Startup
// ============================================================================

async function start() {
  await initDatabase();

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║         Sendblue ↔ Hermes Bridge (Polling Mode)              ║
║              With SQLite Persistence                         ║
╚═══════════════════════════════════════════════════════════════╝

  Status: ✓ Running
  Mode:   Polling every 2s (no webhooks required)
  Memory: SQLite persistent (up to ${MAX_MESSAGES_PER_SENDER} messages per sender)

  Sendblue Number: ${config.sendblue.fromNumber}
  Hermes API:      ${config.hermes.url}
  Database:        ${dbPath}

  Configuration check:
    ✓ SENDBLUE_API_KEY_ID
    ✓ SENDBLUE_API_SECRET_KEY
    ✓ SENDBLUE_FROM_NUMBER: ${config.sendblue.fromNumber}
    ✓ HERMES_API_SERVER_URL: ${config.hermes.url}
    ✓ HERMES_API_SERVER_KEY
`);

  // Start polling
  setInterval(pollMessages, 2000);
  pollMessages();
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n✓ Shutting down...');
  if (db) { saveDatabase(); console.log('✓ Database saved'); }
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n✓ Shutting down...');
  if (db) { saveDatabase(); console.log('✓ Database saved'); }
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error.message);
  process.exit(1);
});

start().catch(err => {
  console.error('❌ Failed to start:', err.message);
  process.exit(1);
});
