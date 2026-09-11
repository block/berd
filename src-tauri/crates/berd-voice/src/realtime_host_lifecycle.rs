use std::{collections::HashSet, time::Duration};

use crate::gpt_live_voice_update::VoiceUpdatePurpose;

const DEFAULT_GPT_LIVE_RENEW_AFTER: Duration = Duration::from_secs(55 * 60);

pub fn gpt_live_renew_after() -> Duration {
    std::env::var("BERD_VOICE_REALTIME_RENEW_AFTER_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_GPT_LIVE_RENEW_AFTER)
}

/// Transport-independent activity that determines whether an OpenAI Realtime
/// GptLive session may start or activate lifecycle work.
///
/// Playback ownership and presentation remain adapter concerns. Both the
/// in-process Berd host and the framed VCCLI host feed their observed activity
/// into this type so turn admission and voice-update safety do not drift.
#[derive(Debug, Default)]
pub struct RealtimeHostActivity {
    user_speaking: bool,
    pending_user_items: HashSet<String>,
    inflight_responses: HashSet<String>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct RealtimeHostWork {
    pub playback_active: bool,
    pub retained_responses: usize,
    pub backend_output_reserved: bool,
    pub pending_backend_prepare: bool,
    pub truncation_pending: bool,
}

/// Shared lifecycle coordinator for every Backend-GptLive Realtime host.
///
/// Hosts still own transport I/O and playback, but session activity, renewal
/// admission, maintenance request identity, update safety, and disconnect
/// recovery decisions all pass through this state.
#[derive(Debug)]
pub struct RealtimeHostLifecycle {
    activity: RealtimeHostActivity,
    renew_after: Duration,
    renew_at: Option<std::time::Instant>,
    next_maintenance_id: u64,
}

impl RealtimeHostLifecycle {
    pub fn new(renew_after: Duration) -> Self {
        Self {
            activity: RealtimeHostActivity::default(),
            renew_after,
            renew_at: None,
            next_maintenance_id: u64::MAX,
        }
    }

    pub fn begin_user_speaking(&mut self, item_id: String) {
        self.activity.begin_user_speaking(item_id);
    }

    pub fn finish_user_speaking(&mut self) {
        self.activity.finish_user_speaking();
    }

    pub fn finish_user_item(&mut self, item_id: &str) {
        self.activity.finish_user_item(item_id);
    }

    pub fn begin_response(&mut self, response_id: String) {
        self.activity.begin_response(response_id);
    }

    pub fn has_inflight_response(&self, response_id: &str) -> bool {
        self.activity.has_inflight_response(response_id)
    }

    pub fn finish_response(&mut self, response_id: &str) {
        self.activity.finish_response(response_id);
    }

    pub fn input_blocks_output(&self) -> bool {
        self.activity.input_blocks_output()
    }

    pub fn is_busy(&self, work: RealtimeHostWork) -> bool {
        self.activity.is_busy(work)
    }

    pub fn settings_are_quiescent(&self, work: RealtimeHostWork) -> bool {
        self.activity.settings_are_quiescent(work)
    }

    pub fn queued_settings_are_ready(&self, work: RealtimeHostWork) -> bool {
        self.activity.queued_settings_are_ready(work)
    }

    pub fn session_started(&mut self, now: std::time::Instant) {
        self.renew_at = Some(now + self.renew_after);
    }

    pub fn retry_renewal_after(&mut self, now: std::time::Instant, delay: Duration) {
        self.renew_at = Some(now + delay);
    }

    pub fn renewal_is_due(
        &self,
        now: std::time::Instant,
        work: RealtimeHostWork,
        unresolved_handoff: bool,
        update_pending: bool,
    ) -> bool {
        !update_pending
            && !unresolved_handoff
            && self.renew_at.is_some_and(|deadline| now >= deadline)
            && self.activity.settings_are_quiescent(work)
    }

    pub fn next_maintenance_id(&mut self) -> u64 {
        let id = self.next_maintenance_id;
        self.next_maintenance_id = self.next_maintenance_id.wrapping_sub(1);
        id
    }

    #[allow(clippy::too_many_arguments)]
    pub fn voice_update_is_safe(
        &self,
        purpose: &VoiceUpdatePurpose,
        update_semantic_revision: u64,
        semantic_revision: u64,
        update_settings_revision: u64,
        settings_revision: u64,
        unresolved_handoff: bool,
        work: RealtimeHostWork,
    ) -> bool {
        voice_update_is_safe(
            purpose,
            update_semantic_revision,
            semantic_revision,
            update_settings_revision,
            settings_revision,
            unresolved_handoff,
            self.activity.settings_are_quiescent(work),
        )
    }

    pub fn session_loss_action(
        &self,
        pending: Option<&VoiceUpdatePurpose>,
        work: RealtimeHostWork,
        unresolved_handoff: bool,
    ) -> RealtimeSessionLossAction {
        session_loss_action(
            pending,
            self.activity.settings_are_quiescent(work),
            unresolved_handoff,
        )
    }
}

impl RealtimeHostActivity {
    pub fn begin_user_speaking(&mut self, item_id: String) {
        self.pending_user_items.insert(item_id);
        self.user_speaking = true;
    }

    pub fn finish_user_speaking(&mut self) {
        self.user_speaking = false;
    }

    pub fn finish_user_item(&mut self, item_id: &str) {
        self.pending_user_items.remove(item_id);
    }

    pub fn begin_response(&mut self, response_id: String) {
        self.inflight_responses.insert(response_id);
    }

    pub fn has_inflight_response(&self, response_id: &str) -> bool {
        self.inflight_responses.contains(response_id)
    }

    pub fn finish_response(&mut self, response_id: &str) {
        self.inflight_responses.remove(response_id);
    }

    pub fn input_blocks_output(&self) -> bool {
        self.user_speaking || !self.pending_user_items.is_empty()
    }

    pub fn is_busy(&self, work: RealtimeHostWork) -> bool {
        self.input_blocks_output()
            || work.playback_active
            || work.retained_responses != 0
            || !self.inflight_responses.is_empty()
    }

    pub fn settings_are_quiescent(&self, work: RealtimeHostWork) -> bool {
        !work.pending_backend_prepare && !self.is_busy(work) && !work.backend_output_reserved
    }

    pub fn queued_settings_are_ready(&self, work: RealtimeHostWork) -> bool {
        !self.is_busy(work) && !work.backend_output_reserved && !work.truncation_pending
    }
}

fn voice_update_is_safe(
    purpose: &VoiceUpdatePurpose,
    update_semantic_revision: u64,
    semantic_revision: u64,
    update_settings_revision: u64,
    settings_revision: u64,
    unresolved_handoff: bool,
    quiescent: bool,
) -> bool {
    let handoff_safe = !unresolved_handoff || matches!(purpose, VoiceUpdatePurpose::Settings);
    update_semantic_revision == semantic_revision
        && update_settings_revision == settings_revision
        && handoff_safe
        && quiescent
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RealtimeSessionLossAction {
    Fail,
    ContinuePendingRecovery,
    ReplacePendingAndRecover,
    StartRecovery,
}

fn session_loss_action(
    pending: Option<&VoiceUpdatePurpose>,
    quiescent: bool,
    unresolved_handoff: bool,
) -> RealtimeSessionLossAction {
    if !quiescent || unresolved_handoff {
        return RealtimeSessionLossAction::Fail;
    }
    match pending {
        Some(VoiceUpdatePurpose::Renewal) => RealtimeSessionLossAction::ContinuePendingRecovery,
        Some(VoiceUpdatePurpose::Settings) => RealtimeSessionLossAction::ReplacePendingAndRecover,
        Some(VoiceUpdatePurpose::SessionRecovery { .. }) => RealtimeSessionLossAction::Fail,
        None => RealtimeSessionLossAction::StartRecovery,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        session_loss_action, voice_update_is_safe, RealtimeHostActivity, RealtimeHostLifecycle,
        RealtimeHostWork, RealtimeSessionLossAction,
    };
    use crate::gpt_live_voice_update::VoiceUpdatePurpose;

    #[test]
    fn recognition_remains_busy_until_the_user_item_is_finalized() {
        let mut activity = RealtimeHostActivity::default();
        activity.begin_user_speaking("user-1".into());
        activity.finish_user_speaking();

        assert!(activity.is_busy(RealtimeHostWork::default()));
        activity.finish_user_item("user-1");
        assert!(!activity.is_busy(RealtimeHostWork::default()));
    }

    #[test]
    fn both_playback_models_use_the_same_quiescence_policy() {
        let activity = RealtimeHostActivity::default();
        assert!(!activity.settings_are_quiescent(RealtimeHostWork {
            playback_active: true,
            ..RealtimeHostWork::default()
        }));
        assert!(!activity.settings_are_quiescent(RealtimeHostWork {
            retained_responses: 1,
            ..RealtimeHostWork::default()
        }));
        assert!(activity.settings_are_quiescent(RealtimeHostWork::default()));
    }

    #[test]
    fn unresolved_handoffs_block_maintenance_but_not_explicit_settings() {
        let safe = |purpose| voice_update_is_safe(purpose, 4, 4, 2, 2, true, true);

        assert!(safe(&VoiceUpdatePurpose::Settings));
        assert!(!safe(&VoiceUpdatePurpose::Renewal));
    }

    #[test]
    fn queued_settings_wait_for_pending_truncation() {
        let activity = RealtimeHostActivity::default();
        assert!(!activity.queued_settings_are_ready(RealtimeHostWork {
            truncation_pending: true,
            ..RealtimeHostWork::default()
        }));
    }

    #[test]
    fn session_loss_recovery_policy_is_shared_by_both_hosts() {
        assert_eq!(
            session_loss_action(None, true, false),
            RealtimeSessionLossAction::StartRecovery
        );
        assert_eq!(
            session_loss_action(Some(&VoiceUpdatePurpose::Renewal), true, false),
            RealtimeSessionLossAction::ContinuePendingRecovery
        );
        assert_eq!(
            session_loss_action(Some(&VoiceUpdatePurpose::Settings), true, false),
            RealtimeSessionLossAction::ReplacePendingAndRecover
        );
        assert_eq!(
            session_loss_action(None, true, true),
            RealtimeSessionLossAction::Fail
        );
    }

    #[test]
    fn lifecycle_coordinates_renewal_identity_and_recovery() {
        let now = std::time::Instant::now();
        let mut lifecycle = RealtimeHostLifecycle::new(std::time::Duration::from_secs(30));
        lifecycle.session_started(now);

        assert!(!lifecycle.renewal_is_due(
            now + std::time::Duration::from_secs(29),
            RealtimeHostWork::default(),
            false,
            false,
        ));
        assert!(lifecycle.renewal_is_due(
            now + std::time::Duration::from_secs(30),
            RealtimeHostWork::default(),
            false,
            false,
        ));
        assert!(!lifecycle.renewal_is_due(
            now + std::time::Duration::from_secs(30),
            RealtimeHostWork::default(),
            true,
            false,
        ));
        assert_eq!(lifecycle.next_maintenance_id(), u64::MAX);
        assert_eq!(lifecycle.next_maintenance_id(), u64::MAX - 1);
        assert_eq!(
            lifecycle.session_loss_action(None, RealtimeHostWork::default(), false),
            RealtimeSessionLossAction::StartRecovery,
        );
    }
}
