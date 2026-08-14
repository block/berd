# Sending messages from the composer

## Sending

- Every message sent from the composer MUST go through the queue.
- The queue MUST keep messages in the order they were added.
- A queued message MUST retain the message and persona intent accepted when it was added or last edited.
- Each send attempt MUST use one authoritative session model and provider from the start of preparation through dispatch.
- A message that is not first in the queue MUST NOT be sent.
- A message MUST NOT be sent until its session is ready.
- A session MUST be considered ready if and only if it exists, its preparation is complete, and it can accept a message.
- The queue MUST resume sending when the session becomes ready.

## Success and failure

- A message MUST remain in the queue until its session begins processing it or the user removes it.
- A message MUST produce at most one user turn, including across retries.
- A failed message MUST remain first in the queue.
- A message MUST NOT have more than one active send attempt.
- A send result MUST affect only the message and attempt that produced it.

## Editing and removal

- Editing a queued message MUST NOT change its position.
- Removing a queued message MUST NOT change the order of the remaining messages.
- Canceling an edit MUST leave the message unchanged.
- Sending a queued message MUST NOT alter text entered in the composer after that message was queued.

## Steering

- A message that is not first in the queue MUST NOT steer the session.
- A steering result MUST affect only the message that produced it.
- While the session is running, a send shortcut with an empty composer MUST steer the first queued message when steering is available.
- A send shortcut MUST NOT steer a queued message while the composer holds draft content or a queued message is being edited.

## Subagent activity

- Subagent activity MUST attribute the subagent when its identity is known.
- Subagent activity MUST describe the delegated task when it is known.
