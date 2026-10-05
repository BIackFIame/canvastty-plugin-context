// Service entry (bundled to services/context.mjs): wires the Context service to CanvasTTY's JSON-RPC protocol.
import { serve, type Host } from '../rpc.ts';
import { ContextService, type Caller, type LaunchContext } from './context.ts';

let resolveReady: (service: ContextService) => void;
const ready = new Promise<ContextService>(resolve => { resolveReady = resolve; });

serve({
  onInitialize: async (params, host: Host) => {
    const dataDir = typeof params.dataDir === 'string' ? params.dataDir : process.cwd();
    const service = new ContextService({ host, dataDir, ...(typeof params.pluginId === 'string' ? { pluginId: params.pluginId } : {}) });
    await service.loadMemoryPolicy();
    resolveReady(service);
  },
  methods: {
    // Host-only requests.
    'canvastty.launch.options': async () => (await ready).launchOptions(),
    'canvastty.launch.prepare': async params => (await ready).prepare(params as unknown as LaunchContext),
    'canvastty.tools.call': async params => (await ready).tool(String(params.tool), (params.input ?? {}) as Record<string, unknown>, params.caller as Caller | undefined),
    // The settings page.
    state: async () => (await ready).state(),
    imported: async params => (await ready).imported(params.projectId),
    discover: async params => (await ready).discover(params.projectId),
    preview: async params => (await ready).preview(params),
    saveProject: async params => (await ready).saveProject(params),
    saveImports: async params => (await ready).saveImports(params),
    saveTask: async params => (await ready).saveTask(params),
    saveRule: async params => (await ready).saveRule(params),
    remove: async params => (await ready).remove(params),
    memoryState: async params => (await ready).memoryState(params.projectId),
    saveMemory: async params => (await ready).saveMemory(params),
    approveMemory: async params => (await ready).approveMemory(params),
    removeMemory: async params => (await ready).removeMemory(params),
    setMemoryPolicy: async params => (await ready).setMemoryPolicy(params)
  }
});
