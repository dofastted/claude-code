use serde::ser::SerializeMap;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Map, Value};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MessageRequest {
    pub model: String,
    pub messages: Vec<Message>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<SystemPrompt>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolDefinition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
    pub max_tokens: u32,
    #[serde(default, skip_serializing_if = "is_false")]
    pub stream: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_k: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stop_sequences: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub betas: Vec<String>,
    #[serde(default, flatten)]
    pub extra: Map<String, Value>,
}

impl Default for MessageRequest {
    fn default() -> Self {
        Self {
            model: String::new(),
            messages: Vec::new(),
            system: None,
            tools: Vec::new(),
            tool_choice: None,
            thinking: None,
            metadata: None,
            max_tokens: 1024,
            stream: false,
            temperature: None,
            top_p: None,
            top_k: None,
            stop_sequences: Vec::new(),
            betas: Vec::new(),
            extra: Map::new(),
        }
    }
}

impl MessageRequest {
    pub fn normalize_openai_tools(&mut self) {
        for message in &mut self.messages {
            if message.role == "tool"
                && let Some(id) = message.tool_call_id.clone()
            {
                let content = match &message.content {
                    MessageContent::Text(text) => Value::String(text.clone()),
                    MessageContent::Blocks(blocks) => {
                        serde_json::to_value(blocks).unwrap_or(Value::Null)
                    }
                };
                message.role = "user".into();
                message.content = MessageContent::Blocks(vec![ContentBlock::ToolResult {
                    tool_use_id: id,
                    content,
                    is_error: false,
                    cache_control: None,
                }]);
                message.tool_call_id = None;
            }
            if !message.tool_calls.is_empty() {
                let mut blocks = Vec::new();
                if let MessageContent::Text(text) = &message.content
                    && !text.is_empty()
                {
                    blocks.push(ContentBlock::Text {
                        text: text.clone(),
                        cache_control: None,
                    });
                }
                if let MessageContent::Blocks(existing) = &message.content {
                    blocks.extend(existing.clone());
                }
                for call in message.tool_calls.drain(..) {
                    let input = serde_json::from_str(&call.function.arguments)
                        .unwrap_or_else(|_| json_or_string(&call.function.arguments));
                    blocks.push(ContentBlock::ToolUse {
                        id: call.id,
                        name: call.function.name,
                        input,
                        cache_control: None,
                    });
                }
                message.content = MessageContent::Blocks(blocks);
            }
        }
    }
}

fn json_or_string(raw: &str) -> Value {
    Value::String(raw.to_string())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum SystemPrompt {
    Text(String),
    Blocks(Vec<Value>),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Message {
    pub role: String,
    #[serde(default, deserialize_with = "deserialize_content")]
    pub content: MessageContent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ChatToolCall>,
    #[serde(default, flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Blocks(Vec<ContentBlock>),
}

impl Default for MessageContent {
    fn default() -> Self {
        Self::Text(String::new())
    }
}

fn deserialize_content<'de, D>(deserializer: D) -> Result<MessageContent, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    match value {
        None | Some(Value::Null) => Ok(MessageContent::Text(String::new())),
        Some(Value::String(text)) => Ok(MessageContent::Text(text)),
        Some(Value::Array(items)) => {
            let blocks = items
                .into_iter()
                .map(serde_json::from_value)
                .collect::<Result<Vec<_>, _>>()
                .map_err(serde::de::Error::custom)?;
            Ok(MessageContent::Blocks(blocks))
        }
        Some(other) => Ok(MessageContent::Text(other.to_string())),
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ContentBlock {
    Text {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cache_control: Option<Value>,
    },
    Image {
        source: Value,
    },
    Document {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
    ToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cache_control: Option<Value>,
    },
    ToolResult {
        tool_use_id: String,
        #[serde(default)]
        content: Value,
        #[serde(default)]
        is_error: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cache_control: Option<Value>,
    },
    Thinking {
        thinking: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
    RedactedThinking {
        #[serde(default, skip_serializing_if = "Value::is_null")]
        data: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
    ServerToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cache_control: Option<Value>,
    },
    WebSearchToolResult {
        tool_use_id: String,
        #[serde(default)]
        content: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cache_control: Option<Value>,
    },
    /// Preserve extensions and newer blocks without reconstructing their fields.
    #[serde(untagged)]
    Raw(Value),
}

#[derive(Clone, Debug, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub tool_type: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(default = "default_schema")]
    pub input_schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_control: Option<Value>,
    #[serde(default, flatten)]
    pub extra: Map<String, Value>,
}

impl Serialize for ToolDefinition {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("name", &self.name)?;
        if let Some(tool_type) = &self.tool_type {
            map.serialize_entry("type", tool_type)?;
        }
        if !self.description.is_empty() {
            map.serialize_entry("description", &self.description)?;
        }
        if !is_server_tool_type(self.tool_type.as_deref()) {
            map.serialize_entry("input_schema", &self.input_schema)?;
        }
        if let Some(cache_control) = &self.cache_control {
            map.serialize_entry("cache_control", cache_control)?;
        }
        for (key, value) in &self.extra {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

fn is_server_tool_type(tool_type: Option<&str>) -> bool {
    matches!(
        tool_type,
        Some(value)
            if value.starts_with("web_search_")
                || value.starts_with("web_fetch_")
                || value.starts_with("computer_")
                || value.starts_with("bash_")
                || value.starts_with("text_editor_")
                || value.starts_with("code_execution_")
                || value.starts_with("tool_search_")
    )
}

fn default_schema() -> Value {
    serde_json::json!({"type": "object", "properties": {}})
}

#[derive(Clone, Debug, Serialize)]
pub struct MessageResponse {
    pub id: String,
    pub r#type: &'static str,
    pub role: &'static str,
    pub model: String,
    pub content: Vec<ContentBlock>,
    pub stop_reason: StopReason,
    pub stop_sequence: Option<String>,
    pub usage: Usage,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    ToolUse,
    MaxTokens,
    StopSequence,
    PauseTurn,
    Refusal,
    ModelContextWindowExceeded,
    Unknown,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub cache_read_input_tokens: u64,
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub cache_creation_input_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_creation: Option<CacheCreation>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct CacheCreation {
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub ephemeral_5m_input_tokens: u64,
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub ephemeral_1h_input_tokens: u64,
}

fn is_zero_u64(value: &u64) -> bool {
    *value == 0
}

#[derive(Clone, Debug, Deserialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub tools: Vec<ChatTool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<Value>,
    #[serde(default = "default_chat_max_tokens")]
    pub max_tokens: u32,
    #[serde(default)]
    pub stream: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ChatTool {
    #[allow(dead_code)]
    pub r#type: String,
    pub function: ChatFunction,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ChatFunction {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub parameters: Value,
}

#[derive(Clone, Debug, Serialize)]
pub struct ChatResponse {
    pub id: String,
    pub object: &'static str,
    pub model: String,
    pub choices: Vec<ChatChoice>,
    pub usage: ChatUsage,
}

#[derive(Clone, Debug, Serialize)]
pub struct ChatChoice {
    pub index: u32,
    pub message: ChatAssistantMessage,
    pub finish_reason: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ChatAssistantMessage {
    pub role: &'static str,
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ChatToolCall>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ChatToolCall {
    pub id: String,
    #[serde(default = "function_type")]
    pub r#type: String,
    pub function: ChatToolCallFunction,
}

fn function_type() -> String {
    "function".into()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ChatToolCallFunction {
    pub name: String,
    pub arguments: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ChatUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

fn default_chat_max_tokens() -> u32 {
    1024
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl From<ChatRequest> for MessageRequest {
    fn from(value: ChatRequest) -> Self {
        let tools = value
            .tools
            .into_iter()
            .map(|tool| ToolDefinition {
                name: tool.function.name,
                description: tool.function.description,
                input_schema: tool.function.parameters,
                cache_control: None,
                tool_type: None,
                extra: Map::new(),
            })
            .collect();

        let mut request = Self {
            model: value.model,
            messages: value.messages,
            tools,
            tool_choice: value.tool_choice,
            max_tokens: value.max_tokens,
            stream: value.stream,
            temperature: value.temperature,
            ..Self::default()
        };
        request.normalize_openai_tools();
        request
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_content_blocks_survive_roundtrip() {
        let raw = serde_json::json!({
            "model": "claude-opus-5-5",
            "max_tokens": 64,
            "messages": [{
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "signed", "signature": "sig"},
                    {"type": "tool_search_tool_result", "tool_use_id": "toolu_1", "content": {"items": [1, 2]}},
                    {"type": "text", "text": "answer"}
                ]
            }]
        });
        let parsed: MessageRequest = serde_json::from_value(raw).unwrap();
        let out = serde_json::to_value(parsed).unwrap();
        assert_eq!(
            out["messages"][0]["content"][1]["type"],
            "tool_search_tool_result"
        );
        assert_eq!(
            out["messages"][0]["content"][1]["content"]["items"],
            serde_json::json!([1, 2])
        );
    }

    #[test]
    fn known_content_extensions_survive_history_roundtrip() {
        let blocks = serde_json::json!([
            {"type":"text","text":"answer","citations":[{"type":"char_location","start_char_index":0}]},
            {"type":"image","source":{"type":"url","url":"https://example.test/a.png"},"cache_control":{"type":"ephemeral","ttl":"1h"}},
            {"type":"thinking","thinking":"","signature":"signed","block_binding":"binding"},
            {"type":"redacted_thinking","data":"encrypted","signature":"signed","block_binding":"binding"},
            {"type":"tool_use","id":"t1","name":"echo","input":{},"caller":{"type":"direct"}},
            {"type":"tool_result","tool_use_id":"t1","content":"ok","extension":{"nested":true}},
            {"type":"document","source":{"type":"text","data":"document"},"citations":{"enabled":true}},
            {"type":"server_tool_use","id":"s1","name":"search","input":{},"caller":{"type":"direct"}},
            {"type":"web_search_tool_result","tool_use_id":"s1","content":[],"extension":true}
        ]);
        let request: MessageRequest = serde_json::from_value(serde_json::json!({
            "model":"claude-opus-5-5","max_tokens":64,
            "messages":[{"role":"assistant","content":blocks.clone()}]
        }))
        .unwrap();
        let out = serde_json::to_value(request).unwrap();
        assert_eq!(out["messages"][0]["content"], blocks);
    }

    #[test]
    fn official_messages_body_roundtrip() {
        let raw = serde_json::json!({
            "model": "claude-sonnet-5",
            "max_tokens": 256,
            "stream": true,
            "temperature": 0.2,
            "top_p": 0.9,
            "top_k": 20,
            "stop_sequences": ["END"],
            "system": [
                {"type": "text", "text": "You are helpful.", "cache_control": {"type": "ephemeral"}}
            ],
            "thinking": {"type": "enabled", "budget_tokens": 2048},
            "tool_choice": {"type": "auto"},
            "metadata": {"user_id": "u1"},
            "service_tier": "auto",
            "tools": [{
                "name": "get_weather",
                "description": "weather",
                "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}}
            }],
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": "what is this?"},
                    {"type": "image", "source": {"type": "url", "url": "https://example.com/a.png"}}
                ]
            }]
        });
        let parsed: MessageRequest = serde_json::from_value(raw).unwrap();
        assert_eq!(parsed.model, "claude-sonnet-5");
        assert!(parsed.stream);
        assert_eq!(parsed.tools[0].name, "get_weather");
        assert!(parsed.system.is_some());
        assert!(parsed.thinking.is_some());
        assert_eq!(parsed.extra.get("service_tier").unwrap(), "auto");
        match &parsed.messages[0].content {
            MessageContent::Blocks(blocks) => {
                assert!(matches!(blocks[0], ContentBlock::Text { .. }));
                assert!(matches!(blocks[1], ContentBlock::Image { .. }));
            }
            _ => panic!("blocks"),
        }
    }

    #[test]
    fn safeguards_survive_message_request_roundtrip() {
        let raw = serde_json::json!({
            "model": "claude-sonnet-4-6",
            "max_tokens": 64,
            "messages": [{"role": "user", "content": "hi"}],
            "safeguards": {"actions": [{"tool_use_id": "toolu_1"}]}
        });
        let parsed: MessageRequest = serde_json::from_value(raw).unwrap();
        let out = serde_json::to_value(parsed).unwrap();
        assert_eq!(out["safeguards"]["actions"][0]["tool_use_id"], "toolu_1");
    }

    #[test]
    fn message_output_config_survives_roundtrip() {
        let raw = serde_json::json!({
            "model": "claude-opus-5-5",
            "max_tokens": 64,
            "output_config": {"effort": "high"},
            "messages": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "ok"},
                {"role": "system", "content": [], "output_config": {"effort": "medium"}},
                {"role": "user", "content": "again"}
            ]
        });
        let parsed: MessageRequest = serde_json::from_value(raw).unwrap();
        assert_eq!(parsed.extra["output_config"]["effort"], "high");
        assert_eq!(
            parsed.messages[2].extra["output_config"]["effort"],
            "medium"
        );
        let out = serde_json::to_value(&parsed).unwrap();
        assert_eq!(out["output_config"]["effort"], "high");
        assert_eq!(out["messages"][2]["role"], "system");
        assert_eq!(out["messages"][2]["content"], serde_json::json!([]));
        assert_eq!(out["messages"][2]["output_config"]["effort"], "medium");
        assert_eq!(out["messages"][3]["role"], "user");
    }
    #[test]
    fn signed_thinking_history_survives_roundtrip() {
        let raw = serde_json::json!({
            "model": "claude-opus-5-5",
            "max_tokens": 64,
            "thinking": {"type": "adaptive"},
            "messages": [{
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "", "signature": "signed"},
                    {"type": "redacted_thinking", "data": "encrypted", "signature": "signed"},
                    {"type": "text", "text": "answer"}
                ]
            }]
        });
        let parsed: MessageRequest = serde_json::from_value(raw).unwrap();
        let out = serde_json::to_value(parsed).unwrap();
        let blocks = &out["messages"][0]["content"];
        assert_eq!(blocks[0]["thinking"], "");
        assert_eq!(blocks[0]["signature"], "signed");
        assert_eq!(blocks[1]["type"], "redacted_thinking");
        assert_eq!(blocks[1]["data"], "encrypted");
        assert_eq!(blocks[1]["signature"], "signed");
        assert!(blocks[1].get("cache_control").is_none());
        let signature_only = serde_json::json!({
            "model": "claude-opus-5-5",
            "max_tokens": 64,
            "messages": [{
                "role": "assistant",
                "content": [{"type": "redacted_thinking", "signature": "sig_real_1234567890abcdef"}]
            }]
        });
        let kept: MessageRequest = serde_json::from_value(signature_only).unwrap();
        let exact = serde_json::to_value(kept).unwrap();
        assert!(exact["messages"][0]["content"][0].get("data").is_none());
        assert_eq!(
            exact["messages"][0]["content"][0]["signature"],
            "sig_real_1234567890abcdef"
        );
    }

    #[test]
    fn server_tool_omits_default_input_schema() {
        let request: MessageRequest = serde_json::from_value(serde_json::json!({
            "model": "claude-sonnet-5",
            "max_tokens": 1024,
            "tools": [{"type": "web_search_20250305", "name": "web_search"}],
            "messages": [{"role": "user", "content": "search"}]
        }))
        .unwrap();

        let serialized = serde_json::to_value(request).unwrap();
        let tool = &serialized["tools"][0];
        assert_eq!(tool["type"], "web_search_20250305");
        assert_eq!(tool["name"], "web_search");
        assert!(tool.get("input_schema").is_none());
    }

    #[test]
    fn openai_tool_role_normalizes() {
        let raw = serde_json::json!({
            "model": "claude-sonnet-5",
            "messages": [
                {"role": "assistant", "content": null, "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "echo", "arguments": "{\"ok\":true}"}
                }]},
                {"role": "tool", "tool_call_id": "call_1", "content": "pong"}
            ]
        });
        let chat: ChatRequest = serde_json::from_value(raw).unwrap();
        let req = MessageRequest::from(chat);
        match &req.messages[1].content {
            MessageContent::Blocks(blocks) => match &blocks[0] {
                ContentBlock::ToolResult { tool_use_id, .. } => {
                    assert_eq!(tool_use_id, "call_1")
                }
                _ => panic!("tool_result"),
            },
            _ => panic!("blocks"),
        }
    }
}
