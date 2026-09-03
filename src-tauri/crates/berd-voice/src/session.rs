use std::collections::HashSet;

use crate::protocol::{NotAdmittedReason, PendingUtterance};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PlaybackState {
    Idle,
    WaitingOutput,
    Playing,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PrepareRequest {
    pub id: u64,
    pub acknowledgement: Option<u64>,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PrepareOutcome {
    Hold,
    Pending(Vec<PendingUtterance>),
    NotAdmitted(NotAdmittedReason),
    Admitted {
        speech_id: u64,
        confirmed_token: u64,
        text: String,
    },
}

#[derive(Debug)]
pub struct SessionCore {
    utterances: Vec<PendingUtterance>,
    individually_confirmed: HashSet<u64>,
    highest_utterance_token: u64,
    confirmed_token: u64,
    user_speaking: bool,
    recognition_pending: bool,
    paused: bool,
    playback: PlaybackState,
    next_speech_id: u64,
    active_speech_id: Option<u64>,
}

impl Default for SessionCore {
    fn default() -> Self {
        Self {
            utterances: Vec::new(),
            individually_confirmed: HashSet::new(),
            highest_utterance_token: 0,
            confirmed_token: 0,
            user_speaking: false,
            recognition_pending: false,
            paused: false,
            playback: PlaybackState::Idle,
            next_speech_id: 1,
            active_speech_id: None,
        }
    }
}

impl SessionCore {
    pub fn add_final(&mut self, token: u64, text: String) -> Result<(), String> {
        let previous = self.highest_utterance_token;
        if token == 0 || token <= previous {
            return Err(format!(
                "user_final token {token} must be greater than {previous}"
            ));
        }
        self.highest_utterance_token = token;
        self.utterances.push(PendingUtterance { token, text });
        Ok(())
    }

    /// Confirms one exact finalized-input token after a host's delivery trust
    /// decision succeeds. This does not imply that earlier inputs were delivered.
    pub fn confirm_exact(&mut self, token: u64) -> bool {
        if token == 0
            || !self
                .utterances
                .iter()
                .any(|utterance| utterance.token == token)
        {
            return false;
        }
        self.individually_confirmed.insert(token)
    }

    /// Removes a finalized input that the host has terminally abandoned.
    /// Discarding never confirms that input or any input before it.
    pub fn discard_final(&mut self, token: u64) -> bool {
        let previous_len = self.utterances.len();
        self.utterances.retain(|utterance| utterance.token != token);
        self.individually_confirmed.remove(&token);
        self.utterances.len() != previous_len
    }

    /// Applies an exact causal cutoff while requiring every retained input at
    /// or before it to have been individually confirmed by the host.
    pub fn prepare_after_host_confirmation(&mut self, request: PrepareRequest) -> PrepareOutcome {
        let text = request.text.trim().to_string();
        if text.is_empty() {
            return PrepareOutcome::NotAdmitted(NotAdmittedReason::EmptyText);
        }
        if self.user_speaking || self.recognition_pending {
            return PrepareOutcome::Hold;
        }

        let cutoff = request.acknowledgement.unwrap_or(0);
        let pending: Vec<_> = self
            .utterances
            .iter()
            .filter(|utterance| {
                utterance.token > cutoff || !self.individually_confirmed.contains(&utterance.token)
            })
            .cloned()
            .collect();
        if !pending.is_empty() {
            return PrepareOutcome::Pending(pending);
        }
        self.reserve(text)
    }

    pub fn set_user_speaking(&mut self, active: bool) -> bool {
        self.user_speaking = active;
        active && self.playback != PlaybackState::Idle
    }

    pub fn set_recognition_pending(&mut self, active: bool) -> bool {
        self.recognition_pending = active;
        active && self.playback != PlaybackState::Idle
    }

    pub fn set_paused(&mut self, active: bool) -> bool {
        self.paused = active;
        active && self.playback != PlaybackState::Idle
    }

    pub fn prepare(&mut self, request: PrepareRequest) -> PrepareOutcome {
        let text = request.text.trim().to_string();
        if text.is_empty() {
            return PrepareOutcome::NotAdmitted(NotAdmittedReason::EmptyText);
        }
        if self.user_speaking || self.recognition_pending {
            return PrepareOutcome::Hold;
        }

        let cutoff = self.apply_acknowledgement(request.acknowledgement);
        let pending: Vec<_> = self
            .utterances
            .iter()
            .filter(|utterance| utterance.token > cutoff)
            .cloned()
            .collect();
        if !pending.is_empty() {
            return PrepareOutcome::Pending(pending);
        }
        self.reserve(text)
    }

    pub fn mark_started(&mut self, speech_id: u64) -> bool {
        if self.playback == PlaybackState::WaitingOutput
            && self.active_speech_id() == Some(speech_id)
        {
            self.playback = PlaybackState::Playing;
            true
        } else {
            false
        }
    }

    pub fn finish(&mut self, speech_id: u64) -> bool {
        if self.playback != PlaybackState::Idle && self.active_speech_id() == Some(speech_id) {
            self.playback = PlaybackState::Idle;
            self.active_speech_id = None;
            true
        } else {
            false
        }
    }

    fn active_speech_id(&self) -> Option<u64> {
        self.active_speech_id
    }
    fn reserve(&mut self, text: String) -> PrepareOutcome {
        if self.paused {
            return PrepareOutcome::NotAdmitted(NotAdmittedReason::Paused);
        }
        if self.playback != PlaybackState::Idle {
            return PrepareOutcome::NotAdmitted(NotAdmittedReason::InProgress);
        }

        let speech_id = self.next_speech_id;
        self.next_speech_id = self.next_speech_id.saturating_add(1);
        self.playback = PlaybackState::WaitingOutput;
        self.active_speech_id = Some(speech_id);
        PrepareOutcome::Admitted {
            speech_id,
            confirmed_token: self.confirmed_token,
            text,
        }
    }
    pub fn utterances_after(&self, token: u64) -> Vec<PendingUtterance> {
        self.utterances
            .iter()
            .filter(|item| item.token > token)
            .cloned()
            .collect()
    }

    pub fn confirmed_token(&self) -> u64 {
        self.confirmed_token
    }
    pub fn user_speaking(&self) -> bool {
        self.user_speaking
    }
    pub fn recognition_pending(&self) -> bool {
        self.recognition_pending
    }
    fn apply_acknowledgement(&mut self, acknowledgement: Option<u64>) -> u64 {
        let Some(token) = acknowledgement else {
            return self.confirmed_token;
        };
        if token == 0 {
            return 0;
        }
        if self
            .utterances
            .iter()
            .any(|utterance| utterance.token == token)
        {
            self.confirmed_token = self.confirmed_token.max(token);
            token
        } else {
            self.confirmed_token
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(acknowledgement: Option<u64>) -> PrepareRequest {
        PrepareRequest {
            id: 7,
            acknowledgement,
            text: "hello".into(),
        }
    }

    #[test]
    fn exact_ack_advances_global_cursor_and_admits() {
        let mut core = SessionCore::default();
        core.add_final(2, "one".into()).unwrap();
        core.add_final(5, "two".into()).unwrap();
        assert!(matches!(
            core.prepare(request(Some(5))),
            PrepareOutcome::Admitted {
                confirmed_token: 5,
                ..
            }
        ));
    }

    #[test]
    fn zero_and_missing_ack_do_not_confirm_input() {
        for acknowledgement in [None, Some(0)] {
            let mut core = SessionCore::default();
            core.add_final(2, "one".into()).unwrap();
            assert!(matches!(
                core.prepare(request(acknowledgement)),
                PrepareOutcome::Pending(_)
            ));
            assert_eq!(core.confirmed_token(), 0);
        }
    }

    #[test]
    fn existing_stale_ack_is_exact_but_future_falls_back_global() {
        let mut core = SessionCore::default();
        core.add_final(2, "one".into()).unwrap();
        core.add_final(5, "two".into()).unwrap();
        assert!(matches!(
            core.prepare(request(Some(5))),
            PrepareOutcome::Admitted { .. }
        ));
        assert!(core.finish(1));
        core.add_final(9, "three".into()).unwrap();
        let PrepareOutcome::Pending(stale) = core.prepare(request(Some(2))) else {
            panic!("stale existing token is an exact cutoff")
        };
        assert_eq!(
            stale.iter().map(|item| item.token).collect::<Vec<_>>(),
            vec![5, 9]
        );
        assert_eq!(core.confirmed_token(), 5);
        assert!(matches!(
            core.prepare(request(Some(99))),
            PrepareOutcome::Pending(_)
        ));
        assert_eq!(core.confirmed_token(), 5);
    }

    #[test]
    fn speaking_holds_before_ack_mutation() {
        let mut core = SessionCore::default();
        core.add_final(3, "one".into()).unwrap();
        core.set_user_speaking(true);
        assert_eq!(core.prepare(request(Some(3))), PrepareOutcome::Hold);
        assert_eq!(core.confirmed_token(), 0);
    }

    #[test]
    fn recognition_pending_holds_before_ack_mutation_until_cleared() {
        let mut core = SessionCore::default();
        core.add_final(3, "one".into()).unwrap();
        core.set_recognition_pending(true);
        assert_eq!(core.prepare(request(Some(3))), PrepareOutcome::Hold);
        assert_eq!(core.confirmed_token(), 0);

        core.set_recognition_pending(false);
        assert!(matches!(
            core.prepare(request(Some(3))),
            PrepareOutcome::Admitted {
                confirmed_token: 3,
                ..
            }
        ));
    }

    #[test]
    fn host_confirmation_is_exact_monotonic_and_duplicate_safe() {
        let mut core = SessionCore::default();
        core.add_final(2, "one".into()).unwrap();
        core.add_final(5, "two".into()).unwrap();

        assert!(!core.confirm_exact(4));
        assert_eq!(core.confirmed_token(), 0);
        assert!(core.confirm_exact(5));
        assert!(core.confirm_exact(2));
        assert!(!core.confirm_exact(2));
        assert_eq!(core.confirmed_token(), 0);
    }

    #[test]
    fn later_individual_confirmation_cannot_hide_an_earlier_failed_delivery() {
        let mut core = SessionCore::default();
        core.add_final(1, "slow first".into()).unwrap();
        core.add_final(2, "fast second".into()).unwrap();
        assert!(core.confirm_exact(2));

        assert!(matches!(
            core.prepare_after_host_confirmation(request(Some(2))),
            PrepareOutcome::Pending(items)
                if items.iter().map(|item| item.token).collect::<Vec<_>>() == vec![1]
        ));
        assert!(core.discard_final(1));
        assert!(matches!(
            core.prepare_after_host_confirmation(request(Some(2))),
            PrepareOutcome::Admitted { .. }
        ));
    }

    #[test]
    fn discarded_final_never_confirms_and_high_water_does_not_rewind() {
        let mut core = SessionCore::default();
        core.add_final(2, "one".into()).unwrap();
        assert!(core.discard_final(2));
        assert!(!core.discard_final(2));
        assert!(!core.confirm_exact(2));
        assert_eq!(core.confirmed_token(), 0);
        assert_eq!(
            core.add_final(2, "reused".into()).unwrap_err(),
            "user_final token 2 must be greater than 2"
        );
        core.add_final(3, "next".into()).unwrap();
        assert!(
            matches!(core.prepare(request(None)), PrepareOutcome::Pending(items) if items.len() == 1 && items[0].token == 3)
        );
    }

    #[test]
    fn reservation_is_single_and_pause_cancels_active() {
        let mut core = SessionCore::default();
        assert!(matches!(
            core.prepare(request(None)),
            PrepareOutcome::Admitted { .. }
        ));
        assert_eq!(
            core.prepare(request(None)),
            PrepareOutcome::NotAdmitted(NotAdmittedReason::InProgress)
        );
        assert!(core.set_paused(true));
        assert!(core.finish(1));
        assert_eq!(
            core.prepare(request(None)),
            PrepareOutcome::NotAdmitted(NotAdmittedReason::Paused)
        );
    }

    #[test]
    fn recognition_pending_interrupts_a_reserved_speech() {
        let mut core = SessionCore::default();
        assert!(matches!(
            core.prepare(request(None)),
            PrepareOutcome::Admitted { .. }
        ));
        assert!(core.set_recognition_pending(true));
        assert!(core.finish(1));
    }

    #[test]
    fn final_tokens_are_positive_and_monotonic() {
        let mut core = SessionCore::default();
        assert!(core.add_final(0, "bad".into()).is_err());
        core.add_final(4, "ok".into()).unwrap();
        assert!(core.add_final(4, "duplicate".into()).is_err());
        assert!(core.add_final(3, "stale".into()).is_err());
    }
}
