//! Memory-aware admission for the 20-slot single-process runtime.
//!
//! Admission scales with the live cgroup memory limit. Without a finite limit,
//! retain the original 4 GiB profile and kernel+Claude RSS observation.

use std::sync::{
    Mutex,
    atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering},
};

use serde::Serialize;

use crate::error::KernelError;

pub const MIB: u64 = 1024 * 1024;
pub const GIB: u64 = 1024 * MIB;

#[derive(Clone, Copy, Debug)]
pub struct MemoryLimits {
    pub soft: u64,
    pub drain: u64,
    pub reject: u64,
    pub max_inflight_payload: usize,
    pub max_pending: usize,
    pub large_request_bytes: usize,
}

impl MemoryLimits {
    pub fn production() -> Self {
        Self {
            soft: 3 * GIB,
            drain: 3500 * MIB,
            reject: 3750 * MIB,
            max_inflight_payload: (256 * MIB) as usize,
            max_pending: 100,
            large_request_bytes: (256 * MIB) as usize,
        }
    }

    pub fn from_env() -> Self {
        let mut limits = Self::production();
        if let Ok(value) = std::env::var("MEM_SOFT_BYTES")
            && let Ok(parsed) = value.parse()
        {
            limits.soft = parsed;
        }
        if let Ok(value) = std::env::var("MEM_DRAIN_BYTES")
            && let Ok(parsed) = value.parse()
        {
            limits.drain = parsed;
        }
        if let Ok(value) = std::env::var("MEM_REJECT_BYTES")
            && let Ok(parsed) = value.parse()
        {
            limits.reject = parsed;
        }
        if let Ok(value) = std::env::var("MAX_INFLIGHT_PAYLOAD")
            && let Ok(parsed) = value.parse()
        {
            limits.max_inflight_payload = parsed;
        }
        if let Ok(value) = std::env::var("MAX_PENDING")
            && let Ok(parsed) = value.parse()
        {
            limits.max_pending = parsed;
        }
        limits
    }

    fn effective(self, cap: Option<u64>) -> Self {
        let Some(cap) = cap.filter(|cap| *cap > 0) else {
            return self;
        };
        let defaults = Self::production();
        let scale = |value: u64| {
            ((value as u128 * cap as u128) / (4 * GIB) as u128).clamp(1, u64::MAX as u128) as u64
        };
        let bounded = |configured: u64, default: u64| {
            let dynamic = scale(default);
            if configured == default {
                dynamic
            } else {
                configured.min(dynamic)
            }
        };
        let bounded_usize = |configured: usize, default: usize| {
            bounded(configured as u64, default as u64).min(usize::MAX as u64) as usize
        };
        Self {
            soft: bounded(self.soft, defaults.soft),
            drain: bounded(self.drain, defaults.drain),
            reject: bounded(self.reject, defaults.reject),
            max_inflight_payload: bounded_usize(
                self.max_inflight_payload,
                defaults.max_inflight_payload,
            ),
            max_pending: bounded_usize(self.max_pending, defaults.max_pending),
            large_request_bytes: bounded_usize(
                self.large_request_bytes,
                defaults.large_request_bytes,
            ),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Admission {
    Allow,
    AllowSmall,
    Drain,
    Reject,
}

#[derive(Clone, Debug, Serialize)]
pub struct MemorySnapshot {
    pub kernel_rss_bytes: u64,
    pub claude_rss_bytes: u64,
    pub cgroup_bytes: u64,
    pub cgroup_limit_bytes: Option<u64>,
    pub soft_bytes: u64,
    pub drain_bytes: u64,
    pub reject_bytes: u64,
    pub max_inflight_payload_bytes: usize,
    pub max_pending: usize,
    pub service_rss_bytes: u64,
    pub observed_bytes: u64,
    pub inflight_payload: usize,
    pub pending: usize,
    pub admission: Admission,
}

pub struct MemoryGuard {
    limits: MemoryLimits,
    admission_lock: Mutex<()>,
    inflight_payload: AtomicUsize,
    pending: AtomicUsize,
    claude_pid: AtomicU32,
    rss_override: AtomicU64,
    #[cfg(test)]
    limit_override: AtomicU64,
}

pub struct MemoryReservation<'a> {
    guard: &'a MemoryGuard,
    bytes: usize,
    active: bool,
}

impl MemoryReservation<'_> {
    pub fn commit(mut self) {
        self.active = false;
    }
}

impl Drop for MemoryReservation<'_> {
    fn drop(&mut self) {
        if self.active {
            self.guard.end(self.bytes);
        }
    }
}

impl MemoryGuard {
    pub fn new(limits: MemoryLimits) -> Self {
        Self {
            limits,
            admission_lock: Mutex::new(()),
            inflight_payload: AtomicUsize::new(0),
            pending: AtomicUsize::new(0),
            claude_pid: AtomicU32::new(0),
            rss_override: AtomicU64::new(0),
            #[cfg(test)]
            limit_override: AtomicU64::new(0),
        }
    }

    pub fn from_env() -> Self {
        Self::new(MemoryLimits::from_env())
    }

    pub fn set_claude_pid(&self, pid: u32) {
        self.claude_pid.store(pid, Ordering::Relaxed);
    }

    #[cfg(test)]
    pub fn set_rss_override(&self, bytes: u64) {
        self.rss_override.store(bytes, Ordering::Relaxed);
    }

    #[cfg(test)]
    pub fn set_limit_override(&self, bytes: u64) {
        self.limit_override.store(bytes, Ordering::Relaxed);
    }

    fn cgroup_limit(&self) -> Option<u64> {
        #[cfg(test)]
        {
            let override_limit = self.limit_override.load(Ordering::Relaxed);
            if override_limit > 0 {
                return Some(override_limit);
            }
        }
        cgroup_limit()
    }

    pub fn snapshot(&self) -> MemorySnapshot {
        let cgroup_limit = self.cgroup_limit();
        let limits = self.limits.effective(cgroup_limit);
        let kernel = rss_of(std::process::id()).unwrap_or(0);
        let claude = rss_of(self.claude_pid.load(Ordering::Relaxed)).unwrap_or(0);
        let service = kernel.saturating_add(claude);
        let cgroup = cgroup_current().unwrap_or(0);
        let mut observed = if (cgroup_limit.is_some() || observe_cgroup()) && cgroup > 0 {
            service.max(cgroup)
        } else {
            service
        };
        let override_rss = self.rss_override.load(Ordering::Relaxed);
        if override_rss > 0 {
            observed = override_rss;
        }
        MemorySnapshot {
            kernel_rss_bytes: kernel,
            claude_rss_bytes: claude,
            cgroup_bytes: cgroup,
            cgroup_limit_bytes: cgroup_limit,
            soft_bytes: limits.soft,
            drain_bytes: limits.drain,
            reject_bytes: limits.reject,
            max_inflight_payload_bytes: limits.max_inflight_payload,
            max_pending: limits.max_pending,
            service_rss_bytes: service,
            observed_bytes: observed,
            inflight_payload: self.inflight_payload.load(Ordering::Relaxed),
            pending: self.pending.load(Ordering::Relaxed),
            admission: classify(observed, &limits),
        }
    }

    fn check_admission(&self, request_bytes: usize) -> Result<(), KernelError> {
        let snap = self.snapshot();
        let limits = self.limits.effective(snap.cgroup_limit_bytes);
        if snap.pending >= limits.max_pending {
            return Err(KernelError::Overloaded {
                retry_after: Some("1".into()),
            });
        }
        if snap.inflight_payload.saturating_add(request_bytes) > limits.max_inflight_payload {
            return Err(KernelError::Overloaded {
                retry_after: Some("1".into()),
            });
        }
        let large = request_bytes >= limits.large_request_bytes;
        match snap.admission {
            Admission::Allow => Ok(()),
            Admission::AllowSmall if !large => Ok(()),
            Admission::AllowSmall | Admission::Drain | Admission::Reject => {
                Err(KernelError::Overloaded {
                    retry_after: Some("2".into()),
                })
            }
        }
    }

    pub fn reserve(&self, request_bytes: usize) -> Result<MemoryReservation<'_>, KernelError> {
        let _lock = self
            .admission_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.check_admission(request_bytes)?;
        self.begin(request_bytes);
        Ok(MemoryReservation {
            guard: self,
            bytes: request_bytes,
            active: true,
        })
    }

    #[cfg(test)]
    pub fn admit(&self, request_bytes: usize) -> Result<(), KernelError> {
        self.check_admission(request_bytes)
    }

    pub(crate) fn begin(&self, request_bytes: usize) {
        self.pending.fetch_add(1, Ordering::Relaxed);
        self.inflight_payload
            .fetch_add(request_bytes, Ordering::Relaxed);
    }

    pub fn end(&self, request_bytes: usize) {
        self.pending
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                Some(n.saturating_sub(1))
            })
            .ok();
        self.inflight_payload
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                Some(n.saturating_sub(request_bytes))
            })
            .ok();
    }
}

fn observe_cgroup() -> bool {
    matches!(
        std::env::var("MEM_OBSERVED").as_deref(),
        Ok("cgroup") | Ok("Cgroup") | Ok("CGROUP")
    )
}

fn classify(observed: u64, limits: &MemoryLimits) -> Admission {
    if observed >= limits.reject {
        Admission::Reject
    } else if observed >= limits.drain {
        Admission::Drain
    } else if observed >= limits.soft {
        Admission::AllowSmall
    } else {
        Admission::Allow
    }
}

#[cfg(not(target_os = "macos"))]
fn rss_of(pid: u32) -> Option<u64> {
    if pid == 0 {
        return None;
    }
    let text = std::fs::read_to_string(format!("/proc/{pid}/statm")).ok()?;
    let pages: u64 = text.split_whitespace().nth(1)?.parse().ok()?;
    Some(pages.saturating_mul(page_size()))
}

#[cfg(not(target_os = "macos"))]
fn page_size() -> u64 {
    4096
}

/// Darwin has no procfs; without this the guard would observe 0 bytes and never shed load.
#[cfg(target_os = "macos")]
fn rss_of(pid: u32) -> Option<u64> {
    /// `struct proc_taskinfo` from <sys/proc_info.h>; only the resident size is read.
    #[repr(C)]
    struct ProcTaskInfo {
        _virtual_size: u64,
        resident_size: u64,
        _times_and_threads: [u64; 4],
        _counters: [i32; 12],
    }
    const PROC_PIDTASKINFO: i32 = 4;
    unsafe extern "C" {
        fn proc_pidinfo(
            pid: i32,
            flavor: i32,
            arg: u64,
            buffer: *mut std::ffi::c_void,
            size: i32,
        ) -> i32;
    }
    if pid == 0 {
        return None;
    }
    let pid = i32::try_from(pid).ok()?;
    let mut info = std::mem::MaybeUninit::<ProcTaskInfo>::zeroed();
    let size = std::mem::size_of::<ProcTaskInfo>() as i32;
    // SAFETY: the buffer is a writable ProcTaskInfo of exactly `size` bytes.
    let written = unsafe { proc_pidinfo(pid, PROC_PIDTASKINFO, 0, info.as_mut_ptr().cast(), size) };
    if written != size {
        return None;
    }
    // SAFETY: proc_pidinfo filled all `size` bytes.
    Some(unsafe { info.assume_init() }.resident_size)
}

fn cgroup_current() -> Option<u64> {
    std::fs::read_to_string("/sys/fs/cgroup/memory.current")
        .ok()
        .and_then(|text| text.trim().parse().ok())
}

fn cgroup_limit() -> Option<u64> {
    std::fs::read_to_string("/sys/fs/cgroup/memory.max")
        .ok()
        .and_then(|text| text.trim().parse::<u64>().ok())
        .filter(|cap| *cap > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bands() {
        let limits = MemoryLimits::production();
        assert_eq!(classify(2 * GIB, &limits), Admission::Allow);
        assert_eq!(classify(3 * GIB, &limits), Admission::AllowSmall);
        assert_eq!(classify(3500 * MIB, &limits), Admission::Drain);
        assert_eq!(classify(3750 * MIB, &limits), Admission::Reject);
    }

    #[test]
    fn reject_when_override_high() {
        let guard = MemoryGuard::new(MemoryLimits::production());
        guard.set_rss_override(4 * GIB);
        let err = guard.admit(128).unwrap_err();
        assert!(matches!(err, KernelError::Overloaded { .. }));
    }

    #[test]
    fn drain_blocks_large_only() {
        let mut limits = MemoryLimits::production();
        limits.large_request_bytes = 1024;
        let guard = MemoryGuard::new(limits);
        guard.set_limit_override(4 * GIB);
        guard.set_rss_override(3 * GIB + 1);
        assert!(guard.admit(512).is_ok());
        assert!(guard.admit(2048).is_err());
    }

    #[test]
    fn cgroup_limit_scales_up_and_down_without_restart() {
        let guard = MemoryGuard::new(MemoryLimits::production());
        guard.set_limit_override(512 * MIB);
        guard.set_rss_override(400 * MIB);
        assert!(matches!(guard.snapshot().admission, Admission::AllowSmall));
        assert_eq!(guard.snapshot().soft_bytes, 384 * MIB);
        assert!(guard.reserve(33 * MIB as usize).is_err());
        guard.set_limit_override(GIB);
        assert_eq!(guard.snapshot().admission, Admission::Allow);
        assert_eq!(guard.snapshot().soft_bytes, 768 * MIB);
        assert!(guard.reserve(33 * MIB as usize).is_ok());
    }

    #[test]
    fn reservation_counts_waiters_and_releases_on_drop() {
        let guard = MemoryGuard::new(MemoryLimits::production());
        guard.set_limit_override(512 * MIB);
        guard.set_rss_override(200 * MIB);
        let first = guard.reserve(20 * MIB as usize).unwrap();
        assert!(guard.reserve(20 * MIB as usize).is_err());
        assert_eq!(guard.snapshot().pending, 1);
        drop(first);
        assert_eq!(guard.snapshot().pending, 0);
        assert!(guard.reserve(20 * MIB as usize).is_ok());
    }

    #[test]
    fn concurrent_reservations_cannot_exceed_live_limit() {
        use std::sync::{Arc, Barrier};

        let guard = MemoryGuard::new(MemoryLimits::production());
        guard.set_limit_override(512 * MIB);
        guard.set_rss_override(200 * MIB);
        let barrier = Arc::new(Barrier::new(24));
        let accepted = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..24 {
                let barrier = Arc::clone(&barrier);
                let guard = &guard;
                let accepted = &accepted;
                scope.spawn(move || {
                    let reservation = guard.reserve(2 * MIB as usize).ok();
                    if reservation.is_some() {
                        accepted.fetch_add(1, Ordering::Relaxed);
                    }
                    barrier.wait();
                });
            }
        });
        assert_eq!(accepted.load(Ordering::Relaxed), 12);
        assert_eq!(guard.snapshot().pending, 0);
    }
}
