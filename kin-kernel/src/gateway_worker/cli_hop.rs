use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::body::Body;
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use bytes::Bytes as RawBytes;
use http_body::Frame;
use http_body_util::StreamBody;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::config::WorkerConfig;
use super::error::WorkerError;
use super::sse::PumpResult;
use crate::error::KernelError;
use crate::model::MessageRequest;
use crate::provider::multiplex_cli::{MultiplexCliProvider, MultiplexConfig, RecoveryConfig};
use crate::provider::{self, ExecutionContext, Provider, StreamRx};
use crate::stream::StreamItem;

fn set_env(key: &str, value: &str) {
    unsafe { std::env::set_var(key, value) };
}

pub fn provider_from_config(config: &WorkerConfig, config_path: &Path) -> MultiplexCliProvider {
    let submit_wait = std::env::var("SUBMIT_WAIT_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(2_000);
    if !config.https_proxy.trim().is_empty() {
        set_env("HTTPS_PROXY", config.https_proxy.trim());
        set_env("https_proxy", config.https_proxy.trim());
    }
    if !config.system_layout.trim().is_empty() {
        set_env("CLAUDE_CODE_SYSTEM_LAYOUT", config.system_layout.trim());
    }
    if !config.timezone.trim().is_empty() {
        set_env("TZ", config.timezone.trim());
        set_env("CLAUDE_CODE_TIMEZONE", config.timezone.trim());
    }
    let cli_version = config.cli_version.trim();
    set_env(
        "CLAUDE_CODE_VERSION",
        if cli_version.is_empty() {
            "2.1.296"
        } else {
            cli_version
        },
    );
    set_env("CLAUDE_CODE_GATEWAY_HINT_HEADERS", "1");
    let session_dir = PathBuf::from(&config.credential_path)
        .parent()
        .map(PathBuf::from);
    MultiplexCliProvider::from_cfg(MultiplexConfig {
        slot_count: (config.slots_per_worker as usize).clamp(1, 20),
        simulate: false,
        bin: PathBuf::from(&config.claude_bin),
        mock_bin: false,
        model: "claude-sonnet-5-5".into(),
        session_idle_ttl: Duration::from_secs(config.session_idle_ttl_seconds as u64),
        panel_config_path: Some(config_path.to_path_buf()),
        simulate_latency: Duration::from_millis(40),
        continuation_ttl_secs: 600,
        client_stall_timeout: Duration::from_secs(crate::config::DEFAULT_CLIENT_STALL_SECS),
        job_idle_timeout: crate::config::job_idle_timeout_from_env()
            .unwrap_or(Duration::from_secs(crate::config::DEFAULT_JOB_IDLE_SECS)),
        cancel_ack_timeout: crate::config::cancel_ack_timeout_from_env()
            .unwrap_or(Duration::from_secs(crate::config::DEFAULT_CANCEL_ACK_SECS)),
        submit_wait: Duration::from_millis(submit_wait),
        desired_config_hash: None,
        session_dir,
        recovery: RecoveryConfig::default(),
    })
}

pub fn take_auto_compact_window(body: &mut Value) -> Option<u32> {
    let value = body.as_object_mut()?.remove("auto_compact_window")?;
    let tokens = value.as_u64()?;
    (100_000..=1_000_000)
        .contains(&tokens)
        .then_some(tokens as u32)
}

pub fn parse_request(
    mut body: Value,
    _request_cache_ttl: Option<&str>,
    _default_cache_ttl: &str,
    _preserve_cache_breakpoints: bool,
) -> Result<MessageRequest, WorkerError> {
    if let Some(obj) = body.as_object_mut() {
        obj.entry("max_tokens").or_insert(json!(128000));
        obj.insert("stream".into(), json!(true));
    }
    // Claude Code owns cache marker placement and TTL normalization. Keep
    // explicit caller markers byte-for-byte intact while forwarding the body.

    serde_json::from_value(body).map_err(|err| {
        WorkerError::new(StatusCode::BAD_REQUEST, "invalid_request", err.to_string())
    })
}
/// Slot sticky key and the session the CLI forwards upstream.
///
/// Node writes the stable conversation id on `metadata.user_id` before the hop.
/// Envelope headers are only a fallback: `x-claude-code-session-id`, then the
/// older sticky header names. A fresh UUID is used only when none of those exist.
pub fn resolve_hop_session(metadata: Option<&Value>, headers: &HashMap<String, String>) -> String {
    session_from_metadata(metadata)
        .or_else(|| header_value(headers, "x-claude-code-session-id"))
        .or_else(|| header_value(headers, "x-session-id"))
        .or_else(|| header_value(headers, "x-conversation-id"))
        .unwrap_or_else(|| Uuid::new_v4().to_string())
}

pub fn context_from_headers(
    config: &WorkerConfig,
    headers: &HashMap<String, String>,
    metadata: Option<&Value>,
    request_id: &str,
) -> ExecutionContext {
    ExecutionContext {
        tenant_id: config.vm_id.clone(),
        session_id: resolve_hop_session(metadata, headers),
        worker_id: config.vm_id.clone(),
        worker_generation: 1,
        resumed: false,
        request_id: request_id.trim().to_string(),
        request_context: None,
        auto_compact_window: None,
    }
}

/// Fill `metadata.user_id.session_id` when the body has none, so the CLI cache
/// key matches the slot sticky id. An existing session is left unchanged.
pub fn align_request_session(request: &mut MessageRequest, session_id: &str) {
    let session_id = session_id.trim();
    if session_id.is_empty() || session_from_metadata(request.metadata.as_ref()).is_some() {
        return;
    }
    let metadata = request
        .metadata
        .get_or_insert_with(|| Value::Object(serde_json::Map::new()));
    let Some(obj) = metadata.as_object_mut() else {
        return;
    };
    match obj.get("user_id").cloned() {
        Some(Value::Object(mut user)) => {
            if session_field(user.get("session_id")).is_none() {
                user.insert(
                    "session_id".to_string(),
                    Value::String(session_id.to_string()),
                );
                obj.insert("user_id".to_string(), Value::Object(user));
            }
        }
        Some(Value::String(raw)) => {
            if session_from_user_id_str(&raw).is_some() {
                return;
            }
            if let Ok(Value::Object(mut user)) = serde_json::from_str::<Value>(&raw) {
                if session_field(user.get("session_id")).is_none() {
                    user.insert(
                        "session_id".to_string(),
                        Value::String(session_id.to_string()),
                    );
                    if let Ok(encoded) = serde_json::to_string(&Value::Object(user)) {
                        obj.insert("user_id".to_string(), Value::String(encoded));
                    }
                }
            } else if raw.trim().is_empty() {
                obj.insert(
                    "user_id".to_string(),
                    Value::String(format_user_id("", "", session_id)),
                );
            }
        }
        _ => {
            obj.insert(
                "user_id".to_string(),
                Value::String(format_user_id("", "", session_id)),
            );
        }
    }
}

fn session_from_metadata(metadata: Option<&Value>) -> Option<String> {
    let user_id = metadata?.as_object()?.get("user_id")?;
    match user_id {
        Value::Object(user) => session_field(user.get("session_id")),
        Value::String(raw) => session_from_user_id_str(raw),
        _ => None,
    }
}

fn session_from_user_id_str(raw: &str) -> Option<String> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    if let Ok(Value::Object(user)) = serde_json::from_str::<Value>(text) {
        return session_field(user.get("session_id"));
    }
    let rest = text.strip_prefix("user_")?;
    let marker = "_account_";
    let account_at = rest.find(marker)?;
    let after_account = &rest[account_at + marker.len()..];
    let session_marker = "_session_";
    let session_at = after_account.find(session_marker)?;
    let session = after_account[session_at + session_marker.len()..].trim();
    if session.is_empty() {
        None
    } else {
        Some(session.to_string())
    }
}

fn session_field(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

fn format_user_id(device_id: &str, account_uuid: &str, session_id: &str) -> String {
    serde_json::json!({
        "device_id": device_id,
        "account_uuid": account_uuid,
        "session_id": session_id,
    })
    .to_string()
}

fn header_value(headers: &HashMap<String, String>, name: &str) -> Option<String> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub async fn dispatch(
    provider: &MultiplexCliProvider,
    request: MessageRequest,
    context: ExecutionContext,
    stream: bool,
    delivery: &str,
    shutdown: CancellationToken,
) -> Result<Response, WorkerError> {
    let rx = provider
        .execute_stream(&request, &context)
        .await
        .map_err(map_kernel)?;
    if !stream {
        let response = provider::collect_stream(rx).await.map_err(map_kernel)?;
        let body = serde_json::to_vec(&response).map_err(|err| {
            WorkerError::new(StatusCode::INTERNAL_SERVER_ERROR, "encode", err.to_string())
        })?;
        let mut headers = HeaderMap::new();
        headers.insert(
            HeaderName::from_static("content-type"),
            HeaderValue::from_static("application/json"),
        );
        headers.insert(
            HeaderName::from_static("x-terminal-state"),
            HeaderValue::from_static("verified"),
        );
        return Ok((StatusCode::OK, headers, body).into_response());
    }
    if delivery == "verified" {
        return verified_cli(rx, shutdown).await;
    }
    Ok(realtime_cli(rx, shutdown))
}

async fn verified_cli(
    mut rx: StreamRx,
    shutdown: CancellationToken,
) -> Result<Response, WorkerError> {
    let mut body = Vec::new();
    let mut result = PumpResult::default();
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => {
                return Err(WorkerError::new(
                    StatusCode::BAD_GATEWAY,
                    "upstream_terminal_invalid",
                    "shutdown",
                ));
            }
            item = rx.recv() => {
                let Some(item) = item else { break; };
                match item.map_err(map_kernel)? {
                    StreamItem::Event(event) => {
                        let frame = sse_frame(&event);
                        result.event_count += 1;
                        if let Some(model) = event
                            .get("message")
                            .and_then(|m| m.get("model"))
                            .and_then(Value::as_str)
                        {
                            result.model = model.to_string();
                        }
                        body.extend_from_slice(&frame);
                    }
                    StreamItem::Finished(_) => break,
                }
            }
        }
    }
    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("content-type"),
        HeaderValue::from_static("text/event-stream"),
    );
    headers.insert(
        HeaderName::from_static("x-terminal-state"),
        HeaderValue::from_static("verified"),
    );
    insert_event_count(&mut headers, result.event_count, &result.model);
    Ok((StatusCode::OK, headers, body).into_response())
}

fn terminal_trailer_state(saw_stop: bool) -> &'static str {
    if saw_stop { "verified" } else { "incomplete" }
}

fn realtime_cli(mut rx: StreamRx, shutdown: CancellationToken) -> Response {
    let (tx, rx_out) = mpsc::channel::<Result<Frame<RawBytes>, std::io::Error>>(16);
    tokio::spawn(async move {
        let mut saw_stop = false;
        let mut error_code = None;
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => break,
                // Downstream HTTP body dropped while the CLI is silent. Leaving
                // this task drops `rx`, which is the provider client channel.
                // job_egress treats that close as ClientGone and cancels the job
                // through the existing cancel / CancelAck path.
                _ = tx.closed() => break,
                item = rx.recv() => {
                    let Some(item) = item else { break; };
                    match item {
                        Ok(StreamItem::Event(event)) => {
                            if event.get("type").and_then(Value::as_str) == Some("message_stop") {
                                saw_stop = true;
                            }
                            let frame = sse_frame(&event);
                            if tx.send(Ok(Frame::data(RawBytes::from(frame)))).await.is_err() {
                                break;
                            }
                        }
                        Ok(StreamItem::Finished(_)) => break,
                        Err(err) => {
                            error_code = Some(match &err {
                                KernelError::Job(failure) => failure.code,
                                _ => "kernel_error",
                            });
                            let _ = tx
                                .send(Ok(Frame::data(RawBytes::from(error_event(&err)))))
                                .await;
                            break;
                        }
                    }
                }
            }
        }
        let mut trailers = HeaderMap::new();
        let _ = trailers.insert(
            HeaderName::from_static("x-terminal-state"),
            HeaderValue::from_static(terminal_trailer_state(saw_stop)),
        );
        if let Some(code) = error_code {
            trailers.insert(
                HeaderName::from_static("x-error-code"),
                HeaderValue::from_static(code),
            );
        }
        let _ = tx.send(Ok(Frame::trailers(trailers))).await;
    });
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    headers.insert(
        HeaderName::from_static("trailer"),
        HeaderValue::from_static(
            "X-Terminal-State, X-Error-Code, X-Event-Count, X-Usage, X-Model, X-Stop-Reason",
        ),
    );
    let stream = futures_util::stream::unfold(rx_out, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    });
    let body = Body::new(StreamBody::new(stream));
    (StatusCode::OK, headers, body).into_response()
}

fn sse_frame(event: &Value) -> Vec<u8> {
    let name = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("message");
    format!("event: {name}\ndata: {event}\n\n").into_bytes()
}

/// Terminal `error` event. `code` / `status` tell Node the real cause; without
/// them every failed hop used to read as an empty `incomplete_response`.
fn error_event(err: &KernelError) -> Vec<u8> {
    let payload = match err {
        KernelError::Job(failure) => json!({
            "type": "error",
            "error": {
                "type": failure.error_type,
                "code": failure.code,
                "message": failure.message,
                "status": failure.status,
                "retry_after": failure.retry_after,
                "upstream_code": failure.upstream_code,
                "request_id": failure.request_id,
            }
        }),
        other => json!({
            "type": "error",
            "error": {
                "type": "api_error",
                "code": "kernel_error",
                "message": other.to_string(),
                "status": 502,
            }
        }),
    };
    format!("event: error\ndata: {payload}\n\n").into_bytes()
}

fn map_kernel(err: KernelError) -> WorkerError {
    match err {
        KernelError::NoCapacity => WorkerError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "no_capacity",
            err.to_string(),
        ),
        KernelError::Overloaded { retry_after } => {
            let mut error = WorkerError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "overloaded",
                "runtime overloaded",
            );
            error.retry_after = retry_after;
            error
        }
        KernelError::BodyDoesNotFit => WorkerError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "invalid_request",
            err.to_string(),
        ),
        KernelError::InvalidRequest(_) => {
            WorkerError::new(StatusCode::BAD_REQUEST, "invalid_request", err.to_string())
        }
        KernelError::ProviderRateLimited { .. } => WorkerError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "provider_rate_limited",
            err.to_string(),
        ),
        KernelError::Job(failure) => {
            let mut error = WorkerError::new(
                StatusCode::from_u16(failure.status).unwrap_or(StatusCode::BAD_GATEWAY),
                failure.code,
                failure.message,
            );
            error.error_type = failure.error_type;
            error.retry_after = failure.retry_after;
            error.upstream_code = failure.upstream_code;
            error.request_id = failure.request_id;
            error
        }
        other => WorkerError::new(StatusCode::BAD_GATEWAY, "provider_error", other.to_string()),
    }
}

fn insert_event_count(headers: &mut HeaderMap, count: i64, model: &str) {
    let _ = headers.insert(
        HeaderName::from_static("x-event-count"),
        HeaderValue::from_str(&count.to_string()).unwrap_or(HeaderValue::from_static("0")),
    );
    if !model.is_empty()
        && let Ok(value) = HeaderValue::from_str(model)
    {
        headers.insert(HeaderName::from_static("x-model"), value);
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::model::{ContentBlock, MessageContent};

    fn tail_ttl(request: &MessageRequest) -> &str {
        let MessageContent::Blocks(blocks) = &request.messages.last().unwrap().content else {
            panic!("blocks");
        };
        let ContentBlock::Text { cache_control, .. } = blocks.last().unwrap() else {
            panic!("text");
        };
        cache_control.as_ref().unwrap()["ttl"].as_str().unwrap()
    }

    #[test]
    fn terminal_trailer_is_verified_only_after_message_stop() {
        assert_eq!(terminal_trailer_state(true), "verified");
        assert_eq!(terminal_trailer_state(false), "incomplete");
    }

    fn last_cache(request: &MessageRequest) -> Option<&Value> {
        let last = request.messages.last()?;
        let MessageContent::Blocks(blocks) = &last.content else {
            return None;
        };
        let ContentBlock::Text { cache_control, .. } = blocks.last()? else {
            return None;
        };
        cache_control.as_ref()
    }

    #[test]
    fn kernel_does_not_stamp_message_breakpoints() {
        let request = parse_request(
            json!({"model":"claude-sonnet-5","messages":[{"role":"user","content":"hi"}]}),
            Some("5m"),
            "1h",
            false,
        )
        .unwrap();
        match &request.messages[0].content {
            MessageContent::Text(text) => assert_eq!(text, "hi"),
            MessageContent::Blocks(blocks) => match &blocks[0] {
                ContentBlock::Text { cache_control, .. } => assert!(cache_control.is_none()),
                _ => panic!("text"),
            },
        }
        assert!(last_cache(&request).is_none());
    }

    #[test]
    fn kernel_keeps_node_message_markers() {
        let request = parse_request(
            json!({
                "model":"claude-sonnet-5",
                "messages":[
                    {"role":"user","content":[{"type":"text","text":"u1","cache_control":{"type":"ephemeral","ttl":"1h"}}]},
                    {"role":"assistant","content":[{"type":"text","text":"a1"}]},
                    {"role":"user","content":[{"type":"text","text":"u2"}]},
                    {"role":"assistant","content":[{"type":"text","text":"a2","cache_control":{"type":"ephemeral","ttl":"1h"}}]}
                ]
            }),
            Some("5m"),
            "5m",
            true,
        )
        .unwrap();
        match &request.messages[0].content {
            MessageContent::Blocks(blocks) => match &blocks[0] {
                ContentBlock::Text { cache_control, .. } => {
                    assert_eq!(cache_control.as_ref().unwrap()["ttl"], "1h");
                }
                _ => panic!("text"),
            },
            _ => panic!("blocks"),
        }
        match &request.messages[3].content {
            MessageContent::Blocks(blocks) => match &blocks[0] {
                ContentBlock::Text { cache_control, .. } => {
                    assert_eq!(cache_control.as_ref().unwrap()["ttl"], "1h");
                }
                _ => panic!("text"),
            },
            _ => panic!("blocks"),
        }
        match &request.messages[1].content {
            MessageContent::Blocks(blocks) => match &blocks[0] {
                ContentBlock::Text { cache_control, .. } => assert!(cache_control.is_none()),
                _ => panic!("text"),
            },
            _ => panic!("blocks"),
        }
    }

    #[test]
    fn invalid_request_cache_ttl_is_ignored() {
        let request = parse_request(
            json!({"model":"claude-sonnet-5","messages":[{"role":"user","content":"hi"}]}),
            Some("forever"),
            "1h",
            false,
        )
        .unwrap();
        assert_eq!(request.model, "claude-sonnet-5");
        assert!(last_cache(&request).is_none());
    }

    #[test]
    fn official_request_preserves_explicit_breakpoint_order_and_ttl() {
        let request = parse_request(
            json!({
                "model":"claude-sonnet-5",
                "tools":[{"name":"Read","cache_control":{"type":"ephemeral","ttl":"5m"}}],
                "messages":[{"role":"user","content":[{
                    "type":"text",
                    "text":"hi",
                    "cache_control":{"type":"ephemeral","ttl":"1h"}
                }]}]
            }),
            None,
            "1h",
            true,
        )
        .unwrap();
        assert_eq!(tail_ttl(&request), "1h");
        assert_eq!(request.tools.len(), 1);
        assert_eq!(
            request.tools[0].cache_control.as_ref().unwrap()["ttl"],
            "5m"
        );
    }

    #[test]
    fn official_request_preserves_client_cache_breakpoints() {
        let request = parse_request(
            json!({
                "model":"claude-sonnet-5",
                "messages":[{"role":"user","content":[{
                    "type":"text",
                    "text":"hi",
                    "cache_control":{"type":"ephemeral","ttl":"1h"}
                }]}]
            }),
            None,
            "5m",
            true,
        )
        .unwrap();
        assert_eq!(tail_ttl(&request), "1h");
    }

    fn headers(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn hop_session_prefers_metadata_user_id_over_headers() {
        let metadata = json!({
            "user_id": {
                "device_id": "dev",
                "account_uuid": "acc",
                "session_id": "sess-body"
            }
        });
        let resolved = resolve_hop_session(
            Some(&metadata),
            &headers(&[
                ("x-claude-code-session-id", "sess-header"),
                ("x-session-id", "sess-sticky"),
            ]),
        );
        assert_eq!(resolved, "sess-body");
    }

    #[test]
    fn hop_session_reads_json_and_legacy_user_id_strings() {
        let json_id = json!({
            "user_id": "{\"device_id\":\"dev\",\"account_uuid\":\"acc\",\"session_id\":\"sess-json\"}"
        });
        assert_eq!(
            resolve_hop_session(Some(&json_id), &HashMap::new()),
            "sess-json"
        );
        let legacy = json!({
            "user_id": "user_dev_account_acc_session_sess-legacy"
        });
        assert_eq!(
            resolve_hop_session(Some(&legacy), &HashMap::new()),
            "sess-legacy"
        );
    }

    #[test]
    fn hop_session_falls_back_to_claude_code_header_then_sticky_headers() {
        assert_eq!(
            resolve_hop_session(None, &headers(&[("X-Claude-Code-Session-Id", "sess-cc")])),
            "sess-cc"
        );
        assert_eq!(
            resolve_hop_session(None, &headers(&[("x-session-id", "sess-x")])),
            "sess-x"
        );
        assert_eq!(
            resolve_hop_session(None, &headers(&[("x-conversation-id", "conv-1")])),
            "conv-1"
        );
    }

    #[test]
    fn align_request_session_fills_missing_id_and_keeps_existing() {
        let mut request = parse_request(
            json!({"model":"claude-sonnet-5","messages":[{"role":"user","content":"hi"}]}),
            Some("5m"),
            "5m",
            true,
        )
        .unwrap();
        align_request_session(&mut request, "sess-new");
        let user_id = request.metadata.as_ref().unwrap()["user_id"]
            .as_str()
            .unwrap();
        assert!(user_id.contains("sess-new"));

        let mut kept = parse_request(
            json!({
                "model":"claude-sonnet-5",
                "metadata":{"user_id":"{\"device_id\":\"dev\",\"account_uuid\":\"acc\",\"session_id\":\"sess-keep\"}"},
                "messages":[{"role":"user","content":"hi"}]
            }),
            Some("5m"),
            "5m",
            true,
        )
        .unwrap();
        align_request_session(&mut kept, "sess-other");
        assert_eq!(
            kept.metadata.as_ref().unwrap()["user_id"].as_str().unwrap(),
            "{\"device_id\":\"dev\",\"account_uuid\":\"acc\",\"session_id\":\"sess-keep\"}"
        );
    }
}
