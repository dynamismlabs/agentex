import { describe, expect, it } from "vitest";
import { github, NotInstalledError } from "../src/index.js";
import { _setGhExecutor } from "../src/index.js";
import { fail, ok, useStub, makeStub } from "./helpers.js";

const stub = useStub();

describe("github.checkInstalled", () => {
  it("returns installed: true with version when `gh --version` succeeds", async () => {
    const s = makeStub([ok("gh version 2.74.2 (2025-06-17)\nhttps://github.com/cli/cli/releases/tag/v2.74.2\n")]);
    stub.install(s);

    const result = await github.checkInstalled();

    expect(result.installed).toBe(true);
    expect(result.version).toBe("2.74.2");
    expect(s.calls[0]?.args).toEqual(["--version"]);
  });

  it("returns installed: false when the executor throws NotInstalledError (gh not on PATH)", async () => {
    _setGhExecutor(async () => {
      throw new NotInstalledError();
    });

    const result = await github.checkInstalled();
    expect(result.installed).toBe(false);
    expect(result.version).toBeUndefined();
  });

  it("returns installed: false on non-zero exit even without throwing", async () => {
    const s = makeStub([fail(1, "command failed")]);
    stub.install(s);

    const result = await github.checkInstalled();
    expect(result.installed).toBe(false);
  });
});

describe("github.checkAuthenticated", () => {
  it("parses the modern `Logged in to <host> account <user>` format from stderr", async () => {
    const stderr = `github.com
  ✓ Logged in to github.com account demouser (keyring)
  - Active account: true
`;
    const s = makeStub([ok("", stderr)]);
    stub.install(s);

    const r = await github.checkAuthenticated();
    expect(r.authenticated).toBe(true);
    expect(r.user).toBe("demouser");
    expect(r.host).toBe("github.com");
    expect(s.calls[0]?.args).toEqual(["auth", "status"]);
  });

  it("parses the legacy `Logged in to <host> as <user>` format", async () => {
    const stderr = "github.com\n  ✓ Logged in to github.com as alice (keyring)\n";
    const s = makeStub([ok("", stderr)]);
    stub.install(s);

    const r = await github.checkAuthenticated();
    expect(r.authenticated).toBe(true);
    expect(r.user).toBe("alice");
    expect(r.host).toBe("github.com");
  });

  it("returns authenticated: false on non-zero exit code", async () => {
    const s = makeStub([fail(1, "You are not logged into any GitHub hosts. Run `gh auth login` to authenticate.\n")]);
    stub.install(s);

    const r = await github.checkAuthenticated();
    expect(r.authenticated).toBe(false);
  });

  it("returns authenticated: false when the executor throws NotInstalledError", async () => {
    _setGhExecutor(async () => {
      throw new NotInstalledError();
    });

    const r = await github.checkAuthenticated();
    expect(r.authenticated).toBe(false);
  });
});
