//! One Claude OS process, N slots.
//!
//! Jobs go to the CLI's stdin as `job_start`; the CLI hosts the slots and
//! its stdout `stream_event` / `job_done` frames are the only
//! authority for a job's text and terminal state.

pub mod bootstrap;
pub mod envelope;
pub mod job;
pub mod memory_guard;
pub mod native_protocol;
pub mod scheduler;
pub mod slot;
pub mod supervisor;
pub mod telemetry;

use std::{
    collections::{HashMap, HashSet, VecDeque},
    env,
    path::PathBuf,
    sync::{
        Arc, OnceLock, Weak,
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, Instant, SystemTime},
};

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::sync::{Mutex, Notify, OnceCell, mpsc, oneshot};
use uuid::Uuid;

use crate::{
    error::{JobFailure, KernelError},
    model::{ContentBlock, MessageContent, MessageRequest, MessageResponse, StopReason, Usage},
    provider::{ExecutionContext, Provider, ProviderCapabilities, StreamTx, job_event_channel},
    stream::{StreamAssembler, StreamItem},
};

use self::{
    job::{Job, new_id},
    memory_guard::MemoryGuard,
    scheduler::SlotScheduler,
    slot::Slot,
};

fn serialized_request_bytes(request: &MessageRequest) -> Result<usize, KernelError> {
    struct ByteCounter(usize);

    impl std::io::Write for ByteCounter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self
                .0
                .checked_add(bytes.len())
                .ok_or_else(|| std::io::Error::other("request size overflow"))?;
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    let mut counter = ByteCounter(0);
    serde_json::to_writer(&mut counter, request)
        .map_err(|_| KernelError::Provider("unable to measure request size".into()))?;
    Ok(counter.0.saturating_add(1024))
}

fn json_byte_len(value: &serde_json::Value) -> Result<usize, KernelError> {
    struct ByteCounter(usize);
    impl std::io::Write for ByteCounter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self
                .0
                .checked_add(bytes.len())
                .ok_or_else(|| std::io::Error::other("request size overflow"))?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = ByteCounter(0);
    serde_json::to_writer(&mut counter, value)
        .map_err(|_| KernelError::Provider("unable to measure request size".into()))?;
    Ok(counter.0)
}

#[derive(Clone)]
pub struct MultiplexConfig {
    pub slot_count: usize,
    pub simulate: bool,
    pub bin: PathBuf,
    pub mock_bin: bool,
    pub model: String,
    pub session_idle_ttl: Duration,
    pub panel_config_path: Option<PathBuf>,
    pub simulate_latency: Duration,
    pub continuation_ttl_secs: i64,
    pub client_stall_timeout: Duration,
    /// A job with no CLI frame for this long is cancelled (slot watchdog).
    pub job_idle_timeout: Duration,
    /// A cancelled slot with no `cancel_ack` after this long is closed.
    pub cancel_ack_timeout: Duration,
    pub submit_wait: Duration,
    pub desired_config_hash: Option<String>,
    /// Live Claude config dir (`CLAUDE_CONFIG_DIR`). None → temp dir + env oauth.
    pub session_dir: Option<PathBuf>,
    pub recovery: RecoveryConfig,
}

/// Bounds for self-recovery before the control plane restarts the container.
///
/// L1 closes a slot whose cancel is not acked and resends the cancel; L2
/// pings the CLI process; L3 restarts the CLI process inside this kernel.
#[derive(Clone, Debug)]
pub struct RecoveryConfig {
    /// `cancel` resends after a slot is closed; each waits twice as long.
    pub cancel_resends: u32,
    /// Unanswered pings before the CLI process counts as dead.
    pub probe_attempts: u32,
    pub probe_timeout: Duration,
    /// Running jobs but no CLI frame at all for this long: probe the process.
    pub host_silence: Duration,
    /// A CLI that leaves its stdin pipe full this long is not reading it.
    pub stdin_write_timeout: Duration,
    /// One wait per allowed CLI restart within `restart_window`.
    pub restart_backoff: Vec<Duration>,
    pub restart_window: Duration,
}

impl Default for RecoveryConfig {
    fn default() -> Self {
        Self {
            cancel_resends: 3,
            probe_attempts: 3,
            probe_timeout: Duration::from_secs(10),
            host_silence: Duration::from_secs(60),
            stdin_write_timeout: Duration::from_secs(10),
            restart_backoff: vec![
                Duration::from_secs(10),
                Duration::from_secs(30),
                Duration::from_secs(60),
            ],
            restart_window: Duration::from_secs(600),
        }
    }
}

impl MultiplexConfig {
    pub fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        let slot_count = env::var("SLOTS_PER_WORKER")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(20)
            .clamp(1, 20);
        let bin = env::var("CLAUDE_BIN")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into()))
                    .join("../../scripts/node-kernel/mock-claude.mjs")
            });
        let mock_bin = bin.to_string_lossy().contains("mock-claude");
        let simulate = env::var("MULTIPLEX_SIMULATE")
            .map(|value| value != "0")
            .unwrap_or(mock_bin);
        Ok(Self {
            slot_count,
            simulate,
            mock_bin,
            bin,
            model: env::var("CLI_MODEL").unwrap_or_else(|_| "claude-sonnet-5-5".into()),
            session_idle_ttl: Duration::from_secs(
                env::var("SESSION_IDLE_TTL_SECS")
                    .ok()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(600),
            ),
            panel_config_path: None,
            simulate_latency: Duration::from_millis(
                env::var("SIMULATE_LATENCY_MS")
                    .ok()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(40),
            ),
            continuation_ttl_secs: 600,
            client_stall_timeout: crate::config::client_stall_timeout_from_env()?,
            job_idle_timeout: crate::config::job_idle_timeout_from_env()?,
            cancel_ack_timeout: crate::config::cancel_ack_timeout_from_env()?,
            submit_wait: Duration::from_millis(
                env::var("SUBMIT_WAIT_MS")
                    .ok()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(2000),
            ),
            desired_config_hash: env::var("DESIRED_CONFIG_HASH").ok(),
            session_dir: None,
            recovery: RecoveryConfig::default(),
        })
    }
}

pub struct Runtime {
    pub pid: AtomicU32,
    cfg: MultiplexConfig,
    session_idle: Mutex<SessionIdleConfig>,
    slots: Mutex<Vec<Slot>>,
    sched: Mutex<SlotScheduler>,
    jobs: Mutex<HashMap<String, Job>>,
    sinks: Mutex<HashMap<String, JobSink>>,
    job_sizes: Mutex<HashMap<String, usize>>,
    stdout_bytes: Mutex<HashMap<String, usize>>,
    /// Planned idle RSS recycle. Not an L3 crash and not counted in `cli_restarts`.
    mem_recycling: AtomicBool,
    /// Boxed rather than `ChildStdin` so the simulated CLI can be driven
    /// over an in-memory pipe on exactly the same code path.
    cli_stdin: Mutex<Option<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>>,
    pub memory: MemoryGuard,
    running: AtomicUsize,
    peak_running: AtomicUsize,
    ready: AtomicUsize,
    stage_dropped: AtomicU64,
    host_unavailable: AtomicBool,
    native_host: Mutex<Option<NativeHostInfo>>,
    classifier_context_supported: AtomicBool,
    /// P0(5.4): per-job aggregation of native `stream_event` SSE into
    /// real `{id,name,input}` content blocks, for `stream:false` clients and
    /// for populating `complete_job()`'s response content under
    /// native/native_messages. Only touched from the native code paths.
    stream_assemblers: Mutex<HashMap<String, StreamAssembler>>,
    /// Set when `validate_host_ready()` rejects a `host_ready` handshake
    /// due to config_hash mismatch (design.md §6, AC14). Surfaced via
    /// `Provider::config_hash_mismatch()` for `/readyz`.
    config_hash_mismatch: AtomicBool,
    /// Last CLI frame per live job. The watchdog cancels jobs gone silent.
    job_seen: Mutex<HashMap<String, Instant>>,
    /// slot_id -> the `cancel` still waiting for its ack.
    pending_cancels: Mutex<HashMap<String, PendingCancel>>,
    /// Early cancels can overtake registration on a different HTTP connection.
    cancelled_requests: Mutex<HashMap<String, Instant>>,
    /// Pending cancels whose slot is closed (L1). Reported on health.
    closed_count: AtomicUsize,
    me: Weak<Runtime>,
    frame_gate: Mutex<()>,
    telemetry: Mutex<telemetry::TelemetryTracking>,
    telemetry_submissions: Arc<tokio::sync::Semaphore>,
    /// Bumped per CLI process; frames and exits of an older process are ignored.
    host_gen: AtomicU64,
    child_kill: Mutex<Option<oneshot::Sender<()>>>,
    epoch: Instant,
    /// Millis since `epoch` of the last stdout line from the CLI.
    last_frame_ms: AtomicU64,
    probe: Mutex<Option<Probe>>,
    probe_wanted: AtomicBool,
    /// A CLI restart is scheduled or booting (L3).
    recovering: AtomicBool,
    restarts: Mutex<VecDeque<Instant>>,
    cli_restarts: AtomicU32,
    /// Set once the restart budget is spent; the kernel stays down and reports unhealthy.
    gave_up: std::sync::Mutex<Option<String>>,
}

struct SessionIdleConfig {
    ttl: Duration,
    stamp: Option<(SystemTime, u64)>,
}

#[derive(serde::Deserialize)]
struct PanelSessionIdle {
    session_idle_ttl_seconds: Option<u64>,
}

struct PendingCancel {
    job_id: String,
    sent_at: Instant,
    resends: u32,
    closed: bool,
}

struct Probe {
    nonce: String,
    sent_at: Instant,
    attempts: u32,
}

const JOB_SINK_ITEMS: usize = 256;
const JOB_SINK_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, serde::Serialize)]
struct NativeHostInfo {
    protocol_version: u32,
    slots: usize,
    system_layout: String,
    timezone: String,
    capabilities: Vec<String>,
    config_hash: Option<String>,
}

#[derive(Clone)]
struct JobSink {
    data_tx: mpsc::Sender<SinkEnvelope>,
    terminal: Arc<OnceLock<Terminal>>,
    terminal_notify: Arc<Notify>,
    budget: Arc<ByteBudget>,
    client_tx: Arc<Mutex<Option<StreamTx>>>,
}

struct SinkEnvelope {
    item: StreamItem,
    bytes: usize,
}

struct ByteBudget {
    used: AtomicUsize,
    max: usize,
}

#[derive(Debug)]
enum Terminal {
    Overflow,
    ClientTooSlow,
    ClientGone,
    Done,
    Failed(KernelError),
}

#[derive(Debug, PartialEq, Eq)]
enum EmitResult {
    Sent,
    StageDropped,
    Failed,
    Closed,
    Missing,
}

enum SinkPushError {
    Full,
    Closed,
}

impl JobSink {
    fn new(client_tx: StreamTx) -> (Self, mpsc::Receiver<SinkEnvelope>) {
        let (data_tx, data_rx) = mpsc::channel(JOB_SINK_ITEMS);
        let sink = Self {
            data_tx,
            terminal: Arc::new(OnceLock::new()),
            terminal_notify: Arc::new(Notify::new()),
            budget: Arc::new(ByteBudget::new(JOB_SINK_BYTES)),
            client_tx: Arc::new(Mutex::new(Some(client_tx))),
        };
        (sink, data_rx)
    }

    fn try_push(&self, item: StreamItem) -> Result<(), SinkPushError> {
        if self.terminal_failed() {
            return Err(SinkPushError::Closed);
        }
        let bytes = stream_item_bytes(&item);
        if !self.budget.try_reserve(bytes) {
            return Err(SinkPushError::Full);
        }
        let envelope = SinkEnvelope { item, bytes };
        match self.data_tx.try_send(envelope) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(envelope)) => {
                self.budget.release(envelope.bytes);
                Err(SinkPushError::Full)
            }
            Err(mpsc::error::TrySendError::Closed(envelope)) => {
                self.budget.release(envelope.bytes);
                Err(SinkPushError::Closed)
            }
        }
    }

    fn set_terminal(&self, terminal: Terminal) -> bool {
        let set = self.terminal.set(terminal).is_ok();
        if set {
            self.terminal_notify.notify_waiters();
        }
        set
    }

    fn terminal_failed(&self) -> bool {
        self.terminal.get().is_some_and(Terminal::is_failure)
    }
}

impl ByteBudget {
    fn new(max: usize) -> Self {
        Self {
            used: AtomicUsize::new(0),
            max,
        }
    }

    fn try_reserve(&self, bytes: usize) -> bool {
        let bytes = bytes.max(1);
        let mut current = self.used.load(Ordering::Relaxed);
        loop {
            let Some(next) = current.checked_add(bytes) else {
                return false;
            };
            if next > self.max {
                return false;
            }
            match self.used.compare_exchange_weak(
                current,
                next,
                Ordering::AcqRel,
                Ordering::Relaxed,
            ) {
                Ok(_) => return true,
                Err(actual) => current = actual,
            }
        }
    }

    fn release(&self, bytes: usize) {
        self.used
            .fetch_update(Ordering::AcqRel, Ordering::Relaxed, |current| {
                Some(current.saturating_sub(bytes.max(1)))
            })
            .ok();
    }
}

impl Terminal {
    fn is_failure(&self) -> bool {
        matches!(
            self,
            Self::Overflow | Self::ClientTooSlow | Self::ClientGone | Self::Failed(_)
        )
    }

    fn error(&self) -> KernelError {
        match self {
            Self::Overflow => KernelError::Job(JobFailure::new(
                "kernel_error",
                502,
                "api_error",
                "job stream overflow",
            )),
            Self::ClientTooSlow => KernelError::Job(JobFailure::new(
                "kernel_error",
                502,
                "api_error",
                "client read timed out",
            )),
            Self::ClientGone => KernelError::Provider("client disconnected".into()),
            Self::Done => KernelError::Provider("job already completed".into()),
            Self::Failed(KernelError::Job(failure)) => KernelError::Job(failure.clone()),
            Self::Failed(err) => KernelError::Provider(err.to_string()),
        }
    }
}

impl Runtime {
    pub fn new(cfg: MultiplexConfig) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            pid: AtomicU32::new(0),
            session_idle: Mutex::new(SessionIdleConfig {
                ttl: cfg.session_idle_ttl,
                stamp: None,
            }),
            cfg,
            slots: Mutex::new(Vec::new()),
            sched: Mutex::new(SlotScheduler::new()),
            jobs: Mutex::new(HashMap::new()),
            sinks: Mutex::new(HashMap::new()),
            job_sizes: Mutex::new(HashMap::new()),
            stdout_bytes: Mutex::new(HashMap::new()),
            mem_recycling: AtomicBool::new(false),
            cli_stdin: Mutex::new(None),
            memory: MemoryGuard::from_env(),
            running: AtomicUsize::new(0),
            peak_running: AtomicUsize::new(0),
            ready: AtomicUsize::new(0),
            stage_dropped: AtomicU64::new(0),
            host_unavailable: AtomicBool::new(false),
            native_host: Mutex::new(None),
            classifier_context_supported: AtomicBool::new(false),
            stream_assemblers: Mutex::new(HashMap::new()),
            config_hash_mismatch: AtomicBool::new(false),
            job_seen: Mutex::new(HashMap::new()),
            pending_cancels: Mutex::new(HashMap::new()),
            cancelled_requests: Mutex::new(HashMap::new()),
            closed_count: AtomicUsize::new(0),
            me: me.clone(),
            host_gen: AtomicU64::new(0),
            frame_gate: Mutex::new(()),
            telemetry: Mutex::new(telemetry::TelemetryTracking::default()),
            telemetry_submissions: Arc::new(tokio::sync::Semaphore::new(
                telemetry::MAX_PENDING_ACKS,
            )),
            child_kill: Mutex::new(None),
            epoch: Instant::now(),
            last_frame_ms: AtomicU64::new(0),
            probe: Mutex::new(None),
            probe_wanted: AtomicBool::new(false),
            recovering: AtomicBool::new(false),
            restarts: Mutex::new(VecDeque::new()),
            cli_restarts: AtomicU32::new(0),
            gave_up: std::sync::Mutex::new(None),
        })
    }

    pub async fn start(self: &Arc<Self>) -> Result<(), KernelError> {
        self.spawn_host().await?;
        tokio::spawn(job_watchdog(Arc::downgrade(self)));
        Ok(())
    }

    /// Start one CLI process generation. Used at boot and by every L3 restart.
    async fn spawn_host(self: &Arc<Self>) -> Result<(), KernelError> {
        let generation = {
            let _gate = self.frame_gate.lock().await;
            let generation = self.host_gen.fetch_add(1, Ordering::AcqRel) + 1;
            self.clear_telemetry().await;
            *self.native_host.lock().await = None;
            self.classifier_context_supported
                .store(false, Ordering::Relaxed);
            self.note_frame();
            self.host_unavailable.store(false, Ordering::Release);
            generation
        };
        if self.cfg.simulate {
            self.start_simulated(generation).await
        } else {
            self.start_claude(generation).await
        }
    }

    fn note_frame(&self) {
        let now = u64::try_from(self.epoch.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.last_frame_ms.store(now, Ordering::Relaxed);
    }

    fn watchdog_tick(&self) -> Duration {
        let shortest = self
            .cfg
            .job_idle_timeout
            .min(self.cfg.cancel_ack_timeout)
            .min(self.cfg.recovery.probe_timeout);
        (shortest / 4).clamp(Duration::from_millis(10), Duration::from_secs(5))
    }

    async fn touch_job(&self, job_id: &str) {
        if let Some(seen) = self.job_seen.lock().await.get_mut(job_id) {
            *seen = Instant::now();
        }
    }

    /// One watchdog pass, in recovery order:
    /// L0 fail silent jobs; L1 close slots whose cancel is not acked and
    /// resend the cancel; L3 restart the CLI when closed slots leave it
    /// useless; L2 probe a CLI that may have stopped reading stdin.
    async fn watchdog_sweep(&self) {
        if self.mem_recycling.load(Ordering::Relaxed) || self.host_unavailable() {
            // A restart is scheduled, a memory recycle is in progress, or the budget is spent.
            return;
        }
        let now = Instant::now();
        let idle = self.cfg.job_idle_timeout;
        let silent: Vec<String> = self
            .job_seen
            .lock()
            .await
            .iter()
            .filter(|(_, seen)| now.duration_since(**seen) >= idle)
            .map(|(job_id, _)| job_id.clone())
            .collect();
        for job_id in silent {
            tracing::warn!(%job_id, idle_secs = idle.as_secs_f64(), "job watchdog: no CLI frame, cancelling");
            self.probe_wanted.store(true, Ordering::Relaxed);
            let error = KernelError::Job(JobFailure::new(
                "upstream_timeout",
                504,
                "timeout_error",
                format!("job idle timeout: no CLI frame for {}s", idle.as_secs()),
            ));
            let sink = self.sinks.lock().await.get(&job_id).cloned();
            match sink {
                // job_egress sees the failure terminal, fails the client
                // stream and sends cancel.
                Some(sink) if sink.set_terminal(Terminal::Failed(error)) => {
                    self.job_seen.lock().await.remove(&job_id);
                }
                _ => self.abort_terminal_job(&job_id).await,
            }
        }

        let ack_limit = self.cfg.cancel_ack_timeout;
        let max_resends = self.cfg.recovery.cancel_resends;
        let mut newly_closed = Vec::new();
        let mut resend = Vec::new();
        {
            let mut pending = self.pending_cancels.lock().await;
            for (slot_id, cancel) in pending.iter_mut() {
                if cancel.resends >= max_resends && cancel.closed {
                    continue;
                }
                // 30s to close, then resends after 60s, 120s, ... (doubling).
                let wait = ack_limit.saturating_mul(1 << cancel.resends.min(16));
                if now.duration_since(cancel.sent_at) < wait {
                    continue;
                }
                if !cancel.closed {
                    cancel.closed = true;
                    newly_closed.push(slot_id.clone());
                }
                if cancel.resends < max_resends {
                    cancel.resends += 1;
                    cancel.sent_at = now;
                    resend.push((cancel.job_id.clone(), slot_id.clone()));
                }
            }
        }
        for slot_id in newly_closed {
            tracing::error!(%slot_id, "cancel not acked; closing slot and resending cancel");
            self.retire_slot(&slot_id).await;
            self.closed_count.fetch_add(1, Ordering::Relaxed);
            self.probe_wanted.store(true, Ordering::Relaxed);
        }
        for (job_id, slot_id) in resend {
            let frame = native_protocol::StdinFrame::Cancel {
                job_id,
                slot_id: Some(slot_id),
            };
            if self.write_cli_stdin(frame).await.is_err() {
                return;
            }
        }

        let closed = self.closed_count.load(Ordering::Relaxed);
        let slots = self.cfg.slot_count;
        if closed >= slots {
            self.request_restart(format!("all {slots} slots closed by unacked cancels"))
                .await;
            return;
        }
        if closed > 0 && closed * 2 >= slots && self.running_jobs() == 0 {
            // Recycle while idle so no live stream is cut.
            self.request_restart(format!("{closed}/{slots} slots closed; idle recycle"))
                .await;
            return;
        }
        self.retire_idle().await;
        self.probe_tick(now).await;
        self.shed_largest_job().await;
        if self.running_jobs() == 0
            && let Some(me) = self.me.upgrade()
        {
            tokio::spawn(async move {
                me.recycle_for_memory().await;
            });
        }
    }

    async fn note_stdout(&self, job_id: &str, bytes: usize) {
        let mut accounted = self.stdout_bytes.lock().await;
        let entry = accounted.entry(job_id.to_string()).or_insert(0);
        *entry = entry.saturating_add(bytes);
    }

    async fn shed_largest_job(&self) {
        let snap = self.memory.snapshot();
        if snap.observed_bytes < snap.reject_bytes || self.running_jobs() == 0 {
            return;
        }
        let sizes = self.job_sizes.lock().await.clone();
        let stdout = self.stdout_bytes.lock().await.clone();
        let best = {
            let jobs = self.jobs.lock().await;
            let mut best: Option<(String, usize)> = None;
            for job in jobs.values() {
                let score = sizes.get(&job.job_id).copied().unwrap_or(0)
                    + stdout.get(&job.job_id).copied().unwrap_or(0);
                if best.as_ref().is_none_or(|(_, current)| score > *current) {
                    best = Some((job.job_id.clone(), score));
                }
            }
            best
        };
        let Some((job_id, _)) = best else {
            return;
        };
        let sink = self.sinks.lock().await.get(&job_id).cloned();
        let failure = JobFailure {
            retry_after: Some("2".into()),
            ..JobFailure::new("overloaded", 503, "api_error", "runtime overloaded")
        };
        let error = KernelError::Job(failure);
        if let Some(sink) = sink {
            sink.set_terminal(Terminal::Failed(error));
        }
    }

    async fn recycle_for_memory(self: &Arc<Self>) {
        if self.running_jobs() != 0
            || self.recovering.load(Ordering::Relaxed)
            || self
                .gave_up
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .is_some()
        {
            return;
        }
        if self.mem_recycling.swap(true, Ordering::AcqRel) {
            return;
        }
        let snap = self.memory.snapshot();
        if snap.observed_bytes < snap.drain_bytes {
            self.mem_recycling.store(false, Ordering::Release);
            return;
        }
        if let Some(kill) = self.child_kill.lock().await.take() {
            let _ = kill.send(());
        }
        if let Err(err) = self.spawn_host().await {
            tracing::error!(%err, "idle memory recycle failed to spawn cli");
        }
        self.mem_recycling.store(false, Ordering::Release);
    }

    /// L2: ask the CLI's stdin loop for a pong. A process that stays alive but
    /// stops reading stdin leaves every slot silent while health still shows
    /// ready slots; only an unanswered ping proves it.
    async fn probe_tick(&self, now: Instant) {
        let pings = self.native_host.lock().await.as_ref().is_some_and(|host| {
            host.capabilities
                .iter()
                .any(|cap| cap == native_protocol::CAP_PING)
        });
        if !pings {
            self.probe_wanted.store(false, Ordering::Relaxed);
            return;
        }
        let since_frame = Duration::from_millis(
            u64::try_from(self.epoch.elapsed().as_millis())
                .unwrap_or(u64::MAX)
                .saturating_sub(self.last_frame_ms.load(Ordering::Relaxed)),
        );
        let silent = self.running_jobs() > 0 && since_frame >= self.cfg.recovery.host_silence;
        let nonce = {
            let mut probe = self.probe.lock().await;
            match probe.as_mut() {
                None => {
                    if !self.probe_wanted.swap(false, Ordering::Relaxed) && !silent {
                        return;
                    }
                    let nonce = new_id("ping");
                    *probe = Some(Probe {
                        nonce: nonce.clone(),
                        sent_at: now,
                        attempts: 1,
                    });
                    nonce
                }
                Some(current) => {
                    if now.duration_since(current.sent_at) < self.cfg.recovery.probe_timeout {
                        return;
                    }
                    if current.attempts >= self.cfg.recovery.probe_attempts {
                        let attempts = current.attempts;
                        *probe = None;
                        drop(probe);
                        self.request_restart(format!("cli did not answer {attempts} pings"))
                            .await;
                        return;
                    }
                    current.attempts += 1;
                    current.sent_at = now;
                    current.nonce = new_id("ping");
                    current.nonce.clone()
                }
            }
        };
        let _ = self
            .write_cli_stdin(native_protocol::StdinFrame::Ping { nonce })
            .await;
    }

    /// Exit or stdout EOF of CLI generation `generation`. Older ones are already replaced.
    async fn host_lost(&self, generation: u64, reason: String) {
        let _gate = self.frame_gate.lock().await;
        if self.host_gen.load(Ordering::Acquire) != generation {
            return;
        }
        self.request_restart(reason).await;
    }

    /// L3 entry. Single flight: fails in-flight jobs as `kernel_unavailable`,
    /// kills the CLI and restarts it within the restart budget.
    async fn request_restart(&self, reason: String) {
        if self.recovering.swap(true, Ordering::AcqRel) {
            return;
        }
        tracing::error!(%reason, "native cli host failed; restarting it");
        self.mark_host_unavailable(reason.clone()).await;
        if let Some(kill) = self.child_kill.lock().await.take() {
            let _ = kill.send(());
        }
        let Some(me) = self.me.upgrade() else {
            return;
        };
        tokio::spawn(me.recover(reason));
    }

    /// Boxed: the restarted CLI's exit watcher calls back into
    /// `request_restart`, so an inferred future type here would be recursive.
    fn recover(
        self: Arc<Self>,
        reason: String,
    ) -> std::pin::Pin<Box<dyn Future<Output = ()> + Send>> {
        Box::pin(async move { self.recover_loop(reason).await })
    }

    async fn recover_loop(self: &Arc<Self>, mut reason: String) {
        loop {
            let wait = {
                let mut restarts = self.restarts.lock().await;
                let now = Instant::now();
                restarts.retain(|at| now.duration_since(*at) < self.cfg.recovery.restart_window);
                self.cfg
                    .recovery
                    .restart_backoff
                    .get(restarts.len())
                    .copied()
            };
            let Some(wait) = wait else {
                tracing::error!(%reason, "native cli restart budget spent; reporting unhealthy");
                *self.gave_up.lock().unwrap_or_else(|e| e.into_inner()) = Some(reason);
                self.recovering.store(false, Ordering::Release);
                return;
            };
            tokio::time::sleep(wait).await;
            self.restarts.lock().await.push_back(Instant::now());
            self.cli_restarts.fetch_add(1, Ordering::Relaxed);
            match self.spawn_host().await {
                Ok(()) => {
                    tracing::info!(pid = self.pid(), "native cli restarted");
                    self.recovering.store(false, Ordering::Release);
                    return;
                }
                Err(err) => {
                    reason = err.to_string();
                    tracing::error!(%reason, "native cli restart failed");
                    self.mark_host_unavailable(reason.clone()).await;
                    if let Some(kill) = self.child_kill.lock().await.take() {
                        let _ = kill.send(());
                    }
                }
            }
        }
    }

    /// Stand-in for the CLI child: an in-memory pipe carrying the very same
    /// `*` protocol, so tests exercise `write_cli_stdin` /
    /// `decode_stdout` instead of a bespoke fake.
    async fn start_simulated(self: &Arc<Self>, generation: u64) -> Result<(), KernelError> {
        self.pid.store(std::process::id(), Ordering::Relaxed);
        let (kernel_side, cli_side) = tokio::io::duplex(256 * 1024);
        let (kernel_read, kernel_write) = tokio::io::split(kernel_side);
        let (cli_read, cli_write) = tokio::io::split(cli_side);
        *self.cli_stdin.lock().await = Some(Box::new(kernel_write));
        let runtime = Arc::clone(self);
        tokio::spawn(async move {
            decode_stdout(runtime, kernel_read, generation).await;
        });
        tokio::spawn(simulated_cli(
            cli_read,
            cli_write,
            self.cfg.slot_count,
            self.cfg.simulate_latency,
            self.cfg.desired_config_hash.clone(),
        ));
        self.wait_host_ready(Duration::from_secs(5)).await
    }

    async fn start_claude(self: &Arc<Self>, generation: u64) -> Result<(), KernelError> {
        ensure_socks_http_bridge()?;
        let reuse = self.cfg.session_dir.is_some();
        let dir = self.cfg.session_dir.clone().unwrap_or_else(|| {
            PathBuf::from("/tmp/cli/multiplex").join(Uuid::new_v4().to_string())
        });
        let spec = supervisor::SpawnSpec {
            bin: self.cfg.bin.clone(),
            mock: self.cfg.mock_bin,
            model: self.cfg.model.clone(),
            slot_count: self.cfg.slot_count,
            session_dir: dir,
            desired_config_hash: self.cfg.desired_config_hash.clone(),
            kernel_config_path: self.cfg.panel_config_path.clone(),
            reuse_credentials: reuse,
        };
        let mut supervised = supervisor::spawn(&spec).await?;
        self.pid.store(supervised.pid, Ordering::Relaxed);
        self.memory.set_claude_pid(supervised.pid);
        let stdout = supervised
            .child
            .stdout
            .take()
            .ok_or_else(|| KernelError::Provider("claude stdout missing".into()))?;
        let stdin = supervised
            .child
            .stdin
            .take()
            .ok_or_else(|| KernelError::Provider("claude stdin missing".into()))?;
        // Do not write hello: official `-p` peeks stdin and, after the
        // first byte, waits for EOF. A live job pipe never ends, so a boot
        // hello hung the CLI before runHeadless / slot_ready.
        *self.cli_stdin.lock().await = Some(Box::new(stdin));
        let runtime = Arc::clone(self);
        tokio::spawn(async move {
            decode_stdout(runtime, stdout, generation).await;
        });
        if let Some(stderr) = supervised.child.stderr.take() {
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut lines = BufReader::new(stderr).lines();
                let path = "/tmp/live/claude.multiplex.stderr.log";
                let mut file = tokio::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path)
                    .await
                    .ok();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::info!(target: "kernel::claude", "{line}");
                    if let Some(file) = file.as_mut() {
                        use tokio::io::AsyncWriteExt;
                        let _ = file.write_all(line.as_bytes()).await;
                        let _ = file.write_all(b"\n").await;
                    }
                }
            });
        }
        let (kill_tx, kill_rx) = oneshot::channel::<()>();
        *self.child_kill.lock().await = Some(kill_tx);
        let runtime = Arc::clone(self);
        let mut child = supervised.child;
        tokio::spawn(async move {
            let reason = tokio::select! {
                status = child.wait() => match status {
                    Ok(status) => format!("claude process exited: {status}"),
                    Err(err) => format!("claude wait failed: {err}"),
                },
                // Restart path: the kernel already tore this generation down.
                _ = kill_rx => {
                    let _ = child.kill().await;
                    return;
                }
            };
            tracing::warn!(%reason, "claude process gone");
            runtime.host_lost(generation, reason).await;
        });
        tracing::info!(pid = supervised.pid, "claude supervisor alive");
        let wait = Duration::from_secs((120 + 8 * self.cfg.slot_count as u64).min(240));
        self.wait_host_ready(wait).await
    }

    async fn wait_host_ready(&self, max_wait: Duration) -> Result<(), KernelError> {
        tokio::time::timeout(max_wait, async {
            loop {
                if !self.host_unavailable() && self.native_host.lock().await.is_some() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .map_err(|_| KernelError::Provider("timed out waiting for native host readiness".into()))
    }

    pub fn ready_slots(&self) -> usize {
        if self.host_unavailable.load(Ordering::Relaxed) {
            return 0;
        }
        self.ready.load(Ordering::Relaxed)
    }

    pub(crate) fn host_unavailable(&self) -> bool {
        self.host_unavailable.load(Ordering::Relaxed)
    }

    fn host_available(&self) -> Result<(), KernelError> {
        if self.host_unavailable() {
            return Err(KernelError::Job(JobFailure::kernel_unavailable(
                "native cli host unavailable",
            )));
        }
        Ok(())
    }

    async fn mark_host_unavailable(&self, reason: String) {
        let first = !self.host_unavailable.swap(true, Ordering::AcqRel);
        if first {
            tracing::error!(%reason, "native cli host unavailable");
        }
        self.clear_telemetry().await;
        self.pid.store(0, Ordering::Relaxed);
        self.memory.set_claude_pid(0);
        self.ready.store(0, Ordering::Relaxed);
        *self.cli_stdin.lock().await = None;
        *self.native_host.lock().await = None;
        self.classifier_context_supported
            .store(false, Ordering::Relaxed);

        {
            let mut slots = self.slots.lock().await;
            for slot in slots.iter_mut() {
                slot.retire();
            }
        }
        *self.sched.lock().await = SlotScheduler::new();
        self.pending_cancels.lock().await.clear();
        self.closed_count.store(0, Ordering::Relaxed);
        *self.probe.lock().await = None;
        self.probe_wanted.store(false, Ordering::Relaxed);

        let sinks: Vec<JobSink> = self
            .sinks
            .lock()
            .await
            .drain()
            .map(|(_, sink)| sink)
            .collect();
        for sink in sinks {
            let terminal = Terminal::Failed(KernelError::Job(JobFailure::kernel_unavailable(
                reason.clone(),
            )));
            if sink.set_terminal(terminal)
                && let Some(terminal) = sink.terminal.get()
            {
                fail_client_stream(&sink, terminal).await;
            } else if let Some(terminal) = sink.terminal.get()
                && terminal.is_failure()
            {
                fail_client_stream(&sink, terminal).await;
            }
        }

        self.jobs.lock().await.clear();
        self.job_seen.lock().await.clear();
        self.stream_assemblers.lock().await.clear();
        let sizes: Vec<usize> = self
            .job_sizes
            .lock()
            .await
            .drain()
            .map(|(_, size)| size)
            .collect();
        for size in sizes {
            self.memory.end(size);
        }
        self.running.store(0, Ordering::Relaxed);
    }

    #[cfg(test)]
    pub async fn snapshots(&self) -> Vec<slot::SlotSnapshot> {
        self.slots
            .lock()
            .await
            .iter()
            .map(|slot| slot::SlotSnapshot {
                id: slot.id.clone(),
                phase: slot.phase,
                session_id: slot.session_id.clone(),
                tenant_id: slot.tenant_id.clone(),
            })
            .collect()
    }

    pub fn closed_slots(&self) -> usize {
        self.closed_count.load(Ordering::Relaxed)
    }

    /// `None` while the kernel can still recover on its own.
    pub fn unhealthy_reason(&self) -> Option<String> {
        self.gave_up
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn peak_running(&self) -> usize {
        self.peak_running.load(Ordering::Relaxed)
    }

    pub fn running_jobs(&self) -> usize {
        self.running.load(Ordering::Relaxed)
    }

    /// Terminal handler for a job: `job_done` (`failure` = None) or
    /// `job_error`.
    async fn complete_job(
        &self,
        job_id: &str,
        failure: Option<JobFailure>,
        stop_reason: &str,
        usage: Value,
    ) -> Result<(), KernelError> {
        let job = {
            let mut jobs = self.jobs.lock().await;
            let job = jobs.get_mut(job_id).ok_or(KernelError::ContinuationLost)?;
            // The CLI released its slot with this frame: no teardown may cancel it.
            job.cli_done = true;
            job.clone()
        };
        if let Some(failure) = failure {
            if let Some(sink) = self.sinks.lock().await.get(job_id).cloned() {
                sink.set_terminal(Terminal::Failed(KernelError::Job(failure)));
            }
            self.abort_terminal_job(job_id).await;
            return Ok(());
        }
        let assembler = self.stream_assemblers.lock().await.remove(job_id);
        if assembler.as_ref().is_none_or(|a| !a.saw_stop()) {
            // First-byte path flushes message_start before the CLI turn
            // ends. JobDone is the authority; without message_stop the hop
            // client marks incomplete and the panel paints 200 as 超时.
            let _ = self
                .emit(job_id, StreamItem::Event(json!({ "type": "message_stop" })))
                .await;
        }
        let mut response = assembler
            .map(|a| a.finish(&job.request))
            .unwrap_or_else(|| MessageResponse {
                id: format!("msg_{}", self.pid.load(Ordering::Relaxed)),
                r#type: "message",
                role: "assistant",
                model: job.request.model.clone(),
                content: Vec::new(),
                stop_reason: native_stop_reason(stop_reason),
                stop_sequence: None,
                usage: Usage::default(),
            });
        let usage_value = if usage.is_null() { json!({}) } else { usage };
        if usage_value != json!({}) {
            response.usage = usage_from_value(&usage_value);
        }
        if !stop_reason.is_empty() {
            response.stop_reason = native_stop_reason(stop_reason);
        }
        if self.emit(job_id, StreamItem::Finished(response)).await != EmitResult::Sent {
            self.abort_terminal_job(job_id).await;
        }
        Ok(())
    }

    async fn finish_sent_job(&self, job_id: &str) {
        if let Some(sink) = self.sinks.lock().await.get(job_id).cloned()
            && !sink.set_terminal(Terminal::Done)
        {
            self.abort_terminal_job(job_id).await;
            return;
        }
        let job = self.jobs.lock().await.remove(job_id);
        self.job_seen.lock().await.remove(job_id);
        let slot_id = job.as_ref().map(|job| job.slot_id.clone());
        self.sinks.lock().await.remove(job_id);
        self.stream_assemblers.lock().await.remove(job_id);
        self.running
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                Some(n.saturating_sub(1))
            })
            .ok();
        if let Some(size) = self.job_sizes.lock().await.remove(job_id) {
            self.memory.end(size);
        }
        self.stdout_bytes.lock().await.remove(job_id);
        if let Some(slot_id) = slot_id {
            if self.host_unavailable() {
                self.retire_slot(&slot_id).await;
            } else {
                self.register_native_ready(slot_id).await;
            }
        }
    }

    async fn session_idle_ttl(&self) -> Duration {
        let Some(path) = &self.cfg.panel_config_path else {
            return self.cfg.session_idle_ttl;
        };
        let mut cached = self.session_idle.lock().await;
        let Ok(meta) = tokio::fs::metadata(path).await else {
            return cached.ttl;
        };
        let Ok(modified) = meta.modified() else {
            return cached.ttl;
        };
        let stamp = (modified, meta.len());
        if cached.stamp == Some(stamp) {
            return cached.ttl;
        }
        cached.stamp = Some(stamp);
        let loaded = async {
            let raw = tokio::fs::read(path).await.map_err(|err| err.to_string())?;
            let config: PanelSessionIdle =
                serde_json::from_slice(&raw).map_err(|err| err.to_string())?;
            let seconds = config.session_idle_ttl_seconds.unwrap_or(600);
            if !(1..=86400).contains(&seconds) {
                return Err("session_idle_ttl_seconds must be 1..=86400".to_string());
            }
            Ok(Duration::from_secs(seconds))
        }
        .await;
        match loaded {
            Ok(ttl) => cached.ttl = ttl,
            Err(error) => tracing::warn!(%error, "keeping previous sticky slot idle timeout"),
        }
        cached.ttl
    }

    async fn retire_idle(&self) {
        if self.host_unavailable() {
            return;
        }
        let ttl = self.session_idle_ttl().await;
        let mut slots = self.slots.lock().await;
        let mut sched = self.sched.lock().await;
        for slot in slots.iter_mut() {
            if !slot.session_idle(ttl) {
                continue;
            }
            if let (Some(tenant), Some(session)) =
                (slot.tenant_id.as_deref(), slot.session_id.as_deref())
            {
                sched.forget_session(tenant, session, &slot.id);
                slot.release_session();
            }
        }
    }

    async fn retire_slot(&self, slot_id: &str) {
        {
            let mut slots = self.slots.lock().await;
            if let Some(slot) = slots.iter_mut().find(|slot| slot.id == slot_id) {
                slot.retire();
            }
        }
        self.sched.lock().await.forget(slot_id);
    }

    pub async fn handle_cli_frame(&self, frame: Value) {
        let Some(native) = native_protocol::decode_stdout_value(&frame) else {
            tracing::debug!(?frame, "unrecognised cli frame");
            return;
        };
        self.handle_native_frame(native).await;
    }

    async fn handle_native_frame(&self, frame: native_protocol::StdoutFrame) {
        if self.host_unavailable() {
            tracing::debug!(?frame, "discarding frame after native host stopped");
            return;
        }
        match frame {
            native_protocol::StdoutFrame::HostReady {
                protocol_version,
                slots,
                system_layout,
                timezone,
                capabilities,
                config_hash,
            } => {
                tracing::info!(
                    protocol_version,
                    slots,
                    %system_layout,
                    %timezone,
                    ?capabilities,
                    ?config_hash,
                    "native host ready"
                );
                if let Err(reason) = self.validate_host_ready(
                    protocol_version,
                    slots,
                    &system_layout,
                    &timezone,
                    &capabilities,
                    config_hash.as_deref(),
                ) {
                    tracing::error!(
                        reason,
                        "native host ready validation failed, refusing to register slots"
                    );
                    if reason.starts_with("config_hash mismatch") {
                        self.config_hash_mismatch.store(true, Ordering::Relaxed);
                    }
                    return;
                }
                self.classifier_context_supported.store(
                    capabilities
                        .iter()
                        .any(|cap| cap == native_protocol::CAP_CLASSIFIER),
                    Ordering::Relaxed,
                );
                self.telemetry_capability(
                    capabilities
                        .iter()
                        .any(|cap| cap == native_protocol::CAP_VM_TELEMETRY),
                )
                .await;
                *self.native_host.lock().await = Some(NativeHostInfo {
                    protocol_version,
                    slots,
                    system_layout,
                    timezone,
                    capabilities,
                    config_hash,
                });
                for index in 0..slots {
                    self.register_native_ready(native_protocol::slot_id(index))
                        .await;
                }
            }
            native_protocol::StdoutFrame::SlotReady { slot_id } => {
                self.register_native_ready(slot_id).await;
            }
            native_protocol::StdoutFrame::StreamEvent {
                job_id,
                slot_id,
                event,
            } => {
                let model = {
                    let jobs = self.jobs.lock().await;
                    if let Some(job) = jobs.get(&job_id)
                        && job.slot_id != slot_id
                    {
                        tracing::warn!(
                            %job_id,
                            expected = %job.slot_id,
                            got = %slot_id,
                            "native stream slot_id mismatch"
                        );
                        return;
                    }
                    jobs.get(&job_id)
                        .map(|job| job.request.model.clone())
                        .unwrap_or_default()
                };
                self.touch_job(&job_id).await;
                self.stream_assemblers
                    .lock()
                    .await
                    .entry(job_id.clone())
                    .or_insert_with(|| StreamAssembler::new(model))
                    .apply_event(&event);
                self.emit(&job_id, StreamItem::Event(event)).await;
            }
            native_protocol::StdoutFrame::JobDone {
                job_id,
                slot_id,
                stop_reason,
                usage,
            } => {
                if let Some(job) = self.jobs.lock().await.get(&job_id)
                    && job.slot_id != slot_id
                {
                    tracing::warn!(
                        %job_id,
                        expected = %job.slot_id,
                        got = %slot_id,
                        "native job_done slot_id mismatch"
                    );
                    return;
                }
                let _ = self.complete_job(&job_id, None, &stop_reason, usage).await;
            }
            native_protocol::StdoutFrame::JobError {
                job_id,
                slot_id: _,
                error,
                code,
                status,
                error_type,
                retry_after,
                upstream_code,
                request_id,
            } => {
                let mut failure = JobFailure::from_cli(
                    code.as_deref(),
                    status,
                    error_type.as_deref(),
                    error,
                    retry_after,
                );
                failure.upstream_code = upstream_code;
                failure.request_id = request_id;
                let _ = self
                    .complete_job(&job_id, Some(failure), "error", json!({}))
                    .await;
            }
            native_protocol::StdoutFrame::CancelAck { job_id, slot_id } => {
                // Only the ack for the cancel we are waiting on frees the slot;
                // duplicates and acks for jobs we never cancelled are ignored.
                let matched = {
                    let mut pending = self.pending_cancels.lock().await;
                    if pending
                        .get(&slot_id)
                        .is_some_and(|cancel| cancel.job_id == job_id)
                    {
                        pending.remove(&slot_id)
                    } else {
                        None
                    }
                };
                let Some(cancel) = matched else {
                    tracing::debug!(%job_id, %slot_id, "unmatched cancel_ack");
                    return;
                };
                if cancel.closed {
                    tracing::info!(%slot_id, "late cancel_ack; reopening slot");
                    self.closed_count.fetch_sub(1, Ordering::Relaxed);
                }
                self.register_native_ready(slot_id).await;
            }
            native_protocol::StdoutFrame::Pong { nonce } => {
                let mut probe = self.probe.lock().await;
                if probe.as_ref().is_some_and(|probe| probe.nonce == nonce) {
                    *probe = None;
                }
            }
            native_protocol::StdoutFrame::TelemetryAck {
                request_id,
                ok,
                error,
            } => {
                self.telemetry_ack(request_id, ok, error).await;
            }
            native_protocol::StdoutFrame::TelemetryState { state } => {
                self.telemetry_state(state).await;
            }
        }
    }

    /// P1-3: reject a `host_ready` handshake that doesn't match what
    /// Rust expects, instead of registering slots against a CLI running an
    /// incompatible protocol/env. `config_hash` has no "desired" side yet
    /// (Go `RuntimeProfile`, design.md §6, not implemented) so it is only
    /// checked for presence under `native_messages`, not compared to a
    /// reference value.
    fn validate_host_ready(
        &self,
        protocol_version: u32,
        slots: usize,
        system_layout: &str,
        timezone: &str,
        capabilities: &[String],
        config_hash: Option<&str>,
    ) -> Result<(), String> {
        if protocol_version != native_protocol::PROTOCOL_VERSION {
            return Err(format!(
                "protocol_version {protocol_version} != {}",
                native_protocol::PROTOCOL_VERSION
            ));
        }
        if slots != self.cfg.slot_count {
            return Err(format!(
                "slots {slots} != configured slot_count {}",
                self.cfg.slot_count
            ));
        }
        let expected = envelope::load();
        if system_layout != expected.mode.as_str() {
            return Err(format!(
                "system_layout {system_layout} != expected {}",
                expected.mode.as_str()
            ));
        }
        if timezone != expected.timezone {
            return Err(format!(
                "timezone {timezone} != expected {}",
                expected.timezone
            ));
        }
        for required in native_protocol::CAPABILITIES {
            if !capabilities.iter().any(|c| c == required) {
                return Err(format!("missing required capability {required}"));
            }
        }
        if let Some(expected_hash) = &self.cfg.desired_config_hash
            && config_hash != Some(expected_hash.as_str())
        {
            return Err(format!(
                "config_hash mismatch: cli={config_hash:?} expected={expected_hash}"
            ));
        }
        Ok(())
    }

    async fn register_native_ready(&self, slot_id: String) {
        if self.host_unavailable() {
            return;
        }
        let mut slots = self.slots.lock().await;
        if !slots.iter().any(|slot| slot.id == slot_id) {
            slots.push(Slot::new(slot_id.clone()));
        }
        if let Some(slot) = slots.iter_mut().find(|slot| slot.id == slot_id) {
            slot.unbind_ready();
        }
        drop(slots);
        if self.sched.lock().await.enqueue_ready(slot_id) {
            self.ready.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Any failure here means the CLI cannot take input any more (closed
    /// pipe, or a pipe it stopped draining): restart it (L3).
    async fn write_cli_stdin(&self, frame: native_protocol::StdinFrame) -> Result<(), KernelError> {
        self.write_cli_stdin_for_generation(frame, None).await
    }

    async fn write_cli_stdin_for_generation(
        &self,
        frame: native_protocol::StdinFrame,
        generation: Option<u64>,
    ) -> Result<(), KernelError> {
        let line = native_protocol::encode_stdin(&frame).map_err(KernelError::Provider)?;
        self.write_stdin_line_for_generation(&line, generation)
            .await
    }

    async fn write_stdin_line(&self, line: &[u8]) -> Result<(), KernelError> {
        self.write_stdin_line_for_generation(line, None).await
    }

    async fn write_stdin_line_for_generation(
        &self,
        line: &[u8],
        generation: Option<u64>,
    ) -> Result<(), KernelError> {
        self.host_available()?;
        let limit = self.cfg.recovery.stdin_write_timeout;
        let write = async {
            use tokio::io::AsyncWriteExt;
            let mut guard = self.cli_stdin.lock().await;
            if let Some(expected) = generation
                && (self.host_gen.load(Ordering::Acquire) != expected || self.host_unavailable())
            {
                return Err("native cli generation replaced".to_string());
            }
            let Some(stdin) = guard.as_mut() else {
                return Err("native cli stdin closed".to_string());
            };
            stdin
                .write_all(line)
                .await
                .map_err(|err| format!("native stdin: {err}"))?;
            stdin
                .flush()
                .await
                .map_err(|err| format!("native stdin: {err}"))
        };
        let reason = match tokio::time::timeout(limit, write).await {
            Ok(Ok(())) => return Ok(()),
            Ok(Err(reason)) => reason,
            Err(_) => format!("native stdin write blocked for {}s", limit.as_secs()),
        };
        if let Some(generation) = generation {
            self.host_lost(generation, reason.clone()).await;
        } else {
            self.request_restart(reason.clone()).await;
        }
        Err(KernelError::Job(JobFailure::kernel_unavailable(reason)))
    }

    async fn emit(&self, job_id: &str, item: StreamItem) -> EmitResult {
        let lossless_delta = is_lossless_delta(&item);
        let sink = self.sinks.lock().await.get(job_id).cloned();
        let Some(sink) = sink else {
            return EmitResult::Missing;
        };
        match sink.try_push(item) {
            Ok(()) => EmitResult::Sent,
            Err(SinkPushError::Full) => {
                if lossless_delta {
                    sink.set_terminal(Terminal::Overflow);
                    EmitResult::Failed
                } else if matches!(sink.terminal.get(), Some(Terminal::Done)) {
                    EmitResult::Closed
                } else {
                    self.stage_dropped.fetch_add(1, Ordering::Relaxed);
                    EmitResult::StageDropped
                }
            }
            Err(SinkPushError::Closed) => EmitResult::Closed,
        }
    }

    async fn start_job_sink(self: &Arc<Self>, job_id: String, tx: StreamTx) -> oneshot::Sender<()> {
        let (sink, data_rx) = JobSink::new(tx);
        self.sinks.lock().await.insert(job_id.clone(), sink.clone());
        let (submitted, ready) = oneshot::channel();
        let runtime = Arc::downgrade(self);
        let stall_timeout = self.cfg.client_stall_timeout;
        tokio::spawn(async move {
            // Do not write a cancel ahead of the start frame. Dropped HTTP
            // futures do not interrupt submission, which releases this gate.
            let _ = ready.await;
            job_egress(runtime, job_id, data_rx, sink, stall_timeout).await;
        });
        submitted
    }

    /// Tear down a job that will not complete normally.
    ///
    /// `Job::cli_done` decides who frees the slot. After `job_done` /
    /// `job_error` the CLI already released it, so it is re-registered
    /// here. Otherwise the CLI is still running the job: send `cancel`
    /// and let its ack free the slot. Removing the job under the `jobs` lock
    /// makes this run once per job, whoever calls it first.
    async fn abort_terminal_job(&self, job_id: &str) {
        let sink = self.sinks.lock().await.get(job_id).cloned();
        if let Some(sink) = &sink
            && let Some(terminal) = sink.terminal.get()
            && terminal.is_failure()
        {
            fail_client_stream(sink, terminal).await;
        }
        let job = self.jobs.lock().await.remove(job_id);
        self.job_seen.lock().await.remove(job_id);
        self.sinks.lock().await.remove(job_id);
        self.stream_assemblers.lock().await.remove(job_id);
        if let Some(size) = self.job_sizes.lock().await.remove(job_id) {
            self.memory.end(size);
        }
        self.stdout_bytes.lock().await.remove(job_id);
        let Some(job) = job else {
            return;
        };
        self.running
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                Some(n.saturating_sub(1))
            })
            .ok();
        if job.cli_done {
            if self.host_unavailable() {
                self.retire_slot(&job.slot_id).await;
            } else {
                self.register_native_ready(job.slot_id).await;
            }
            return;
        }
        // Recorded before the write: a write that fails restarts the host,
        // which clears it; one that never lands is still timed and resent.
        self.pending_cancels.lock().await.insert(
            job.slot_id.clone(),
            PendingCancel {
                job_id: job.job_id.clone(),
                sent_at: Instant::now(),
                resends: 0,
                closed: false,
            },
        );
        let frame = native_protocol::StdinFrame::Cancel {
            job_id: job.job_id,
            slot_id: Some(job.slot_id),
        };
        let _ = self.write_cli_stdin(frame).await;
    }

    /// Explicit cancel from Node by its hop id. Goes through the same
    /// teardown as a dropped connection, so both arriving is harmless.
    pub async fn cancel_request(&self, request_id: &str) -> bool {
        if request_id.is_empty() {
            return false;
        }
        {
            let now = Instant::now();
            let mut cancelled = self.cancelled_requests.lock().await;
            cancelled.retain(|_, at| now.duration_since(*at) < Duration::from_secs(300));
            if cancelled.len() >= 4096
                && let Some(oldest) = cancelled
                    .iter()
                    .min_by_key(|(_, at)| *at)
                    .map(|(id, _)| id.clone())
            {
                cancelled.remove(&oldest);
            }
            cancelled.insert(request_id.to_string(), now);
        }
        let job_id = self
            .jobs
            .lock()
            .await
            .values()
            .find(|job| job.request_id == request_id)
            .map(|job| job.job_id.clone());
        let Some(job_id) = job_id else {
            return false;
        };
        tracing::info!(%request_id, %job_id, "explicit cancel from control plane");
        let sink = self.sinks.lock().await.get(&job_id).cloned();
        match sink {
            // job_egress fails the stream and runs the teardown once.
            Some(sink) => {
                sink.set_terminal(Terminal::ClientGone);
            }
            None => self.abort_terminal_job(&job_id).await,
        }
        true
    }

    pub async fn submit(
        self: &Arc<Self>,
        request: MessageRequest,
        context: ExecutionContext,
        tx: StreamTx,
    ) -> Result<(), KernelError> {
        if context.resumed {
            return self.resume(request, context, tx).await;
        }
        self.submit_fresh(request, context, tx).await
    }

    async fn submission_cancelled(&self, request_id: &str, tx: &StreamTx) -> bool {
        tx.is_closed()
            || (!request_id.is_empty()
                && self
                    .cancelled_requests
                    .lock()
                    .await
                    .get(request_id)
                    .is_some_and(|at| at.elapsed() < Duration::from_secs(300)))
    }

    /// Bind an idle slot and dispatch a brand-new job. Shared by `submit()`
    /// and native `resume()` (which, per design.md §5.2, treats a
    /// continuation as a fresh job once the caller has already merged the
    /// message history).
    async fn submit_fresh(
        self: &Arc<Self>,
        request: MessageRequest,
        context: ExecutionContext,
        tx: StreamTx,
    ) -> Result<(), KernelError> {
        self.host_available()?;
        let mut request_value = serde_json::to_value(&request).map_err(|_| {
            KernelError::Job(JobFailure::new(
                "invalid_request_context",
                400,
                "invalid_request_error",
                "Invalid classifier body",
            ))
        })?;
        if let Some(purpose) = &context.request_context {
            if !purpose.validate(&request_value) {
                return Err(KernelError::Job(JobFailure::new(
                    "invalid_request_context",
                    400,
                    "invalid_request_error",
                    "Classifier context does not match request format",
                )));
            }
            if !self.classifier_context_supported.load(Ordering::Relaxed) {
                return Err(KernelError::Job(JobFailure::new(
                    "classifier_runtime_unsupported",
                    400,
                    "invalid_request_error",
                    "CLI does not support classifier request context",
                )));
            }
        }
        if let Some(window) = context.auto_compact_window
            && let Some(obj) = request_value.as_object_mut()
        {
            obj.insert("auto_compact_window".to_string(), json!(window));
        }
        if let Some(obj) = request_value.as_object_mut() {
            obj.insert("wireMessages".to_string(), json!(true));
            obj.remove("settings");
            obj.remove("env");
        }
        let body_bytes = json_byte_len(&request_value)?;
        self.memory.preflight(body_bytes, body_bytes)?;
        let mut request = request;
        let deadline = tokio::time::Instant::now() + self.cfg.submit_wait;
        let (slot_id, job_id) = loop {
            if self.submission_cancelled(&context.request_id, &tx).await {
                return Err(KernelError::Job(JobFailure::new(
                    "client_cancelled",
                    499,
                    "api_error",
                    "client cancelled inference attempt",
                )));
            }
            self.host_available()?;
            let mut slots = self.slots.lock().await;
            let mut sched = self.sched.lock().await;
            match sched.pick(&mut slots, &context.tenant_id, &context.session_id) {
                Ok(slot_id) => {
                    self.ready
                        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                            Some(n.saturating_sub(1))
                        })
                        .ok();
                    let job_id = new_id("job");
                    let slot = slots
                        .iter_mut()
                        .find(|slot| slot.id == slot_id)
                        .ok_or(KernelError::NoCapacity)?;
                    if !slot.bind_job(&context.tenant_id, &context.session_id, &job_id) {
                        return Err(KernelError::NoCapacity);
                    }
                    break (slot_id, job_id);
                }
                Err(err) => {
                    drop(sched);
                    drop(slots);
                    if tokio::time::Instant::now() >= deadline {
                        return Err(err);
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
        };
        let request_context = context.request_context.clone();
        let frame = native_protocol::StdinFrame::JobStart {
            request_context,
            job_id: job_id.clone(),
            slot_id: slot_id.clone(),
            request: request_value,
        };
        let line = native_protocol::encode_stdin(&frame).map_err(KernelError::Provider)?;
        if let Err(err) = self.memory.preflight(line.len(), body_bytes) {
            self.register_native_ready(slot_id).await;
            return Err(err);
        }
        let reservation = match self.memory.reserve(line.len()) {
            Ok(reservation) => reservation,
            Err(err) => {
                self.register_native_ready(slot_id).await;
                return Err(err);
            }
        };
        // The stdin line is the copy the CLI parses. Keep only the model here.
        request.messages.clear();
        request.system = None;
        request.tools.clear();
        request.thinking = None;
        request.tool_choice = None;
        request.extra.clear();
        let job = Job {
            request_context: context.request_context.clone(),
            job_id: job_id.clone(),
            slot_id: slot_id.clone(),
            request,
            request_id: context.request_id.clone(),
            cli_done: false,
        };
        self.jobs.lock().await.insert(job_id.clone(), job);
        self.job_seen
            .lock()
            .await
            .insert(job_id.clone(), Instant::now());
        let submitted = self.start_job_sink(job_id.clone(), tx).await;
        self.job_sizes
            .lock()
            .await
            .insert(job_id.clone(), line.len());
        reservation.commit();
        let n = self.running.fetch_add(1, Ordering::Relaxed) + 1;
        self.peak_running.fetch_max(n, Ordering::Relaxed);
        if let Err(err) = self.write_stdin_line(&line).await {
            self.jobs.lock().await.remove(&job_id);
            self.job_seen.lock().await.remove(&job_id);
            self.sinks.lock().await.remove(&job_id);
            self.stream_assemblers.lock().await.remove(&job_id);
            if let Some(size) = self.job_sizes.lock().await.remove(&job_id) {
                self.memory.end(size);
            }
            self.stdout_bytes.lock().await.remove(&job_id);
            self.running
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                    Some(n.saturating_sub(1))
                })
                .ok();
            self.register_native_ready(slot_id).await;
            return Err(err);
        }
        drop(line);
        let cancelled = !context.request_id.is_empty()
            && self
                .cancelled_requests
                .lock()
                .await
                .get(&context.request_id)
                .is_some_and(|at| at.elapsed() < Duration::from_secs(300));
        if cancelled {
            self.cancel_request(&context.request_id).await;
        }
        let _ = submitted.send(());
        Ok(())
    }

    async fn resume(
        self: &Arc<Self>,
        request: MessageRequest,
        context: ExecutionContext,
        tx: StreamTx,
    ) -> Result<(), KernelError> {
        // The CLI holds no cross-job state. Continuation + tenant +
        // tool_use_id-subset validation and the full message-history merge
        // already happened one layer up (api.rs::ActiveTurn::begin ->
        // session.rs::SessionDirectory::resume) by the time `context.resumed`
        // is set here, so a "resume" is structurally a fresh job: new job_id,
        // any idle slot (sticky preferred), fresh job_start with the
        // already-merged request (design.md §5.2).
        let context = ExecutionContext {
            resumed: false,
            ..context
        };
        self.submit_fresh(request, context, tx).await
    }

    pub fn pid(&self) -> u32 {
        self.pid.load(Ordering::Relaxed)
    }

    /// Diagnostic only, best-effort: current slot_id bound to `session_id`.
    pub fn session_slot(&self, session_id: &str) -> Option<String> {
        let slots = self.slots.try_lock().ok()?;
        slots
            .iter()
            .find(|slot| slot.session_id.as_deref() == Some(session_id))
            .map(|slot| slot.id.clone())
    }

    /// True if the native host's last `host_ready` was rejected for a
    /// config_hash mismatch against `desired_config_hash` (design.md §6).
    pub fn config_hash_mismatch(&self) -> bool {
        self.config_hash_mismatch.load(Ordering::Relaxed)
    }
}

async fn job_egress(
    runtime: Weak<Runtime>,
    job_id: String,
    mut data_rx: mpsc::Receiver<SinkEnvelope>,
    sink: JobSink,
    stall_timeout: Duration,
) {
    loop {
        if let Some(terminal) = sink.terminal.get()
            && terminal.is_failure()
        {
            fail_client_stream(&sink, terminal).await;
            if let Some(runtime) = runtime.upgrade() {
                // Cancels on the CLI only if it has not finished the job yet.
                runtime.abort_terminal_job(&job_id).await;
            }
            break;
        }
        let client_tx = sink.client_tx.lock().await.clone();
        let client_closed = async {
            match &client_tx {
                Some(tx) => tx.closed().await,
                None => std::future::pending().await,
            }
        };
        let envelope = tokio::select! {
            biased;
            envelope = data_rx.recv() => envelope,
            _ = sink.terminal_notify.notified() => continue,
            _ = client_closed => {
                // Client left while the CLI is quiet: cancel now instead of
                // holding the slot until the next frame (or forever).
                sink.set_terminal(Terminal::ClientGone);
                continue;
            }
        };
        drop(client_tx);
        let Some(envelope) = envelope else {
            break;
        };
        sink.budget.release(envelope.bytes);
        // Every terminal frame ends the job, `tool_use` included: the client
        // resumes through a brand-new job, never back into this one.
        let final_response = match &envelope.item {
            StreamItem::Finished(response) => Some(response.clone()),
            StreamItem::Event(_) => None,
        };
        let Some(tx) = sink.client_tx.lock().await.clone() else {
            sink.set_terminal(Terminal::ClientGone);
            continue;
        };
        let send = tx.send(Ok(envelope.item));
        tokio::pin!(send);
        let deadline = tokio::time::sleep(stall_timeout);
        tokio::pin!(deadline);
        // A `Done` notification must not abandon the envelope mid-send (it may
        // be the Finished frame); only failure terminals abort the delivery.
        let sent = loop {
            tokio::select! {
                biased;
                result = &mut send => break result.map_err(|_| Terminal::ClientGone),
                _ = sink.terminal_notify.notified() => {
                    if sink.terminal_failed() {
                        break Err(Terminal::ClientGone);
                    }
                }
                _ = &mut deadline => break Err(Terminal::ClientTooSlow),
            }
        };
        match sent {
            Ok(()) if final_response.is_some() => {
                sink.client_tx.lock().await.take();
                if let Some(runtime) = runtime.upgrade() {
                    runtime.finish_sent_job(&job_id).await;
                }
                break;
            }
            Ok(()) => {}
            Err(terminal) => {
                sink.set_terminal(terminal);
            }
        }
    }
}

async fn job_watchdog(runtime: Weak<Runtime>) {
    loop {
        let tick = match runtime.upgrade() {
            Some(runtime) => runtime.watchdog_tick(),
            None => return,
        };
        tokio::time::sleep(tick).await;
        let Some(runtime) = runtime.upgrade() else {
            return;
        };
        runtime.watchdog_sweep().await;
        runtime.retire_idle().await;
    }
}

async fn fail_client_stream(sink: &JobSink, terminal: &Terminal) {
    if let Some(tx) = sink.client_tx.lock().await.take() {
        let _ = tx.try_send(Err(terminal.error()));
    }
}

fn stream_item_bytes(item: &StreamItem) -> usize {
    match item {
        StreamItem::Event(event) => event.to_string().len(),
        StreamItem::Finished(response) => {
            serde_json::to_vec(response).map_or(1, |bytes| bytes.len())
        }
    }
}

fn is_lossless_delta(item: &StreamItem) -> bool {
    let StreamItem::Event(event) = item else {
        return true;
    };
    matches!(
        event.get("type").and_then(Value::as_str),
        Some(
            "message_start"
                | "content_block_start"
                | "content_block_delta"
                | "content_block_stop"
                | "message_delta"
                | "message_stop"
        )
    )
}

fn native_stop_reason(reason: &str) -> StopReason {
    match reason {
        "tool_use" => StopReason::ToolUse,
        "max_tokens" => StopReason::MaxTokens,
        "refusal" => StopReason::Refusal,
        "stop_sequence" => StopReason::StopSequence,
        "pause_turn" => StopReason::PauseTurn,
        _ => StopReason::EndTurn,
    }
}

fn usage_from_value(value: &Value) -> Usage {
    Usage {
        input_tokens: value
            .get("input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        output_tokens: value
            .get("output_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        ..Usage::default()
    }
}

fn latest_text(request: &MessageRequest) -> String {
    for message in request.messages.iter().rev() {
        if message.role != "user" {
            continue;
        }
        match &message.content {
            MessageContent::Text(text) => return text.clone(),
            MessageContent::Blocks(blocks) => {
                let mut out = String::new();
                for block in blocks {
                    if let ContentBlock::Text { text, .. } = block {
                        out.push_str(text);
                    }
                }
                if !out.is_empty() {
                    return out;
                }
            }
        }
    }
    String::new()
}

/// In-memory stand-in for the Claude CLI child. It speaks exactly the `*`
/// protocol the real CLI speaks, so tests exercise `write_cli_stdin`,
/// `decode_stdout` and `handle_native_frame` instead of a bespoke fake.
///
/// The request text selects the reply shape: `[use_tool:NAME]` ends the turn
/// on `tool_use`, `[web_search]` emits server tool blocks, anything else
/// answers with a single text block.
///
/// Cancel semantics mirror the real runner: every `cancel` is acked,
/// including one for a job the CLI already finished, and `ping` is
/// answered from the input loop.
/// Simulated CLI: accept the job, emit nothing, but ack a cancel.
const SIM_SILENT_MARKER: &str = "__sim_silent__";
/// Simulated CLI: accept the job, emit nothing, never ack its cancel.
const SIM_HANG_MARKER: &str = "__sim_hang__";
/// Simulated CLI: the input loop stops reading stdin for good (process alive).
const SIM_DEAF_MARKER: &str = "__sim_deaf__";

async fn simulated_cli(
    reader: impl tokio::io::AsyncRead + Unpin,
    writer: impl tokio::io::AsyncWrite + Unpin + Send + 'static,
    slots: usize,
    latency: Duration,
    config_hash: Option<String>,
) {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let writer = Arc::new(Mutex::new(writer));
    let hung: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    let layout = envelope::load();
    let ready = native_protocol::StdoutFrame::HostReady {
        protocol_version: native_protocol::PROTOCOL_VERSION,
        slots,
        system_layout: layout.mode.as_str().to_string(),
        timezone: layout.timezone.clone(),
        capabilities: native_protocol::CAPABILITIES
            .iter()
            .chain([&native_protocol::CAP_PING])
            .map(|cap| (*cap).to_string())
            .collect(),
        config_hash,
    };
    if write_sim_frame(&writer, &ready).await.is_err() {
        return;
    }
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(frame) = serde_json::from_str::<native_protocol::StdinFrame>(&line) else {
            continue;
        };
        match frame {
            native_protocol::StdinFrame::JobStart {
                job_id,
                slot_id,
                request,
                ..
            } => {
                let text = serde_json::from_value::<MessageRequest>(request.clone())
                    .map(|request| latest_text(&request))
                    .unwrap_or_default();
                if text.contains(SIM_DEAF_MARKER) {
                    // The old `await cancelJob` bug: alive, but never reads again.
                    std::future::pending::<()>().await;
                }
                if text.contains(SIM_HANG_MARKER) {
                    // Upstream hung and abort is ignored: no frames, no ack.
                    hung.lock().await.insert(job_id);
                    continue;
                }
                if text.contains(SIM_SILENT_MARKER) {
                    // Upstream hung but the job still honours cancel.
                    continue;
                }
                let writer = Arc::clone(&writer);
                tokio::spawn(async move {
                    simulated_job(writer, job_id, slot_id, request, latency).await;
                });
            }
            native_protocol::StdinFrame::Cancel { job_id, slot_id } => {
                if hung.lock().await.contains(&job_id) {
                    continue;
                }
                let slot_id = slot_id.unwrap_or_default();
                let _ = write_sim_frame(
                    &writer,
                    &native_protocol::StdoutFrame::CancelAck { job_id, slot_id },
                )
                .await;
            }
            native_protocol::StdinFrame::Ping { nonce } => {
                let _ =
                    write_sim_frame(&writer, &native_protocol::StdoutFrame::Pong { nonce }).await;
            }
            native_protocol::StdinFrame::TelemetryEvent { request_id, .. } => {
                let _ = write_sim_frame(
                    &writer,
                    &native_protocol::StdoutFrame::TelemetryAck {
                        request_id,
                        ok: false,
                        error: None,
                    },
                )
                .await;
            }
        }
    }
}

async fn write_sim_frame<W: tokio::io::AsyncWrite + Unpin>(
    writer: &Arc<Mutex<W>>,
    frame: &native_protocol::StdoutFrame,
) -> Result<(), std::io::Error> {
    use tokio::io::AsyncWriteExt;
    let mut line = serde_json::to_vec(frame).unwrap_or_default();
    line.push(b'\n');
    let mut guard = writer.lock().await;
    guard.write_all(&line).await?;
    guard.flush().await
}

async fn simulated_job<W: tokio::io::AsyncWrite + Unpin>(
    writer: Arc<Mutex<W>>,
    job_id: String,
    slot_id: String,
    request: Value,
    latency: Duration,
) {
    let request: MessageRequest = serde_json::from_value(request).unwrap_or_default();
    let model = request.model.clone();
    let text = latest_text(&request);
    let event = |writer: &Arc<Mutex<W>>, event: Value| {
        let writer = Arc::clone(writer);
        let job_id = job_id.clone();
        let slot_id = slot_id.clone();
        async move {
            write_sim_frame(
                &writer,
                &native_protocol::StdoutFrame::StreamEvent {
                    job_id,
                    slot_id,
                    event,
                },
            )
            .await
        }
    };
    // message_start is not gated on the answer: a client must see the turn
    // open before the model produces anything.
    if event(
        &writer,
        json!({
            "type": "message_start",
            "message": { "id": format!("msg_{job_id}"), "model": model, "usage": {} }
        }),
    )
    .await
    .is_err()
    {
        return;
    }
    tokio::time::sleep(latency).await;
    let (stop_reason, usage) = if let Some(tool) = text
        .split("[use_tool:")
        .nth(1)
        .and_then(|part| part.split(']').next())
    {
        let tool_id = new_id("toolu");
        let _ = event(
            &writer,
            json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": { "type": "tool_use", "id": tool_id, "name": tool, "input": {} }
            }),
        )
        .await;
        let _ = event(
            &writer,
            json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "input_json_delta", "partial_json": "{\"echo\":true}" }
            }),
        )
        .await;
        let _ = event(&writer, json!({"type": "content_block_stop", "index": 0})).await;
        ("tool_use", json!({ "output_tokens": 4 }))
    } else if text.contains("[web_search]") {
        for block in [
            json!({ "type": "server_tool_use", "id": "srvtoolu_sim", "name": "web_search", "input": { "query": text } }),
            json!({ "type": "web_search_tool_result", "tool_use_id": "srvtoolu_sim", "content": [] }),
        ] {
            let _ = event(
                &writer,
                json!({ "type": "content_block_start", "index": 0, "content_block": block }),
            )
            .await;
            let _ = event(&writer, json!({"type": "content_block_stop", "index": 0})).await;
        }
        let _ = event(
            &writer,
            json!({
                "type": "content_block_start",
                "index": 1,
                "content_block": { "type": "text", "text": "" }
            }),
        )
        .await;
        let _ = event(
            &writer,
            json!({
                "type": "content_block_delta",
                "index": 1,
                "delta": { "type": "text_delta", "text": "search-complete" }
            }),
        )
        .await;
        let _ = event(&writer, json!({"type": "content_block_stop", "index": 1})).await;
        ("end_turn", json!({ "web_search_requests": 1 }))
    } else {
        let reply = format!("slot {slot_id} :: {text}");
        let _ = event(
            &writer,
            json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": { "type": "text", "text": "" }
            }),
        )
        .await;
        let _ = event(
            &writer,
            json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "text_delta", "text": reply }
            }),
        )
        .await;
        let _ = event(&writer, json!({"type": "content_block_stop", "index": 0})).await;
        ("end_turn", json!({ "output_tokens": 8 }))
    };
    let _ = event(
        &writer,
        json!({ "type": "message_delta", "delta": { "stop_reason": stop_reason }, "usage": usage }),
    )
    .await;
    let _ = event(&writer, json!({ "type": "message_stop" })).await;
    let _ = write_sim_frame(
        &writer,
        &native_protocol::StdoutFrame::JobDone {
            job_id,
            slot_id,
            stop_reason: stop_reason.to_string(),
            usage,
        },
    )
    .await;
}

fn ensure_socks_http_bridge() -> Result<(), KernelError> {
    if env::var("BRIDGE_HTTPS_PROXY")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
    {
        return Ok(());
    }
    let socks = env::var("SOCKS5").unwrap_or_default();
    if socks.trim().is_empty() {
        return Ok(());
    }
    let listen = env::var("HTTP_BRIDGE_ADDR").unwrap_or_else(|_| "127.0.0.1:18080".into());
    let proxy = format!("http://{listen}");
    // SAFETY: boot-time only, before CLI spawn.
    unsafe {
        env::set_var("BRIDGE_HTTPS_PROXY", &proxy);
        env::set_var("HTTP_BRIDGE_ADDR", &listen);
    }
    let script = http_to_socks_script();
    let mut child = std::process::Command::new("python3")
        .arg(&script)
        .env("SOCKS5", socks)
        .env("HTTP_BRIDGE_ADDR", &listen)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|err| KernelError::Provider(format!("http_to_socks spawn: {err}")))?;
    std::thread::sleep(Duration::from_millis(200));
    if let Ok(Some(status)) = child.try_wait() {
        return Err(KernelError::Provider(format!(
            "http_to_socks exited {status}"
        )));
    }
    std::mem::forget(child);
    tracing::info!(proxy = %proxy, "cli https proxy -> socks5 bridge");
    Ok(())
}

fn http_to_socks_script() -> PathBuf {
    if let Ok(path) = env::var("HTTP_TO_SOCKS") {
        return PathBuf::from(path);
    }
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into()));
    for candidate in [
        manifest.join("../../scripts/http_to_socks.py"),
        manifest.join("../scripts/http_to_socks.py"),
        PathBuf::from("service/scripts/http_to_socks.py"),
        PathBuf::from("scripts/http_to_socks.py"),
    ] {
        if candidate.exists() {
            return candidate;
        }
    }
    manifest.join("../../scripts/http_to_socks.py")
}

/// Charges `line_len` bytes against `job_id`'s running total in `job_bytes`
/// and reports whether that job has now exceeded `MAX_JOB_BYTES`, so one
/// runaway job's stdout can't starve other concurrent jobs sharing the same
/// CLI process.
fn charge_job_bytes(job_bytes: &mut HashMap<String, usize>, key: &str, line_len: usize) -> bool {
    let used = job_bytes.entry(key.to_string()).or_insert(0);
    *used = used.saturating_add(line_len);
    *used > native_protocol::MAX_JOB_BYTES
}

async fn decode_stdout(
    runtime: Arc<Runtime>,
    stdout: impl tokio::io::AsyncRead + Unpin,
    generation: u64,
) {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut lines = BufReader::new(stdout).lines();
    let mut job_bytes: HashMap<String, usize> = HashMap::new();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => {
                runtime
                    .host_lost(generation, "native cli stdout closed".into())
                    .await;
                return;
            }
            Err(err) => {
                runtime
                    .host_lost(generation, format!("native cli stdout read failed: {err}"))
                    .await;
                return;
            }
        };
        let _gate = runtime.frame_gate.lock().await;
        if runtime.host_gen.load(Ordering::Acquire) != generation {
            // A replaced CLI process: its leftovers must not touch the new one.
            return;
        }
        runtime.note_frame();
        if line.len() > native_protocol::MAX_LINE_BYTES {
            continue;
        }
        let Ok(frame) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(key) = frame.get("job_id").and_then(Value::as_str) {
            runtime.note_stdout(key, line.len()).await;
            if charge_job_bytes(&mut job_bytes, key, line.len()) {
                continue;
            }
        }
        runtime.handle_cli_frame(frame).await;
    }
}

pub struct MultiplexCliProvider {
    cfg: MultiplexConfig,
    runtime: OnceCell<Arc<Runtime>>,
}

impl MultiplexCliProvider {
    pub fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        Ok(Self {
            cfg: MultiplexConfig::from_env()?,
            runtime: OnceCell::new(),
        })
    }

    pub fn from_cfg(cfg: MultiplexConfig) -> Self {
        Self {
            cfg,
            runtime: OnceCell::new(),
        }
    }

    #[cfg(test)]
    pub fn simulated(slot_count: usize) -> Self {
        Self {
            cfg: MultiplexConfig {
                slot_count,
                simulate: true,
                bin: PathBuf::from("simulated"),
                mock_bin: true,
                model: "claude-sonnet-5".into(),
                session_idle_ttl: Duration::from_secs(600),
                panel_config_path: None,
                simulate_latency: Duration::from_millis(60),
                continuation_ttl_secs: 600,
                client_stall_timeout: Duration::from_secs(crate::config::DEFAULT_CLIENT_STALL_SECS),
                job_idle_timeout: Duration::from_secs(crate::config::DEFAULT_JOB_IDLE_SECS),
                cancel_ack_timeout: Duration::from_secs(crate::config::DEFAULT_CANCEL_ACK_SECS),
                submit_wait: Duration::from_millis(200),
                desired_config_hash: None,
                session_dir: None,
                recovery: RecoveryConfig::default(),
            },
            runtime: OnceCell::new(),
        }
    }

    /// `/internal/v1/cancel`: false when the request is unknown or already gone.
    pub async fn cancel_request(&self, request_id: &str) -> bool {
        match self.runtime.get() {
            Some(runtime) => runtime.cancel_request(request_id).await,
            None => false,
        }
    }

    pub async fn submit_telemetry(
        &self,
        event: telemetry::TelemetryEvent,
    ) -> Result<Uuid, telemetry::TelemetryError> {
        let runtime = self
            .runtime
            .get()
            .ok_or(telemetry::TelemetryError::Unavailable)?;
        runtime
            .queue_telemetry(event)
            .await?
            .await
            .map_err(|_| telemetry::TelemetryError::Unavailable)?
    }

    pub async fn telemetry_health(&self) -> Value {
        match self.runtime.get() {
            Some(runtime) => runtime.telemetry_health().await,
            None => json!({
                "vm_telemetry": false, "telemetry_ready": false, "telemetry": null,
                "native_host": null, "capabilities": null,
            }),
        }
    }
    async fn runtime(&self) -> Result<&Arc<Runtime>, KernelError> {
        self.runtime
            .get_or_try_init(|| async {
                let runtime = Runtime::new(self.cfg.clone());
                runtime.start().await?;
                Ok(runtime)
            })
            .await
    }
}

#[async_trait]
impl Provider for MultiplexCliProvider {
    fn name(&self) -> &'static str {
        "local_cli"
    }

    async fn boot(&self) -> Result<(), KernelError> {
        self.runtime().await.map(|_| ())
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            streaming: true,
            resume: true,
            multiplex_slots: true,
            native_tool_wait: true,
            cancel_receipt: true,
        }
    }

    fn session_pid(&self, _session_id: &str) -> Option<u32> {
        self.runtime.get().map(|runtime| runtime.pid())
    }

    fn session_slot(&self, session_id: &str) -> Option<String> {
        self.runtime
            .get()
            .and_then(|runtime| runtime.session_slot(session_id))
    }

    fn config_hash_mismatch(&self) -> bool {
        self.runtime
            .get()
            .map(|runtime| runtime.config_hash_mismatch())
            .unwrap_or(false)
    }

    fn memory_snapshot(&self) -> Option<serde_json::Value> {
        self.runtime.get().map(|runtime| {
            let mut value =
                serde_json::to_value(runtime.memory.snapshot()).unwrap_or(serde_json::Value::Null);
            if let Some(obj) = value.as_object_mut() {
                obj.insert("peak_running".into(), json!(runtime.peak_running()));
                obj.insert("running".into(), json!(runtime.running_jobs()));
                obj.insert("ready_slots".into(), json!(runtime.ready_slots()));
                obj.insert(
                    "classifier_request_context".into(),
                    json!(runtime.classifier_context_supported.load(Ordering::Relaxed)),
                );
                obj.insert("closed_slots".into(), json!(runtime.closed_slots()));
                obj.insert(
                    "cli_restarts".into(),
                    json!(runtime.cli_restarts.load(Ordering::Relaxed)),
                );
                obj.insert(
                    "recovering".into(),
                    json!(runtime.recovering.load(Ordering::Relaxed)),
                );
                let unhealthy = runtime.unhealthy_reason();
                obj.insert("healthy".into(), json!(unhealthy.is_none()));
                obj.insert("unhealthy_reason".into(), json!(unhealthy));
                if let Ok(host) = runtime.native_host.try_lock()
                    && let Some(info) = host.as_ref()
                {
                    obj.insert("native_host".into(), json!(info));
                }
            }
            value
        })
    }

    async fn execute_stream(
        &self,
        request: &MessageRequest,
        context: &ExecutionContext,
    ) -> Result<crate::provider::StreamRx, KernelError> {
        let runtime = Arc::clone(self.runtime().await?);
        let (tx, rx) = job_event_channel();
        let request = request.clone();
        let context = context.clone();
        // Complete a JSONL write and teardown even when the HTTP future drops.
        tokio::spawn(async move { runtime.submit(request, context, tx).await })
            .await
            .map_err(|_| KernelError::Internal)??;
        Ok(rx)
    }
}

#[cfg(test)]
mod tests {
    use super::slot::SlotPhase;
    use super::*;
    use crate::model::{Message, ToolDefinition};
    use crate::provider::stream_channel;
    use std::{
        io,
        pin::Pin,
        task::{Context, Poll},
    };
    use tokio::io::AsyncWrite;
    use tokio::time::timeout;

    struct BrokenPipeWriter;

    impl AsyncWrite for BrokenPipeWriter {
        fn poll_write(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            _buf: &[u8],
        ) -> Poll<io::Result<usize>> {
            Poll::Ready(Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "broken pipe",
            )))
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    fn ctx(session: &str, resumed: bool) -> ExecutionContext {
        ExecutionContext {
            tenant_id: "demo".into(),
            session_id: session.into(),
            worker_id: "runtime-00".into(),
            worker_generation: 1,
            resumed,
            request_id: String::new(),
            request_context: None,
            auto_compact_window: None,
        }
    }

    fn text_request(text: &str) -> MessageRequest {
        MessageRequest {
            model: "claude-sonnet-5".into(),
            messages: vec![Message {
                role: "user".into(),
                content: MessageContent::Text(text.into()),
                tool_call_id: None,
                tool_calls: Vec::new(),
                extra: Default::default(),
            }],
            tools: vec![ToolDefinition {
                name: "echo".into(),
                description: "echo".into(),
                input_schema: json!({"type":"object"}),
                cache_control: None,
                tool_type: None,
                extra: Default::default(),
            }],
            max_tokens: 128,
            stream: false,
            ..MessageRequest::default()
        }
    }

    #[test]
    fn admission_size_includes_large_single_message() {
        let request = text_request(&"x".repeat(2 * 1024 * 1024));
        assert_eq!(request.messages.len(), 1);
        assert!(serialized_request_bytes(&request).unwrap() > 2 * 1024 * 1024);
    }

    fn test_cfg(stall: Duration) -> MultiplexConfig {
        MultiplexConfig {
            slot_count: 1,
            simulate: true,
            bin: PathBuf::from("simulated"),
            mock_bin: true,
            model: "claude-sonnet-5".into(),
            session_idle_ttl: Duration::from_secs(600),
            panel_config_path: None,
            simulate_latency: Duration::from_millis(1),
            continuation_ttl_secs: 600,
            client_stall_timeout: stall,
            job_idle_timeout: Duration::from_secs(crate::config::DEFAULT_JOB_IDLE_SECS),
            cancel_ack_timeout: Duration::from_secs(crate::config::DEFAULT_CANCEL_ACK_SECS),
            submit_wait: Duration::from_millis(200),
            desired_config_hash: None,
            session_dir: None,
            recovery: RecoveryConfig::default(),
        }
    }

    #[tokio::test]
    async fn panel_idle_timeout_hot_reload_preserves_active_jobs_and_last_completion() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("kernel.json");
        std::fs::write(&path, r#"{"session_idle_ttl_seconds":3600}"#).unwrap();
        let mut cfg = test_cfg(Duration::from_secs(1));
        cfg.panel_config_path = Some(path.clone());
        let runtime = Runtime::new(cfg);
        let idle_since = Instant::now() - Duration::from_secs(90);
        for (id, phase) in [
            ("idle", SlotPhase::ReadyBlocked),
            ("active", SlotPhase::Running),
        ] {
            let mut slot = Slot::new(id);
            slot.phase = phase;
            slot.tenant_id = Some("demo".into());
            slot.session_id = Some(id.into());
            slot.last_change = idle_since;
            runtime.slots.lock().await.push(slot);
        }
        runtime.retire_idle().await;
        assert_eq!(runtime.slots.lock().await[0].last_change, idle_since);
        assert_eq!(
            runtime.slots.lock().await[0].session_id.as_deref(),
            Some("idle")
        );

        std::fs::write(&path, r#"{"session_idle_ttl_seconds":60}"#).unwrap();
        runtime.retire_idle().await;
        let slots = runtime.slots.lock().await;
        assert_eq!(slots[0].session_id, None);
        assert_eq!(slots[1].session_id.as_deref(), Some("active"));
        assert_eq!(slots[1].phase, SlotPhase::Running);
        assert_eq!(slots[1].last_change, idle_since);
        drop(slots);

        std::fs::write(&path, r#"{"session_idle_ttl_seconds":0}"#).unwrap();
        assert_eq!(runtime.session_idle_ttl().await, Duration::from_secs(60));
    }

    #[tokio::test]
    async fn idle_session_releases_slot_for_reuse() {
        let runtime = Runtime::new(test_cfg(Duration::from_secs(1)));
        let slot_id = "s00".to_string();
        let mut slot = Slot::new(slot_id.clone());
        slot.phase = SlotPhase::ReadyBlocked;
        slot.tenant_id = Some("demo".into());
        slot.session_id = Some("idle-session".into());
        slot.last_change = Instant::now() - Duration::from_secs(601);
        runtime.slots.lock().await.push(slot);
        {
            let mut sched = runtime.sched.lock().await;
            sched.enqueue_ready(slot_id.clone());
            sched.bind_sticky("demo\u{1f}idle-session".into(), slot_id.clone());
        }

        runtime.retire_idle().await;

        let mut slots = runtime.slots.lock().await;
        let slot = slots.iter_mut().find(|slot| slot.id == slot_id).unwrap();
        assert_eq!(slot.phase, SlotPhase::ReadyBlocked);
        assert_eq!(slot.session_id, None);
        assert_eq!(slot.tenant_id, None);
        let mut sched = runtime.sched.lock().await;
        assert_eq!(
            sched.pick(&mut slots, "other", "new-session").unwrap(),
            slot_id
        );
        assert!(slots[0].bind_job("other", "new-session", "job"));
    }

    fn delta(text: &str) -> StreamItem {
        StreamItem::Event(json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "text_delta", "text": text }
        }))
    }

    fn stage_event(name: &str) -> StreamItem {
        StreamItem::Event(json!({ "type": name }))
    }

    fn structural_start() -> StreamItem {
        StreamItem::Event(json!({
            "type": "content_block_start",
            "index": 0,
            "content_block": { "type": "text", "text": "" }
        }))
    }

    fn finished_response() -> StreamItem {
        StreamItem::Finished(MessageResponse {
            id: "msg_test".into(),
            r#type: "message",
            role: "assistant",
            model: "claude-sonnet-5".into(),
            content: vec![ContentBlock::Text {
                text: "done".into(),
                cache_control: None,
            }],
            stop_reason: StopReason::EndTurn,
            stop_sequence: None,
            usage: Usage::default(),
        })
    }

    async fn wait_for_overflow(sink: &JobSink) {
        timeout(Duration::from_secs(1), async {
            loop {
                if matches!(sink.terminal.get(), Some(Terminal::Overflow)) {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("overflow terminal");
    }

    async fn collect(
        provider: &MultiplexCliProvider,
        request: MessageRequest,
        context: ExecutionContext,
    ) -> Result<MessageResponse, KernelError> {
        let rx = provider.execute_stream(&request, &context).await?;
        crate::provider::collect_stream(rx).await
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fast_consumer_receives_all_deltas() {
        let runtime = Runtime::new(test_cfg(Duration::from_secs(1)));
        let (tx, mut rx) = mpsc::channel(64);
        runtime.start_job_sink("job-fast".into(), tx).await;

        for index in 0..24 {
            assert_eq!(
                runtime
                    .emit("job-fast", delta(&format!("chunk-{index};")))
                    .await,
                EmitResult::Sent
            );
        }
        assert_eq!(
            runtime.emit("job-fast", finished_response()).await,
            EmitResult::Sent
        );

        let mut deltas = Vec::new();
        let mut finished = false;
        while let Some(item) = timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("stream item")
        {
            match item.unwrap() {
                StreamItem::Event(event) => {
                    if event.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta") {
                        deltas.push(event["delta"]["text"].as_str().unwrap_or("").to_string());
                    }
                }
                StreamItem::Finished(_) => {
                    finished = true;
                    break;
                }
            }
        }
        assert!(finished);
        assert_eq!(deltas.len(), 24);
        assert_eq!(deltas[0], "chunk-0;");
        assert_eq!(deltas[23], "chunk-23;");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn final_finished_sets_done_only_after_client_delivery() {
        let runtime = Runtime::new(test_cfg(Duration::from_secs(1)));
        let (tx, mut rx) = mpsc::channel(8);
        runtime.start_job_sink("job-done".into(), tx).await;
        let sink = runtime
            .sinks
            .lock()
            .await
            .get("job-done")
            .cloned()
            .expect("sink");

        assert_eq!(
            runtime.emit("job-done", finished_response()).await,
            EmitResult::Sent
        );
        assert!(matches!(
            timeout(Duration::from_secs(1), rx.recv())
                .await
                .expect("finished")
                .expect("finished")
                .unwrap(),
            StreamItem::Finished(_)
        ));
        timeout(Duration::from_secs(1), async {
            loop {
                if matches!(sink.terminal.get(), Some(Terminal::Done)) {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("done terminal");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn oversized_delta_overflow_sends_explicit_error() {
        let runtime = Runtime::new(test_cfg(Duration::from_secs(1)));
        let (tx, mut rx) = mpsc::channel(8);
        runtime.start_job_sink("job-big".into(), tx).await;

        let big = "x".repeat(JOB_SINK_BYTES + 1);
        assert_eq!(
            runtime.emit("job-big", delta(&big)).await,
            EmitResult::Failed
        );

        let item = timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("error item")
            .expect("error item");
        assert!(item.is_err(), "{item:?}");
        assert!(rx.recv().await.is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn queue_full_text_delta_sets_overflow_terminal() {
        let runtime = Runtime::new(test_cfg(Duration::from_secs(1)));
        let (tx, _rx) = mpsc::channel(1);
        runtime.start_job_sink("job-full".into(), tx).await;
        let sink = runtime
            .sinks
            .lock()
            .await
            .get("job-full")
            .cloned()
            .expect("sink");

        for index in 0..(JOB_SINK_ITEMS + 32) {
            let _ = runtime
                .emit("job-full", delta(&format!("chunk-{index}")))
                .await;
        }

        wait_for_overflow(&sink).await;
        assert!(sink.terminal_failed());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn queue_full_structural_event_sets_overflow_terminal() {
        let runtime = Runtime::new(test_cfg(Duration::from_secs(1)));
        let (tx, _rx) = mpsc::channel(1);
        runtime.start_job_sink("job-struct-full".into(), tx).await;
        let sink = runtime
            .sinks
            .lock()
            .await
            .get("job-struct-full")
            .cloned()
            .expect("sink");

        for _ in 0..(JOB_SINK_ITEMS + 8) {
            let _ = runtime.emit("job-struct-full", structural_start()).await;
        }

        wait_for_overflow(&sink).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stalled_client_never_receives_success_finish() {
        let runtime = Runtime::new(test_cfg(Duration::from_millis(20)));
        let (tx, mut rx) = mpsc::channel(1);
        runtime.start_job_sink("job-stalled".into(), tx).await;
        let sink = runtime
            .sinks
            .lock()
            .await
            .get("job-stalled")
            .cloned()
            .expect("sink");

        assert_eq!(
            runtime
                .emit("job-stalled", stage_event("message_start"))
                .await,
            EmitResult::Sent
        );
        assert_eq!(
            runtime.emit("job-stalled", finished_response()).await,
            EmitResult::Sent
        );

        tokio::time::sleep(Duration::from_millis(80)).await;
        let mut saw_finished = false;
        while let Some(item) = rx.recv().await {
            if matches!(item.unwrap(), StreamItem::Finished(_)) {
                saw_finished = true;
            }
        }
        assert!(!saw_finished);
        assert!(matches!(sink.terminal.get(), Some(Terminal::ClientTooSlow)));
        assert!(!matches!(sink.terminal.get(), Some(Terminal::Done)));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn submit_retries_through_slot_reentry_gap() {
        // FAIL-3 in the 20-way live test: a burst submission can land in the
        // window where a slot has finished its job but has not yet re-entered
        // slot_wait, seeing a spurious NoCapacity. submit must wait it out.
        let provider = MultiplexCliProvider::simulated(1);
        provider.runtime().await.expect("start");
        let runtime = Arc::clone(provider.runtime.get().unwrap());
        // Occupy the only slot, then submit again while it is busy: the retry
        // loop should pick it up as soon as the first job completes.
        let (tx1, rx1) = stream_channel();
        runtime
            .submit(text_request("first"), ctx("sess-gap-1", false), tx1)
            .await
            .unwrap();
        let second = {
            let runtime = Arc::clone(&runtime);
            tokio::spawn(async move {
                let (tx2, rx2) = stream_channel();
                runtime
                    .submit(text_request("second"), ctx("sess-gap-2", false), tx2)
                    .await?;
                crate::provider::collect_stream(rx2).await
            })
        };
        let first = crate::provider::collect_stream(rx1).await.unwrap();
        assert!(matches!(first.stop_reason, StopReason::EndTurn));
        let second = timeout(Duration::from_secs(5), second)
            .await
            .expect("second submit within retry window")
            .unwrap()
            .unwrap();
        assert!(matches!(second.stop_reason, StopReason::EndTurn));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn one_pid_five_parallel_slots() {
        let shared = MultiplexCliProvider::simulated(5);
        shared.runtime().await.expect("start");
        let pid = shared.session_pid("any").expect("pid");
        let mut joins = Vec::new();
        for index in 0..5 {
            let request = text_request(&format!("hello {index}"));
            let context = ctx(&format!("sess-{index}"), false);
            let runtime = Arc::clone(shared.runtime.get().unwrap());
            joins.push(tokio::spawn(async move {
                let (tx, rx) = stream_channel();
                runtime.submit(request, context, tx).await.unwrap();
                crate::provider::collect_stream(rx).await
            }));
        }
        let mut texts = Vec::new();
        for join in joins {
            let response = timeout(Duration::from_secs(5), join)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert!(matches!(response.stop_reason, StopReason::EndTurn));
            assert_eq!(shared.session_pid("x").unwrap(), pid);
            if let ContentBlock::Text { text, .. } = &response.content[0] {
                texts.push(text.clone());
            }
        }
        assert_eq!(texts.len(), 5);
        assert!(shared.runtime.get().unwrap().peak_running() >= 2);
        assert_eq!(
            shared.runtime.get().unwrap().snapshots().await.len(),
            5,
            "each job must land on its own slot"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn two_tool_calls_resume_independently() {
        let provider = MultiplexCliProvider::simulated(2);
        let first = collect(
            &provider,
            text_request("please [use_tool:echo] now"),
            ctx("sess-tool-a", false),
        )
        .await
        .unwrap();
        let second = collect(
            &provider,
            text_request("please [use_tool:echo] now"),
            ctx("sess-tool-b", false),
        )
        .await
        .unwrap();
        assert!(matches!(first.stop_reason, StopReason::ToolUse));
        assert!(matches!(second.stop_reason, StopReason::ToolUse));
        let id_a = match &first.content[0] {
            ContentBlock::ToolUse { id, .. } => id.clone(),
            _ => panic!("tool a"),
        };
        let id_b = match &second.content[0] {
            ContentBlock::ToolUse { id, .. } => id.clone(),
            _ => panic!("tool b"),
        };
        assert_ne!(id_a, id_b);
        let resume = |id: String| MessageRequest {
            model: "claude-sonnet-5".into(),
            messages: vec![Message {
                role: "user".into(),
                content: MessageContent::Blocks(vec![ContentBlock::ToolResult {
                    tool_use_id: id,
                    content: json!("ok"),
                    is_error: false,
                    cache_control: None,
                }]),
                tool_call_id: None,
                tool_calls: Vec::new(),
                extra: Default::default(),
            }],
            max_tokens: 32,
            stream: false,
            ..MessageRequest::default()
        };
        let a = collect(&provider, resume(id_a), ctx("sess-tool-a", true))
            .await
            .unwrap();
        let b = collect(&provider, resume(id_b), ctx("sess-tool-b", true))
            .await
            .unwrap();
        assert!(matches!(a.stop_reason, StopReason::EndTurn));
        assert!(matches!(b.stop_reason, StopReason::EndTurn));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn one_pid_twenty_parallel_slots() {
        let shared = MultiplexCliProvider::simulated(20);
        shared.runtime().await.expect("start");
        let pid = shared.session_pid("any").expect("pid");
        let started = std::time::Instant::now();
        let mut joins = Vec::new();
        for index in 0..20 {
            let request = text_request(&format!("hello {index}"));
            let context = ctx(&format!("sess-20-{index}"), false);
            let runtime = Arc::clone(shared.runtime.get().unwrap());
            joins.push(tokio::spawn(async move {
                let (tx, rx) = stream_channel();
                runtime.submit(request, context, tx).await.unwrap();
                crate::provider::collect_stream(rx).await
            }));
        }
        let mut texts = Vec::new();
        for join in joins {
            let response = timeout(Duration::from_secs(5), join)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert_eq!(shared.session_pid("x").unwrap(), pid);
            if let ContentBlock::Text { text, .. } = &response.content[0] {
                texts.push(text.clone());
            }
        }
        let elapsed = started.elapsed();
        assert_eq!(texts.len(), 20);
        let unique: std::collections::HashSet<_> = texts.into_iter().collect();
        assert_eq!(unique.len(), 20, "outputs must not mix across slots");
        assert!(
            elapsed < Duration::from_millis(800),
            "20 slots should overlap, elapsed={elapsed:?}"
        );
        assert!(shared.runtime.get().unwrap().peak_running() >= 10);
        let slots = shared.runtime.get().unwrap().snapshots().await;
        assert_eq!(slots.len(), 20, "20 slots must stay distinct");
    }

    #[tokio::test]
    async fn memory_guard_rejects_when_rss_is_over_limit() {
        let provider = MultiplexCliProvider::simulated(2);
        provider.runtime().await.expect("start");
        provider
            .runtime
            .get()
            .unwrap()
            .memory
            .set_rss_override(4 * crate::provider::multiplex_cli::memory_guard::GIB);
        let err = collect(&provider, text_request("hello"), ctx("sess-oom", false))
            .await
            .unwrap_err();
        assert!(matches!(err, KernelError::Overloaded { .. }));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn message_start_arrives_before_slot_finishes() {
        let provider = MultiplexCliProvider::simulated(1);
        let rx = provider
            .execute_stream(&text_request("hello stream"), &ctx("sess-stream", false))
            .await
            .unwrap();
        let mut rx = rx;
        let first = timeout(Duration::from_millis(40), rx.recv())
            .await
            .expect("message_start should not wait for the slot")
            .unwrap()
            .unwrap();
        match first {
            StreamItem::Event(event) => {
                assert_eq!(
                    event.get("type").and_then(Value::as_str),
                    Some("message_start")
                );
            }
            other => panic!("expected message_start, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stdout_text_is_one_block_not_fake_tokens() {
        let provider = MultiplexCliProvider::simulated(1);
        let rx = provider
            .execute_stream(&text_request("hello stream"), &ctx("sess-block", false))
            .await
            .unwrap();
        let mut deltas = Vec::new();
        let mut types = Vec::new();
        let mut rx = rx;
        while let Some(item) = rx.recv().await {
            match item.unwrap() {
                StreamItem::Event(event) => {
                    types.push(
                        event
                            .get("type")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    );
                    if event.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta") {
                        deltas.push(event["delta"]["text"].as_str().unwrap_or("").to_string());
                    }
                }
                StreamItem::Finished(_) => {}
            }
        }
        assert_eq!(types.first().map(String::as_str), Some("message_start"));
        assert_eq!(deltas.len(), 1, "do not fake-chunk: {deltas:?}");
        assert!(deltas[0].contains("hello stream"), "{}", deltas[0]);
        assert!(types.iter().any(|t| t == "message_delta"));
        assert!(types.iter().any(|t| t == "message_stop"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn web_search_frames_are_forwarded() {
        let provider = MultiplexCliProvider::simulated(1);
        let rx = provider
            .execute_stream(
                &text_request("please [web_search] now"),
                &ctx("sess-ws", false),
            )
            .await
            .unwrap();
        let mut block_types = Vec::new();
        let mut deltas = Vec::new();
        let mut rx = rx;
        while let Some(item) = rx.recv().await {
            if let StreamItem::Event(event) = item.unwrap() {
                if event.get("type").and_then(Value::as_str) == Some("content_block_start") {
                    block_types.push(
                        event["content_block"]["type"]
                            .as_str()
                            .unwrap_or("")
                            .to_string(),
                    );
                }
                if event.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta") {
                    deltas.push(event["delta"]["text"].as_str().unwrap_or("").to_string());
                }
            }
        }
        assert!(
            block_types.contains(&"server_tool_use".to_string()),
            "{block_types:?}"
        );
        assert!(
            block_types.contains(&"web_search_tool_result".to_string()),
            "{block_types:?}"
        );
        assert!(block_types.contains(&"text".to_string()), "{block_types:?}");
        assert_eq!(deltas, vec!["search-complete".to_string()]);
        assert!(
            !deltas.iter().any(|d| d.contains("DUPLICATE_FROM_DONE")),
            "{deltas:?}"
        );
    }

    /// AC13: a single job's stdout metering trips `MAX_JOB_BYTES` once its
    /// cumulative line bytes exceed the cap, while a concurrent job sharing
    /// the same CLI PID keeps accumulating independently and is unaffected.
    #[test]
    fn job_byte_metering_trips_only_the_oversized_job() {
        let mut job_bytes: HashMap<String, usize> = HashMap::new();

        // Job "big" steadily approaches the cap without tripping it yet.
        assert!(!charge_job_bytes(
            &mut job_bytes,
            "job-big",
            native_protocol::MAX_JOB_BYTES - 100
        ));
        // A concurrent job on the same PID has its own independent budget.
        assert!(!charge_job_bytes(&mut job_bytes, "job-small", 50));

        // "big" now crosses the cap and truncation should engage for it.
        assert!(charge_job_bytes(&mut job_bytes, "job-big", 200));
        // Once tripped, further bytes for the same job stay tripped.
        assert!(charge_job_bytes(&mut job_bytes, "job-big", 1));

        // "small" is completely unaffected by "big" having been truncated.
        assert!(!charge_job_bytes(&mut job_bytes, "job-small", 50));
    }

    #[test]
    fn validate_host_ready_rejects_config_hash_mismatch() {
        let mut cfg = test_cfg(Duration::from_secs(1));
        cfg.slot_count = 1;
        cfg.desired_config_hash = Some("expected-hash".into());
        let runtime = Runtime::new(cfg);
        let expected_envelope = envelope::load();
        let capabilities: Vec<String> = native_protocol::CAPABILITIES
            .iter()
            .map(|s| s.to_string())
            .collect();

        let err = runtime
            .validate_host_ready(
                native_protocol::PROTOCOL_VERSION,
                1,
                expected_envelope.mode.as_str(),
                &expected_envelope.timezone,
                &capabilities,
                Some("wrong-hash"),
            )
            .expect_err("mismatched config_hash must be rejected");
        assert!(
            err.contains("config_hash mismatch"),
            "unexpected error: {err}"
        );

        runtime
            .validate_host_ready(
                native_protocol::PROTOCOL_VERSION,
                1,
                expected_envelope.mode.as_str(),
                &expected_envelope.timezone,
                &capabilities,
                Some("expected-hash"),
            )
            .expect("matching config_hash must be accepted");
    }

    /// AC3: a native_messages job that ends on `tool_use` must assemble the
    /// correct `ContentBlock::ToolUse` from `stream_event` frames alone
    /// (CLI sends empty `stop_reason`/`usage` in `job_done`, per
    /// APPLY.md's second protocol-defect fix), free its slot once the
    /// response is delivered, and accept a second job on that same slot
    /// carrying the matching `ContentBlock::ToolResult` through to
    /// `StopReason::EndTurn`. This drives `handle_cli_frame()` directly
    /// (bypassing `submit()`/`resume()`, which require a real CLI child
    /// process for `write_cli_stdin()`) — see APPLY.md for the scope note.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn native_messages_tool_use_resume_round_trip() {
        let runtime = Runtime::new(test_cfg(Duration::from_secs(1)));
        let slot_id = "s00".to_string();
        runtime.register_native_ready(slot_id.clone()).await;

        // Turn 1: request ends on tool_use.
        let job_id_1 = "job-ac3-1".to_string();
        runtime.jobs.lock().await.insert(
            job_id_1.clone(),
            Job {
                job_id: job_id_1.clone(),
                slot_id: slot_id.clone(),
                request: text_request("please call echo"),
                ..Job::default()
            },
        );
        let (tx1, mut rx1) = mpsc::channel(64);
        runtime.start_job_sink(job_id_1.clone(), tx1).await;

        runtime
            .handle_cli_frame(json!({
                "type": "stream_event",
                "job_id": job_id_1,
                "slot_id": slot_id,
                "event": {
                    "type": "message_start",
                    "message": { "id": "msg_1", "model": "claude-sonnet-5", "usage": {} }
                }
            }))
            .await;
        runtime
            .handle_cli_frame(json!({
                "type": "stream_event",
                "job_id": job_id_1,
                "slot_id": slot_id,
                "event": {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": { "type": "tool_use", "id": "toolu_1", "name": "echo", "input": {} }
                }
            }))
            .await;
        for chunk in ["{\"te", "xt\":\"", "hi\"}"] {
            runtime
                .handle_cli_frame(json!({
                    "type": "stream_event",
                    "job_id": job_id_1,
                    "slot_id": slot_id,
                    "event": {
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": { "type": "input_json_delta", "partial_json": chunk }
                    }
                }))
                .await;
        }
        runtime
            .handle_cli_frame(json!({
                "type": "stream_event",
                "job_id": job_id_1,
                "slot_id": slot_id,
                "event": { "type": "content_block_stop", "index": 0 }
            }))
            .await;
        runtime
            .handle_cli_frame(json!({
                "type": "stream_event",
                "job_id": job_id_1,
                "slot_id": slot_id,
                "event": {
                    "type": "message_delta",
                    "delta": { "stop_reason": "tool_use" },
                    "usage": { "output_tokens": 12, "input_tokens": 34 }
                }
            }))
            .await;
        runtime
            .handle_cli_frame(json!({
                "type": "job_done",
                "job_id": job_id_1,
                "slot_id": slot_id,
                "stop_reason": "",
                "usage": {}
            }))
            .await;

        let response_1 = loop {
            match timeout(Duration::from_secs(1), rx1.recv())
                .await
                .expect("turn 1 stream item")
                .expect("turn 1 channel open")
                .expect("turn 1 item ok")
            {
                StreamItem::Finished(response) => break response,
                StreamItem::Event(_) => continue,
            }
        };
        assert!(matches!(response_1.stop_reason, StopReason::ToolUse));
        assert_eq!(response_1.usage.output_tokens, 12);
        assert_eq!(response_1.usage.input_tokens, 34);
        let tool_use_id = match &response_1.content[0] {
            ContentBlock::ToolUse {
                id, name, input, ..
            } => {
                assert_eq!(name, "echo");
                assert_eq!(input, &json!({"text": "hi"}));
                id.clone()
            }
            other => panic!("expected tool_use block, got {other:?}"),
        };

        // Slot must be free again (finish_sent_job re-registers native slots
        // unconditionally, including on ToolUse).
        drop(rx1);
        for _ in 0..20 {
            if !runtime.jobs.lock().await.contains_key(&job_id_1) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(!runtime.jobs.lock().await.contains_key(&job_id_1));
        assert!(
            runtime
                .slots
                .lock()
                .await
                .iter()
                .any(|slot| slot.id == slot_id && slot.phase == SlotPhase::ReadyBlocked),
            "slot should be re-registered ready after turn 1"
        );

        // Turn 2: continuation carries the matching tool_result, ends on end_turn.
        let job_id_2 = "job-ac3-2".to_string();
        let mut request_2 = text_request("please call echo");
        request_2.messages.push(Message {
            role: "user".into(),
            content: MessageContent::Blocks(vec![ContentBlock::ToolResult {
                tool_use_id: tool_use_id.clone(),
                content: json!("ok"),
                is_error: false,
                cache_control: None,
            }]),
            tool_call_id: None,
            tool_calls: Vec::new(),
            extra: Default::default(),
        });
        runtime.jobs.lock().await.insert(
            job_id_2.clone(),
            Job {
                job_id: job_id_2.clone(),
                slot_id: slot_id.clone(),
                request: request_2,
                ..Job::default()
            },
        );
        let (tx2, mut rx2) = mpsc::channel(64);
        runtime.start_job_sink(job_id_2.clone(), tx2).await;

        runtime
            .handle_cli_frame(json!({
                "type": "stream_event",
                "job_id": job_id_2,
                "slot_id": slot_id,
                "event": {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": { "type": "text", "text": "" }
                }
            }))
            .await;
        runtime
            .handle_cli_frame(json!({
                "type": "stream_event",
                "job_id": job_id_2,
                "slot_id": slot_id,
                "event": {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": { "type": "text_delta", "text": "done" }
                }
            }))
            .await;
        runtime
            .handle_cli_frame(json!({
                "type": "stream_event",
                "job_id": job_id_2,
                "slot_id": slot_id,
                "event": {
                    "type": "message_delta",
                    "delta": { "stop_reason": "end_turn" },
                    "usage": { "output_tokens": 3, "input_tokens": 9 }
                }
            }))
            .await;
        runtime
            .handle_cli_frame(json!({
                "type": "job_done",
                "job_id": job_id_2,
                "slot_id": slot_id,
                "stop_reason": "",
                "usage": {}
            }))
            .await;

        let response_2 = loop {
            match timeout(Duration::from_secs(1), rx2.recv())
                .await
                .expect("turn 2 stream item")
                .expect("turn 2 channel open")
                .expect("turn 2 item ok")
            {
                StreamItem::Finished(response) => break response,
                StreamItem::Event(_) => continue,
            }
        };
        assert!(matches!(response_2.stop_reason, StopReason::EndTurn));
        match &response_2.content[0] {
            ContentBlock::Text { text, .. } => assert_eq!(text, "done"),
            other => panic!("expected text block, got {other:?}"),
        }
    }

    /// AC17 "job-slot 不匹配丢弃": `handle_cli_frame()` must silently discard
    /// a `stream_event`/`job_done` frame whose `slot_id` does not
    /// match the job's actual assigned slot (`mod.rs`'s `job.slot_id !=
    /// slot_id` guards), rather than applying it to the wrong job's state.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn handle_cli_frame_discards_slot_id_mismatch() {
        let runtime = Runtime::new(test_cfg(Duration::from_secs(1)));
        let real_slot = "s00".to_string();
        let wrong_slot = "s99".to_string();
        runtime.register_native_ready(real_slot.clone()).await;

        let job_id = "job-ac17-mismatch".to_string();
        runtime.jobs.lock().await.insert(
            job_id.clone(),
            Job {
                job_id: job_id.clone(),
                slot_id: real_slot.clone(),
                request: text_request("hello"),
                ..Job::default()
            },
        );
        let (tx, mut rx) = mpsc::channel(64);
        runtime.start_job_sink(job_id.clone(), tx).await;

        // A stream_event tagged with a slot_id that doesn't match the job's
        // real slot must be discarded: no StreamAssembler state, no emitted
        // StreamItem.
        runtime
            .handle_cli_frame(json!({
                "type": "stream_event",
                "job_id": job_id,
                "slot_id": wrong_slot,
                "event": {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": { "type": "text_delta", "text": "should not apply" }
                }
            }))
            .await;
        assert!(
            !runtime.stream_assemblers.lock().await.contains_key(&job_id),
            "mismatched slot_id must not seed a StreamAssembler"
        );
        assert!(
            timeout(Duration::from_millis(100), rx.recv())
                .await
                .is_err(),
            "mismatched slot_id must not emit any StreamItem"
        );

        // A job_done tagged with the wrong slot_id must not complete the job.
        runtime
            .handle_cli_frame(json!({
                "type": "job_done",
                "job_id": job_id,
                "slot_id": wrong_slot,
                "stop_reason": "end_turn",
                "usage": {}
            }))
            .await;
        assert!(
            runtime.jobs.lock().await.contains_key(&job_id),
            "mismatched slot_id job_done must not complete/remove the job"
        );
        assert!(
            timeout(Duration::from_millis(100), rx.recv())
                .await
                .is_err(),
            "mismatched slot_id job_done must not emit a Finished item"
        );

        // Sanity: the same frames on the correct slot_id do apply.
        runtime
            .handle_cli_frame(json!({
                "type": "stream_event",
                "job_id": job_id,
                "slot_id": real_slot,
                "event": {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": { "type": "text_delta", "text": "ok" }
                }
            }))
            .await;
        assert!(
            runtime.stream_assemblers.lock().await.contains_key(&job_id),
            "matching slot_id must seed the StreamAssembler"
        );
        runtime
            .handle_cli_frame(json!({
                "type": "job_done",
                "job_id": job_id,
                "slot_id": real_slot,
                "stop_reason": "end_turn",
                "usage": {}
            }))
            .await;
        loop {
            match timeout(Duration::from_secs(1), rx.recv())
                .await
                .expect("matching slot_id job_done must emit a stream item")
                .expect("channel open")
                .expect("item ok")
            {
                StreamItem::Finished(_) => break,
                StreamItem::Event(_) => continue,
            }
        }
        for _ in 0..20 {
            if !runtime.jobs.lock().await.contains_key(&job_id) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            !runtime.jobs.lock().await.contains_key(&job_id),
            "matching slot_id job_done must complete/remove the job"
        );
    }

    /// AC17 "取消七步时序" (R2): a slot must not be reusable until the
    /// terminal step of the cancel sequence. If the native stdin write fails,
    /// the host lifecycle is already invalid, so the slot must stay dead
    /// instead of being locally recycled onto a broken pipe.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn abort_terminal_job_marks_host_dead_when_cancel_cannot_be_written() {
        let runtime = Runtime::new(test_cfg(Duration::from_secs(1)));
        let slot_id = "s00".to_string();
        runtime.register_native_ready(slot_id.clone()).await;

        let job_id = "job-ac17-cancel".to_string();
        runtime.jobs.lock().await.insert(
            job_id.clone(),
            Job {
                job_id: job_id.clone(),
                slot_id: slot_id.clone(),
                request: text_request("hello"),
                ..Job::default()
            },
        );
        let (tx, _rx) = mpsc::channel(64);
        runtime.start_job_sink(job_id.clone(), tx).await;
        runtime.running.fetch_add(1, Ordering::Relaxed);

        // No CLI stdin is wired up in this test harness, matching the state
        // after the native process has already closed its pipe.
        runtime.abort_terminal_job(&job_id).await;

        assert!(
            !runtime.jobs.lock().await.contains_key(&job_id),
            "abort_terminal_job must remove the job's bookkeeping unconditionally"
        );
        assert!(runtime.host_unavailable());
        assert_eq!(runtime.pid(), 0);
        assert_eq!(runtime.ready_slots(), 0);
        assert_eq!(slot_phase(&runtime, &slot_id).await, Some(SlotPhase::Dead));

        // Late frames from the dead process must not reanimate capacity.
        runtime
            .handle_cli_frame(json!({
                "type": "cancel_ack",
                "job_id": job_id,
                "slot_id": slot_id
            }))
            .await;
        assert_eq!(runtime.ready_slots(), 0);
        assert_eq!(slot_phase(&runtime, &slot_id).await, Some(SlotPhase::Dead));
    }

    /// A CLI-side terminal frame (`job_error` here) already released the
    /// slot inside the CLI, and the CLI drops a `cancel` for a job it no
    /// longer owns **without** acking it. Sending cancel on this path
    /// therefore leaked the slot forever (observed live: two failed jobs took
    /// a 2-slot runtime to `no_capacity`). The slot must come back
    /// immediately instead.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cli_side_job_error_frees_the_slot_without_a_cancel_ack() {
        let runtime = Runtime::new(test_cfg(Duration::from_secs(1)));
        runtime.spawn_host().await.expect("simulated cli");
        let slot_id = native_protocol::slot_id(0);

        let job_id = "job-cli-error".to_string();
        runtime.jobs.lock().await.insert(
            job_id.clone(),
            Job {
                job_id: job_id.clone(),
                slot_id: slot_id.clone(),
                request: text_request("hello"),
                ..Job::default()
            },
        );
        let (tx, _rx) = mpsc::channel(64);
        runtime.start_job_sink(job_id.clone(), tx).await;
        runtime.running.fetch_add(1, Ordering::Relaxed);
        {
            let mut slots = runtime.slots.lock().await;
            let slot = slots
                .iter_mut()
                .find(|slot| slot.id == slot_id)
                .expect("registered slot");
            assert!(slot.bind_job("demo", "sess-cli-error", &job_id));
        }

        runtime
            .handle_cli_frame(json!({
                "type": "job_error",
                "job_id": job_id,
                "slot_id": slot_id,
                "error": "API Error: 400 invalid_request_error"
            }))
            .await;

        assert!(
            !runtime.jobs.lock().await.contains_key(&job_id),
            "the failed job must be torn down"
        );
        assert!(
            runtime
                .slots
                .lock()
                .await
                .iter()
                .any(|slot| slot.id == slot_id && slot.phase == SlotPhase::ReadyBlocked),
            "slot must be reusable right after a CLI-side error, not wait for an ack that never comes"
        );
        assert_eq!(
            runtime.ready_slots(),
            1,
            "the freed slot must be schedulable"
        );
    }

    fn watchdog_cfg(idle: Duration, ack: Duration) -> MultiplexConfig {
        MultiplexConfig {
            job_idle_timeout: idle,
            cancel_ack_timeout: ack,
            ..test_cfg(Duration::from_secs(5))
        }
    }

    async fn wait_until<F, Fut>(limit: Duration, mut check: F) -> bool
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = bool>,
    {
        timeout(limit, async {
            loop {
                if check().await {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .is_ok()
    }

    async fn slot_phase(runtime: &Runtime, slot_id: &str) -> Option<SlotPhase> {
        runtime
            .slots
            .lock()
            .await
            .iter()
            .find(|slot| slot.id == slot_id)
            .map(|slot| slot.phase)
    }

    async fn seed_live_job(
        runtime: &Arc<Runtime>,
        job_id: &str,
        slot_id: &str,
    ) -> crate::provider::StreamRx {
        let (tx, rx) = job_event_channel();
        runtime.jobs.lock().await.insert(
            job_id.to_string(),
            Job {
                job_id: job_id.to_string(),
                slot_id: slot_id.to_string(),
                request: text_request("hello"),
                ..Job::default()
            },
        );
        runtime
            .job_seen
            .lock()
            .await
            .insert(job_id.to_string(), Instant::now());
        runtime.start_job_sink(job_id.to_string(), tx).await;
        runtime
            .job_sizes
            .lock()
            .await
            .insert(job_id.to_string(), 1024);
        runtime.memory.begin(1024);
        runtime.running.fetch_add(1, Ordering::Relaxed);
        rx
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stdout_eof_marks_host_unavailable_and_fails_inflight_jobs() {
        let runtime = Runtime::new(test_cfg(Duration::from_secs(1)));
        runtime.pid.store(42, Ordering::Relaxed);
        runtime.memory.set_claude_pid(42);
        let slot_id = native_protocol::slot_id(0);
        runtime.register_native_ready(slot_id.clone()).await;
        let job_id = "job-eof";
        let mut rx = seed_live_job(&runtime, job_id, &slot_id).await;
        {
            let mut slots = runtime.slots.lock().await;
            let slot = slots
                .iter_mut()
                .find(|slot| slot.id == slot_id)
                .expect("slot");
            assert!(slot.bind_job("demo", "sess-eof", job_id));
        }

        let (reader, writer) = tokio::io::duplex(64);
        let decode = tokio::spawn(decode_stdout(Arc::clone(&runtime), reader, 0));
        drop(writer);
        timeout(Duration::from_secs(1), decode)
            .await
            .expect("decode_stdout exits on EOF")
            .expect("decode task ok");

        assert!(runtime.host_unavailable());
        assert_eq!(runtime.pid(), 0);
        assert_eq!(runtime.ready_slots(), 0);
        assert!(runtime.jobs.lock().await.is_empty());
        assert!(runtime.sinks.lock().await.is_empty());
        assert_eq!(runtime.running_jobs(), 0);
        assert_eq!(slot_phase(&runtime, &slot_id).await, Some(SlotPhase::Dead));
        assert!(runtime.cli_stdin.lock().await.is_none());
        assert!(runtime.native_host.lock().await.is_none());

        let item = timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("in-flight stream gets terminal error")
            .expect("terminal item");
        let err = item.expect_err("EOF must fail the in-flight stream");
        assert!(
            err.to_string().contains("native cli stdout closed"),
            "unexpected error: {err}"
        );

        let layout = envelope::load();
        let capabilities: Vec<String> = native_protocol::CAPABILITIES
            .iter()
            .map(|cap| (*cap).to_string())
            .collect();
        runtime
            .handle_cli_frame(json!({
                "type": "host_ready",
                "protocol_version": native_protocol::PROTOCOL_VERSION,
                "slots": 1,
                "system_layout": layout.mode.as_str(),
                "timezone": layout.timezone,
                "capabilities": capabilities,
            }))
            .await;
        runtime
            .handle_cli_frame(json!({
                "type": "job_done",
                "job_id": job_id,
                "slot_id": slot_id,
                "stop_reason": "end_turn",
                "usage": {}
            }))
            .await;
        assert_eq!(
            runtime.ready_slots(),
            0,
            "dead host must not be re-registered"
        );

        let (tx, _rx) = job_event_channel();
        let err = runtime
            .submit(text_request("after eof"), ctx("sess-after-eof", false), tx)
            .await
            .expect_err("dead host rejects new jobs");
        assert!(
            err.to_string().contains("native cli host unavailable"),
            "unexpected submit error: {err}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn broken_stdin_marks_host_unavailable_and_leaves_no_submit_residue() {
        let runtime = Runtime::new(test_cfg(Duration::from_secs(1)));
        runtime.pid.store(42, Ordering::Relaxed);
        runtime.memory.set_claude_pid(42);
        let slot_id = native_protocol::slot_id(0);
        runtime.register_native_ready(slot_id.clone()).await;
        *runtime.cli_stdin.lock().await = Some(Box::new(BrokenPipeWriter));

        let (tx, _rx) = job_event_channel();
        let err = runtime
            .submit(
                text_request("broken pipe"),
                ctx("sess-broken-pipe", false),
                tx,
            )
            .await
            .expect_err("broken stdin rejects the job");
        assert!(
            err.to_string().contains("broken pipe"),
            "unexpected submit error: {err}"
        );

        assert!(runtime.host_unavailable());
        assert_eq!(runtime.pid(), 0);
        assert_eq!(runtime.ready_slots(), 0);
        assert_eq!(slot_phase(&runtime, &slot_id).await, Some(SlotPhase::Dead));
        assert!(runtime.jobs.lock().await.is_empty());
        assert!(runtime.sinks.lock().await.is_empty());
        assert!(runtime.job_seen.lock().await.is_empty());
        assert!(runtime.stream_assemblers.lock().await.is_empty());
        assert!(runtime.cli_stdin.lock().await.is_none());
    }

    /// Root cause of the "VM stays unusable after incomplete_response" bug:
    /// a CLI job that never emits another frame held its native slot forever.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn watchdog_cancels_silent_job_and_frees_slot() {
        let runtime = Runtime::new(watchdog_cfg(
            Duration::from_millis(200),
            Duration::from_secs(5),
        ));
        runtime.start().await.expect("simulated cli");
        let slot_id = native_protocol::slot_id(0);
        let (tx, mut rx) = job_event_channel();
        runtime
            .submit(
                text_request(SIM_SILENT_MARKER),
                ctx("sess-silent", false),
                tx,
            )
            .await
            .expect("submit");
        assert_eq!(
            runtime.ready_slots(),
            0,
            "the silent job holds the only slot"
        );

        let item = timeout(Duration::from_secs(3), rx.recv())
            .await
            .expect("client must get a terminal item")
            .expect("channel item");
        let err = item.expect_err("a silent job must end in an error, not success");
        assert!(
            matches!(&err, KernelError::Job(failure) if failure.code == "upstream_timeout" && failure.status == 504),
            "unexpected error: {err:?}"
        );
        assert!(
            wait_until(Duration::from_secs(3), || async {
                runtime.ready_slots() == 1 && runtime.jobs.lock().await.is_empty()
            })
            .await,
            "cancel_ack must bring the slot back"
        );
        assert_eq!(
            slot_phase(&runtime, &slot_id).await,
            Some(SlotPhase::ReadyBlocked)
        );
        assert_eq!(runtime.closed_slots(), 0);
    }

    fn recovery_cfg(slots: usize, recovery: RecoveryConfig) -> MultiplexConfig {
        MultiplexConfig {
            slot_count: slots,
            recovery,
            ..watchdog_cfg(Duration::from_millis(150), Duration::from_millis(200))
        }
    }

    fn fast_recovery() -> RecoveryConfig {
        RecoveryConfig {
            probe_timeout: Duration::from_millis(100),
            host_silence: Duration::from_millis(200),
            restart_backoff: vec![Duration::from_millis(50); 3],
            ..RecoveryConfig::default()
        }
    }

    async fn pending_cancel_job(runtime: &Runtime, slot_id: &str) -> Option<String> {
        runtime
            .pending_cancels
            .lock()
            .await
            .get(slot_id)
            .map(|cancel| cancel.job_id.clone())
    }

    /// L1: an unacked cancel closes only that slot and is resent; only the
    /// ack for that very job reopens it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unacked_cancel_closes_slot_and_matching_late_ack_reopens_it() {
        let runtime = Runtime::new(recovery_cfg(4, fast_recovery()));
        runtime.start().await.expect("simulated cli");
        let (tx, mut rx) = job_event_channel();
        runtime
            .submit(text_request(SIM_HANG_MARKER), ctx("sess-hang", false), tx)
            .await
            .expect("submit");
        let slot_id = runtime
            .jobs
            .lock()
            .await
            .values()
            .next()
            .map(|job| job.slot_id.clone())
            .expect("job slot");
        let item = timeout(Duration::from_secs(3), rx.recv())
            .await
            .expect("client must get a terminal item")
            .expect("channel item");
        assert!(item.is_err(), "a hung job must end in an error");
        assert!(
            wait_until(Duration::from_secs(3), || async {
                runtime.closed_slots() == 1
            })
            .await,
            "an unacked cancel must close the slot"
        );
        assert_eq!(slot_phase(&runtime, &slot_id).await, Some(SlotPhase::Dead));
        assert_eq!(runtime.ready_slots(), 3, "other slots keep serving");
        assert!(
            wait_until(Duration::from_secs(3), || async {
                runtime
                    .pending_cancels
                    .lock()
                    .await
                    .get(&slot_id)
                    .is_some_and(|cancel| cancel.resends >= 1)
            })
            .await,
            "the cancel is resent after closing"
        );
        assert_eq!(runtime.unhealthy_reason(), None);

        runtime
            .handle_cli_frame(json!({"type": "cancel_ack", "job_id": "other", "slot_id": slot_id}))
            .await;
        assert_eq!(
            runtime.closed_slots(),
            1,
            "an ack for another job is ignored"
        );

        let job_id = pending_cancel_job(&runtime, &slot_id)
            .await
            .expect("pending cancel");
        runtime
            .handle_cli_frame(json!({"type": "cancel_ack", "job_id": job_id, "slot_id": slot_id}))
            .await;
        assert_eq!(runtime.closed_slots(), 0);
        assert_eq!(runtime.ready_slots(), 4);
        assert_eq!(runtime.cli_restarts.load(Ordering::Relaxed), 0);
    }

    /// L3: once unacked cancels close every slot, the CLI is restarted in
    /// place and serves again.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn all_slots_closed_restarts_cli_in_place() {
        let runtime = Runtime::new(recovery_cfg(1, fast_recovery()));
        runtime.start().await.expect("simulated cli");
        let (tx, _rx) = job_event_channel();
        runtime
            .submit(text_request(SIM_HANG_MARKER), ctx("sess-hang", false), tx)
            .await
            .expect("submit");
        assert!(
            wait_until(Duration::from_secs(5), || async {
                runtime.cli_restarts.load(Ordering::Relaxed) == 1 && runtime.ready_slots() == 1
            })
            .await,
            "the CLI must come back after its only slot closed"
        );
        assert_eq!(runtime.closed_slots(), 0);
        assert_eq!(runtime.unhealthy_reason(), None);

        let (tx, mut rx) = job_event_channel();
        runtime
            .submit(text_request("after restart"), ctx("sess-new", false), tx)
            .await
            .expect("submit after restart");
        let finished = timeout(Duration::from_secs(3), async {
            while let Some(item) = rx.recv().await {
                if let Ok(StreamItem::Finished(_)) = item {
                    return true;
                }
            }
            false
        })
        .await
        .expect("job finishes");
        assert!(finished);
    }

    /// L2 -> L3: a CLI that is alive but stopped reading stdin (the old
    /// `await cancelJob` bug) still shows ready slots; unanswered pings
    /// restart it and the stuck job fails as `kernel_unavailable`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn deaf_cli_is_probed_then_restarted() {
        let runtime = Runtime::new(MultiplexConfig {
            job_idle_timeout: Duration::from_secs(60),
            cancel_ack_timeout: Duration::from_secs(60),
            ..recovery_cfg(4, fast_recovery())
        });
        runtime.start().await.expect("simulated cli");
        let (tx, mut rx) = job_event_channel();
        runtime
            .submit(text_request(SIM_DEAF_MARKER), ctx("sess-deaf", false), tx)
            .await
            .expect("submit");
        assert_eq!(
            runtime.ready_slots(),
            3,
            "health alone cannot see a deaf CLI"
        );

        let item = timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("stuck job must be failed")
            .expect("channel item");
        let err = item.expect_err("deaf CLI cannot finish the job");
        assert!(
            matches!(&err, KernelError::Job(failure) if failure.code == "kernel_unavailable"),
            "unexpected error: {err:?}"
        );
        assert!(
            wait_until(Duration::from_secs(5), || async {
                runtime.cli_restarts.load(Ordering::Relaxed) == 1 && runtime.ready_slots() == 4
            })
            .await,
            "the CLI must be restarted"
        );
    }

    /// L3 is bounded: with the restart budget spent the kernel stays down
    /// and reports unhealthy so the control plane takes over (L4).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn spent_restart_budget_reports_unhealthy() {
        let runtime = Runtime::new(recovery_cfg(
            2,
            RecoveryConfig {
                restart_backoff: Vec::new(),
                ..fast_recovery()
            },
        ));
        runtime.start().await.expect("simulated cli");
        runtime.request_restart("test failure".into()).await;
        assert!(
            wait_until(Duration::from_secs(3), || async {
                runtime.unhealthy_reason().is_some()
            })
            .await
        );
        assert_eq!(runtime.ready_slots(), 0);
        assert_eq!(runtime.cli_restarts.load(Ordering::Relaxed), 0);
        let (tx, _rx) = job_event_channel();
        let err = runtime
            .submit(text_request("hello"), ctx("sess-down", false), tx)
            .await
            .expect_err("down kernel rejects jobs");
        assert!(matches!(&err, KernelError::Job(failure) if failure.code == "kernel_unavailable"));
    }

    /// Explicit cancel from Node finds the job by request id and frees the slot.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn explicit_cancel_by_request_id_frees_slot() {
        let runtime = Runtime::new(watchdog_cfg(
            Duration::from_secs(60),
            Duration::from_secs(60),
        ));
        runtime.start().await.expect("simulated cli");
        assert!(!runtime.cancel_request("req-unknown").await);
        let (tx, mut rx) = job_event_channel();
        runtime
            .submit(
                text_request(SIM_SILENT_MARKER),
                ExecutionContext {
                    request_id: "req-1".into(),
                    ..ctx("sess-cancel", false)
                },
                tx,
            )
            .await
            .expect("submit");
        assert_eq!(runtime.ready_slots(), 0);
        assert!(runtime.cancel_request("req-1").await);
        let item = timeout(Duration::from_secs(3), rx.recv())
            .await
            .expect("client stream ends")
            .expect("channel item");
        assert!(item.is_err());
        assert!(
            wait_until(Duration::from_secs(3), || async {
                runtime.ready_slots() == 1 && runtime.jobs.lock().await.is_empty()
            })
            .await,
            "ack frees the slot"
        );
        assert!(
            !runtime.cancel_request("req-1").await,
            "second cancel is a no-op"
        );
    }

    #[tokio::test]
    async fn cancellation_before_registration_never_starts_a_job() {
        let runtime = Runtime::new(watchdog_cfg(
            Duration::from_secs(60),
            Duration::from_secs(60),
        ));
        runtime.start().await.expect("simulated cli");
        assert!(!runtime.cancel_request("early-cancel").await);
        let (tx, _rx) = job_event_channel();
        let error = runtime
            .submit(
                text_request("hello"),
                ExecutionContext {
                    request_id: "early-cancel".into(),
                    ..ctx("early-session", false)
                },
                tx,
            )
            .await
            .expect_err("cancelled before dispatch");
        assert!(matches!(error, KernelError::Job(failure) if failure.code == "client_cancelled"));
        assert_eq!(runtime.ready_slots(), 1);
        assert_eq!(runtime.running_jobs(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dropped_submission_finishes_start_line_before_cancelling() {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let runtime = Runtime::new(watchdog_cfg(
            Duration::from_secs(60),
            Duration::from_secs(60),
        ));
        runtime.register_native_ready("s00".into()).await;
        let (writer, reader) = tokio::io::duplex(64);
        *runtime.cli_stdin.lock().await = Some(Box::new(writer));
        let provider = Arc::new(MultiplexCliProvider::from_cfg(runtime.cfg.clone()));
        assert!(provider.runtime.set(runtime.clone()).is_ok());
        let task_provider = provider.clone();
        let task = tokio::spawn(async move {
            task_provider
                .execute_stream(
                    &text_request(&"x".repeat(4096)),
                    &ExecutionContext {
                        request_id: "dropped-submit".into(),
                        ..ctx("dropped-session", false)
                    },
                )
                .await
        });
        assert!(
            wait_until(Duration::from_secs(2), || async {
                runtime.running_jobs() == 1
            })
            .await
        );
        task.abort();
        let _ = task.await;
        let mut lines = BufReader::new(reader).lines();
        let start = timeout(Duration::from_secs(2), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let start: Value = serde_json::from_str(&start).expect("complete start JSONL");
        assert_eq!(start["type"], "job_start");
        let cancel = timeout(Duration::from_secs(2), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let cancel: Value = serde_json::from_str(&cancel).expect("complete cancel JSONL");
        assert_eq!(cancel["type"], "cancel");
        assert_eq!(cancel["job_id"], start["job_id"]);
        assert_eq!(runtime.ready_slots(), 0, "no reuse before acknowledgement");
        runtime
            .handle_cli_frame(json!({
                "type": "cancel_ack", "job_id": start["job_id"], "slot_id": "s00"
            }))
            .await;
        assert_eq!(runtime.ready_slots(), 1);
        assert_eq!(runtime.running_jobs(), 0);
    }

    /// Frames keep the job alive: the watchdog only fires on silence, not on
    /// total duration.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn watchdog_spares_job_that_keeps_streaming() {
        let runtime = Runtime::new(watchdog_cfg(
            Duration::from_millis(300),
            Duration::from_secs(5),
        ));
        runtime.start().await.expect("simulated cli");
        let slot_id = native_protocol::slot_id(0);
        let (tx, mut rx) = job_event_channel();
        runtime
            .submit(
                text_request(SIM_SILENT_MARKER),
                ctx("sess-alive", false),
                tx,
            )
            .await
            .expect("submit");
        let job_id = runtime
            .jobs
            .lock()
            .await
            .keys()
            .next()
            .cloned()
            .expect("job");

        for _ in 0..9 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            runtime
                .handle_cli_frame(json!({
                    "type": "stream_event",
                    "job_id": job_id,
                    "slot_id": slot_id,
                    "event": { "type": "ping" }
                }))
                .await;
        }
        assert!(
            runtime.jobs.lock().await.contains_key(&job_id),
            "900ms of steady frames must outlive a 300ms idle timeout"
        );
        while let Ok(Some(item)) = timeout(Duration::from_millis(50), rx.recv()).await {
            assert!(item.is_ok(), "no error while frames keep flowing");
        }
    }

    /// A client that goes away while the CLI is silent must not pin the slot
    /// until the idle timeout; the job is cancelled right away.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn client_disconnect_during_silence_cancels_job() {
        let runtime = Runtime::new(watchdog_cfg(
            Duration::from_secs(60),
            Duration::from_secs(60),
        ));
        runtime.start().await.expect("simulated cli");
        let (tx, rx) = job_event_channel();
        runtime
            .submit(text_request(SIM_SILENT_MARKER), ctx("sess-gone", false), tx)
            .await
            .expect("submit");
        drop(rx);
        assert!(
            wait_until(Duration::from_secs(3), || async {
                runtime.ready_slots() == 1 && runtime.jobs.lock().await.is_empty()
            })
            .await,
            "client disconnect must cancel the silent job and free the slot"
        );
    }
}
