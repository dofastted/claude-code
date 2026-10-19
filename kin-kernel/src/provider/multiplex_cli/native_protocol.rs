//! stdin/stdout frames for the `*` protocol (v2), used by both
//! `execution_mode=native_slot` (`NativeAgent`) and `native_messages`
//! (`NativeMessages`).
//!
//! Rust never constructs billing/identity. CLI emits Anthropic SSE inside
//! `stream_event.event` and tags job_id/slot_id explicitly. There is no
//! `hello` handshake and no in-CLI tool parking (`tool_result`,
//! `job_parked`) — those were protocol v1 relics.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 2;
pub const CAPABILITIES: &[&str] = &["multi_slot", "native_sse", "stateless"];
/// Optional capability: the CLI answers `ping` from its stdin loop and
/// acks every `cancel`. Only such a host is probed for liveness.
pub const CAP_PING: &str = "ping";
pub const CAP_CLASSIFIER: &str = "classifier_request_context";

/// Hard caps on CLI stdout: a single line longer than this is dropped, and a
/// job whose cumulative stdout exceeds `MAX_JOB_BYTES` stops being decoded so
/// one runaway job cannot starve the others sharing the CLI process.
pub const MAX_LINE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_JOB_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum StdinFrame {
    #[serde(rename = "job_start")]
    JobStart {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_context: Option<crate::provider::ClassifierRequestContext>,
        job_id: String,
        slot_id: String,
        request: Value,
    },
    #[serde(rename = "cancel")]
    Cancel {
        job_id: String,
        #[serde(default)]
        slot_id: Option<String>,
    },
    #[serde(rename = "ping")]
    Ping { nonce: String },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum StdoutFrame {
    #[serde(rename = "host_ready")]
    HostReady {
        protocol_version: u32,
        slots: usize,
        system_layout: String,
        timezone: String,
        #[serde(default)]
        capabilities: Vec<String>,
        #[serde(default)]
        config_hash: Option<String>,
    },
    #[serde(rename = "slot_ready")]
    SlotReady { slot_id: String },
    #[serde(rename = "stream_event")]
    StreamEvent {
        job_id: String,
        slot_id: String,
        event: Value,
    },
    #[serde(rename = "job_done")]
    JobDone {
        job_id: String,
        slot_id: String,
        stop_reason: String,
        #[serde(default)]
        usage: Value,
    },
    #[serde(rename = "job_error")]
    JobError {
        job_id: String,
        #[serde(default)]
        slot_id: Option<String>,
        error: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<u16>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_type: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retry_after: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        upstream_code: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
    #[serde(rename = "cancel_ack")]
    CancelAck { job_id: String, slot_id: String },
    #[serde(rename = "pong")]
    Pong { nonce: String },
}

pub fn encode_stdin(frame: &StdinFrame) -> Result<Vec<u8>, String> {
    let mut line = serde_json::to_vec(frame).map_err(|err| err.to_string())?;
    line.push(b'\n');
    Ok(line)
}

#[cfg(test)]
pub fn decode_stdout_line(line: &str) -> Option<StdoutFrame> {
    serde_json::from_str(line).ok()
}

pub fn decode_stdout_value(frame: &Value) -> Option<StdoutFrame> {
    serde_json::from_value(frame.clone()).ok()
}

pub fn slot_id(index: usize) -> String {
    format!("s{index:02}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn roundtrip_job_start() {
        let frame = StdinFrame::JobStart {
            request_context: None,
            job_id: "job-1".into(),
            slot_id: "s00".into(),
            request: json!({"model":"claude-sonnet-5","messages":[]}),
        };
        let raw = String::from_utf8(encode_stdin(&frame).unwrap()).unwrap();
        let parsed: StdinFrame = serde_json::from_str(raw.trim()).unwrap();
        assert_eq!(parsed, frame);
    }

    #[test]
    fn stream_event_carries_ids() {
        let line = r#"{"type":"stream_event","job_id":"j1","slot_id":"s03","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}}"#;
        let parsed = decode_stdout_line(line).unwrap();
        match parsed {
            StdoutFrame::StreamEvent {
                job_id,
                slot_id,
                event,
            } => {
                assert_eq!(job_id, "j1");
                assert_eq!(slot_id, "s03");
                assert_eq!(event["delta"]["text"], "Hi");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn host_ready_handshake() {
        let line = r#"{"type":"host_ready","protocol_version":2,"slots":2,"system_layout":"zero","timezone":"America/New_York","capabilities":["multi_slot","native_sse","stateless"],"config_hash":"abc123"}"#;
        let parsed = decode_stdout_line(line).unwrap();
        match parsed {
            StdoutFrame::HostReady {
                protocol_version,
                slots,
                capabilities,
                config_hash,
                ..
            } => {
                assert_eq!(protocol_version, 2);
                assert_eq!(slots, 2);
                assert!(capabilities.iter().any(|c| c == "stateless"));
                assert_eq!(config_hash.as_deref(), Some("abc123"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn host_ready_without_config_hash() {
        let line = r#"{"type":"host_ready","protocol_version":2,"slots":1,"system_layout":"zero","timezone":"UTC","capabilities":["multi_slot"]}"#;
        let parsed = decode_stdout_line(line).unwrap();
        match parsed {
            StdoutFrame::HostReady { config_hash, .. } => assert!(config_hash.is_none()),
            other => panic!("{other:?}"),
        }
    }
}
