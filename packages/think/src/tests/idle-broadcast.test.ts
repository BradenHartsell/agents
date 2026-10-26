import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName, getSubAgentByName } from "agents";
import { ThinkTestAgent } from "./agents/think-session";

// A chat frame is serialized only when a client can receive it. With no
// client connected, `_broadcastMessages()` used to stringify the whole
// cached transcript (and every stream chunk frame) before `broadcast()`
// found nobody to send it to.

const MSG_CHAT_MESSAGES = "cf_agent_chat_messages";
const MSG_CHAT_RESPONSE = "cf_agent_use_chat_response";

async function freshAgent(name?: string) {
  return getAgentByName(
    env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
    name ?? crypto.randomUUID()
  );
}

async function connectWS(path: string) {
  const res = await exports.default.fetch(
    `http://example.com/agents/think-test-agent/${path}`,
    { headers: { Upgrade: "websocket" } }
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return ws;
}

function collectTypes(ws: WebSocket): string[] {
  const types: string[] = [];
  ws.addEventListener("message", (e: MessageEvent) => {
    try {
      const frame = JSON.parse(e.data as string) as { type?: unknown };
      if (typeof frame.type === "string") types.push(frame.type);
    } catch {
      // ignore non-JSON frames
    }
  });
  return types;
}

function closeWS(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 200);
    ws.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    ws.close();
  });
}

async function waitFor(check: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("Think — chat frames with no client connected", () => {
  it("does not serialize chat frames when no client is connected", async () => {
    const agent = await freshAgent();

    // Build some history first, so the transcript frame is not trivial.
    await agent.testChat("first");
    const counts = await agent.countChatFrameSerializationsForTest("second");

    expect(counts).toEqual({});
  });

  it("still sends chat frames to a connected client", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    const ws = await connectWS(room);
    const types = collectTypes(ws);
    await waitFor(() => types.includes(MSG_CHAT_MESSAGES));
    types.length = 0;

    const counts = await agent.countChatFrameSerializationsForTest("hello");

    expect(counts[MSG_CHAT_MESSAGES]).toBeGreaterThan(0);
    expect(counts[MSG_CHAT_RESPONSE]).toBeGreaterThan(0);
    await waitFor(
      () =>
        types.includes(MSG_CHAT_MESSAGES) && types.includes(MSG_CHAT_RESPONSE)
    );
    await closeWS(ws);
  });

  it("does not serialize chat frames for a sub-agent nobody is connected to", async () => {
    const parent = await freshAgent();
    const child = await getSubAgentByName(
      parent,
      ThinkTestAgent,
      crypto.randomUUID()
    );

    await child.testChat("first");
    const counts = await child.countChatFrameSerializationsForTest("second");

    expect(counts).toEqual({});
  });

  it("still sends chat frames to a client connected to a sub-agent", async () => {
    const parentRoom = crypto.randomUUID();
    const childRoom = crypto.randomUUID();
    const parent = await freshAgent(parentRoom);
    const ws = await connectWS(
      `${parentRoom}/sub/think-test-agent/${childRoom}`
    );
    const types = collectTypes(ws);
    await waitFor(() => types.includes(MSG_CHAT_MESSAGES));
    types.length = 0;

    const child = await getSubAgentByName(parent, ThinkTestAgent, childRoom);
    await child.countChatFrameSerializationsForTest("hello");

    await waitFor(
      () =>
        types.includes(MSG_CHAT_MESSAGES) && types.includes(MSG_CHAT_RESPONSE)
    );
    await closeWS(ws);
  });
});
