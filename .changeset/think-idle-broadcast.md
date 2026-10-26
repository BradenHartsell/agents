---
"agents": patch
"@cloudflare/think": patch
---

Think no longer serializes chat frames, including the whole cached transcript, when no client can receive them. See [#2724](https://github.com/cloudflare/agents/issues/2724).
