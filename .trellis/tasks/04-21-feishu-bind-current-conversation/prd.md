# Bind Current Conversation To Feishu Chat

## Goal
Allow a user to bind the currently open CAFF conversation to a Feishu `chat_id`, so future Feishu messages from that chat reuse the selected conversation.

## Requirements
- Add a minimal backend API to bind a conversation to a Feishu chat by `chat_id`.
- Reuse the existing `chat_channel_bindings` persistence model; do not add a new table.
- Support the MVP behavior of moving an existing Feishu `chat_id` binding to the selected conversation.
- Reject binding when the target conversation is currently busy/running, to avoid replies being redirected mid-turn.
- Add a small UI control in conversation settings for entering a Feishu `chat_id` and binding it to the active conversation.
- Show clear success and error feedback in the UI.

## Acceptance Criteria
- [ ] A user can open a conversation, enter a Feishu `chat_id`, and bind that Feishu chat to the conversation.
- [ ] The backend validates that the conversation exists and `chat_id` is non-empty.
- [ ] The backend refuses to bind a busy conversation and returns a structured error.
- [ ] Existing Feishu binding rows are reused/updated instead of duplicating bindings.
- [ ] The UI exposes the action without breaking existing conversation settings.
- [ ] Existing Feishu `/new` behavior continues to work.
- [ ] Relevant backend and/or frontend tests cover the new binding flow where existing test infrastructure allows it.

## Technical Notes
- Candidate endpoint: `PUT /api/conversations/:id/channel-bindings/feishu` with body `{ "chatId": "..." }`.
- Initial scope is bind/rebind by Feishu `chat_id`; explicit unbind and conflict-confirm UX are out of scope.
- Implementation should follow existing controller response conventions and conversation settings UI patterns.
- No automatic Feishu message should be sent during binding.
