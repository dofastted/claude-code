use axum::{
    Json,
    http::{HeaderValue, StatusCode, header::RETRY_AFTER},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use thiserror::Error;

/// A failed job, carried to the client with its real cause.
///
/// `code` is one of the fixed gateway codes Node maps to a client error;
/// `status` and `error_type` follow the Anthropic error the job ended on.
#[derive(Clone, Debug)]
pub struct JobFailure {
    pub code: &'static str,
    pub status: u16,
    pub error_type: String,
    pub message: String,
    pub retry_after: Option<String>,
    pub upstream_code: Option<String>,
    pub request_id: Option<String>,
}

/// Codes the CLI may report; anything else is a CLI-internal failure.
const CLI_CODES: &[&str] = &[
    "invalid_request_context",
    "classifier_runtime_unsupported",
    "upstream_rate_limit",
    "upstream_auth_error",
    "upstream_invalid_request",
    "upstream_overloaded",
    "upstream_timeout",
    "upstream_error",
    "upstream_network_error",
    "upstream_stream_interrupted",
    "upstream_empty_stream",
    "cli_error",
];

impl JobFailure {
    pub fn new(
        code: &'static str,
        status: u16,
        error_type: &str,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code,
            status,
            error_type: error_type.to_string(),
            message: message.into(),
            retry_after: None,
            upstream_code: None,
            request_id: None,
        }
    }

    /// CLI host is gone or restarting: retry on another runtime.
    pub fn kernel_unavailable(message: impl Into<String>) -> Self {
        Self::new("kernel_unavailable", 503, "api_error", message)
    }

    /// `job_error`. Older CLIs send only `error`; that stays a CLI failure.
    pub fn from_cli(
        code: Option<&str>,
        status: Option<u16>,
        error_type: Option<&str>,
        message: String,
        retry_after: Option<String>,
    ) -> Self {
        let code = code
            .and_then(|code| CLI_CODES.iter().copied().find(|known| *known == code))
            .unwrap_or("cli_error");
        Self {
            code,
            status: status.filter(|s| (400..600).contains(s)).unwrap_or(502),
            error_type: error_type
                .filter(|t| !t.is_empty())
                .unwrap_or("api_error")
                .to_string(),
            message,
            retry_after,
            upstream_code: None,
            request_id: None,
        }
    }
}

#[derive(Debug, Error)]
pub enum KernelError {
    #[error("{0}")]
    InvalidRequest(String),
    /// Reserved 501 surface: constructed by callers that reject a
    /// request feature this build does not implement. Kept even while
    /// unconstructed so the HTTP contract stays stable.
    #[allow(dead_code)]
    #[error("{0}")]
    UnsupportedFeature(String),
    #[error("no compatible capacity is currently available")]
    NoCapacity,
    #[error("runtime overloaded")]
    Overloaded { retry_after: Option<String> },
    #[error("{0}")]
    ContinuationMismatch(String),
    #[error("the bound runtime is no longer available")]
    ContinuationLost,
    #[error("provider error: {0}")]
    Provider(String),
    #[error("{}", .0.message)]
    Job(JobFailure),
    #[error("provider rate limit reached")]
    ProviderRateLimited { retry_after: Option<String> },
    #[error("internal error")]
    Internal,
}

#[derive(Serialize)]
struct ErrorEnvelope {
    r#type: &'static str,
    error: ErrorBody,
}

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
    retryable: bool,
}

impl IntoResponse for KernelError {
    fn into_response(self) -> Response {
        let (status, code, retryable) = match &self {
            Self::InvalidRequest(_) => (StatusCode::BAD_REQUEST, "invalid_request", false),
            Self::UnsupportedFeature(_) => {
                (StatusCode::NOT_IMPLEMENTED, "unsupported_feature", false)
            }
            Self::NoCapacity => (StatusCode::SERVICE_UNAVAILABLE, "no_capacity", true),
            Self::Overloaded { .. } => (StatusCode::SERVICE_UNAVAILABLE, "overloaded", true),
            Self::ContinuationMismatch(_) => (StatusCode::CONFLICT, "continuation_mismatch", false),
            Self::ContinuationLost => (StatusCode::CONFLICT, "continuation_lost", false),
            Self::Provider(_) => (StatusCode::BAD_GATEWAY, "provider_error", true),
            Self::Job(failure) => (
                StatusCode::from_u16(failure.status).unwrap_or(StatusCode::BAD_GATEWAY),
                failure.code,
                true,
            ),
            Self::ProviderRateLimited { .. } => {
                (StatusCode::TOO_MANY_REQUESTS, "provider_rate_limited", true)
            }
            Self::Internal => (StatusCode::INTERNAL_SERVER_ERROR, "internal_error", false),
        };

        let retry_after = match &self {
            Self::ProviderRateLimited { retry_after } => retry_after.clone(),
            Self::Overloaded { retry_after } => retry_after.clone(),
            Self::Job(failure) => failure.retry_after.clone(),
            _ => None,
        };
        let mut response = (
            status,
            Json(ErrorEnvelope {
                r#type: "error",
                error: ErrorBody {
                    code,
                    message: self.to_string(),
                    retryable,
                },
            }),
        )
            .into_response();
        if let Some(value) = retry_after.and_then(|value| HeaderValue::from_str(&value).ok()) {
            response.headers_mut().insert(RETRY_AFTER, value);
        }
        response
    }
}
