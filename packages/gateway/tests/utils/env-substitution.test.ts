import { describe, it, expect } from "vitest";
import { substituteEnvVars } from "../../src/utils/env-substitution.js";

describe("substituteEnvVars", () => {
  const env = {
    MY_TOKEN: "secret123",
    DB_HOST: "localhost",
    PORT: "3000",
  };

  it("substitutes $VAR syntax", () => {
    expect(substituteEnvVars("$MY_TOKEN", env)).toBe("secret123");
  });

  it("substitutes ${VAR} syntax", () => {
    expect(substituteEnvVars("${MY_TOKEN}", env)).toBe("secret123");
  });

  it("substitutes within a larger string", () => {
    expect(substituteEnvVars("host:${DB_HOST}:${PORT}", env)).toBe(
      "host:localhost:3000",
    );
  });

  it("throws on missing variable", () => {
    expect(() => substituteEnvVars("$MISSING", env, "config.token")).toThrow(
      "Config error: config.token references $MISSING which is not set",
    );
  });

  it("recursively substitutes in objects", () => {
    const input = {
      host: "$DB_HOST",
      token: "${MY_TOKEN}",
      nested: { port: "$PORT" },
    };
    expect(substituteEnvVars(input, env)).toEqual({
      host: "localhost",
      token: "secret123",
      nested: { port: "3000" },
    });
  });

  it("recursively substitutes in arrays", () => {
    const input = ["$DB_HOST", "${PORT}"];
    expect(substituteEnvVars(input, env)).toEqual(["localhost", "3000"]);
  });

  it("preserves non-string values", () => {
    const input = { count: 5, flag: true, nothing: null };
    expect(substituteEnvVars(input, env)).toEqual({
      count: 5,
      flag: true,
      nothing: null,
    });
  });

  it("throws with correct field path for nested missing vars", () => {
    const input = { channels: { telegram: { token: "$UNKNOWN" } } };
    expect(() => substituteEnvVars(input, env)).toThrow(
      "Config error: channels.telegram.token references $UNKNOWN which is not set",
    );
  });

  it("handles string with no variables", () => {
    expect(substituteEnvVars("plain text", env)).toBe("plain text");
  });

  it("handles empty object", () => {
    expect(substituteEnvVars({}, env)).toEqual({});
  });
});
