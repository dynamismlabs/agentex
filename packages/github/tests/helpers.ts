import { afterEach, beforeEach } from "vitest";
import {
  _resetGhExecutor,
  _setGhExecutor,
} from "../src/index.js";
import type { GhExecResult } from "../src/index.js";

export interface RecordedCall {
  args: string[];
  opts: { cwd?: string; input?: string };
}

export interface ExecStub {
  fn: (args: readonly string[], opts: { cwd?: string; input?: string }) => Promise<GhExecResult>;
  calls: RecordedCall[];
}

/**
 * Build a stub executor that returns the next planned `GhExecResult` per call
 * (in order) and records every invocation. Use one stub per test for clarity.
 */
export function makeStub(plan: readonly GhExecResult[]): ExecStub {
  const calls: RecordedCall[] = [];
  const queue = [...plan];
  const fn = async (
    args: readonly string[],
    opts: { cwd?: string; input?: string },
  ): Promise<GhExecResult> => {
    calls.push({ args: [...args], opts });
    const next = queue.shift();
    if (!next) {
      throw new Error(
        `gh stub: no more planned responses (args: ${args.join(" ")})`,
      );
    }
    return next;
  };
  return { fn, calls };
}

/**
 * Bind a stub for the duration of a single test/file. Auto-resets in
 * `afterEach` to keep tests isolated.
 */
export function useStub(): { install: (stub: ExecStub) => void } {
  beforeEach(() => _resetGhExecutor());
  afterEach(() => _resetGhExecutor());
  return {
    install(stub) {
      _setGhExecutor(stub.fn);
    },
  };
}

export function ok(stdout: string, stderr = ""): GhExecResult {
  return { stdout, stderr, exitCode: 0 };
}

export function fail(exitCode: number, stderr: string, stdout = ""): GhExecResult {
  return { stdout, stderr, exitCode };
}
