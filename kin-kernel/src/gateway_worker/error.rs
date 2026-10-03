use axum::{
    Json,
    http::{HeaderValue, StatusCode, header::RETRY_AFTER},
    response::{IntoResponse, Response},
};
use serde::Serialize;

#[derive(Debug)]
pub struct WorkerError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub error_type: String,
    pub retry_after: Option<String>,
    pub upstream_code: Option<String>,
    pub request_id: Option<String>,
}

impl WorkerError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: truncate(&message.into()),
            error_type: "worker_error".to_string(),
            retry_after: None,
            upstream_code: None,
            request_id: None,
        }
    }
}

#[derive(Serialize)]
struct Envelope {
    ok: bool,
    error: ErrorBody,
}

#[derive(Serialize)]
struct ErrorBody {
    #[serde(rename = "type")]
    kind: String,
    code: &'static str,
    message: String,
    status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    upstream_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
}

impl IntoResponse for WorkerError {
    fn into_response(self) -> Response {
        let retry_after = self
            .retry_after
            .as_deref()
            .and_then(|value| HeaderValue::from_str(value).ok());
        let request_id = self
            .request_id
            .as_deref()
            .and_then(|v| HeaderValue::from_str(v).ok());
        let mut response = (
            self.status,
            Json(Envelope {
                ok: false,
                error: ErrorBody {
                    kind: self.error_type,
                    code: self.code,
                    message: self.message,
                    status: self.status.as_u16(),
                    retry_after: self.retry_after,
                    upstream_code: self.upstream_code,
                    request_id: self.request_id,
                },
            }),
        )
            .into_response();
        if let Some(value) = retry_after {
            response.headers_mut().insert(RETRY_AFTER, value);
        }
        if let Some(value) = request_id {
            response.headers_mut().insert("request-id", value);
        }
        response
    }
}

pub fn truncate(message: &str) -> String {
    if message.len() <= 300 {
        return message.to_string();
    }
    let mut end = 300;
    while end > 0 && !message.is_char_boundary(end) {
        end -= 1;
    }
    message[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_to_300_bytes() {
        let long = "a".repeat(400);
        assert_eq!(truncate(&long).len(), 300);
    }
}
