import { describe, expect, it } from "vitest";
import { createGoalInputSchema, sendMessageInputSchema, createShareInputSchema } from "../src/index.js";

describe("OpenMuse transport contracts", () => {
  it("accepts bounded user content and rejects server-authored tool parts", () => {
    expect(sendMessageInputSchema.safeParse({
      conversationId: "conversation-1",
      parts: [{ type: "text", text: "Hello" }, { type: "file", artifactId: "artifact-1" }],
    }).success).toBe(true);
    expect(sendMessageInputSchema.safeParse({
      conversationId: "conversation-1",
      parts: [{ type: "toolCall", callId: "tool-1", name: "send", arguments: {} }],
    }).success).toBe(false);
  });

  it("requires explicit per-action approval policy through the goal boundary", () => {
    const parsed = createGoalInputSchema.parse({
      workspaceId: "workspace-1",
      title: "Summarize my calendar",
      instructions: "Create a read-only daily summary.",
    });
    expect(parsed).not.toHaveProperty("approvalMode");
    expect(createGoalInputSchema.safeParse({
      ...parsed,
      approvalMode: "standing",
    }).success).toBe(false);
  });

  it("only creates immutable read shares", () => {
    expect(createShareInputSchema.safeParse({
      resourceType: "artifact",
      resourceId: "artifact-1",
      subjectType: "user",
      subjectId: "user-2",
    }).success).toBe(true);
    expect(createShareInputSchema.safeParse({
      resourceType: "memory",
      resourceId: "memory-1",
      subjectType: "user",
      subjectId: "user-2",
      permission: "write",
    }).success).toBe(false);
  });
});
