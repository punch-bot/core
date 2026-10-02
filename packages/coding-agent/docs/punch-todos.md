# Punch todos

The Punch `todo` tool stores ordered tasks in `todos.sqlite` under `PI_DATA_DIR`, or under the user agent directory when `PI_DATA_DIR` is unset. Each task list belongs to one core session ID and the original working directory recorded in its session header. Resuming with a working directory override keeps the same list. A new session starts with an empty list. Sessions without persistence keep their tasks in memory. The context hook reads that session's current list before model requests.

The embedded Punch HTTP server provides authenticated task access:

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/todos/{sessionId}` | Current tasks, next ID, and recent changes |
| `DELETE` | `/todos/{sessionId}` | Deletes the list and blocks later writes to that session ID |

The API is limited to the sandbox owner, the first configured Punch HTTP user. The bot should call `DELETE` with the old **core session ID** when it discards that session on `/punch new`. Deleting the bot's logical conversation ID will not affect a different core session ID. The delete is idempotent. Creating or switching core sessions does not delete another session's tasks, because a sandbox can serve multiple conversations.

Both endpoints use the server's current working directory by default. When the session header records another directory, pass that original absolute path as the URL-encoded `cwd` query parameter, such as `/todos/work?cwd=%2Fworkspace%2Fproject`. Use the header's directory even when the session resumes with a working directory override. For legacy headers without `cwd`, the storage scope is the absolute directory containing the session file; pass that directory in the query.

On first use, the extension imports each existing `todos.json` into the first persistent session that starts in its working directory after the upgrade. It leaves the JSON file in place and records that file's migration in SQLite, so it cannot import again after a reset. The old file has no thread or session identifier; its original owner cannot be recovered automatically.
