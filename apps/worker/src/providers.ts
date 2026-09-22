/**
 * Compatibility export for worker-local imports. Provider composition lives in
 * the server-only package so API metadata validation and worker execution use
 * the same registered provider build catalogue.
 */
export {
  WorkerProviderRuntime,
  createBuiltinProviderRegistry,
  type ProviderRuntimeOptions,
} from "@openmuse/provider-server";
