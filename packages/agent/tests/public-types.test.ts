import { describe, expect, it } from "vitest";
import type {
  BackgroundTaskPhase,
  BackgroundTaskStatus,
  BackgroundTaskType,
  CapabilityStatus,
  HistoryAttachment,
  HistoryCatchUpOptions,
  HistoryCatchUpYield,
  HistoryCheckpoint,
  HistorySource,
  ListModelsOptions,
  ProviderAuthFlow,
  ProviderAuthMethod,
  ProviderRuntimeContext,
  ProviderRuntimeReport,
  SavedHistoryDiscoverOptions,
  SavedHistoryEvent,
  SavedHistoryOps,
  SavedHistoryProbeOptions,
  SavedHistoryProbeResult,
  SavedHistoryReadOptions,
  SavedHistorySession,
  SavedHistoryYield,
  UpstreamProvider,
  UpstreamProviderManager,
} from "../src/index.js";

type PublicTypes =
  | BackgroundTaskPhase
  | BackgroundTaskStatus
  | BackgroundTaskType
  | CapabilityStatus
  | HistoryAttachment
  | HistoryCatchUpOptions
  | HistoryCatchUpYield
  | HistoryCheckpoint
  | HistorySource
  | ListModelsOptions
  | ProviderAuthFlow
  | ProviderAuthMethod
  | ProviderRuntimeContext
  | ProviderRuntimeReport
  | SavedHistoryDiscoverOptions
  | SavedHistoryEvent
  | SavedHistoryOps
  | SavedHistoryProbeOptions
  | SavedHistoryProbeResult
  | SavedHistoryReadOptions
  | SavedHistorySession
  | SavedHistoryYield
  | UpstreamProvider
  | UpstreamProviderManager;

describe("root public type exports", () => {
  it("keeps the compile-time public contract reachable", () => {
    expect(null as PublicTypes | null).toBeNull();
  });
});
