use serde::{Deserialize, Serialize};
use std::fs;
use std::sync::{Arc, Mutex};
use tokio::time::{interval, Duration};
use base64::{Engine as _, engine::general_purpose};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Config {
    port: u16,
    gmail: Gmail,
    telegram: Telegram,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Gmail {
    #[serde(rename = "clientId")]
    client_id: String,
    #[serde(rename = "clientSecret")]
    client_secret: String,
    #[serde(rename = "redirectUri")]
    redirect_uri: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Telegram {
    #[serde(rename = "botToken")]
    bot_token: String,
    #[serde(rename = "chatId")]
    chat_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Memory {
    emails: Vec<EmailRecord>,
    telegram: Vec<TelegramRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EmailRecord {
    id: String,
    from: String,
    subject: String,
    body: String,
    reply: String,
    timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TelegramRecord {
    id: i64,
    text: String,
    timestamp: String,
    reply: Option<String>,
}

#[derive(Debug, Serialize)]
struct OllamaRequest {
    model: String,
    prompt: String,
    stream: bool,
    options: OllamaOptions,
}

#[derive(Debug, Serialize)]
struct OllamaOptions {
    temperature: f32,
    num_predict: i32,
}

#[derive(Debug, Deserialize)]
struct OllamaResponse {
    response: String,
}

#[derive(Debug, Serialize)]
struct StatusResponse {
    status: String,
    #[serde(rename = "emailCount")]
    email_count: usize,
    #[serde(rename = "telegramCount")]
    telegram_count: usize,
}

#[derive(Debug, Deserialize)]
struct TokenData {
    access_token: String,
    refresh_token: Option<String>,
    token_type: String,
    expires_in: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct GmailMessage {
    id: String,
}

#[derive(Debug, Deserialize)]
struct GmailMessageList {
    messages: Option<Vec<GmailMessage>>,
}

#[derive(Debug, Deserialize)]
struct GmailMessageFull {
    id: String,
    payload: GmailPayload,
}

#[derive(Debug, Deserialize)]
struct GmailPayload {
    headers: Vec<GmailHeader>,
    body: GmailBody,
    parts: Option<Vec<GmailPart>>,
}

#[derive(Debug, Deserialize)]
struct GmailHeader {
    name: String,
    value: String,
}

#[derive(Debug, Deserialize)]
struct GmailBody {
    data: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GmailPart {
    #[serde(rename = "mimeType")]
    mime_type: String,
    body: GmailBody,
}

struct AppState {
    memory: Arc<Mutex<Memory>>,
    config: Config,
    assistant_core: String,
    current_status: Arc<Mutex<String>>,
    token: Arc<Mutex<Option<String>>>,
}

#[tokio::main]
async fn main() {
    let config = load_config();
    let assistant_core = load_assistant_core();
    let memory = Arc::new(Mutex::new(load_memory()));
    let current_status = Arc::new(Mutex::new(String::from("idle")));
    let token = Arc::new(Mutex::new(load_token()));

    let state = Arc::new(AppState {
        memory: memory.clone(),
        config: config.clone(),
        assistant_core,
        current_status: current_status.clone(),
        token: token.clone(),
    });

    let has_token = state.token.lock().unwrap().is_some();

    let state_clone = state.clone();
    if has_token {
        tokio::spawn(async move {
            process_emails(state_clone.clone()).await;
            let mut ticker = interval(Duration::from_secs(120));
            loop {
                ticker.tick().await;
                process_emails(state_clone.clone()).await;
            }
        });
    }

    let state_clone = state.clone();
    tokio::spawn(async move {
        telegram_listener(state_clone).await;
    });

    let app = axum::Router::new()
        .route("/status", axum::routing::get(status_handler))
        .route("/emails", axum::routing::get(emails_handler))
        .route("/telegram", axum::routing::get(telegram_handler))
        .route("/auth", axum::routing::get(auth_handler))
        .route("/oauth2callback", axum::routing::get(oauth2callback_handler))
        .fallback_service(tower_http::services::ServeDir::new("."))
        .with_state(state);

    let addr = format!("0.0.0.0:{}", config.port);
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    println!("Server running on http://localhost:{}", config.port);
    if !has_token {
        println!("Visit http://localhost:{}/auth to authenticate Gmail", config.port);
    }
    axum::serve(listener, app).await.unwrap();
}

fn load_config() -> Config {
    let data = fs::read_to_string("./config.json").expect("Failed to read config.json");
    serde_json::from_str(&data).expect("Failed to parse config.json")
}

fn load_assistant_core() -> String {
    fs::read_to_string("./assistant_core.txt").unwrap_or_default()
}

fn load_memory() -> Memory {
    let data = fs::read_to_string("./memory.json").unwrap_or_else(|_| {
        String::from(r#"{"emails":[],"telegram":[]}"#)
    });
    serde_json::from_str(&data).unwrap_or(Memory {
        emails: Vec::new(),
        telegram: Vec::new(),
    })
}

fn save_memory(memory: &Memory) {
    let data = serde_json::to_string_pretty(memory).unwrap();
    let _ = fs::write("./memory.json", data);
}

fn load_token() -> Option<String> {
    fs::read_to_string("./token.json").ok()
}

fn save_token(token_json: &str) {
    let _ = fs::write("./token.json", token_json);
}

async fn call_ollama(prompt: &str, system_prompt: &str, assistant_core: &str) -> String {
    let full_prompt = if !assistant_core.is_empty() {
        format!("{}\n\n{}\n\n{}", assistant_core, system_prompt, prompt)
    } else {
        format!("{}\n\n{}", system_prompt, prompt)
    };

    let request = OllamaRequest {
        model: String::from("qwen:0.5b"),
        prompt: full_prompt,
        stream: false,
        options: OllamaOptions {
            temperature: 0.7,
            num_predict: 300,
        },
    };

    let client = reqwest::Client::new();
    let response = client
        .post("http://127.0.0.1:11434/api/generate")
        .json(&request)
        .send()
        .await;

    if let Ok(resp) = response {
        if let Ok(ollama_resp) = resp.json::<OllamaResponse>().await {
            return ollama_resp.response.trim().to_string();
        }
    }

    String::new()
}

fn strip_markdown(text: &str) -> String {
    let text = regex::Regex::new(r"\*\*(.+?)\*\*")
        .unwrap()
        .replace_all(text, "$1");
    let text = regex::Regex::new(r"\*(.+?)\*")
        .unwrap()
        .replace_all(&text, "$1");
    let text = regex::Regex::new(r"```[\s\S]*?```")
        .unwrap()
        .replace_all(&text, "");
    let text = regex::Regex::new(r"`(.+?)`")
        .unwrap()
        .replace_all(&text, "$1");
    let text = regex::Regex::new(r"(?m)^#+\s+")
        .unwrap()
        .replace_all(&text, "");
    let text = regex::Regex::new(r"\[(.+?)\]\(.+?\)")
        .unwrap()
        .replace_all(&text, "$1");
    text.trim().to_string()
}

async fn generate_reply(customer_message: &str, context: &str, assistant_core: &str) -> String {
    let system_prompt = "You are a professional customer support assistant for an e-commerce platform. You write polite, clear, and helpful replies to customers. You never mention that you are AI or automated. You never promise refunds or compensation without authorization. You never make up order details or tracking numbers. You escalate serious issues politely by saying the customer will be contacted by a specialist. You keep replies concise but warm. You never use markdown formatting. You always end with a professional closing like \"Best regards\" or \"Kind regards\".";

    let user_prompt = if !context.is_empty() {
        format!("Previous context: {}\n\nCustomer message: {}", context, customer_message)
    } else {
        format!("Customer message: {}", customer_message)
    };

    let reply = call_ollama(&user_prompt, system_prompt, assistant_core).await;
    if reply.is_empty() {
        String::from("Thank you for contacting us. We have received your message and will respond shortly. Best regards.")
    } else {
        strip_markdown(&reply)
    }
}

async fn fetch_emails(token: &str) -> Vec<(String, String, String, String)> {
    let client = reqwest::Client::new();
    
    let list_resp = client
        .get("https://gmail.googleapis.com/gmail/v1/users/me/messages")
        .bearer_auth(token)
        .query(&[("q", "is:unread"), ("maxResults", "5")])
        .send()
        .await;

    if let Ok(resp) = list_resp {
        if let Ok(list) = resp.json::<GmailMessageList>().await {
            if let Some(messages) = list.messages {
                let mut emails = Vec::new();
                
                for msg in messages {
                    let msg_resp = client
                        .get(&format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{}", msg.id))
                        .bearer_auth(token)
                        .query(&[("format", "full")])
                        .send()
                        .await;

                    if let Ok(resp) = msg_resp {
                        if let Ok(full_msg) = resp.json::<GmailMessageFull>().await {
                            let mut from = String::new();
                            let mut subject = String::new();
                            
                            for header in &full_msg.payload.headers {
                                if header.name == "From" {
                                    from = header.value.clone();
                                }
                                if header.name == "Subject" {
                                    subject = header.value.clone();
                                }
                            }

                            let mut body = String::new();
                            if let Some(data) = &full_msg.payload.body.data {
                                if let Ok(decoded) = general_purpose::URL_SAFE.decode(data) {
                                    body = String::from_utf8_lossy(&decoded).to_string();
                                }
                            } else if let Some(parts) = &full_msg.payload.parts {
                                for part in parts {
                                    if part.mime_type == "text/plain" {
                                        if let Some(data) = &part.body.data {
                                            if let Ok(decoded) = general_purpose::URL_SAFE.decode(data) {
                                                body = String::from_utf8_lossy(&decoded).to_string();
                                                break;
                                            }
                                        }
                                    }
                                }
                            }

                            if body.len() > 2000 {
                                body = body[..2000].to_string();
                            }

                            emails.push((full_msg.id, from, subject, body));
                        }
                    }
                }
                
                return emails;
            }
        }
    }

    Vec::new()
}

async fn send_email_reply(token: &str, to: &str, subject: &str, body: &str) -> bool {
    let email = format!("To: {}\r\nSubject: Re: {}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{}", to, subject, body);
    let encoded = general_purpose::URL_SAFE.encode(email.as_bytes());

    let client = reqwest::Client::new();
    let resp = client
        .post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send")
        .bearer_auth(token)
        .json(&serde_json::json!({"raw": encoded}))
        .send()
        .await;

    resp.is_ok()
}

async fn mark_as_read(token: &str, message_id: &str) {
    let client = reqwest::Client::new();
    let _ = client
        .post(&format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{}/modify", message_id))
        .bearer_auth(token)
        .json(&serde_json::json!({"removeLabelIds": ["UNREAD"]}))
        .send()
        .await;
}

async fn send_telegram_message(bot_token: &str, chat_id: &str, text: &str) {
    let client = reqwest::Client::new();
    let _ = client
        .post(&format!("https://api.telegram.org/bot{}/sendMessage", bot_token))
        .json(&serde_json::json!({
            "chat_id": chat_id,
            "text": text
        }))
        .send()
        .await;
}

async fn process_emails(state: Arc<AppState>) {
    let token_opt = state.token.lock().unwrap().clone();
    if token_opt.is_none() {
        return;
    }

    let token_data: TokenData = match serde_json::from_str(&token_opt.unwrap()) {
        Ok(t) => t,
        Err(_) => return,
    };

    {
        let mut status = state.current_status.lock().unwrap();
        *status = String::from("reading");
    }

    let emails = fetch_emails(&token_data.access_token).await;

    for (id, from, subject, body) in emails {
        let exists = {
            let memory = state.memory.lock().unwrap();
            memory.emails.iter().any(|e| e.id == id)
        };

        if exists {
            continue;
        }

        let telegram_message = format!("NEW EMAIL\n\nFrom: {}\nSubject: {}\n\n{}", from, subject, body);
        send_telegram_message(&state.config.telegram.bot_token, &state.config.telegram.chat_id, &telegram_message).await;

        {
            let mut status = state.current_status.lock().unwrap();
            *status = String::from("replying");
        }

        let ai_reply = generate_reply(&body, "", &state.assistant_core).await;

        let sent = send_email_reply(&token_data.access_token, &from, &subject, &ai_reply).await;

        if sent {
            mark_as_read(&token_data.access_token, &id).await;

            let timestamp = chrono::Utc::now().to_rfc3339();
            let reply_message = format!("REPLY SENT\n\nTo: {}\nTime: {}\n\n{}", from, timestamp, ai_reply);
            send_telegram_message(&state.config.telegram.bot_token, &state.config.telegram.chat_id, &reply_message).await;

            let body_to_store = if body.len() > 500 {
                body[..500].to_string()
            } else {
                body.clone()
            };

            {
                let mut memory = state.memory.lock().unwrap();
                memory.emails.push(EmailRecord {
                    id: id.clone(),
                    from: from.clone(),
                    subject: subject.clone(),
                    body: body_to_store,
                    reply: ai_reply.clone(),
                    timestamp: timestamp,
                });

                if memory.emails.len() > 100 {
                    memory.emails = memory.emails.split_off(memory.emails.len() - 100);
                }
            }

            let memory = state.memory.lock().unwrap();
            save_memory(&memory);
        }
    }

    {
        let mut status = state.current_status.lock().unwrap();
        *status = String::from("idle");
    }
}

async fn telegram_listener(state: Arc<AppState>) {
    let client = reqwest::Client::new();
    let mut offset = 0i64;

    loop {
        let resp = client
            .post(&format!("https://api.telegram.org/bot{}/getUpdates", state.config.telegram.bot_token))
            .json(&serde_json::json!({
                "offset": offset,
                "timeout": 60
            }))
            .send()
            .await;

        if let Ok(response) = resp {
            if let Ok(json) = response.json::<serde_json::Value>().await {
                if let Some(updates) = json["result"].as_array() {
                    for update in updates {
                        if let Some(message) = update["message"].as_object() {
                            let chat_id = message["chat"]["id"].as_i64().unwrap_or(0).to_string();
                            
                            if chat_id != state.config.telegram.chat_id {
                                continue;
                            }

                            let text = message["text"].as_str().unwrap_or("");
                            if text.is_empty() || text.starts_with('/') {
                                continue;
                            }

                            let message_id = message["message_id"].as_i64().unwrap_or(0);
                            let timestamp = chrono::Utc::now().to_rfc3339();

                            let context = {
                                let mut memory = state.memory.lock().unwrap();
                                memory.telegram.push(TelegramRecord {
                                    id: message_id,
                                    text: text.to_string(),
                                    timestamp: timestamp.clone(),
                                    reply: None,
                                });

                                let start = if memory.telegram.len() > 3 { memory.telegram.len() - 3 } else { 0 };
                                memory.telegram[start..].iter().map(|m| m.text.clone()).collect::<Vec<_>>().join("\n")
                            };

                            {
                                let mut status = state.current_status.lock().unwrap();
                                *status = String::from("replying");
                            }

                            let ai_reply = generate_reply(text, &context, &state.assistant_core).await;

                            send_telegram_message(&state.config.telegram.bot_token, &state.config.telegram.chat_id, &ai_reply).await;

                            {
                                let mut memory = state.memory.lock().unwrap();
                                if let Some(last) = memory.telegram.last_mut() {
                                    last.reply = Some(ai_reply);
                                }

                                if memory.telegram.len() > 100 {
                                    memory.telegram = memory.telegram.split_off(memory.telegram.len() - 100);
                                }

                                save_memory(&memory);
                            }

                            {
                                let mut status = state.current_status.lock().unwrap();
                                *status = String::from("idle");
                            }
                        }

                        offset = update["update_id"].as_i64().unwrap_or(0) + 1;
                    }
                }
            }
        }

        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn status_handler(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
) -> axum::Json<StatusResponse> {
    let memory = state.memory.lock().unwrap();
    let status = state.current_status.lock().unwrap();

    axum::Json(StatusResponse {
        status: status.clone(),
        email_count: memory.emails.len(),
        telegram_count: memory.telegram.len(),
    })
}

async fn emails_handler(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
) -> axum::Json<Vec<EmailRecord>> {
    let memory = state.memory.lock().unwrap();
    let start = if memory.emails.len() > 20 {
        memory.emails.len() - 20
    } else {
        0
    };

    let mut result: Vec<EmailRecord> = memory.emails[start..].to_vec();
    result.reverse();

    axum::Json(result)
}

async fn telegram_handler(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
) -> axum::Json<Vec<TelegramRecord>> {
    let memory = state.memory.lock().unwrap();
    let start = if memory.telegram.len() > 20 {
        memory.telegram.len() - 20
    } else {
        0
    };

    let mut result: Vec<TelegramRecord> = memory.telegram[start..].to_vec();
    result.reverse();

    axum::Json(result)
}

async fn auth_handler(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
) -> axum::response::Redirect {
    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/auth?client_id={}&redirect_uri={}&scope=https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send&response_type=code&access_type=offline",
        state.config.gmail.client_id,
        urlencoding::encode(&state.config.gmail.redirect_uri)
    );
    axum::response::Redirect::temporary(&auth_url)
}

async fn oauth2callback_handler(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> axum::response::Html<&'static str> {
    let code = match params.get("code") {
        Some(c) => c,
        None => return axum::response::Html("Authentication failed."),
    };

    let client = reqwest::Client::new();
    let token_resp = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", code.as_str()),
            ("client_id", &state.config.gmail.client_id),
            ("client_secret", &state.config.gmail.client_secret),
            ("redirect_uri", &state.config.gmail.redirect_uri),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await;

    if let Ok(resp) = token_resp {
        if let Ok(token_json) = resp.text().await {
            save_token(&token_json);
            
            {
                let mut token = state.token.lock().unwrap();
                *token = Some(token_json);
            }

            let state_clone = state.clone();
            tokio::spawn(async move {
                process_emails(state_clone.clone()).await;
                let mut ticker = interval(Duration::from_secs(120));
                loop {
                    ticker.tick().await;
                    process_emails(state_clone.clone()).await;
                }
            });

            return axum::response::Html("Authentication successful. You can close this window.");
        }
    }

    axum::response::Html("Authentication failed.")
}