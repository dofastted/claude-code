use std::collections::HashMap;
use std::sync::{Arc, atomic::Ordering};
use std::time::Duration;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use tokio::sync::{OwnedSemaphorePermit, oneshot};
use uuid::Uuid;

use super::{Runtime, native_protocol};

pub const MAX_EVENT_BYTES: usize = 4096;
pub const MAX_PENDING_ACKS: usize = 64;
const ACK_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct SafeCode(String);

impl SafeCode {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for SafeCode {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let code = String::deserialize(deserializer)?;
        if code.is_empty()
            || code.len() > 64
            || !code.as_bytes()[0].is_ascii_lowercase()
            || !code
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        {
            return Err(serde::de::Error::custom("invalid safe code"));
        }
        Ok(Self(code))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum OAuthOperation {
    SessionKey,
    AuthorizationCode,
    Reauthorize,
    Refresh,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum OAuthPhase {
    Start,
    Success,
    Failure,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
enum SettingValue {
    Bool(bool),
    Number(f64),
    Enum(String),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum EventInput {
    Oauth {
        event_id: Uuid,
        attempt_id: Uuid,
        operation: OAuthOperation,
        phase: OAuthPhase,
        #[serde(skip_serializing_if = "Option::is_none")]
        error_code: Option<SafeCode>,
    },
    Setting {
        event_id: Uuid,
        setting: String,
        value: SettingValue,
    },
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(transparent)]
pub struct TelemetryEvent(EventInput);

impl TelemetryEvent {
    pub fn event_id(&self) -> Uuid {
        match &self.0 {
            EventInput::Oauth { event_id, .. } | EventInput::Setting { event_id, .. } => *event_id,
        }
    }
}

impl<'de> Deserialize<'de> for TelemetryEvent {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let input = EventInput::deserialize(deserializer)?;
        if let EventInput::Setting { setting, value, .. } = &input
            && !valid_setting(setting, value)
        {
            return Err(serde::de::Error::custom("invalid native setting or value"));
        }
        Ok(Self(input))
    }
}

fn valid_setting(setting: &str, value: &SettingValue) -> bool {
    match setting {
        "autoCompactEnabled"
        | "spinnerTipsEnabled"
        | "prefersReducedMotion"
        | "thinkingEnabled"
        | "fastMode"
        | "verbose"
        | "respectGitignore"
        | "useAutoModeDuringPlan"
        | "env.ANTHROPIC_API_KEY" => matches!(value, SettingValue::Bool(_)),
        "defaultPermissionMode" => {
            matches!(value, SettingValue::Enum(value) if matches!(value.as_str(), "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions" | "dontAsk"))
        }
        "defaultView" => {
            matches!(value, SettingValue::Enum(value) if matches!(value.as_str(), "default" | "transcript" | "chat"))
        }
        "theme" => {
            matches!(value, SettingValue::Enum(value) if matches!(value.as_str(), "dark" | "light" | "light-daltonized" | "dark-daltonized" | "light-ansi" | "dark-ansi" | "system"))
        }
        "editorMode" => {
            matches!(value, SettingValue::Enum(value) if matches!(value.as_str(), "emacs" | "vim"))
        }
        "autoUpdatesChannel" => {
            matches!(value, SettingValue::Enum(value) if matches!(value.as_str(), "latest" | "stable"))
        }
        _ => false,
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TelemetryPhase {
    Disabled,
    Idle,
    WaitingCredentials,
    WaitingEgress,
    Uploading,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TelemetryState {
    pub enabled: bool,
    pub state: TelemetryPhase,
    #[serde(deserialize_with = "pending_count")]
    pub pending_events: u16,
    #[serde(deserialize_with = "upload_time")]
    pub last_upload_at: Option<String>,
    pub last_error: Option<SafeCode>,
}

fn pending_count<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u16, D::Error> {
    let count = u16::deserialize(deserializer)?;
    if count > 1000 {
        return Err(serde::de::Error::custom("telemetry queue exceeds limit"));
    }
    Ok(count)
}

fn upload_time<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    let timestamp = Option::<String>::deserialize(deserializer)?;
    if timestamp.as_ref().is_some_and(|value| {
        value.is_empty()
            || value.len() > 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || b"-:T.Z+".contains(&byte))
    }) {
        return Err(serde::de::Error::custom("invalid upload timestamp"));
    }
    Ok(timestamp)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TelemetryError {
    Unsupported,
    Unavailable,
    Busy,
    AckTimeout,
    Rejected(Option<SafeCode>),
}

impl TelemetryError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unsupported => "telemetry_unsupported",
            Self::Unavailable => "telemetry_unavailable",
            Self::Busy => "telemetry_busy",
            Self::AckTimeout => "telemetry_ack_timeout",
            Self::Rejected(_) => "telemetry_rejected",
        }
    }
}

pub(super) struct PendingAck {
    generation: u64,
    sender: oneshot::Sender<Result<(), TelemetryError>>,
}

#[derive(Default)]
pub(super) struct TelemetryTracking {
    generation: u64,
    supported: bool,
    status: Option<TelemetryState>,
    pending: HashMap<Uuid, PendingAck>,
}

impl Runtime {
    pub(super) async fn clear_telemetry(&self) {
        let mut telemetry = self.telemetry.lock().await;
        telemetry.generation = self.host_gen.load(Ordering::Acquire);
        telemetry.supported = false;
        telemetry.status = None;
        telemetry.pending.clear();
    }

    pub(super) async fn telemetry_capability(&self, supported: bool) {
        let mut telemetry = self.telemetry.lock().await;
        if !self.host_unavailable() {
            telemetry.supported = supported;
        }
    }

    pub(super) async fn telemetry_ack(&self, request_id: Uuid, ok: bool, error: Option<SafeCode>) {
        let mut telemetry = self.telemetry.lock().await;
        if !telemetry.supported || self.host_unavailable() {
            return;
        }
        if let Some(pending) = telemetry.pending.remove(&request_id)
            && pending.generation == self.host_gen.load(Ordering::Acquire)
        {
            let result = if ok && error.is_none() {
                Ok(())
            } else {
                Err(TelemetryError::Rejected(error))
            };
            let _ = pending.sender.send(result);
        }
    }

    pub(super) async fn telemetry_state(&self, status: TelemetryState) {
        let mut telemetry = self.telemetry.lock().await;
        if telemetry.supported
            && !self.host_unavailable()
            && telemetry.generation == self.host_gen.load(Ordering::Acquire)
        {
            telemetry.status = Some(status);
        }
    }

    pub(super) async fn telemetry_health(&self) -> Value {
        let _gate = self.frame_gate.lock().await;
        let telemetry = self.telemetry.lock().await;
        let supported = telemetry.supported
            && !self.host_unavailable()
            && telemetry.generation == self.host_gen.load(Ordering::Acquire);
        let host = self.native_host.lock().await;
        json!({
            "vm_telemetry": supported,
            "telemetry_ready": supported && telemetry.status.is_some(),
            "telemetry": telemetry.status,
            "native_host": *host,
            "capabilities": host.as_ref().map(|info| &info.capabilities),
        })
    }

    pub(super) async fn queue_telemetry(
        self: &Arc<Self>,
        event: TelemetryEvent,
    ) -> Result<tokio::task::JoinHandle<Result<Uuid, TelemetryError>>, TelemetryError> {
        let permit = self
            .telemetry_submissions
            .clone()
            .try_acquire_owned()
            .map_err(|_| TelemetryError::Busy)?;
        let _gate = self.frame_gate.lock().await;
        if self.host_unavailable() {
            return Err(TelemetryError::Unavailable);
        }
        let generation = self.host_gen.load(Ordering::Acquire);
        let mut telemetry = self.telemetry.lock().await;
        if !telemetry.supported || telemetry.generation != generation {
            return Err(TelemetryError::Unsupported);
        }
        let request_id = loop {
            let candidate = Uuid::new_v4();
            if candidate != event.event_id() && !telemetry.pending.contains_key(&candidate) {
                break candidate;
            }
        };
        let (sender, receiver) = oneshot::channel();
        telemetry
            .pending
            .insert(request_id, PendingAck { generation, sender });
        let runtime = Arc::clone(self);
        Ok(tokio::spawn(async move {
            runtime
                .submit_telemetry(event, request_id, generation, receiver, permit)
                .await
        }))
    }

    async fn submit_telemetry(
        &self,
        event: TelemetryEvent,
        request_id: Uuid,
        generation: u64,
        receiver: oneshot::Receiver<Result<(), TelemetryError>>,
        _permit: OwnedSemaphorePermit,
    ) -> Result<Uuid, TelemetryError> {
        let frame = native_protocol::StdinFrame::TelemetryEvent { request_id, event };
        let result = if self
            .write_cli_stdin_for_generation(frame, Some(generation))
            .await
            .is_err()
        {
            Err(TelemetryError::Unavailable)
        } else {
            match tokio::time::timeout(ACK_TIMEOUT, receiver).await {
                Ok(Ok(result)) => result,
                Ok(Err(_)) => Err(TelemetryError::Unavailable),
                Err(_) => Err(TelemetryError::AckTimeout),
            }
        };
        let _gate = self.frame_gate.lock().await;
        self.telemetry.lock().await.pending.remove(&request_id);
        if self.host_gen.load(Ordering::Acquire) != generation || self.host_unavailable() {
            return Err(TelemetryError::Unavailable);
        }
        result.map(|()| request_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_identity_and_token_fields_before_forwarding() {
        let event = json!({"event_id": Uuid::new_v4(), "kind": "oauth", "attempt_id": Uuid::new_v4(),
            "operation": "refresh", "phase": "start"});
        for key in ["access_token", "device_id", "account_uuid", "environment"] {
            let mut extra = event.clone();
            extra[key] = json!("must_not_cross_ingress");
            assert!(
                serde_json::from_value::<TelemetryEvent>(extra).is_err(),
                "{key}"
            );
        }
    }

    #[test]
    fn permits_api_key_presence_only_not_its_value_or_arbitrary_environment() {
        let event = json!({"event_id": Uuid::new_v4(), "kind": "setting",
            "setting": "env.ANTHROPIC_API_KEY", "value": true});
        assert!(serde_json::from_value::<TelemetryEvent>(event.clone()).is_ok());
        let mut value = event.clone();
        value["value"] = json!(17);
        assert!(serde_json::from_value::<TelemetryEvent>(value).is_err());
        let mut unknown = event;
        unknown["setting"] = json!("env.PRIVATE_TOKEN");
        assert!(serde_json::from_value::<TelemetryEvent>(unknown).is_err());
    }

    #[test]
    fn refuses_free_text_errors_and_invalid_attempt_identifiers() {
        let event = json!({"event_id": Uuid::new_v4(), "kind": "oauth", "attempt_id": Uuid::new_v4(),
            "operation": "reauthorize", "phase": "failure", "error_code": "oauth_failed"});
        assert!(serde_json::from_value::<TelemetryEvent>(event.clone()).is_ok());
        let mut message = event.clone();
        message["error_code"] = json!("request failed with secret token");
        assert!(serde_json::from_value::<TelemetryEvent>(message).is_err());
        let mut identifier = event;
        identifier["attempt_id"] = json!("a caller supplied user identifier");
        assert!(serde_json::from_value::<TelemetryEvent>(identifier).is_err());
    }
}
