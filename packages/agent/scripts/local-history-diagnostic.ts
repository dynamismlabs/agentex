import { getProvider } from "../src/index.js";

for (const providerType of ["claude", "codex"] as const) {
  const started = Date.now();
  const history = getProvider(providerType).localHistory;
  if (!history) continue;

  const probe = await history.probe({ limit: 10_000 });
  const all = new Map<string, { cwd: string | null; archiveState: string }>();
  for await (const session of history.discover({
    mainSessionsOnly: false,
    requireUserMessage: false,
  })) {
    all.set(session.externalSessionId, {
      cwd: session.cwd,
      archiveState: session.archiveState,
    });
  }

  const eligible = [];
  for await (const session of history.discover()) eligible.push(session);
  const projects = new Set(eligible.flatMap((session) => session.cwd ? [session.cwd] : []));
  const archiveStates = eligible.reduce<Record<string, number>>((counts, session) => {
    counts[session.archiveState] = (counts[session.archiveState] ?? 0) + 1;
    return counts;
  }, {});

  console.log(JSON.stringify({
    providerType,
    homeAvailable: probe.homeAvailable,
    plausibleFiles: probe.approximateCount ?? 0,
    eligibleSessions: eligible.length,
    excludedSessions: Math.max(0, all.size - eligible.length),
    projects: projects.size,
    archiveStates,
    durationMs: Date.now() - started,
  }));
}
