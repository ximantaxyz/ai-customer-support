package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/mux"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	"google.golang.org/api/gmail/v1"
	"google.golang.org/api/option"
	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

type Config struct {
	Port     int      `json:"port"`
	Gmail    Gmail    `json:"gmail"`
	Telegram Telegram `json:"telegram"`
}

type Gmail struct {
	ClientID     string `json:"clientId"`
	ClientSecret string `json:"clientSecret"`
	RedirectURI  string `json:"redirectUri"`
}

type Telegram struct {
	BotToken string `json:"botToken"`
	ChatID   string `json:"chatId"`
}

type Memory struct {
	Emails   []EmailRecord    `json:"emails"`
	Telegram []TelegramRecord `json:"telegram"`
}

type EmailRecord struct {
	ID        string `json:"id"`
	From      string `json:"from"`
	Subject   string `json:"subject"`
	Body      string `json:"body"`
	Reply     string `json:"reply"`
	Timestamp string `json:"timestamp"`
}

type TelegramRecord struct {
	ID        int    `json:"id"`
	Text      string `json:"text"`
	Timestamp string `json:"timestamp"`
	Reply     string `json:"reply,omitempty"`
}

type OllamaRequest struct {
	Model   string        `json:"model"`
	Prompt  string        `json:"prompt"`
	Stream  bool          `json:"stream"`
	Options OllamaOptions `json:"options"`
}

type OllamaOptions struct {
	Temperature float64 `json:"temperature"`
	NumPredict  int     `json:"num_predict"`
}

type OllamaResponse struct {
	Response string `json:"response"`
}

type StatusResponse struct {
	Status        string `json:"status"`
	EmailCount    int    `json:"emailCount"`
	TelegramCount int    `json:"telegramCount"`
}

var (
	config        Config
	memory        Memory
	assistantCore string
	currentStatus string
	mu            sync.RWMutex
	memoryFile    = "./memory.json"
	configFile    = "./config.json"
	assistantFile = "./assistant_core.txt"
	tokenFile     = "./token.json"
	oauth2Config  *oauth2.Config
	bot           *tgbotapi.BotAPI
)

func main() {
	loadConfig()
	loadAssistantCore()
	loadMemory()

	oauth2Config = &oauth2.Config{
		ClientID:     config.Gmail.ClientID,
		ClientSecret: config.Gmail.ClientSecret,
		RedirectURL:  config.Gmail.RedirectURI,
		Scopes: []string{
			"https://www.googleapis.com/auth/gmail.modify",
			"https://www.googleapis.com/auth/gmail.send",
		},
		Endpoint: google.Endpoint,
	}

	var err error
	bot, err = tgbotapi.NewBotAPI(config.Telegram.BotToken)
	if err == nil {
		go telegramListener()
	}

	r := mux.NewRouter()
	r.HandleFunc("/status", statusHandler).Methods("GET")
	r.HandleFunc("/emails", emailsHandler).Methods("GET")
	r.HandleFunc("/telegram", telegramHandler).Methods("GET")
	r.HandleFunc("/auth", authHandler).Methods("GET")
	r.HandleFunc("/oauth2callback", oauth2CallbackHandler).Methods("GET")
	r.PathPrefix("/").Handler(http.FileServer(http.Dir(".")))

	hasToken := loadToken()
	if hasToken {
		go emailProcessor()
	}

	addr := fmt.Sprintf(":%d", config.Port)
	log.Printf("Server running on http://localhost%s\n", addr)
	if !hasToken {
		log.Printf("Visit http://localhost%s/auth to authenticate Gmail\n", addr)
	}
	log.Fatal(http.ListenAndServe(addr, r))
}

func loadConfig() {
	data, err := os.ReadFile(configFile)
	if err != nil {
		log.Fatal(err)
	}
	if err := json.Unmarshal(data, &config); err != nil {
		log.Fatal(err)
	}
}

func loadAssistantCore() {
	data, err := os.ReadFile(assistantFile)
	if err != nil {
		assistantCore = ""
		return
	}
	assistantCore = string(data)
}

func loadMemory() {
	data, err := os.ReadFile(memoryFile)
	if err != nil {
		memory = Memory{
			Emails:   []EmailRecord{},
			Telegram: []TelegramRecord{},
		}
		return
	}
	if err := json.Unmarshal(data, &memory); err != nil {
		memory = Memory{
			Emails:   []EmailRecord{},
			Telegram: []TelegramRecord{},
		}
	}
}

func saveMemory() {
	mu.Lock()
	defer mu.Unlock()

	data, err := json.MarshalIndent(memory, "", "  ")
	if err != nil {
		return
	}
	os.WriteFile(memoryFile, data, 0644)
}

func loadToken() bool {
	data, err := os.ReadFile(tokenFile)
	if err != nil {
		return false
	}
	return true
}

func saveToken(token *oauth2.Token) {
	data, _ := json.Marshal(token)
	os.WriteFile(tokenFile, data, 0644)
}

func getToken() (*oauth2.Token, error) {
	data, err := os.ReadFile(tokenFile)
	if err != nil {
		return nil, err
	}
	var token oauth2.Token
	err = json.Unmarshal(data, &token)
	return &token, err
}

func callOllama(prompt, systemPrompt string) string {
	fullPrompt := systemPrompt + "\n\n" + prompt
	if assistantCore != "" {
		fullPrompt = assistantCore + "\n\n" + fullPrompt
	}

	reqBody := OllamaRequest{
		Model:  "qwen:0.5b",
		Prompt: fullPrompt,
		Stream: false,
		Options: OllamaOptions{
			Temperature: 0.7,
			NumPredict:  300,
		},
	}

	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return ""
	}

	resp, err := http.Post("http://127.0.0.1:11434/api/generate", "application/json", bytes.NewBuffer(jsonData))
	if err != nil {
		return ""
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return ""
	}

	var ollamaResp OllamaResponse
	if err := json.Unmarshal(body, &ollamaResp); err != nil {
		return ""
	}

	return strings.TrimSpace(ollamaResp.Response)
}

func stripMarkdown(text string) string {
	text = regexp.MustCompile(`\*\*(.+?)\*\*`).ReplaceAllString(text, "$1")
	text = regexp.MustCompile(`\*(.+?)\*`).ReplaceAllString(text, "$1")
	text = regexp.MustCompile("```[\\s\\S]*?```").ReplaceAllString(text, "")
	text = regexp.MustCompile("`(.+?)`").ReplaceAllString(text, "$1")
	text = regexp.MustCompile(`(?m)^#+\s+`).ReplaceAllString(text, "")
	text = regexp.MustCompile(`\[(.+?)\]\(.+?\)`).ReplaceAllString(text, "$1")
	return strings.TrimSpace(text)
}

func generateReply(customerMessage, context string) string {
	systemPrompt := "You are a professional customer support assistant for an e-commerce platform. You write polite, clear, and helpful replies to customers. You never mention that you are AI or automated. You never promise refunds or compensation without authorization. You never make up order details or tracking numbers. You escalate serious issues politely by saying the customer will be contacted by a specialist. You keep replies concise but warm. You never use markdown formatting. You always end with a professional closing like \"Best regards\" or \"Kind regards\"."

	userPrompt := customerMessage
	if context != "" {
		userPrompt = "Previous context: " + context + "\n\nCustomer message: " + customerMessage
	} else {
		userPrompt = "Customer message: " + customerMessage
	}

	reply := callOllama(userPrompt, systemPrompt)
	if reply == "" {
		return "Thank you for contacting us. We have received your message and will respond shortly. Best regards."
	}
	return stripMarkdown(reply)
}

func fetchEmails() []map[string]string {
	token, err := getToken()
	if err != nil {
		return []map[string]string{}
	}

	client := oauth2Config.Client(context.Background(), token)
	srv, err := gmail.NewService(context.Background(), option.WithHTTPClient(client))
	if err != nil {
		return []map[string]string{}
	}

	listResp, err := srv.Users.Messages.List("me").Q("is:unread").MaxResults(5).Do()
	if err != nil {
		return []map[string]string{}
	}

	if listResp.Messages == nil {
		return []map[string]string{}
	}

	emails := []map[string]string{}

	for _, msg := range listResp.Messages {
		message, err := srv.Users.Messages.Get("me", msg.Id).Format("full").Do()
		if err != nil {
			continue
		}

		from := ""
		subject := ""
		for _, h := range message.Payload.Headers {
			if h.Name == "From" {
				from = h.Value
			}
			if h.Name == "Subject" {
				subject = h.Value
			}
		}

		body := ""
		if message.Payload.Body.Data != "" {
			decoded, _ := base64.URLEncoding.DecodeString(message.Payload.Body.Data)
			body = string(decoded)
		} else if message.Payload.Parts != nil {
			for _, part := range message.Payload.Parts {
				if part.MimeType == "text/plain" && part.Body.Data != "" {
					decoded, _ := base64.URLEncoding.DecodeString(part.Body.Data)
					body = string(decoded)
					break
				}
			}
		}

		if len(body) > 2000 {
			body = body[:2000]
		}

		emails = append(emails, map[string]string{
			"id":      msg.Id,
			"from":    from,
			"subject": subject,
			"body":    body,
		})
	}

	return emails
}

func sendEmailReply(to, subject, body string) bool {
	token, err := getToken()
	if err != nil {
		return false
	}

	client := oauth2Config.Client(context.Background(), token)
	srv, err := gmail.NewService(context.Background(), option.WithHTTPClient(client))
	if err != nil {
		return false
	}

	email := fmt.Sprintf("To: %s\r\nSubject: Re: %s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s", to, subject, body)
	encoded := base64.URLEncoding.EncodeToString([]byte(email))

	message := &gmail.Message{
		Raw: encoded,
	}

	_, err = srv.Users.Messages.Send("me", message).Do()
	return err == nil
}

func markAsRead(messageId string) {
	token, err := getToken()
	if err != nil {
		return
	}

	client := oauth2Config.Client(context.Background(), token)
	srv, err := gmail.NewService(context.Background(), option.WithHTTPClient(client))
	if err != nil {
		return
	}

	modifyRequest := &gmail.ModifyMessageRequest{
		RemoveLabelIds: []string{"UNREAD"},
	}

	srv.Users.Messages.Modify("me", messageId, modifyRequest).Do()
}

func processEmails() {
	mu.Lock()
	currentStatus = "reading"
	mu.Unlock()

	emails := fetchEmails()

	for _, email := range emails {
		mu.RLock()
		found := false
		for _, e := range memory.Emails {
			if e.ID == email["id"] {
				found = true
				break
			}
		}
		mu.RUnlock()

		if found {
			continue
		}

		telegramMessage := fmt.Sprintf("NEW EMAIL\n\nFrom: %s\nSubject: %s\n\n%s", email["from"], email["subject"], email["body"])

		if bot != nil {
			chatID, _ := parseIntChatID(config.Telegram.ChatID)
			msg := tgbotapi.NewMessage(chatID, telegramMessage)
			bot.Send(msg)
		}

		mu.Lock()
		currentStatus = "replying"
		mu.Unlock()

		aiReply := generateReply(email["body"], "")

		sent := sendEmailReply(email["from"], email["subject"], aiReply)

		if sent {
			markAsRead(email["id"])

			timestamp := time.Now().UTC().Format(time.RFC3339)
			replyMessage := fmt.Sprintf("REPLY SENT\n\nTo: %s\nTime: %s\n\n%s", email["from"], timestamp, aiReply)

			if bot != nil {
				chatID, _ := parseIntChatID(config.Telegram.ChatID)
				msg := tgbotapi.NewMessage(chatID, replyMessage)
				bot.Send(msg)
			}

			bodyToStore := email["body"]
			if len(bodyToStore) > 500 {
				bodyToStore = bodyToStore[:500]
			}

			mu.Lock()
			memory.Emails = append(memory.Emails, EmailRecord{
				ID:        email["id"],
				From:      email["from"],
				Subject:   email["subject"],
				Body:      bodyToStore,
				Reply:     aiReply,
				Timestamp: timestamp,
			})

			if len(memory.Emails) > 100 {
				memory.Emails = memory.Emails[len(memory.Emails)-100:]
			}
			mu.Unlock()

			saveMemory()
		}
	}

	mu.Lock()
	currentStatus = "idle"
	mu.Unlock()
}

func emailProcessor() {
	processEmails()
	ticker := time.NewTicker(120 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		processEmails()
	}
}

func telegramListener() {
	u := tgbotapi.NewUpdate(0)
	u.Timeout = 60

	updates := bot.GetUpdatesChan(u)

	for update := range updates {
		if update.Message == nil {
			continue
		}

		if fmt.Sprintf("%d", update.Message.Chat.ID) != config.Telegram.ChatID {
			continue
		}

		if update.Message.Text == "" || strings.HasPrefix(update.Message.Text, "/") {
			continue
		}

		customerFeedback := update.Message.Text
		timestamp := time.Now().UTC().Format(time.RFC3339)

		mu.Lock()
		memory.Telegram = append(memory.Telegram, TelegramRecord{
			ID:        update.Message.MessageID,
			Text:      customerFeedback,
			Timestamp: timestamp,
			Reply:     "",
		})

		contextMessages := []string{}
		start := len(memory.Telegram) - 3
		if start < 0 {
			start = 0
		}
		for i := start; i < len(memory.Telegram); i++ {
			contextMessages = append(contextMessages, memory.Telegram[i].Text)
		}
		context := strings.Join(contextMessages, "\n")

		currentStatus = "replying"
		mu.Unlock()

		aiReply := generateReply(customerFeedback, context)

		chatID, _ := parseIntChatID(config.Telegram.ChatID)
		msg := tgbotapi.NewMessage(chatID, aiReply)
		bot.Send(msg)

		mu.Lock()
		memory.Telegram[len(memory.Telegram)-1].Reply = aiReply

		if len(memory.Telegram) > 100 {
			memory.Telegram = memory.Telegram[len(memory.Telegram)-100:]
		}

		currentStatus = "idle"
		mu.Unlock()

		saveMemory()
	}
}

func parseIntChatID(chatID string) (int64, error) {
	var id int64
	fmt.Sscanf(chatID, "%d", &id)
	return id, nil
}

func statusHandler(w http.ResponseWriter, r *http.Request) {
	mu.RLock()
	status := currentStatus
	emailCount := len(memory.Emails)
	telegramCount := len(memory.Telegram)
	mu.RUnlock()

	resp := StatusResponse{
		Status:        status,
		EmailCount:    emailCount,
		TelegramCount: telegramCount,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func emailsHandler(w http.ResponseWriter, r *http.Request) {
	mu.RLock()
	emails := memory.Emails
	mu.RUnlock()

	start := len(emails) - 20
	if start < 0 {
		start = 0
	}

	result := make([]EmailRecord, len(emails[start:]))
	copy(result, emails[start:])

	for i, j := 0, len(result)-1; i < j; i, j = i+1, j-1 {
		result[i], result[j] = result[j], result[i]
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

func telegramHandler(w http.ResponseWriter, r *http.Request) {
	mu.RLock()
	telegram := memory.Telegram
	mu.RUnlock()

	start := len(telegram) - 20
	if start < 0 {
		start = 0
	}

	result := make([]TelegramRecord, len(telegram[start:]))
	copy(result, telegram[start:])

	for i, j := 0, len(result)-1; i < j; i, j = i+1, j-1 {
		result[i], result[j] = result[j], result[i]
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

func authHandler(w http.ResponseWriter, r *http.Request) {
	authURL := oauth2Config.AuthCodeURL("state", oauth2.AccessTypeOffline)
	http.Redirect(w, r, authURL, http.StatusFound)
}

func oauth2CallbackHandler(w http.ResponseWriter, r *http.Request) {
	code := r.URL.Query().Get("code")
	if code == "" {
		w.Write([]byte("Authentication failed."))
		return
	}

	token, err := oauth2Config.Exchange(context.Background(), code)
	if err != nil {
		w.Write([]byte("Authentication failed."))
		return
	}

	saveToken(token)
	go emailProcessor()

	w.Write([]byte("Authentication successful. You can close this window."))
}