import { describe, it, expect } from "vitest";
import { buildPermissionResponse } from "../../../src/providers/claude/session.js";

describe("buildPermissionResponse", () => {
  const toolUseId = "tool_use_42";
  const input = { command: "ls", path: "/tmp" };

  it("auto-allow path includes updatedInput echoing the original input", () => {
    // Regression: when no host callback is registered, the auto-allow response
    // used to omit `updatedInput`, and the CLI's PermissionResultAllow schema
    // would reject it via discriminated-union fall-through ("expected 'deny'").
    const resp = buildPermissionResponse(toolUseId, input, null);
    expect(resp).toEqual({
      behavior: "allow",
      toolUseID: toolUseId,
      updatedInput: input,
    });
  });

  it("allow with no updatedInput defaults to the original input", () => {
    // Regression: the same shape bug existed in the callback path. A host that
    // returned `{ allow: true }` without an explicit updatedInput got a wire
    // response missing the required field.
    const resp = buildPermissionResponse(toolUseId, input, { allow: true });
    expect(resp).toEqual({
      behavior: "allow",
      toolUseID: toolUseId,
      updatedInput: input,
    });
  });

  it("allow honors a host-supplied updatedInput", () => {
    const updated = { command: "ls", path: "/safe" };
    const resp = buildPermissionResponse(toolUseId, input, {
      allow: true,
      updatedInput: updated,
    });
    expect(resp).toEqual({
      behavior: "allow",
      toolUseID: toolUseId,
      updatedInput: updated,
    });
  });

  it("allow includes an optional host message", () => {
    const resp = buildPermissionResponse(toolUseId, input, {
      allow: true,
      message: "approved by policy",
    });
    expect(resp).toMatchObject({
      behavior: "allow",
      message: "approved by policy",
      updatedInput: input,
    });
  });

  it("deny does not include updatedInput", () => {
    const resp = buildPermissionResponse(toolUseId, input, {
      allow: false,
      message: "user rejected",
    });
    expect(resp).toEqual({
      behavior: "deny",
      toolUseID: toolUseId,
      message: "user rejected",
    });
    expect(resp).not.toHaveProperty("updatedInput");
  });

  it("deny without a message still produces a valid shape", () => {
    const resp = buildPermissionResponse(toolUseId, input, { allow: false });
    expect(resp).toEqual({
      behavior: "deny",
      toolUseID: toolUseId,
    });
  });
});
