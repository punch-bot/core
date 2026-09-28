# Punch todos

The Punch `todo` tool stores ordered tasks in `todos.sqlite` under `PI_DATA_DIR`, or under the user agent directory when `PI_DATA_DIR` is unset. Each task list belongs to one core session ID. A new session starts with an empty list. The context hook reads that session's current list before model requests.

The embedded Punch HTTP server provides authenticated task access:

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/todos/{sessionId}` | Current tasks, next ID, and recent changes |
| `DELETE` | `/todos/{sessionId}` | Deletes the list and blocks later writes to that session ID |

The API is limited to the sandbox owner, the first configured Punch HTTP user. The bot should call `DELETE` with the old **core session ID** when it discards that session on `/punch new`. Deleting the bot's logical conversation ID will not affect a different core session ID. The delete is idempotent. Creating or switching core sessions does not delete another session's tasks, because a sandbox can serve multiple conversations.

On first use, the extension imports each existing `todos.json` into the first session that starts in its working directory after the upgrade. It leaves the JSON file in place and records that file's migration in SQLite, so it cannot import again after a reset. The old file has no thread or session identifier; its original owner cannot be recovered automatically.
