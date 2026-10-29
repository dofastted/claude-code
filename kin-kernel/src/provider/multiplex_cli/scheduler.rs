use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use super::slot::{Slot, SlotPhase};
use crate::error::KernelError;

const DEFAULT_STICKY_TTL: Duration = Duration::from_secs(24 * 60 * 60);

struct StickyPin {
    slot_id: String,
    last_used: Instant,
}

/// One session keeps one slot until its pin expires. A busy or restarting
/// pinned slot only spills that turn; the pin itself is never rewritten.
pub struct SlotScheduler {
    ready: VecDeque<String>,
    sticky: HashMap<String, StickyPin>,
    /// Newest two sessions on each slot. `last_used` only moves forward.
    slot_recent: HashMap<String, Vec<(String, Instant)>>,
    sticky_ttl: Duration,
}

impl SlotScheduler {
    pub fn new() -> Self {
        Self::with_sticky_ttl(DEFAULT_STICKY_TTL)
    }

    pub fn with_sticky_ttl(sticky_ttl: Duration) -> Self {
        Self {
            ready: VecDeque::new(),
            sticky: HashMap::new(),
            slot_recent: HashMap::new(),
            sticky_ttl,
        }
    }

    pub fn enqueue_ready(&mut self, slot_id: String) -> bool {
        if self.ready.iter().any(|id| id == &slot_id) {
            return false;
        }
        self.ready.push_back(slot_id);
        true
    }

    /// Retiring a slot only takes it out of rotation. Native slot ids are
    /// reused when the host re-registers them, so the session pin survives.
    pub fn forget(&mut self, slot_id: &str) {
        self.ready.retain(|id| id != slot_id);
    }

    pub fn forget_session(&mut self, tenant_id: &str, session_id: &str, slot_id: &str) {
        let key = format!("{tenant_id}\u{1f}{session_id}");
        if self
            .sticky
            .get(&key)
            .is_some_and(|pin| pin.slot_id == slot_id)
        {
            self.sticky.remove(&key);
            self.drop_owner(slot_id, &key);
        }
    }
    pub fn bind_sticky(&mut self, session_key: String, slot_id: String) {
        let at = Instant::now();
        self.note_use(&slot_id, &session_key, at);
        self.sticky.insert(
            session_key,
            StickyPin {
                slot_id,
                last_used: at,
            },
        );
    }

    fn note_use(&mut self, slot_id: &str, key: &str, at: Instant) {
        let top = self.slot_recent.entry(slot_id.to_string()).or_default();
        if let Some(found) = top.iter_mut().find(|(owner, _)| owner == key) {
            found.1 = at;
        } else {
            top.push((key.to_string(), at));
        }
        top.sort_by(|left, right| right.1.cmp(&left.1));
        top.truncate(2);
    }

    fn drop_owner(&mut self, slot_id: &str, key: &str) {
        let Some(top) = self.slot_recent.get(slot_id) else {
            return;
        };
        if !top.iter().any(|(owner, _)| owner == key) {
            return;
        }
        let mut rows: Vec<(String, Instant)> = self
            .sticky
            .iter()
            .filter(|(_, pin)| pin.slot_id == slot_id)
            .map(|(owner, pin)| (owner.clone(), pin.last_used))
            .collect();
        rows.sort_by(|left, right| right.1.cmp(&left.1));
        rows.truncate(2);
        self.slot_recent.insert(slot_id.to_string(), rows);
    }

    fn prune_expired(&mut self) {
        let ttl = self.sticky_ttl;
        let expired: Vec<(String, String)> = self
            .sticky
            .iter()
            .filter(|(_, pin)| pin.last_used.elapsed() >= ttl)
            .map(|(key, pin)| (key.clone(), pin.slot_id.clone()))
            .collect();
        for (key, _) in &expired {
            self.sticky.remove(key);
        }
        for (key, slot_id) in expired {
            self.drop_owner(&slot_id, &key);
        }
    }

    fn other_used(&self, slot_id: &str, key: &str) -> Option<Instant> {
        self.slot_recent.get(slot_id).and_then(|top| {
            top.iter()
                .filter(|(owner, _)| owner != key)
                .map(|(_, at)| *at)
                .max()
        })
    }

    pub fn pick(
        &mut self,
        slots: &mut [Slot],
        tenant_id: &str,
        session_id: &str,
    ) -> Result<String, KernelError> {
        self.prune_expired();
        let key = format!("{tenant_id}\u{1f}{session_id}");
        let touched = self.sticky.get_mut(&key).map(|pin| {
            pin.last_used = Instant::now();
            (pin.slot_id.clone(), pin.last_used)
        });
        if let Some((id, at)) = touched {
            self.note_use(&id, &key, at);
            if let Some(slot) = slots.iter().find(|slot| slot.id == id)
                && slot.phase == SlotPhase::ReadyBlocked
                && slot.tenant_id.as_deref().unwrap_or(tenant_id) == tenant_id
            {
                self.ready.retain(|item| item != &id);
                return Ok(id);
            }
        }
        let pinned = self.sticky.contains_key(&key);

        // Free slot choice: never-pinned first, then the least recently used
        // pinned slot. Taking another session's slot is the last resort.
        let owners: HashMap<String, Instant> = self
            .ready
            .iter()
            .filter_map(|id| self.other_used(id, &key).map(|at| (id.clone(), at)))
            .collect();
        let chosen = self
            .ready
            .iter()
            .enumerate()
            .filter(|(_, id)| {
                slots.iter().any(|slot| {
                    &slot.id == *id
                        && slot.phase == SlotPhase::ReadyBlocked
                        && slot.tenant_id.as_deref().unwrap_or(tenant_id) == tenant_id
                })
            })
            // None (never pinned) sorts before any Some(last_used).
            .min_by_key(|(order, id)| (owners.get(*id).copied(), *order))
            .map(|(_, id)| id.clone());
        let Some(id) = chosen else {
            return Err(KernelError::NoCapacity);
        };
        self.ready.retain(|item| item != &id);
        if !pinned {
            self.bind_sticky(key, id.clone());
        }
        Ok(id)
    }
}

impl Default for SlotScheduler {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod sticky_tests {
    use super::*;

    fn ready_slots(sched: &mut SlotScheduler, n: usize) -> Vec<Slot> {
        (0..n)
            .map(|i| {
                let id = format!("s{i:02}");
                let mut slot = Slot::new(id.clone());
                slot.phase = SlotPhase::ReadyBlocked;
                sched.enqueue_ready(id);
                slot
            })
            .collect()
    }

    fn run_and_release(sched: &mut SlotScheduler, slots: &mut [Slot], session: &str) -> String {
        let id = sched.pick(slots, "t", session).expect("slot");
        let slot = slots.iter_mut().find(|s| s.id == id).unwrap();
        assert!(slot.bind_job("t", session, "job"));
        slot.unbind_ready();
        sched.enqueue_ready(id.clone());
        id
    }

    #[test]
    fn session_returns_to_its_slot_while_others_interleave() {
        let mut sched = SlotScheduler::new();
        let mut slots = ready_slots(&mut sched, 3);
        let a = run_and_release(&mut sched, &mut slots, "a");
        let b = run_and_release(&mut sched, &mut slots, "b");
        assert_ne!(
            a, b,
            "a new session must not take a pinned slot while a free one exists"
        );
        for _ in 0..3 {
            assert_eq!(run_and_release(&mut sched, &mut slots, "a"), a);
            assert_eq!(run_and_release(&mut sched, &mut slots, "b"), b);
        }
    }

    #[test]
    fn busy_pinned_slot_spills_one_turn_without_moving_the_pin() {
        let mut sched = SlotScheduler::new();
        let mut slots = ready_slots(&mut sched, 2);
        let a = run_and_release(&mut sched, &mut slots, "a");
        let held = sched.pick(&mut slots, "t", "a").unwrap();
        slots
            .iter_mut()
            .find(|s| s.id == held)
            .unwrap()
            .bind_job("t", "a", "j1");
        let spill = sched.pick(&mut slots, "t", "a").unwrap();
        assert_ne!(spill, a);
        let slot = slots.iter_mut().find(|s| s.id == held).unwrap();
        slot.unbind_ready();
        sched.enqueue_ready(held);
        sched.enqueue_ready(spill);
        assert_eq!(run_and_release(&mut sched, &mut slots, "a"), a);
    }

    #[test]
    fn retired_slot_keeps_its_session_after_reregistering() {
        let mut sched = SlotScheduler::new();
        let mut slots = ready_slots(&mut sched, 2);
        let a = run_and_release(&mut sched, &mut slots, "a");
        sched.forget(&a);
        slots.iter_mut().find(|s| s.id == a).unwrap().retire();
        let slot = slots.iter_mut().find(|s| s.id == a).unwrap();
        *slot = Slot::new(a.clone());
        slot.unbind_ready();
        sched.enqueue_ready(a.clone());
        assert_eq!(run_and_release(&mut sched, &mut slots, "a"), a);
    }

    #[test]
    fn expired_pin_releases_the_slot() {
        let mut sched = SlotScheduler::with_sticky_ttl(Duration::from_millis(1));
        let mut slots = ready_slots(&mut sched, 1);
        run_and_release(&mut sched, &mut slots, "a");
        std::thread::sleep(Duration::from_millis(5));
        sched.pick(&mut slots, "t", "b").unwrap();
        assert!(!sched.sticky.contains_key("t\u{1f}a"));
    }
}

#[cfg(test)]
mod ttft_bench {
    use super::*;
    use crate::provider::multiplex_cli::slot::Slot;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Instant;

    fn percentile(sorted: &[u128], p: f64) -> u128 {
        if sorted.is_empty() {
            return 0;
        }
        let idx = ((sorted.len() as f64 - 1.0) * p).round() as usize;
        sorted[idx.min(sorted.len() - 1)]
    }

    #[test]
    #[ignore]
    fn ttft_claude_hotpath() {
        const USERS: usize = 5;
        const OPS: usize = 400;
        const SLOTS: usize = 2;
        let first_sse: &[u8] = b"event: message_start\ndata: {\"type\":\"message_start\"}\n\n";

        let mut slots = Vec::with_capacity(SLOTS);
        let mut sched = SlotScheduler::new();
        for i in 0..SLOTS {
            let id = format!("slot-{i}");
            let mut slot = Slot::new(id.clone());
            slot.phase = SlotPhase::ReadyBlocked;
            sched.enqueue_ready(id);
            slots.push(slot);
        }
        let slots = Arc::new(Mutex::new(slots));
        let sched = Arc::new(Mutex::new(sched));

        let start = Instant::now();
        let mut handles = Vec::with_capacity(USERS);
        for u in 0..USERS {
            let slots = Arc::clone(&slots);
            let sched = Arc::clone(&sched);
            handles.push(thread::spawn(move || {
                let mut samples = Vec::with_capacity(OPS);
                for i in 0..OPS {
                    let sid = format!("s-{u}-{i}");
                    let t0 = Instant::now();
                    let id = loop {
                        let mut g = sched.lock().expect("sched");
                        let mut sl = slots.lock().expect("slots");
                        if let Ok(id) = g.pick(&mut sl, "t", &sid) {
                            break id;
                        }
                        drop(sl);
                        drop(g);
                        thread::yield_now();
                    };
                    let _ = first_sse.len();
                    {
                        let mut g = sched.lock().expect("sched");
                        let mut sl = slots.lock().expect("slots");
                        if let Some(slot) = sl.iter_mut().find(|s| s.id == id) {
                            slot.unbind_ready();
                        }
                        g.enqueue_ready(id);
                    }
                    samples.push(t0.elapsed().as_nanos());
                }
                samples
            }));
        }
        let mut all = Vec::with_capacity(USERS * OPS);
        for h in handles {
            all.extend(h.join().expect("join"));
        }
        let wall = start.elapsed();
        all.sort_unstable();
        let n = all.len() as f64;
        let mean = all.iter().sum::<u128>() as f64 / n;
        let rps = n / wall.as_secs_f64().max(1e-9);
        println!(
            "METRIC ttft_us={:.3}",
            percentile(&all, 0.50) as f64 / 1000.0
        );
        println!(
            "METRIC ttft_p95_us={:.3}",
            percentile(&all, 0.95) as f64 / 1000.0
        );
        println!(
            "METRIC ttft_p99_us={:.3}",
            percentile(&all, 0.99) as f64 / 1000.0
        );
        println!("METRIC ttft_mean_us={:.3}", mean / 1000.0);
        println!("METRIC conc5_rps={:.3}", rps);
        println!("METRIC samples={}", all.len());
    }
}
