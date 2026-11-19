import {
  PluginFailureStage,
  PluginRuntimeStateKind,
  type SerializablePluginRuntimeState,
} from "@shared/contracts/plugin-manager-api";
import { toError } from "@shared/util";

import {
  LifecycleFailureStage,
  LifecycleStateKind,
  type LifecycleRuntimeState,
} from "./lifecycle";

const KIND: Record<LifecycleStateKind, PluginRuntimeStateKind> = {
  [LifecycleStateKind.Stopped]: PluginRuntimeStateKind.Stopped,
  [LifecycleStateKind.Starting]: PluginRuntimeStateKind.Starting,
  [LifecycleStateKind.Running]: PluginRuntimeStateKind.Running,
  [LifecycleStateKind.Stopping]: PluginRuntimeStateKind.Stopping,
  [LifecycleStateKind.Failed]: PluginRuntimeStateKind.Failed,
  [LifecycleStateKind.Hung]: PluginRuntimeStateKind.Hung,
  [LifecycleStateKind.Abandoned]: PluginRuntimeStateKind.Abandoned,
  [LifecycleStateKind.Disposed]: PluginRuntimeStateKind.Disposed,
};

const STAGE: Record<LifecycleFailureStage, PluginFailureStage> = {
  [LifecycleFailureStage.Load]: PluginFailureStage.Load,
  [LifecycleFailureStage.Activate]: PluginFailureStage.Activate,
  [LifecycleFailureStage.Deactivate]: PluginFailureStage.Deactivate,
};

/** Convert an in-process runtime state into its IPC-safe form. */
export function serializeRuntimeState<Module>(
  state: LifecycleRuntimeState<Module>
): SerializablePluginRuntimeState {
  const base = { kind: KIND[state.kind], desiredRevision: state.desiredRevision };

  switch (state.kind) {
    case LifecycleStateKind.Starting:
      return {
        ...base,
        attempt: state.attempt,
        startedAt: state.startedAt,
        timedOut: state.timedOut,
      };
    case LifecycleStateKind.Running:
    case LifecycleStateKind.Stopping:
      return { ...base, attempt: state.attempt };
    case LifecycleStateKind.Failed:
      return {
        ...base,
        attempt: state.attempt,
        stage: STAGE[state.stage],
        error: toError(state.error).message,
        retryable: state.retryable,
      };
    case LifecycleStateKind.Hung:
      return {
        ...base,
        attempt: state.attempt,
        stage: STAGE[state.stage],
        since: state.since,
      };
    case LifecycleStateKind.Abandoned:
      return { ...base, attempt: state.attempt, stage: STAGE[state.stage] };
    default:
      return base;
  }
}
