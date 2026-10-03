use uuid::Uuid;

use crate::model::MessageRequest;

/// One in-flight HTTP turn bound to one CLI slot.
#[derive(Clone, Debug, Default)]
pub struct Job {
    pub request_context: Option<crate::provider::ClassifierRequestContext>,
    pub job_id: String,
    pub slot_id: String,
    pub request: MessageRequest,
    /// Node's id for this hop; `/internal/v1/cancel` looks jobs up by it.
    pub request_id: String,
    /// The CLI already sent `kin_job_done` / `kin_job_error` and released its
    /// slot, so a teardown must not send `kin_cancel` for it.
    pub cli_done: bool,
}

pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", Uuid::new_v4().simple())
}
