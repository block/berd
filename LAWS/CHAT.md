# Sending messages from the composer

## Sending

- Every message sent from the composer MUST go through the queue.
- The queue MUST keep messages in the order they were added.
- A message that is not first in the queue MUST NOT be sent.
- A message MUST NOT be sent until its session is ready.
- A session MUST be considered ready if and only if it exists, its preparation is complete, and it can accept a message.
- The queue MUST resume sending when the session becomes ready.

## Success and failure

- A message MUST remain in the queue until its send is accepted or the user removes it.
- A failed message MUST remain first in the queue.
- A message MUST NOT have more than one active send attempt.
- A send result MUST affect only the message and attempt that produced it.

## Editing and removal

- Editing a queued message MUST NOT change its position.
- Removing a queued message MUST NOT change the order of the remaining messages.
- Canceling an edit MUST leave the message unchanged.

## Steering

- A message that is not first in the queue MUST NOT steer the session.
- A steering result MUST affect only the message that produced it.
