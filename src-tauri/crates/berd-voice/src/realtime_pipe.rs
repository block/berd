use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub enum RealtimePipePeer {
    #[serde(rename = "master")]
    Expert,
    #[serde(rename = "emissary")]
    Spokesperson,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimePipeMessage {
    pub id: u64,
    pub sender: RealtimePipePeer,
    pub recipient: RealtimePipePeer,
    pub sender_cursor: u64,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum RealtimePipeExchange {
    Accepted(RealtimePipeAccepted),
    Rejected(RealtimePipeRejected),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimePipeAccepted {
    pub accepted: bool,
    pub outbound: RealtimePipeMessage,
    pub cursor: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimePipeRejected {
    pub accepted: bool,
    pub reason: RealtimePipeRejection,
    pub cursor: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RealtimePipeRejection {
    PipeBusy,
    StaleCursor,
}

#[derive(Debug)]
pub struct RealtimeMessagePipe {
    next_message_id: u64,
    pending: Vec<RealtimePipeMessage>,
    expert_cursor: u64,
    spokesperson_cursor: u64,
}

impl RealtimeMessagePipe {
    pub fn new(initial_cursor: u64) -> Self {
        Self {
            next_message_id: initial_cursor.saturating_add(1),
            pending: Vec::new(),
            expert_cursor: initial_cursor,
            spokesperson_cursor: initial_cursor,
        }
    }

    pub fn send(
        &mut self,
        sender: RealtimePipePeer,
        cursor: u64,
        message: &str,
    ) -> Result<RealtimePipeExchange, String> {
        let message = message.trim();
        if message.is_empty() {
            return Err("direct message cannot be empty".into());
        }
        if self
            .pending
            .first()
            .is_some_and(|active| active.sender != sender)
        {
            let latest = self.pending.last().expect("pending batch is nonempty");
            if cursor != latest.id {
                return Ok(RealtimePipeExchange::Rejected(RealtimePipeRejected {
                    accepted: false,
                    reason: RealtimePipeRejection::PipeBusy,
                    cursor: self.cursor(sender),
                }));
            }
            *self.cursor_mut(sender) = latest.id;
            self.pending.clear();
        }
        let confirmed_cursor = self.cursor(sender);
        if cursor != confirmed_cursor {
            return Ok(RealtimePipeExchange::Rejected(RealtimePipeRejected {
                accepted: false,
                reason: RealtimePipeRejection::StaleCursor,
                cursor: confirmed_cursor,
            }));
        }
        let outbound = RealtimePipeMessage {
            id: self.next_message_id,
            sender,
            recipient: other_pipe_peer(sender),
            sender_cursor: confirmed_cursor,
            message: message.into(),
        };
        self.next_message_id = self.next_message_id.saturating_add(1);
        self.pending.push(outbound.clone());
        Ok(RealtimePipeExchange::Accepted(RealtimePipeAccepted {
            accepted: true,
            outbound,
            cursor: confirmed_cursor,
        }))
    }

    pub fn cursor(&self, peer: RealtimePipePeer) -> u64 {
        match peer {
            RealtimePipePeer::Expert => self.expert_cursor,
            RealtimePipePeer::Spokesperson => self.spokesperson_cursor,
        }
    }

    pub fn delivery_cursor(&self, peer: RealtimePipePeer) -> u64 {
        self.pending
            .last()
            .filter(|message| message.recipient == peer)
            .map_or_else(|| self.cursor(peer), |message| message.id)
    }

    pub fn next_message_id(&self) -> u64 {
        self.next_message_id
    }

    fn cursor_mut(&mut self, peer: RealtimePipePeer) -> &mut u64 {
        match peer {
            RealtimePipePeer::Expert => &mut self.expert_cursor,
            RealtimePipePeer::Spokesperson => &mut self.spokesperson_cursor,
        }
    }
}

fn other_pipe_peer(peer: RealtimePipePeer) -> RealtimePipePeer {
    match peer {
        RealtimePipePeer::Expert => RealtimePipePeer::Spokesperson,
        RealtimePipePeer::Spokesperson => RealtimePipePeer::Expert,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_the_complete_pending_batch_before_reversing_direction() {
        let mut pipe = RealtimeMessagePipe::new(0);
        let first = pipe.send(RealtimePipePeer::Spokesperson, 0, "one").unwrap();
        let first_id = match first {
            RealtimePipeExchange::Accepted(accepted) => accepted.outbound.id,
            RealtimePipeExchange::Rejected(_) => panic!("first message was rejected"),
        };
        let second = pipe.send(RealtimePipePeer::Spokesperson, 0, "two").unwrap();
        let second_id = match second {
            RealtimePipeExchange::Accepted(accepted) => accepted.outbound.id,
            RealtimePipeExchange::Rejected(_) => panic!("second message was rejected"),
        };

        assert!(matches!(
            pipe.send(RealtimePipePeer::Expert, first_id, "stale")
                .unwrap(),
            RealtimePipeExchange::Rejected(RealtimePipeRejected {
                reason: RealtimePipeRejection::PipeBusy,
                ..
            })
        ));
        assert!(matches!(
            pipe.send(RealtimePipePeer::Expert, second_id, "caught up")
                .unwrap(),
            RealtimePipeExchange::Accepted(_)
        ));
    }
}
