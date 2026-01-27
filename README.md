# AI-Powered Customer Support System

A self-hosted, local-first AI automation system for handling customer support through email and Telegram. This system uses local LLMs (via Ollama) to generate intelligent responses without sending data to third-party cloud services.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Repository Structure](#repository-structure)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Gmail API Setup](#gmail-api-setup)
- [Telegram Bot Setup](#telegram-bot-setup)
- [Usage](#usage)
- [Customization](#customization)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [License](#license)
- [Author](#author)

## Overview

This project provides a fully self-hosted customer support automation system that:

- Monitors Gmail inbox for incoming customer emails
- Forwards new emails to a private Telegram bot for monitoring
- Uses a local Ollama LLM to generate contextual replies
- Automatically sends AI-generated responses via email
- Handles Telegram-based customer feedback and inquiries
- Maintains conversation memory locally using JSON storage
- Operates entirely offline except for Gmail and Telegram API calls

No data is sent to third-party LLM providers. All AI processing happens locally on your machine.

## Features

- **Local AI Processing**: Uses Ollama for LLM inference without cloud dependencies
- **Gmail Integration**: Automatic email reading and reply generation
- **Telegram Bot**: Private monitoring channel and customer feedback handling
- **Persistent Memory**: Maintains conversation context per customer using local JSON storage
- **Telegram-Safe Formatting**: Automatically formats responses for Telegram compatibility
- **Custom System Prompts**: Configure AI behavior via `assistant_core.txt`
- **Cross-Platform**: Works on Windows, Linux, macOS, and Android (via Termux)
- **Web Dashboard**: Simple HTML interface for monitoring and management

## Tech Stack

- **Runtime**: Node.js
- **Web Framework**: Express
- **AI Model**: Ollama (local LLM)
- **Email**: Gmail API
- **Messaging**: Telegram Bot API
- **Frontend**: Vanilla HTML, CSS, JavaScript
- **Storage**: JSON-based local storage

## Repository Structure
```
.
├── server.js              # Main application server
├── index.html             # Web dashboard interface
├── config.json            # Configuration file (API keys, settings)
├── memory.json            # Persistent conversation memory
├── assistant_core.txt     # System prompt for AI assistant
├── token.json             # Gmail OAuth tokens (auto-generated)
├── package.json           # Node.js dependencies
└── README.md              # This file
```

## Prerequisites

Before installation, ensure you have:

- Node.js (version 14 or higher)
- Ollama installed and running
- A Gmail account with API access enabled
- A Telegram bot token and chat ID
- Administrator access (for Windows) or root access (for Termux)

## Installation

### Step 1: Install Node.js

#### On Windows:

1. Download Node.js from [https://nodejs.org](https://nodejs.org)
2. Run the installer and follow the prompts
3. Verify installation:
```bash
   node --version
   npm --version
```

#### On Termux (Android):

1. Update packages:
```bash
   pkg update && pkg upgrade
```

2. Install Node.js:
```bash
   pkg install nodejs
```

3. Verify installation:
```bash
   node --version
   npm --version
```

### Step 2: Install Ollama

#### On Windows:

1. Download Ollama from [https://ollama.ai](https://ollama.ai)
2. Run the installer
3. Verify installation by opening Command Prompt:
```bash
   ollama --version
```

#### On Termux:

1. Install dependencies:
```bash
   pkg install proot-distro
   proot-distro install ubuntu
```

2. Start Ubuntu environment:
```bash
   proot-distro login ubuntu
```

3. Install Ollama inside Ubuntu:
```bash
   curl -fsSL https://ollama.com/install.sh | sh
```

4. Start Ollama server:
```bash
   ollama serve &
```

### Step 3: Pull AI Model

1. Pull the recommended model (lightweight and fast):
```bash
   ollama pull qwen2.5:0.5b
```

2. Verify the model is available:
```bash
   ollama list
```

3. Test the model:
```bash
   ollama run qwen2.5:0.5b
```
   Type a message and press Enter. Type `/bye` to exit.

### Step 4: Clone and Install Project

1. Clone this repository:
```bash
   git clone https://github.com/tukuexe/ai-customer-support
   cd ai-customer-support
```

2. Install Node.js dependencies:
```bash
   npm install
```

## Configuration

### Step 1: Create Telegram Bot

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` command
3. Follow the prompts to name your bot
4. Copy the bot token provided (format: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)
5. Save this token for later

### Step 2: Get Telegram Chat ID

1. Send a message to your new bot in Telegram
2. Open this URL in your browser (replace `YOUR_BOT_TOKEN`):
```
   https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates
```

3. Look for the `"chat":{"id":` field in the response
4. Copy the numeric chat ID (example: `123456789`)

### Step 3: Create config.json

Create a `config.json` file in the project root:
```json
{
  "telegram": {
    "botToken": "YOUR_TELEGRAM_BOT_TOKEN",
    "chatId": "YOUR_TELEGRAM_CHAT_ID"
  },
  "gmail": {
    "clientId": "YOUR_GMAIL_CLIENT_ID",
    "clientSecret": "YOUR_GMAIL_CLIENT_SECRET",
    "redirectUri": "http://localhost:3000/oauth2callback"
  },
  "ollama": {
    "model": "qwen2.5:0.5b",
    "apiUrl": "http://localhost:11434"
  },
  "port": 3000
}
```

### Step 4: Create assistant_core.txt

Create an `assistant_core.txt` file with your AI assistant's system prompt:
```
You are a helpful customer support assistant. Your role is to:

1. Understand customer inquiries and provide clear, helpful responses
2. Maintain a professional yet friendly tone
3. Ask clarifying questions when needed
4. Provide accurate information based on available context
5. Keep responses concise but complete

Always be polite, patient, and solution-oriented.
```

### Step 5: Create memory.json

Create an empty `memory.json` file:
```json
{}
```

## Gmail API Setup

### Step 1: Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Click "Select a project" then "New Project"
3. Enter a project name (e.g., "AI Customer Support")
4. Click "Create"

### Step 2: Enable Gmail API

1. In the Google Cloud Console, navigate to "APIs & Services" > "Library"
2. Search for "Gmail API"
3. Click on "Gmail API" and click "Enable"

### Step 3: Create OAuth Credentials

1. Navigate to "APIs & Services" > "Credentials"
2. Click "Create Credentials" > "OAuth client ID"
3. If prompted, configure the OAuth consent screen:
   - User Type: External
   - App name: Your app name
   - User support email: Your email
   - Developer contact: Your email
   - Click "Save and Continue" through all steps
4. Return to "Credentials" and click "Create Credentials" > "OAuth client ID"
5. Application type: "Web application"
6. Name: "AI Customer Support Client"
7. Authorized redirect URIs: Add `http://localhost:3000/oauth2callback`
8. Click "Create"
9. Copy the "Client ID" and "Client Secret"

### Step 4: Update config.json

Add the Gmail credentials to your `config.json`:
```json
{
  "gmail": {
    "clientId": "your-client-id.apps.googleusercontent.com",
    "clientSecret": "your-client-secret",
    "redirectUri": "http://localhost:3000/oauth2callback"
  }
}
```

### Step 5: Authenticate Gmail

1. Start the server:
```bash
   node server.js
```

2. Open your browser and navigate to:
```
   http://localhost:3000/auth
```

3. Click the authentication link
4. Sign in with your Gmail account
5. Grant the requested permissions
6. You will be redirected back to the application
7. A `token.json` file will be created automatically

## Telegram Bot Setup

Your Telegram bot is now configured and will:

- Receive notifications when new emails arrive
- Forward customer emails for your review
- Accept commands and customer feedback
- Send AI-generated responses for your approval

To test your bot:

1. Open Telegram and find your bot
2. Send a message like "Hello"
3. The bot should respond (once the server is running)

## Usage

### Starting the Server
```bash
node server.js
```

You should see:
```
Server running on http://localhost:3000
Ollama connected successfully
Telegram bot started
Gmail monitoring active
```

### Accessing the Dashboard

Open your browser and navigate to:
```
http://localhost:3000
```

The dashboard provides:
- System status monitoring
- Recent email activity
- Telegram message log
- Configuration overview

### Email Processing Flow

1. Customer sends email to your Gmail account
2. System detects new email within polling interval (default: 60 seconds)
3. Email is forwarded to your Telegram bot for visibility
4. Local Ollama LLM generates a contextual reply
5. AI-generated reply is sent back to customer via Gmail
6. Conversation context is saved to `memory.json`

### Telegram Message Handling

1. Customer sends message to Telegram bot
2. Message is processed by local LLM
3. AI generates response based on conversation history
4. Response is sent back to customer
5. Conversation is stored in memory

### Memory System

The system maintains conversation context in `memory.json`:
```json
{
  "customer@example.com": {
    "messages": [
      {
        "role": "user",
        "content": "I need help with my order",
        "timestamp": "2026-01-27T10:30:00Z"
      },
      {
        "role": "assistant",
        "content": "I'd be happy to help with your order...",
        "timestamp": "2026-01-27T10:30:15Z"
      }
    ],
    "lastContact": "2026-01-27T10:30:15Z"
  }
}
```

This allows the AI to maintain context across multiple interactions.

## Customization

### Changing AI Behavior

Edit `assistant_core.txt` to modify how the AI responds:
```
You are a technical support specialist for a software company.

Guidelines:
- Provide step-by-step troubleshooting instructions
- Ask about system specifications when relevant
- Reference documentation links when appropriate
- Escalate to human support for account or billing issues

Be precise, technical, and solution-focused.
```

Restart the server after making changes.

### Changing AI Model

To use a different Ollama model:

1. Pull the new model:
```bash
   ollama pull llama2
```

2. Update `config.json`:
```json
   {
     "ollama": {
       "model": "llama2"
     }
   }
```

3. Restart the server

### Adjusting Email Polling Interval

The default polling interval is 60 seconds. To change this, modify `server.js`:
```javascript
// Look for this line and adjust the milliseconds
setInterval(checkEmails, 60000); // Change 60000 to desired interval
```

## Troubleshooting

### Ollama Connection Failed

**Error**: "Cannot connect to Ollama"

**Solutions**:
- Verify Ollama is running: `ollama list`
- Check Ollama is on correct port: `http://localhost:11434`
- On Termux, ensure Ollama server is running in background
- Restart Ollama service

### Gmail Authentication Failed

**Error**: "Invalid credentials" or "Redirect URI mismatch"

**Solutions**:
- Verify `clientId` and `clientSecret` in `config.json`
- Check redirect URI in Google Cloud Console matches `config.json`
- Delete `token.json` and re-authenticate via `/auth`
- Ensure Gmail API is enabled in Google Cloud Console

### Telegram Bot Not Responding

**Error**: Bot does not reply to messages

**Solutions**:
- Verify bot token is correct in `config.json`
- Check chat ID is correct (must be numeric)
- Ensure server is running: `node server.js`
- Check server logs for error messages
- Test bot token using Telegram API tester

### Port Already in Use

**Error**: "Port 3000 is already in use"

**Solutions**:
- Change port in `config.json`:
```json
  {
    "port": 8080
  }
```
- Or kill the process using port 3000:
  - Windows: `netstat -ano | findstr :3000` then `taskkill /PID <PID> /F`
  - Linux/Mac: `lsof -ti:3000 | xargs kill`

### Memory File Corruption

**Error**: "Cannot parse memory.json"

**Solutions**:
- Backup current `memory.json`
- Replace with empty object: `{}`
- Restart server
- Previous conversations will be lost but system will function

### Model Not Found

**Error**: "Model qwen2.5:0.5b not found"

**Solutions**:
- Pull the model: `ollama pull qwen2.5:0.5b`
- Verify model name: `ollama list`
- Update `config.json` with correct model name

## Security

### Important Security Notes

- **Token Storage**: Gmail OAuth tokens are stored in `token.json`. Keep this file secure and never commit it to public repositories.
- **Private Repository**: It is strongly recommended to keep this repository private if using real Gmail accounts and Telegram bots.
- **Local Processing**: All AI processing happens locally. No conversation data is sent to third-party LLM APIs.
- **API Keys**: Never share your `config.json` file as it contains sensitive API credentials.
- **Access Control**: The web dashboard has no authentication. Only run on trusted networks or add authentication layer.

### Best Practices

1. Add sensitive files to `.gitignore`:
```
   config.json
   token.json
   memory.json
```

2. Use environment variables for production:
```javascript
   const config = {
     telegram: {
       botToken: process.env.TELEGRAM_BOT_TOKEN,
       chatId: process.env.TELEGRAM_CHAT_ID
     }
   };
```

3. Regularly backup `memory.json` to prevent data loss

4. Monitor server logs for unusual activity

5. Keep Node.js and dependencies updated:
```bash
   npm update
```

## License

This project is intended for personal and educational use. Feel free to modify and adapt it for your own needs.

**Disclaimer**: This software is provided as-is without warranties. The author is not responsible for any issues arising from its use.

## Author

**Ximanta**

- GitHub: [<img src="https://github.githubassets.com/favicons/favicon.svg" width="16" height="16" style="vertical-align: middle;">](https://github.com/tukuexe) [@tukuexe](https://github.com/tukuexe)
- Instagram: [<img src="https://static.cdninstagram.com/rsrc.php/v3/yR/r/lam-fZmwmvn.png" width="16" height="16" style="vertical-align: middle;">](https://instagram.com/ximanta.xyz) [@ximanta.xyz](https://instagram.com/ximanta.xyz)
- Telegram: [<img src="https://telegram.org/favicon.ico" width="16" height="16" style="vertical-align: middle;">](https://t.me/tukuexe) [@tukuexe](https://t.me/tukuexe)
- Website: [<img src="https://about.ximanta.space/favicon.ico" width="16" height="16" style="vertical-align: middle;">](https://about.ximanta.space) [about.ximanta.space](https://about.ximanta.space)

---

**Contributing**: Issues and pull requests are welcome. For major changes, please open an issue first to discuss proposed modifications.

**Support**: If you encounter problems not covered in the troubleshooting section, please open an issue on GitHub with detailed logs and system information.