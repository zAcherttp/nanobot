import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import type {
  MemoryCategory,
  WorkspaceMemoryService,
} from "@/services/workspace_memory";

export function createWorkspaceMemoryTools(
  memoryService: WorkspaceMemoryService,
): AgentTool<any, any>[] {
  return [
    {
      name: "list_memory_entries",
      label: "List Memory Entries",
      description: "List durable workspace memory entries.",
      parameters: Type.Object({
        category: Type.Optional(
          Type.Union([
            Type.Literal("decision"),
            Type.Literal("convention"),
            Type.Literal("constraint"),
            Type.Literal("attempt_outcome"),
          ]),
        ),
      }),
      execute: async (_toolCallId, params) => {
        const entries = await memoryService.listEntries(
          params.category as MemoryCategory | undefined,
        );
        const text =
          entries.length === 0
            ? "No memory entries found."
            : entries
                .map(
                  (entry) => `${entry.id} [${entry.category}] ${entry.summary}`,
                )
                .join("\n");

        return {
          content: [{ type: "text", text }],
          details: { entries },
        };
      },
    },
    {
      name: "get_memory_entry",
      label: "Get Memory Entry",
      description: "Read one durable workspace memory entry.",
      parameters: Type.Object({
        entry_id: Type.String(),
      }),
      execute: async (_toolCallId, params) => {
        const entry = await memoryService.getEntry(params.entry_id);
        if (!entry) {
          throw new Error(`Memory entry not found: ${params.entry_id}`);
        }

        const text = [
          `${entry.summary} [${entry.category}]`,
          entry.tags.length > 0
            ? `Tags: ${entry.tags.join(", ")}`
            : "Tags: none",
          entry.source ? `Source: ${entry.source}` : "Source: none",
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          details: { entry },
        };
      },
    },
    {
      name: "record_memory_entry",
      label: "Record Memory Entry",
      description: "Record durable workspace/project knowledge in MEMORY.md.",
      parameters: Type.Object({
        category: Type.Union([
          Type.Literal("decision"),
          Type.Literal("convention"),
          Type.Literal("constraint"),
          Type.Literal("attempt_outcome"),
        ]),
        summary: Type.String({ minLength: 1 }),
        tags: Type.Optional(Type.Array(Type.String())),
        source: Type.Optional(Type.String()),
      }),
      execute: async (_toolCallId, params) => {
        const entry = await memoryService.recordEntry({
          category: params.category as MemoryCategory,
          summary: params.summary,
          tags: params.tags,
          source: params.source,
        });

        return {
          content: [{ type: "text", text: `Recorded memory ${entry.id}.` }],
          details: { entry },
        };
      },
    },
    {
      name: "update_memory_entry",
      label: "Update Memory Entry",
      description: "Update a durable workspace memory entry.",
      parameters: Type.Object({
        entry_id: Type.String(),
        summary: Type.Optional(Type.String({ minLength: 1 })),
        tags: Type.Optional(Type.Array(Type.String())),
        source: Type.Optional(Type.String()),
      }),
      execute: async (_toolCallId, params) => {
        const entry = await memoryService.updateEntry(params.entry_id, {
          summary: params.summary,
          tags: params.tags,
          source: params.source,
        });

        return {
          content: [{ type: "text", text: `Updated memory ${entry.id}.` }],
          details: { entry },
        };
      },
    },
    {
      name: "remove_memory_entry",
      label: "Remove Memory Entry",
      description: "Remove a durable workspace memory entry.",
      parameters: Type.Object({
        entry_id: Type.String(),
      }),
      execute: async (_toolCallId, params) => {
        await memoryService.removeEntry(params.entry_id);
        return {
          content: [
            { type: "text", text: `Removed memory ${params.entry_id}.` },
          ],
          details: { entryId: params.entry_id },
        };
      },
    },
  ];
}
