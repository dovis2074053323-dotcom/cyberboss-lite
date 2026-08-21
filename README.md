# wechat-claude-bot

A small single-purpose bridge:

1. long-poll WeChat;
2. admit allowlisted, deduplicated text messages;
3. queue each message independently in FIFO order;
4. wait for the shared Claude host lock;
5. run one plain-text `claude -p` call;
6. reply with the returned text using that message's own `context_token`.

There is no conversation history, persistent model state, scheduled sender,
attachment pipeline, or prompt schema. OAuth credentials are shared through
Claude Code's normal credential file; the service account receives only the
read ACL restored by `deploy/wechat-claude-ensure-credential-acl`.

## Commands

```sh
npm install
npm run login
npm start
npm run doctor
```

Runtime state is configured with `WECHAT_CLAUDE_STATE_DIR`; deployment uses
`/srv/wechat-claude-bot/state`. The service unit is
`deploy/wechat-claude-bot.service`.
