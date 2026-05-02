import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
const pathState = vi.hoisted(() => ({ root: "" }));

vi.mock("../src/utils/paths", () => ({
  getRootDir: () => pathState.root,
  getConfigPath: (appName = "miniclaw") =>
    `${pathState.root}/${appName}/config.json`,
  resolvePath: (...parts: string[]) => `${pathState.root}/${parts.join("/")}`,
}));

import {
  PersistenceService,
  type ThreadMeta,
} from "../src/services/persistence";
import { ThreadCorruptedError, ThreadNotFoundError } from "../src/errors/base";

describe.sequential("PersistenceService integration", () => {
  let tempDir: string;
  let service: PersistenceService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "miniclaw-persist-"));
    pathState.root = tempDir;
    service = new PersistenceService({} as never, "miniclaw");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("auto-creates the conversation thread on first access", async () => {
    const thread = await service.getConversationThread();
    const threadDir = path.join(tempDir, "threads", "conversation");

    expect(thread.type).toBe("conversation");
    expect(thread.status).toBe("active");
    await expect(
      fs.stat(path.join(threadDir, "meta.json")),
    ).resolves.toBeDefined();
    await expect(
      fs.readFile(path.join(threadDir, "messages.jsonl"), "utf8"),
    ).resolves.toBe("");
  });

  it("persists appended and saved messages while keeping thread metadata in sync", async () => {
    const thread = await service.getConversationThread();

    await service.appendMessage(thread.id, {
      role: "user",
      content: "hello",
      timestamp: 1,
    });

    let messages = await service.getMessages(thread.id);
    let meta = await service.getThread(thread.id);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("hello");
    expect(meta.messageCount).toBe(1);

    await service.saveMessages(thread.id, [
      ...messages,
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        timestamp: 2,
      },
    ]);

    messages = await service.getMessages(thread.id);
    meta = await service.getThread(thread.id);

    expect(messages).toHaveLength(2);
    expect(meta.messageCount).toBe(2);
    expect(meta.updatedAt >= meta.createdAt).toBe(true);
  });

  it("surfaces missing and malformed thread data with explicit errors", async () => {
    await expect(service.getThread("missing-thread")).rejects.toBeInstanceOf(
      ThreadNotFoundError,
    );

    const thread = await service.getConversationThread();
    const messagesPath = path.join(
      tempDir,
      "threads",
      thread.id,
      "messages.jsonl",
    );

    await fs.writeFile(
      messagesPath,
      '{"role":"user","content":"ok"}\n{bad json}\n',
    );

    await expect(service.getMessages(thread.id)).rejects.toBeInstanceOf(
      ThreadCorruptedError,
    );
  });

  it("saves summaries and updates compaction metadata", async () => {
    const thread = await service.getConversationThread();
    const compactedMessages = [
      {
        role: "assistant" as const,
        content: [{ type: "text", text: "recent context" }],
        timestamp: 100,
      },
    ];

    await service.saveSummary(thread.id, "summary text");
    await service.compactThread(thread.id, compactedMessages, "summary text");

    const summary = await service.getSummary(thread.id);
    const meta = await service.getThread(thread.id);
    const messages = await service.getMessages(thread.id);

    expect(summary).toBe("summary text");
    expect(meta.summary).toBe("summary text");
    expect(meta.status).toBe("compacted");
    expect(meta.lastCompactedAt).toBeTruthy();
    expect(messages).toEqual(compactedMessages);
  });

  it("archives a thread by renaming its directory and preserving archived metadata", async () => {
    const thread = await service.getConversationThread();
    await service.appendMessage(thread.id, {
      role: "user",
      content: "archive me",
      timestamp: 1,
    });

    await service.archiveThread(thread.id);

    await expect(service.getThread(thread.id)).rejects.toBeInstanceOf(
      ThreadNotFoundError,
    );

    const threadsRoot = path.join(tempDir, "threads");
    const entries = await fs.readdir(threadsRoot);
    const archivedDir = entries.find((entry) => entry !== "conversation");

    expect(archivedDir).toBeTruthy();

    const archivedMeta = JSON.parse(
      await fs.readFile(
        path.join(threadsRoot, archivedDir!, "meta.json"),
        "utf8",
      ),
    ) as ThreadMeta;

    expect(archivedMeta.status).toBe("archived");
    expect(archivedMeta.id).toBe("conversation");
  });
});
