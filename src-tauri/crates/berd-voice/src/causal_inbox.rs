use std::collections::HashSet;

#[derive(Clone, Debug, PartialEq)]
pub struct CausalMessage<T> {
    pub token: u64,
    pub payload: T,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidCausalToken {
    pub token: u64,
    pub previous: u64,
}

#[derive(Debug)]
pub struct CausalInbox<T> {
    messages: Vec<CausalMessage<T>>,
    individually_confirmed: HashSet<u64>,
    highest_token: u64,
    confirmed_token: u64,
}

impl<T> Default for CausalInbox<T> {
    fn default() -> Self {
        Self {
            messages: Vec::new(),
            individually_confirmed: HashSet::new(),
            highest_token: 0,
            confirmed_token: 0,
        }
    }
}

impl<T> CausalInbox<T> {
    pub fn push(&mut self, token: u64, payload: T) -> Result<(), InvalidCausalToken> {
        if token == 0 || token <= self.highest_token {
            return Err(InvalidCausalToken {
                token,
                previous: self.highest_token,
            });
        }
        self.highest_token = token;
        self.messages.push(CausalMessage { token, payload });
        Ok(())
    }

    pub fn confirm_exact(&mut self, token: u64) -> bool {
        if token == 0 || !self.messages.iter().any(|message| message.token == token) {
            return false;
        }
        self.individually_confirmed.insert(token)
    }

    pub fn discard(&mut self, token: u64) -> bool {
        let previous_len = self.messages.len();
        self.messages.retain(|message| message.token != token);
        self.individually_confirmed.remove(&token);
        self.messages.len() != previous_len
    }

    pub fn acknowledge(&mut self, token: Option<u64>) -> u64 {
        let Some(token) = token else {
            return self.confirmed_token;
        };
        if token == 0 {
            return 0;
        }
        if self.messages.iter().any(|message| message.token == token) {
            self.confirmed_token = self.confirmed_token.max(token);
            token
        } else {
            self.confirmed_token
        }
    }

    pub fn confirmed_token(&self) -> u64 {
        self.confirmed_token
    }
}

impl<T: Clone> CausalInbox<T> {
    pub fn messages_after(&self, token: u64) -> Vec<CausalMessage<T>> {
        self.messages
            .iter()
            .filter(|message| message.token > token)
            .cloned()
            .collect()
    }

    pub fn messages_unconfirmed_through(&self, token: u64) -> Vec<CausalMessage<T>> {
        self.messages
            .iter()
            .filter(|message| {
                message.token > token || !self.individually_confirmed.contains(&message.token)
            })
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acknowledgement_requires_an_exact_existing_token() {
        let mut inbox = CausalInbox::default();
        inbox.push(2, "one").unwrap();
        inbox.push(5, "two").unwrap();

        assert_eq!(inbox.acknowledge(Some(5)), 5);
        assert_eq!(inbox.confirmed_token(), 5);
        assert_eq!(inbox.acknowledge(Some(99)), 5);
        assert_eq!(inbox.acknowledge(Some(2)), 2);
        assert_eq!(inbox.confirmed_token(), 5);
    }

    #[test]
    fn individual_delivery_does_not_hide_an_earlier_failure() {
        let mut inbox = CausalInbox::default();
        inbox.push(1, "first").unwrap();
        inbox.push(2, "second").unwrap();
        assert!(inbox.confirm_exact(2));

        assert_eq!(
            inbox
                .messages_unconfirmed_through(2)
                .into_iter()
                .map(|message| message.token)
                .collect::<Vec<_>>(),
            vec![1]
        );
        assert!(inbox.discard(1));
        assert!(inbox.messages_unconfirmed_through(2).is_empty());
    }

    #[test]
    fn tokens_are_positive_and_strictly_increasing() {
        let mut inbox = CausalInbox::default();
        assert!(inbox.push(0, "zero").is_err());
        inbox.push(4, "four").unwrap();
        assert!(inbox.push(4, "duplicate").is_err());
        assert!(inbox.push(3, "older").is_err());
        inbox.push(7, "newer").unwrap();
    }
}
