# Composer queues and session dispatch

## Queue acceptance and dispatch

- The composer MUST queue every accepted message into the selected chat's queue, including before that chat's session is ready.
- The composer MUST queue accepted messages into the selected chat's queue in their acceptance order.
- The selected chat's queue MUST retain the message and persona intent most recently accepted from the composer or a user edit.
- A chat's queue MUST NOT dispatch a message to that chat's session before every message ahead of it in the queue.
- A message MUST NOT be dispatched from the queue until its session is ready.
- A session MUST be ready for dispatch from its queue only when it can begin processing that queue's first message.
- When a chat's session becomes ready, that chat's queue MUST resume dispatching its first message to that session.

## Dispatch outcomes

- A chat's queue MUST NOT dequeue a message before that chat's session begins processing it.
- A user action to remove a message from a chat's queue MUST remove only the selected message from that queue.
- A chat's queue MUST NOT dispatch a message to that chat's session in a way that creates more than one user turn, including after a failed dispatch.
- A failed dispatch from a chat's queue to its session MUST leave the message first in that queue.
- A chat's queue MUST NOT dispatch a second copy of a message to that chat's session while the first dispatch is unresolved.
- A dispatch outcome from a chat's queue to its session MUST NOT change any other message in that queue.

## Queue editing and removal

- A user edit to a message in a chat's queue MUST NOT change that message's position in the queue.
- A user removal from a chat's queue MUST NOT change the order of messages remaining in that queue.
- A user cancellation of an edit MUST leave the selected message unchanged in that chat's queue.
- Dispatching a message from a chat's queue to its session MUST NOT alter text entered later in that chat's composer.

## Queue steering

- A message that is not first in a chat's queue MUST NOT be steered from that queue to that chat's session.
- A steering outcome from a chat's queue to its session MUST NOT change any other message in that queue.
- While a chat's session is running, an empty-composer shortcut MUST steer the first message from that chat's queue to that session when steering is available.
- A composer shortcut MUST NOT steer a message from a chat's queue to that chat's session while the composer contains draft text or a message in that queue is being edited.

## Session activity presentation

- A session's subagent activity MUST appear in the chat transcript with the subagent identity when known.
- A session's subagent activity MUST appear in the chat transcript with the delegated task when known.
