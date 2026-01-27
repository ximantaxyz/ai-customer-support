interface Config {
  port: number;
  gmail: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
  telegram: {
    botToken: string;
    chatId: string;
  };
}

interface EmailRecord {
  id: string;
  from: string;
  subject: string;
  body: string;
  reply: string;
  timestamp: string;
}

interface TelegramRecord {
  id: number;
  text: string;
  timestamp: string;
  reply?: string;
}

interface Memory {
  emails: EmailRecord[];
  telegram: TelegramRecord[];
}

interface OllamaRequest {
  model: string;
  prompt: string;
  stream: boolean;
  options: {
    temperature: number;
    num_predict: number;
  };
}

interface OllamaResponse {
  response: string;
}

interface TokenData {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expiry_date: number;
}

const CONFIG_FILE = "./config.json";
const MEMORY_FILE = "./memory.json";
const TOKEN_FILE = "./token.json";
const ASSISTANT_CORE_FILE = "./assistant_core.txt";

let config: Config;
let memory: Memory = { emails: [], telegram: [] };
let assistantCore = "";
let currentStatus = "idle";
let telegramBot: any;

async function loadConfig(): Promise<void> {
  const text = await Deno.readTextFile(CONFIG_FILE);
  config = JSON.parse(text);
}

async function loadAssistantCore(): Promise<void> {
  try {
    assistantCore = await Deno.readTextFile(ASSISTANT_CORE_FILE);
  } catch {
    assistantCore = "";
  }
}

async function loadMemory(): Promise<void> {
  try {
    const text = await Deno.readTextFile(MEMORY_FILE);
    memory = JSON.parse(text);
  } catch {
    memory = { emails: [], telegram: [] };
  }
}

async function saveMemory(): Promise<void> {
  await Deno.writeTextFile(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

async function loadToken(): Promise<boolean> {
  try {
    const tokenText = await Deno.readTextFile(TOKEN_FILE);
    const tokenData: TokenData = JSON.parse(tokenText);
    return true;
  } catch {
    return false;
  }
}

async function saveToken(tokens: TokenData): Promise<void> {
  await Deno.writeTextFile(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

async function callOllama(prompt: string, systemPrompt: string): Promise<string> {
  const fullPrompt = assistantCore
    ? `${assistantCore}\n\n${systemPrompt}\n\n${prompt}`
    : `${systemPrompt}\n\n${prompt}`;

  const payload: OllamaRequest = {
    model: "qwen:0.5b",
    prompt: fullPrompt,
    stream: false,
    options: {
      temperature: 0.7,
      num_predict: 300,
    },
  };

  try {
    const response = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data: OllamaResponse = await response.json();
    return data.response.trim();
  } catch {
    return "";
  }
}

function stripMarkdown(text: string): string {
  let result = text;
  result = result.replace(/\*\*(.+?)\*\*/g, "$1");
  result = result.replace(/\*(.+?)\*/g, "$1");
  result = result.replace(/```[\s\S]*?```/g, "");
  result = result.replace(/`(.+?)`/g, "$1");
  result = result.replace(/^#+\s+/gm, "");
  result = result.replace(/\[(.+?)\]\(.+?\)/g, "$1");
  return result.trim();
}

async function generateReply(customerMessage: string, context = ""): Promise<string> {
  const systemPrompt =
    'You are a professional customer support assistant for an e-commerce platform. You write polite, clear, and helpful replies to customers. You never mention that you are AI or automated. You never promise refunds or compensation without authorization. You never make up order details or tracking numbers. You escalate serious issues politely by saying the customer will be contacted by a specialist. You keep replies concise but warm. You never use markdown formatting. You always end with a professional closing like "Best regards" or "Kind regards".';

  const userPrompt = context
    ? `Previous context: ${context}\n\nCustomer message: ${customerMessage}`
    : `Customer message: ${customerMessage}`;

  const reply = await callOllama(userPrompt, systemPrompt);
  if (!reply) {
    return "Thank you for contacting us. We have received your message and will respond shortly. Best regards.";
  }
  return stripMarkdown(reply);
}

async function getGmailAuthUrl(): Promise<string> {
  const params = new URLSearchParams({
    client_id: config.gmail.clientId,
    redirect_uri: config.gmail.redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send",
    access_type: "offline",
  });
  return `https://accounts.google.com/o/oauth2/auth?${params.toString()}`;
}

async function exchangeCodeForToken(code: string): Promise<TokenData | null> {
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.gmail.clientId,
        client_secret: config.gmail.clientSecret,
        redirect_uri: config.gmail.redirectUri,
        grant_type: "authorization_code",
      }),
    });
    return await response.json();
  } catch {
    return null;
  }
}

async function fetchEmails(): Promise<Array<{id: string, from: string, subject: string, body: string}>> {
  try {
    const tokenText = await Deno.readTextFile(TOKEN_FILE);
    const tokenData: TokenData = JSON.parse(tokenText);
    
    const listResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=5", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const listData = await listResponse.json();
    
    if (!listData.messages) return [];
    
    const emails = [];
    for (const message of listData.messages) {
      const msgResponse = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=full`, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const msgData = await msgResponse.json();
      
      const headers = msgData.payload.headers;
      const from = headers.find((h: any) => h.name === "From")?.value || "";
      const subject = headers.find((h: any) => h.name === "Subject")?.value || "";
      
      let body = "";
      if (msgData.payload.body.data) {
        body = atob(msgData.payload.body.data.replace(/-/g, '+').replace(/_/g, '/'));
      } else if (msgData.payload.parts) {
        const textPart = msgData.payload.parts.find((p: any) => p.mimeType === "text/plain");
        if (textPart && textPart.body.data) {
          body = atob(textPart.body.data.replace(/-/g, '+').replace(/_/g, '/'));
        }
      }
      
      emails.push({
        id: message.id,
        from,
        subject,
        body: body.substring(0, 2000)
      });
    }
    return emails;
  } catch {
    return [];
  }
}

async function sendEmailReply(to: string, subject: string, body: string): Promise<boolean> {
  try {
    const tokenText = await Deno.readTextFile(TOKEN_FILE);
    const tokenData: TokenData = JSON.parse(tokenText);
    
    const email = [
      `To: ${to}`,
      `Subject: Re: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body
    ].join('\n');
    
    const encodedEmail = btoa(email).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ raw: encodedEmail })
    });
    
    return response.ok;
  } catch {
    return false;
  }
}

async function markAsRead(messageId: string): Promise<void> {
  try {
    const tokenText = await Deno.readTextFile(TOKEN_FILE);
    const tokenData: TokenData = JSON.parse(tokenText);
    
    await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ removeLabelIds: ["UNREAD"] })
    });
  } catch {}
}

async function sendTelegramMessage(text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegram.chatId,
        text: text
      })
    });
  } catch {}
}

async function processEmails(): Promise<void> {
  currentStatus = "reading";
  const emails = await fetchEmails();
  
  for (const email of emails) {
    const existingEmail = memory.emails.find(e => e.id === email.id);
    if (existingEmail) continue;
    
    const telegramMessage = `NEW EMAIL\n\nFrom: ${email.from}\nSubject: ${email.subject}\n\n${email.body}`;
    await sendTelegramMessage(telegramMessage);
    
    currentStatus = "replying";
    const aiReply = await generateReply(email.body);
    
    const sent = await sendEmailReply(email.from, email.subject, aiReply);
    
    if (sent) {
      await markAsRead(email.id);
      
      const timestamp = new Date().toISOString();
      const replyMessage = `REPLY SENT\n\nTo: ${email.from}\nTime: ${timestamp}\n\n${aiReply}`;
      await sendTelegramMessage(replyMessage);
      
      memory.emails.push({
        id: email.id,
        from: email.from,
        subject: email.subject,
        body: email.body.substring(0, 500),
        reply: aiReply,
        timestamp: timestamp
      });
      
      if (memory.emails.length > 100) {
        memory.emails = memory.emails.slice(-100);
      }
      
      await saveMemory();
    }
  }
  
  currentStatus = "idle";
}

function startTelegramBot(): void {
  const webhookUrl = `http://localhost:${config.port}/telegram-webhook`;
  
  fetch(`https://api.telegram.org/bot${config.telegram.botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhookUrl })
  }).catch(() => {});
}

async function emailProcessor(): Promise<void> {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 120000));
    await processEmails();
  }
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (pathname === "/status") {
    return new Response(
      JSON.stringify({
        status: currentStatus,
        emailCount: memory.emails.length,
        telegramCount: memory.telegram.length,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  if (pathname === "/emails") {
    const emails = memory.emails.slice(-20).reverse();
    return new Response(JSON.stringify(emails), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (pathname === "/telegram") {
    const telegram = memory.telegram.slice(-20).reverse();
    return new Response(JSON.stringify(telegram), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (pathname === "/auth") {
    const authUrl = await getGmailAuthUrl();
    return Response.redirect(authUrl);
  }

  if (pathname === "/oauth2callback") {
    const code = url.searchParams.get("code");
    if (code) {
      const tokens = await exchangeCodeForToken(code);
      if (tokens) {
        await saveToken(tokens);
        return new Response("Authentication successful. You can close this window.", {
          headers: { "Content-Type": "text/html" }
        });
      }
    }
    return new Response("Authentication failed.", { status: 400 });
  }

  if (pathname === "/telegram-webhook" && request.method === "POST") {
    try {
      const update = await request.json();
      if (update.message && update.message.chat.id.toString() === config.telegram.chatId) {
        const msg = update.message;
        
        if (msg.text && !msg.text.startsWith('/')) {
          const timestamp = new Date().toISOString();
          memory.telegram.push({
            id: msg.message_id,
            text: msg.text,
            timestamp: timestamp,
            reply: null
          });
          
          currentStatus = "replying";
          const context = memory.telegram.slice(-3).map(m => m.text).join('\n');
          const aiReply = await generateReply(msg.text, context);
          
          await sendTelegramMessage(aiReply);
          
          memory.telegram[memory.telegram.length - 1].reply = aiReply;
          
          if (memory.telegram.length > 100) {
            memory.telegram = memory.telegram.slice(-100);
          }
          
          await saveMemory();
          currentStatus = "idle";
        }
      }
    } catch {}
    return new Response("OK");
  }

  try {
    const filePath = pathname === "/" ? "./index.html" : `.${pathname}`;
    const file = await Deno.readFile(filePath);
    const contentType = filePath.endsWith(".html")
      ? "text/html"
      : filePath.endsWith(".js")
      ? "application/javascript"
      : filePath.endsWith(".css")
      ? "text/css"
      : "application/octet-stream";
    return new Response(file, {
      headers: { "Content-Type": contentType },
    });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

async function main(): Promise<void> {
  await loadConfig();
  await loadAssistantCore();
  await loadMemory();
  
  const hasToken = await loadToken();
  
  if (hasToken) {
    emailProcessor();
    startTelegramBot();
    processEmails();
  }
  
  const port = config.port || 3000;
  console.log(`Server running on http://localhost:${port}`);
  
  if (!hasToken) {
    console.log(`Visit http://localhost:${port}/auth to authenticate Gmail`);
  }
  
  Deno.serve({ port }, handleRequest);
}

main();
[file content end]