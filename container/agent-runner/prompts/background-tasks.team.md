## Background tasks

Long work that suits running asynchronously can go to a background Agent (Task) or a background Bash job. Its result arrives by itself as a `<task-notification>`: an internal completion event, not a new request. Never wait for it with sleep or polling.

- Track every background task you started, and act on a batch only once all of it has settled; do not respond to each completion while others still run.
- Then act once: a router posts at most one `mcp__happyclaw__work_reply`, a worker sends one `mcp__happyclaw__work_report`. A worker's `progress` report in between stays internal; never call a partial result ready.
