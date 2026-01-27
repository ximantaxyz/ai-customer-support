const express = require('express');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.static('.'));

const CONFIG = require('./config.json');
const MEMORY_FILE = './memory.json';
const TOKEN_FILE = './token.json';
const ASSISTANT_CORE_FILE = './assistant_core.txt';

let emailMemory = [];
let telegramMemory = [];
let currentStatus = 'idle';
let assistantCore = '';

try {
  assistantCore = fsSync.readFileSync(ASSISTANT_CORE_FILE, 'utf8');
} catch (error) {
  assistantCore = '';
}

const oauth2Client = new google.auth.OAuth2(
  CONFIG.gmail.clientId,
  CONFIG.gmail.clientSecret,
  CONFIG.gmail.redirectUri
);

const bot = new TelegramBot(CONFIG.telegram.botToken, { polling: true });

async function loadMemory() {
  try {
    const data = await fs.readFile(MEMORY_FILE, 'utf8');
    const parsed = JSON.parse(data);
    emailMemory = parsed.emails || [];
    telegramMemory = parsed.telegram || [];
  } catch (error) {
    emailMemory = [];
    telegramMemory = [];
  }
}

async function saveMemory() {
  await fs.writeFile(MEMORY_FILE, JSON.stringify({ emails: emailMemory, telegram: telegramMemory }, null, 2));
}

async function loadToken() {
  try {
    const token = await fs.readFile(TOKEN_FILE, 'utf8');
    oauth2Client.setCredentials(JSON.parse(token));
    return true;
  } catch (error) {
    return false;
  }
}

async function saveToken(tokens) {
  await fs.writeFile(TOKEN_FILE, JSON.stringify(tokens));
}

async function callOllama(prompt, systemPrompt) {
  try {
    const fullPrompt = assistantCore ? `${assistantCore}\n\n${systemPrompt}\n\n${prompt}` : `${systemPrompt}\n\n${prompt}`;
    
    const response = await axios.post('http://127.0.0.1:11434/api/generate', {
      model: 'qwen:0.5b',
      prompt: fullPrompt,
      stream: false,
      options: {
        temperature: 0.7,
        num_predict: 300
      }
    });
    return response.data.response.trim();
  } catch (error) {
    return null;
  }
}

function stripMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`(.+?)`/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .trim();
}

async function generateReply(customerMessage, context = '') {
  const systemPrompt = `You are a professional customer support assistant for an e-commerce platform. You write polite, clear, and helpful replies to customers. You never mention that you are AI or automated. You never promise refunds or compensation without authorization. You never make up order details or tracking numbers. You escalate serious issues politely by saying the customer will be contacted by a specialist. You keep replies concise but warm. You never use markdown formatting. You always end with a professional closing like "Best regards" or "Kind regards".`;
  
  const userPrompt = context ? `Previous context: ${context}\n\nCustomer message: ${customerMessage}` : `Customer message: ${customerMessage}`;
  
  const reply = await callOllama(userPrompt, systemPrompt);
  return reply ? stripMarkdown(reply) : 'Thank you for contacting us. We have received your message and will respond shortly. Best regards.';
}

async function fetchEmails() {
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  
  try {
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread',
      maxResults: 5
    });
    
    if (!response.data.messages) {
      return [];
    }
    
    const emails = [];
    
    for (const message of response.data.messages) {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: message.id,
        format: 'full'
      });
      
      const headers = msg.data.payload.headers;
      const from = headers.find(h => h.name === 'From')?.value || '';
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      
      let body = '';
      if (msg.data.payload.body.data) {
        body = Buffer.from(msg.data.payload.body.data, 'base64').toString('utf8');
      } else if (msg.data.payload.parts) {
        const textPart = msg.data.payload.parts.find(p => p.mimeType === 'text/plain');
        if (textPart && textPart.body.data) {
          body = Buffer.from(textPart.body.data, 'base64').toString('utf8');
        }
      }
      
      emails.push({
        id: message.id,
        from: from,
        subject: subject,
        body: body.substring(0, 2000)
      });
    }
    
    return emails;
  } catch (error) {
    return [];
  }
}

async function sendEmailReply(to, subject, body) {
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  
  const email = [
    `To: ${to}`,
    `Subject: Re: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body
  ].join('\n');
  
  const encodedEmail = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  
  try {
    await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedEmail
      }
    });
    return true;
  } catch (error) {
    return false;
  }
}

async function markAsRead(messageId) {
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  
  try {
    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: {
        removeLabelIds: ['UNREAD']
      }
    });
  } catch (error) {}
}

async function processEmails() {
  currentStatus = 'reading';
  
  const emails = await fetchEmails();
  
  for (const email of emails) {
    const existingEmail = emailMemory.find(e => e.id === email.id);
    if (existingEmail) continue;
    
    const telegramMessage = `NEW EMAIL\n\nFrom: ${email.from}\nSubject: ${email.subject}\n\n${email.body}`;
    
    try {
      await bot.sendMessage(CONFIG.telegram.chatId, telegramMessage);
    } catch (error) {}
    
    currentStatus = 'replying';
    
    const aiReply = await generateReply(email.body);
    
    const sent = await sendEmailReply(email.from, email.subject, aiReply);
    
    if (sent) {
      await markAsRead(email.id);
      
      const timestamp = new Date().toISOString();
      const replyMessage = `REPLY SENT\n\nTo: ${email.from}\nTime: ${timestamp}\n\n${aiReply}`;
      
      try {
        await bot.sendMessage(CONFIG.telegram.chatId, replyMessage);
      } catch (error) {}
      
      emailMemory.push({
        id: email.id,
        from: email.from,
        subject: email.subject,
        body: email.body.substring(0, 500),
        reply: aiReply,
        timestamp: timestamp
      });
      
      if (emailMemory.length > 100) {
        emailMemory = emailMemory.slice(-100);
      }
      
      await saveMemory();
    }
  }
  
  currentStatus = 'idle';
}

bot.on('message', async (msg) => {
  if (msg.chat.id.toString() !== CONFIG.telegram.chatId.toString()) {
    return;
  }
  
  if (!msg.text || msg.text.startsWith('/')) {
    return;
  }
  
  const customerFeedback = msg.text;
  const timestamp = new Date().toISOString();
  
  telegramMemory.push({
    id: msg.message_id,
    text: customerFeedback,
    timestamp: timestamp,
    reply: null
  });
  
  currentStatus = 'replying';
  
  const context = telegramMemory.slice(-3).map(m => m.text).join('\n');
  const aiReply = await generateReply(customerFeedback, context);
  
  try {
    await bot.sendMessage(CONFIG.telegram.chatId, aiReply);
    
    telegramMemory[telegramMemory.length - 1].reply = aiReply;
    
    if (telegramMemory.length > 100) {
      telegramMemory = telegramMemory.slice(-100);
    }
    
    await saveMemory();
  } catch (error) {}
  
  currentStatus = 'idle';
});

app.get('/status', (req, res) => {
  res.json({
    status: currentStatus,
    emailCount: emailMemory.length,
    telegramCount: telegramMemory.length
  });
});

app.get('/emails', (req, res) => {
  res.json(emailMemory.slice(-20).reverse());
});

app.get('/telegram', (req, res) => {
  res.json(telegramMemory.slice(-20).reverse());
});

app.get('/auth', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.send']
  });
  res.redirect(authUrl);
});

app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    await saveToken(tokens);
    res.send('Authentication successful. You can close this window.');
  } catch (error) {
    res.send('Authentication failed.');
  }
});

async function init() {
  await loadMemory();
  
  const hasToken = await loadToken();
  
  if (hasToken) {
    setInterval(processEmails, 120000);
    processEmails();
  }
  
  app.listen(CONFIG.port, () => {
    console.log(`Server running on http://localhost:${CONFIG.port}`);
    if (!hasToken) {
      console.log(`Visit http://localhost:${CONFIG.port}/auth to authenticate Gmail`);
    }
  });
}

init();