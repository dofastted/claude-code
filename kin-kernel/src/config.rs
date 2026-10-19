use std::{env, net::SocketAddr, time::Duration};

pub const CLIENT_CHANNEL_SIZE: usize = 32;
pub const EVENT_CHANNEL_SIZE: usize = 128;
pub const DEFAULT_CLIENT_STALL_SECS: u64 = 30;
pub const DEFAULT_JOB_IDLE_SECS: u64 = 180;
pub const DEFAULT_CANCEL_ACK_SECS: u64 = 30;
pub const PER_CONNECTION_BUFFER: usize = 512 * 1024;
pub const MAX_TOOL_RESULT_BYTES: usize = 4 * 1024 * 1024;
pub const DEFAULT_SLOTS: usize = 20;

#[derive(Clone, Debug)]
pub struct Config {
    pub listen_addr: SocketAddr,
    pub worker_count: usize,
    pub slots_per_worker: usize,
    pub max_body_bytes: usize,
    pub max_tool_result_bytes: usize,
    pub max_session_bytes: usize,
    pub session_ttl: Duration,
    pub continuation_ttl: Duration,
    pub default_tenant: String,
    pub expose_slot_header: bool,
    pub provider: String,
    /// Go control-plane's computed `RuntimeProfile` hash (design.md §6).
    /// Read once at process startup only — config changes require a drain +
    /// restart cycle, never a runtime re-fetch. `None` means the Go
    /// integration isn't wired up yet; three-way validation is skipped.
    pub desired_config_hash: Option<String>,
}

impl Config {
    pub fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        let listen_addr = env::var("KERNEL_ADDR")
            .unwrap_or_else(|_| "0.0.0.0:8080".to_string())
            .parse()?;
        // One kernel runtime == one Claude OS process. Slot count is --max-procs.
        let worker_count = parse_env("WORKER_COUNT", 1)?;
        let slots_per_worker = parse_env("SLOTS_PER_WORKER", DEFAULT_SLOTS)?;
        let max_body_bytes = parse_env("MAX_BODY_BYTES", 8 * 1024 * 1024)?;
        let max_tool_result_bytes = parse_env("MAX_TOOL_RESULT_BYTES", MAX_TOOL_RESULT_BYTES)?;
        let max_session_bytes = parse_env("MAX_SESSION_BYTES", 16 * 1024 * 1024)?;
        let session_ttl_seconds = parse_env("SESSION_TTL_SECONDS", 600)?;
        let continuation_ttl_seconds = parse_env("CONTINUATION_TTL_SECONDS", 600)?;
        if worker_count == 0
            || slots_per_worker == 0
            || max_body_bytes == 0
            || max_session_bytes == 0
            || session_ttl_seconds == 0
            || continuation_ttl_seconds == 0
        {
            return Err("worker, slot, body, and TTL settings must be positive".into());
        }
        if slots_per_worker > 20 {
            return Err(
                "Claude official subagent cap is 20; SLOTS_PER_WORKER must be <= 20".into(),
            );
        }

        Ok(Self {
            listen_addr,
            worker_count,
            slots_per_worker,
            max_body_bytes,
            max_tool_result_bytes,
            max_session_bytes,
            session_ttl: Duration::from_secs(session_ttl_seconds),
            continuation_ttl: Duration::from_secs(continuation_ttl_seconds),
            default_tenant: env::var("DEFAULT_TENANT").unwrap_or_else(|_| "demo".to_string()),
            expose_slot_header: parse_bool_env("EXPOSE_SLOT_HEADER", true)?,
            provider: env::var("PROVIDER").unwrap_or_else(|_| "mock".to_string()),
            desired_config_hash: env::var("DESIRED_CONFIG_HASH").ok(),
        })
    }
}

fn parse_env<T>(name: &str, default: T) -> Result<T, Box<dyn std::error::Error>>
where
    T: std::str::FromStr,
    T::Err: std::error::Error + 'static,
{
    match env::var(name) {
        Ok(value) => Ok(value.parse()?),
        Err(_) => Ok(default),
    }
}

fn parse_bool_env(name: &str, default: bool) -> Result<bool, Box<dyn std::error::Error>> {
    match env::var(name) {
        Ok(value) => match value.to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" => Ok(true),
            "0" | "false" | "no" => Ok(false),
            _ => Err(format!("{name} must be true or false").into()),
        },
        Err(_) => Ok(default),
    }
}

pub fn client_stall_timeout_from_env() -> Result<Duration, Box<dyn std::error::Error>> {
    let seconds = parse_env("CLIENT_STALL_SECS", DEFAULT_CLIENT_STALL_SECS)?;
    if seconds == 0 {
        return Err("CLIENT_STALL_SECS must be positive".into());
    }
    Ok(Duration::from_secs(seconds))
}

fn positive_secs_env(name: &str, default: u64) -> Result<Duration, Box<dyn std::error::Error>> {
    let seconds = parse_env(name, default)?;
    if seconds == 0 {
        return Err(format!("{name} must be positive").into());
    }
    Ok(Duration::from_secs(seconds))
}

pub fn job_idle_timeout_from_env() -> Result<Duration, Box<dyn std::error::Error>> {
    positive_secs_env("JOB_IDLE_SECS", DEFAULT_JOB_IDLE_SECS)
}

pub fn cancel_ack_timeout_from_env() -> Result<Duration, Box<dyn std::error::Error>> {
    positive_secs_env("CANCEL_ACK_SECS", DEFAULT_CANCEL_ACK_SECS)
}
