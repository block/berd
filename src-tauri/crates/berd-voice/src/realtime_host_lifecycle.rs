use std::collections::HashSet;

use crate::spokesperson_voice_update::VoiceUpdatePurpose;

/// Transport-independent activity that determines whether an OpenAI Realtime
/// Spokesperson session may start or activate lifecycle work.
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
    pub expert_output_reserved: bool,
    pub pending_expert_prepare: bool,
    pub truncation_pending: bool,
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
        !work.pending_expert_prepare && !self.is_busy(work) && !work.expert_output_reserved
    }

    pub fn queued_settings_are_ready(&self, work: RealtimeHostWork) -> bool {
        !self.is_busy(work) && !work.expert_output_reserved && !work.truncation_pending
    }
}

pub fn voice_update_is_safe(
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

#[cfg(test)]
mod tests {
    use super::{voice_update_is_safe, RealtimeHostActivity, RealtimeHostWork};
    use crate::spokesperson_voice_update::VoiceUpdatePurpose;

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
}
