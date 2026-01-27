import json
import os
import re
import asyncio
import base64
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict

from aiohttp import web, ClientSession
import aiofiles
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from telegram import Bot, Update
from telegram.ext import Application, MessageHandler, filters, ContextTypes

CONFIG_FILE = './config.json'
MEMORY_FILE = './memory.json'
ASSISTANT_CORE_FILE = './assistant_core.txt'
TOKEN_FILE = './token.json'

config = {}
memory = {'emails': [], 'telegram': []}
assistant_core = ''
current_status = 'idle'
gmail_service = None
telegram_bot = None
telegram_app = None

async def load_config():
    global config
    async with aiofiles.open(CONFIG_FILE, 'r') as f:
        content = await f.read()
        config = json.loads(content)

async def load_assistant_core():
    global assistant_core
    try:
        async with aiofiles.open(ASSISTANT_CORE_FILE, 'r') as f:
            assistant_core = await f.read()
    except:
        assistant_core = ''

async def load_memory():
    global memory
    try:
        async with aiofiles.open(MEMORY_FILE, 'r') as f:
            content = await f.read()
            memory = json.loads(content)
    except:
        memory = {'emails': [], 'telegram': []}

async def save_memory():
    async with aiofiles.open(MEMORY_FILE, 'w') as f:
        await f.write(json.dumps(memory, indent=2))

def load_token():
    try:
        with open(TOKEN_FILE, 'r') as f:
            token_data = json.load(f)
            creds = Credentials.from_authorized_user_info(token_data)
            return creds
    except:
        return None

def save_token(creds):
    token_data = {
        'token': creds.token,
        'refresh_token': creds.refresh_token,
        'token_uri': creds.token_uri,
        'client_id': creds.client_id,
        'client_secret': creds.client_secret,
        'scopes': creds.scopes
    }
    with open(TOKEN_FILE, 'w') as f:
        json.dump(token_data, f)

def init_gmail_service():
    global gmail_service
    creds = load_token()
    if creds and creds.valid:
        gmail_service = build('gmail', 'v1', credentials=creds)
        return True
    elif creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            save_token(creds)
            gmail_service = build('gmail', 'v1', credentials=creds)
            return True
        except:
            return False
    return False

async def call_ollama(prompt: str, system_prompt: str) -> str:
    full_prompt = system_prompt + '\n\n' + prompt
    if assistant_core:
        full_prompt = assistant_core + '\n\n' + full_prompt
    
    payload = {
        'model': 'qwen:0.5b',
        'prompt': full_prompt,
        'stream': False,
        'options': {
            'temperature': 0.7,
            'num_predict': 300
        }
    }
    
    try:
        async with ClientSession() as session:
            async with session.post('http://127.0.0.1:11434/api/generate', json=payload) as resp:
                data = await resp.json()
                return data.get('response', '').strip()
    except:
        return ''

def strip_markdown(text: str) -> str:
    text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)
    text = re.sub(r'\*(.+?)\*', r'\1', text)
    text = re.sub(r'```[\s\S]*?```', '', text)
    text = re.sub(r'`(.+?)`', r'\1', text)
    text = re.sub(r'^#+\s+', '', text, flags=re.MULTILINE)
    text = re.sub(r'\[(.+?)\]\(.+?\)', r'\1', text)
    return text.strip()

async def generate_reply(customer_message: str, context: str = '') -> str:
    system_prompt = 'You are a professional customer support assistant for an e-commerce platform. You write polite, clear, and helpful replies to customers. You never mention that you are AI or automated. You never promise refunds or compensation without authorization. You never make up order details or tracking numbers. You escalate serious issues politely by saying the customer will be contacted by a specialist. You keep replies concise but warm. You never use markdown formatting. You always end with a professional closing like "Best regards" or "Kind regards".'
    
    if context:
        user_prompt = f'Previous context: {context}\n\nCustomer message: {customer_message}'
    else:
        user_prompt = f'Customer message: {customer_message}'
    
    reply = await call_ollama(user_prompt, system_prompt)
    if not reply:
        return 'Thank you for contacting us. We have received your message and will respond shortly. Best regards.'
    return strip_markdown(reply)

def fetch_emails():
    if not gmail_service:
        return []
    
    try:
        results = gmail_service.users().messages().list(userId='me', q='is:unread', maxResults=5).execute()
        messages = results.get('messages', [])
        
        if not messages:
            return []
        
        emails = []
        for message in messages:
            msg = gmail_service.users().messages().get(userId='me', id=message['id'], format='full').execute()
            
            headers = msg['payload']['headers']
            from_email = ''
            subject = ''
            
            for h in headers:
                if h['name'] == 'From':
                    from_email = h['value']
                if h['name'] == 'Subject':
                    subject = h['value']
            
            body = ''
            if 'data' in msg['payload']['body']:
                body = base64.urlsafe_b64decode(msg['payload']['body']['data']).decode('utf-8')
            elif 'parts' in msg['payload']:
                for part in msg['payload']['parts']:
                    if part['mimeType'] == 'text/plain' and 'data' in part['body']:
                        body = base64.urlsafe_b64decode(part['body']['data']).decode('utf-8')
                        break
            
            if len(body) > 2000:
                body = body[:2000]
            
            emails.append({
                'id': message['id'],
                'from': from_email,
                'subject': subject,
                'body': body
            })
        
        return emails
    except:
        return []

def send_email_reply(to: str, subject: str, body: str) -> bool:
    if not gmail_service:
        return False
    
    try:
        message = f"To: {to}\r\nSubject: Re: {subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}"
        encoded = base64.urlsafe_b64encode(message.encode('utf-8')).decode('utf-8')
        
        gmail_service.users().messages().send(
            userId='me',
            body={'raw': encoded}
        ).execute()
        return True
    except:
        return False

def mark_as_read(message_id: str):
    if not gmail_service:
        return
    
    try:
        gmail_service.users().messages().modify(
            userId='me',
            id=message_id,
            body={'removeLabelIds': ['UNREAD']}
        ).execute()
    except:
        pass

async def process_emails():
    global current_status
    current_status = 'reading'
    
    emails = fetch_emails()
    
    for email in emails:
        existing = next((e for e in memory['emails'] if e['id'] == email['id']), None)
        if existing:
            continue
        
        telegram_message = f"NEW EMAIL\n\nFrom: {email['from']}\nSubject: {email['subject']}\n\n{email['body']}"
        
        if telegram_bot:
            try:
                await telegram_bot.send_message(chat_id=config['telegram']['chatId'], text=telegram_message)
            except:
                pass
        
        current_status = 'replying'
        
        ai_reply = await generate_reply(email['body'])
        
        sent = send_email_reply(email['from'], email['subject'], ai_reply)
        
        if sent:
            mark_as_read(email['id'])
            
            timestamp = datetime.utcnow().isoformat() + 'Z'
            reply_message = f"REPLY SENT\n\nTo: {email['from']}\nTime: {timestamp}\n\n{ai_reply}"
            
            if telegram_bot:
                try:
                    await telegram_bot.send_message(chat_id=config['telegram']['chatId'], text=reply_message)
                except:
                    pass
            
            body_to_store = email['body'][:500] if len(email['body']) > 500 else email['body']
            
            memory['emails'].append({
                'id': email['id'],
                'from': email['from'],
                'subject': email['subject'],
                'body': body_to_store,
                'reply': ai_reply,
                'timestamp': timestamp
            })
            
            if len(memory['emails']) > 100:
                memory['emails'] = memory['emails'][-100:]
            
            await save_memory()
    
    current_status = 'idle'

async def email_processor():
    while True:
        await asyncio.sleep(120)
        await process_emails()

async def telegram_message_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    global current_status
    
    if str(update.message.chat_id) != config['telegram']['chatId']:
        return
    
    if not update.message.text or update.message.text.startswith('/'):
        return
    
    customer_feedback = update.message.text
    timestamp = datetime.utcnow().isoformat() + 'Z'
    
    memory['telegram'].append({
        'id': update.message.message_id,
        'text': customer_feedback,
        'timestamp': timestamp,
        'reply': None
    })
    
    current_status = 'replying'
    
    context_messages = [m['text'] for m in memory['telegram'][-3:]]
    context_str = '\n'.join(context_messages)
    
    ai_reply = await generate_reply(customer_feedback, context_str)
    
    try:
        await update.message.reply_text(ai_reply)
        
        memory['telegram'][-1]['reply'] = ai_reply
        
        if len(memory['telegram']) > 100:
            memory['telegram'] = memory['telegram'][-100:]
        
        await save_memory()
    except:
        pass
    
    current_status = 'idle'

async def status_handler(request):
    return web.json_response({
        'status': current_status,
        'emailCount': len(memory['emails']),
        'telegramCount': len(memory['telegram'])
    })

async def emails_handler(request):
    emails = memory['emails'][-20:]
    emails.reverse()
    return web.json_response(emails)

async def telegram_handler(request):
    telegram = memory['telegram'][-20:]
    telegram.reverse()
    return web.json_response(telegram)

async def auth_handler(request):
    flow = Flow.from_client_config(
        {
            'web': {
                'client_id': config['gmail']['clientId'],
                'client_secret': config['gmail']['clientSecret'],
                'redirect_uris': [config['gmail']['redirectUri']],
                'auth_uri': 'https://accounts.google.com/o/oauth2/auth',
                'token_uri': 'https://oauth2.googleapis.com/token'
            }
        },
        scopes=['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.send']
    )
    flow.redirect_uri = config['gmail']['redirectUri']
    
    auth_url, _ = flow.authorization_url(access_type='offline')
    return web.Response(status=302, headers={'Location': auth_url})

async def oauth2callback_handler(request):
    code = request.query.get('code')
    if not code:
        return web.Response(text='Authentication failed.')
    
    try:
        flow = Flow.from_client_config(
            {
                'web': {
                    'client_id': config['gmail']['clientId'],
                    'client_secret': config['gmail']['clientSecret'],
                    'redirect_uris': [config['gmail']['redirectUri']],
                    'auth_uri': 'https://accounts.google.com/o/oauth2/auth',
                    'token_uri': 'https://oauth2.googleapis.com/token'
                }
            },
            scopes=['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.send']
        )
        flow.redirect_uri = config['gmail']['redirectUri']
        
        flow.fetch_token(code=code)
        creds = flow.credentials
        save_token(creds)
        
        global gmail_service
        gmail_service = build('gmail', 'v1', credentials=creds)
        
        asyncio.create_task(email_processor())
        
        return web.Response(text='Authentication successful. You can close this window.')
    except:
        return web.Response(text='Authentication failed.')

async def init_app():
    global telegram_bot, telegram_app
    
    await load_config()
    await load_assistant_core()
    await load_memory()
    
    has_token = init_gmail_service()
    
    try:
        telegram_app = Application.builder().token(config['telegram']['botToken']).build()
        telegram_bot = telegram_app.bot
        
        telegram_app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, telegram_message_handler))
        
        await telegram_app.initialize()
        await telegram_app.start()
        asyncio.create_task(telegram_app.updater.start_polling())
    except:
        pass
    
    app = web.Application()
    app.router.add_get('/status', status_handler)
    app.router.add_get('/emails', emails_handler)
    app.router.add_get('/telegram', telegram_handler)
    app.router.add_get('/auth', auth_handler)
    app.router.add_get('/oauth2callback', oauth2callback_handler)
    app.router.add_static('/', '.', show_index=True)
    
    if has_token:
        asyncio.create_task(email_processor())
    
    return app

if __name__ == '__main__':
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    app = loop.run_until_complete(init_app())
    port = config.get('port', 3000)
    print(f'Server running on http://localhost:{port}')
    if not init_gmail_service():
        print(f'Visit http://localhost:{port}/auth to authenticate Gmail')
    web.run_app(app, port=port)