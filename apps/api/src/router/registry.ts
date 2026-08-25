import type { Capability, EnginePlugin, SizeOptimizer } from './types.js';

class Registry {
  private readonly capabilities = new Map<string, Capability>();
  private readonly optimizers = new Map<string, SizeOptimizer>();
  private readonly plugins = new Map<string, EnginePlugin>();

  async register(plugin: EnginePlugin): Promise<void> {
    if (this.plugins.has(plugin.domain)) throw new Error(`Engine already registered: ${plugin.domain}`);
    await plugin.init?.();
    this.plugins.set(plugin.domain, plugin);
    for (const cap of plugin.capabilities) {
      if (!cap.name.startsWith(`${plugin.domain}.`)) {
        throw new Error(`Capability ${cap.name} does not belong to domain ${plugin.domain}`);
      }
      if (this.capabilities.has(cap.name)) throw new Error(`Duplicate capability: ${cap.name}`);
      this.capabilities.set(cap.name, cap);
    }
    if (plugin.optimizer) this.optimizers.set(plugin.domain, plugin.optimizer);
  }

  get(name: string): Capability | undefined {
    return this.capabilities.get(name);
  }

  optimizerFor(domain: string): SizeOptimizer | undefined {
    return this.optimizers.get(domain);
  }

  list(): Capability[] {
    return [...this.capabilities.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  domains(): EnginePlugin[] {
    return [...this.plugins.values()];
  }

  async describe() {
    const caps = await Promise.all(
      this.list().map(async (c) => ({
        name: c.name,
        domain: c.domain,
        title: c.title,
        description: c.description,
        accepts: c.accepts,
        produces: c.produces,
        available: await c.available(),
      })),
    );
    return {
      domains: this.domains().map((p) => ({ domain: p.domain, title: p.title })),
      capabilities: caps,
    };
  }

  /** Test helper. */
  reset(): void {
    this.capabilities.clear();
    this.optimizers.clear();
    this.plugins.clear();
  }
}

export const registry = new Registry();
