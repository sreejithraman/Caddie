import { createInProcessAdapter } from './in-process.mjs';

export async function serveTool(rawRequest, runtime = {}) {
  const adapter = runtime.adapter ?? createInProcessAdapter({
    managementOptions: { home: runtime.home, ...(runtime.managementOptions ?? {}) },
    legacyRuntime: { env: runtime.env, operations: runtime.operations },
  });
  const response = await adapter.executeRaw(rawRequest);
  return { response, exitCode: response.ok ? 0 : 1 };
}
