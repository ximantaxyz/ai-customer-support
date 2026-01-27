local http = require("socket.http")
local ltn12 = require("ltn12")
local json = require("cjson")
local socket = require("socket")
local mime = require("mime")

local CONFIG_FILE = "./config.json"
local MEMORY_FILE = "./memory.json"
local TOKEN_FILE = "./token.json"
local ASSISTANT_CORE_FILE = "./assistant_core.txt"

local config = {}
local memory = {emails = {}, telegram = {}}
local assistant_core = ""
local current_status = "idle"

local function read_file(path)
    local file = io.open(path, "r")
    if not file then return nil end
    local content = file:read("*all")
    file:close()
    return content
end

local function write_file(path, content)
    local file = io.open(path, "w")
    if file then
        file:write(content)
        file:close()
    end
end

local function load_config()
    local content = read_file(CONFIG_FILE)
    if content then
        config = json.decode(content)
    end
end

local function load_assistant_core()
    local content = read_file(ASSISTANT_CORE_FILE)
    assistant_core = content or ""
end

local function load_memory()
    local content = read_file(MEMORY_FILE)
    if content then
        memory = json.decode(content)
    else
        memory = {emails = {}, telegram = {}}
    end
end

local function save_memory()
    write_file(MEMORY_FILE, json.encode(memory))
end

local function load_token()
    local content = read_file(TOKEN_FILE)
    if content then
        return true
    end
    return false
end

local function save_token(tokens)
    write_file(TOKEN_FILE, json.encode(tokens))
end

local function call_ollama(prompt, system_prompt)
    local full_prompt = system_prompt .. "\n\n" .. prompt
    if assistant_core ~= "" then
        full_prompt = assistant_core .. "\n\n" .. full_prompt
    end
    
    local payload = json.encode({
        model = "qwen:0.5b",
        prompt = full_prompt,
        stream = false,
        options = {
            temperature = 0.7,
            num_predict = 300
        }
    })
    
    local response_body = {}
    local res, code = http.request{
        url = "http://127.0.0.1:11434/api/generate",
        method = "POST",
        headers = {
            ["Content-Type"] = "application/json",
            ["Content-Length"] = tostring(#payload)
        },
        source = ltn12.source.string(payload),
        sink = ltn12.sink.table(response_body)
    }
    
    if code == 200 then
        local response_text = table.concat(response_body)
        local ok, data = pcall(json.decode, response_text)
        if ok and data.response then
            return data.response:match("^%s*(.-)%s*$")
        end
    end
    
    return ""
end

local function strip_markdown(text)
    text = text:gsub("%*%*(.-)%*%*", "%1")
    text = text:gsub("%*(.-)%*", "%1")
    text = text:gsub("```.-```", "")
    text = text:gsub("`(.-)`", "%1")
    text = text:gsub("^#+%s+", "")
    text = text:gsub("%[(.-)%]%(.-%)", "%1")
    return text:match("^%s*(.-)%s*$")
end

local function generate_reply(customer_message, context)
    local system_prompt = 'You are a professional customer support assistant for an e-commerce platform. You write polite, clear, and helpful replies to customers. You never mention that you are AI or automated. You never promise refunds or compensation without authorization. You never make up order details or tracking numbers. You escalate serious issues politely by saying the customer will be contacted by a specialist. You keep replies concise but warm. You never use markdown formatting. You always end with a professional closing like "Best regards" or "Kind regards".'
    
    local user_prompt
    if context and context ~= "" then
        user_prompt = "Previous context: " .. context .. "\n\nCustomer message: " .. customer_message
    else
        user_prompt = "Customer message: " .. customer_message
    end
    
    local reply = call_ollama(user_prompt, system_prompt)
    if reply == "" then
        return "Thank you for contacting us. We have received your message and will respond shortly. Best regards."
    end
    return strip_markdown(reply)
end

local function get_gmail_auth_url()
    local params = {
        client_id = config.gmail.clientId,
        redirect_uri = config.gmail.redirectUri,
        response_type = "code",
        scope = "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send",
        access_type = "offline"
    }
    local param_str = ""
    for k,v in pairs(params) do
        if param_str ~= "" then param_str = param_str .. "&" end
        param_str = param_str .. k .. "=" .. v:gsub(" ", "%%20")
    end
    return "https://accounts.google.com/o/oauth2/auth?" .. param_str
end

local function exchange_code_for_token(code)
    local params = {
        code = code,
        client_id = config.gmail.clientId,
        client_secret = config.gmail.clientSecret,
        redirect_uri = config.gmail.redirectUri,
        grant_type = "authorization_code"
    }
    
    local param_str = ""
    for k,v in pairs(params) do
        if param_str ~= "" then param_str = param_str .. "&" end
        param_str = param_str .. k .. "=" .. v:gsub(" ", "%%20")
    end
    
    local response_body = {}
    local res, code = http.request{
        url = "https://oauth2.googleapis.com/token",
        method = "POST",
        headers = {
            ["Content-Type"] = "application/x-www-form-urlencoded",
            ["Content-Length"] = tostring(#param_str)
        },
        source = ltn12.source.string(param_str),
        sink = ltn12.sink.table(response_body)
    }
    
    if code == 200 then
        local response_text = table.concat(response_body)
        local ok, data = pcall(json.decode, response_text)
        if ok then
            return data
        end
    end
    return nil
end

local function fetch_emails()
    local token_content = read_file(TOKEN_FILE)
    if not token_content then return {} end
    
    local token_data = json.decode(token_content)
    
    local response_body = {}
    local res, code = http.request{
        url = "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=5",
        headers = {
            ["Authorization"] = "Bearer " .. token_data.access_token
        },
        sink = ltn12.sink.table(response_body)
    }
    
    if code ~= 200 then return {} end
    
    local response_text = table.concat(response_body)
    local list_data = json.decode(response_text)
    
    if not list_data.messages then return {} end
    
    local emails = {}
    
    for _, message in ipairs(list_data.messages) do
        local msg_body = {}
        local res2, code2 = http.request{
            url = "https://gmail.googleapis.com/gmail/v1/users/me/messages/" .. message.id .. "?format=full",
            headers = {
                ["Authorization"] = "Bearer " .. token_data.access_token
            },
            sink = ltn12.sink.table(msg_body)
        }
        
        if code2 == 200 then
            local msg_text = table.concat(msg_body)
            local msg_data = json.decode(msg_text)
            
            local from = ""
            local subject = ""
            
            for _, header in ipairs(msg_data.payload.headers) do
                if header.name == "From" then
                    from = header.value
                elseif header.name == "Subject" then
                    subject = header.value
                end
            end
            
            local body = ""
            if msg_data.payload.body.data then
                body = mime.unb64(msg_data.payload.body.data:gsub("-", "+"):gsub("_", "/"))
            elseif msg_data.payload.parts then
                for _, part in ipairs(msg_data.payload.parts) do
                    if part.mimeType == "text/plain" and part.body.data then
                        body = mime.unb64(part.body.data:gsub("-", "+"):gsub("_", "/"))
                        break
                    end
                end
            end
            
            table.insert(emails, {
                id = message.id,
                from = from,
                subject = subject,
                body = body:sub(1, 2000)
            })
        end
    end
    
    return emails
end

local function send_email_reply(to, subject, body)
    local token_content = read_file(TOKEN_FILE)
    if not token_content then return false end
    
    local token_data = json.decode(token_content)
    
    local email = table.concat({
        "To: " .. to,
        "Subject: Re: " .. subject,
        "Content-Type: text/plain; charset=utf-8",
        "",
        body
    }, "\r\n")
    
    local encoded_email = mime.b64(email):gsub("+", "-"):gsub("/", "_"):gsub("=+$", "")
    
    local response_body = {}
    local res, code = http.request{
        url = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        method = "POST",
        headers = {
            ["Authorization"] = "Bearer " .. token_data.access_token,
            ["Content-Type"] = "application/json"
        },
        source = ltn12.source.string(json.encode({raw = encoded_email})),
        sink = ltn12.sink.table(response_body)
    }
    
    return code == 200
end

local function mark_as_read(message_id)
    local token_content = read_file(TOKEN_FILE)
    if not token_content then return end
    
    local token_data = json.decode(token_content)
    
    http.request{
        url = "https://gmail.googleapis.com/gmail/v1/users/me/messages/" .. message_id .. "/modify",
        method = "POST",
        headers = {
            ["Authorization"] = "Bearer " .. token_data.access_token,
            ["Content-Type"] = "application/json"
        },
        source = ltn12.source.string(json.encode({removeLabelIds = {"UNREAD"}}))
    }
end

local function send_telegram_message(text)
    http.request{
        url = "https://api.telegram.org/bot" .. config.telegram.botToken .. "/sendMessage",
        method = "POST",
        headers = {
            ["Content-Type"] = "application/json"
        },
        source = ltn12.source.string(json.encode({
            chat_id = config.telegram.chatId,
            text = text
        }))
    }
end

local function process_emails()
    current_status = "reading"
    local emails = fetch_emails()
    
    for _, email in ipairs(emails) do
        local exists = false
        for _, mem_email in ipairs(memory.emails) do
            if mem_email.id == email.id then
                exists = true
                break
            end
        end
        if exists then goto continue end
        
        local telegram_message = "NEW EMAIL\n\nFrom: " .. email.from .. "\nSubject: " .. email.subject .. "\n\n" .. email.body
        send_telegram_message(telegram_message)
        
        current_status = "replying"
        local ai_reply = generate_reply(email.body)
        
        local sent = send_email_reply(email.from, email.subject, ai_reply)
        
        if sent then
            mark_as_read(email.id)
            
            local timestamp = os.date("!%Y-%m-%dT%H:%M:%SZ")
            local reply_message = "REPLY SENT\n\nTo: " .. email.from .. "\nTime: " .. timestamp .. "\n\n" .. ai_reply
            send_telegram_message(reply_message)
            
            table.insert(memory.emails, {
                id = email.id,
                from = email.from,
                subject = email.subject,
                body = email.body:sub(1, 500),
                reply = ai_reply,
                timestamp = timestamp
            })
            
            if #memory.emails > 100 then
                memory.emails = {unpack(memory.emails, #memory.emails - 99)}
            end
            
            save_memory()
        end
        
        ::continue::
    end
    
    current_status = "idle"
end

local function start_telegram_bot()
    local webhook_url = "http://localhost:" .. (config.port or 3000) .. "/telegram-webhook"
    
    http.request{
        url = "https://api.telegram.org/bot" .. config.telegram.botToken .. "/setWebhook",
        method = "POST",
        headers = {
            ["Content-Type"] = "application/json"
        },
        source = ltn12.source.string(json.encode({url = webhook_url}))
    }
end

local function email_processor()
    while true do
        socket.sleep(120)
        process_emails()
    end
end

local function handle_status()
    return json.encode({
        status = current_status,
        emailCount = #memory.emails,
        telegramCount = #memory.telegram
    })
end

local function handle_emails()
    local start = math.max(1, #memory.emails - 19)
    local result = {}
    for i = #memory.emails, start, -1 do
        table.insert(result, memory.emails[i])
    end
    return json.encode(result)
end

local function handle_telegram()
    local start = math.max(1, #memory.telegram - 19)
    local result = {}
    for i = #memory.telegram, start, -1 do
        table.insert(result, memory.telegram[i])
    end
    return json.encode(result)
end

local function parse_request(request_line)
    local method, path = request_line:match("^(%S+)%s+(%S+)")
    return method, path
end

local function send_response(client, status, content_type, body)
    local response = "HTTP/1.1 " .. status .. "\r\n"
    response = response .. "Content-Type: " .. content_type .. "\r\n"
    response = response .. "Content-Length: " .. #body .. "\r\n"
    response = response .. "Connection: close\r\n"
    response = response .. "\r\n"
    response = response .. body
    client:send(response)
end

local function handle_client(client)
    client:settimeout(5)
    local request_line = client:receive()
    if not request_line then
        client:close()
        return
    end
    
    local headers = {}
    while true do
        local line = client:receive()
        if not line or line == "" then break end
        table.insert(headers, line)
    end
    
    local method, path = parse_request(request_line)
    local query = ""
    if path:find("?") then
        path, query = path:match("^([^?]*)%?(.*)$")
    end
    
    if path == "/status" then
        send_response(client, "200 OK", "application/json", handle_status())
    elseif path == "/emails" then
        send_response(client, "200 OK", "application/json", handle_emails())
    elseif path == "/telegram" then
        send_response(client, "200 OK", "application/json", handle_telegram())
    elseif path == "/auth" then
        local auth_url = get_gmail_auth_url()
        send_response(client, "302 Found", "text/html", '<html><head><meta http-equiv="refresh" content="0; url=' .. auth_url .. '"></head></html>')
    elseif path == "/oauth2callback" then
        local code = query:match("code=([^&]*)")
        if code then
            local tokens = exchange_code_for_token(code)
            if tokens then
                save_token(tokens)
                send_response(client, "200 OK", "text/html", "Authentication successful. You can close this window.")
            else
                send_response(client, "400 Bad Request", "text/plain", "Authentication failed.")
            end
        else
            send_response(client, "400 Bad Request", "text/plain", "Authentication failed.")
        end
    elseif path == "/telegram-webhook" and method == "POST" then
        local body = ""
        while true do
            local chunk = client:receive()
            if not chunk then break end
            body = body .. chunk
        end
        
        local ok, update = pcall(json.decode, body)
        if ok and update.message and update.message.chat.id == tonumber(config.telegram.chatId) then
            local msg = update.message
            
            if msg.text and not msg.text:match("^/") then
                local timestamp = os.date("!%Y-%m-%dT%H:%M:%SZ")
                table.insert(memory.telegram, {
                    id = msg.message_id,
                    text = msg.text,
                    timestamp = timestamp,
                    reply = nil
                })
                
                current_status = "replying"
                local context = ""
                for i = math.max(1, #memory.telegram - 2), #memory.telegram do
                    if memory.telegram[i].text then
                        if context ~= "" then context = context .. "\n" end
                        context = context .. memory.telegram[i].text
                    end
                end
                local ai_reply = generate_reply(msg.text, context)
                
                send_telegram_message(ai_reply)
                
                memory.telegram[#memory.telegram].reply = ai_reply
                
                if #memory.telegram > 100 then
                    memory.telegram = {unpack(memory.telegram, #memory.telegram - 99)}
                end
                
                save_memory()
                current_status = "idle"
            end
        end
        send_response(client, "200 OK", "text/plain", "OK")
    elseif path == "/" then
        local content = read_file("./index.html")
        if content then
            send_response(client, "200 OK", "text/html", content)
        else
            send_response(client, "404 Not Found", "text/plain", "Not Found")
        end
    else
        local file_path = "." .. path
        local content = read_file(file_path)
        if content then
            local content_type = "text/plain"
            if path:match("%.html$") then content_type = "text/html"
            elseif path:match("%.js$") then content_type = "application/javascript"
            elseif path:match("%.css$") then content_type = "text/css"
            elseif path:match("%.json$") then content_type = "application/json"
            end
            send_response(client, "200 OK", content_type, content)
        else
            send_response(client, "404 Not Found", "text/plain", "Not Found")
        end
    end
    
    client:close()
end

local function main()
    load_config()
    load_assistant_core()
    load_memory()
    
    local has_token = load_token()
    
    if has_token then
        start_telegram_bot()
        socket.sleep(1)
        process_emails()
        
        local co = coroutine.create(function()
            email_processor()
        end)
        coroutine.resume(co)
    end
    
    local port = config.port or 3000
    local server = assert(socket.bind("*", port))
    server:settimeout(0.1)
    
    print("Server running on http://localhost:" .. port)
    
    if not has_token then
        print("Visit http://localhost:" .. port .. "/auth to authenticate Gmail")
    end
    
    while true do
        local client = server:accept()
        if client then
            handle_client(client)
        end
    end
end

main()
[file content end]