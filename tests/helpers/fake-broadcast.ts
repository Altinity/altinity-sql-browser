// A deterministic in-process BroadcastChannel bus for tests (#343 §5). Ports
// created for the same channel name share one subscriber set. Delivery is
// SYNCHRONOUS and to EVERY open port on that name — including the sender.
//
// Real `BroadcastChannel` never echoes a message back to the posting port, so
// this bus is deliberately stricter than the platform: echoing to self is what
// lets a test prove the app's own `sourceTabId === sourceTabId` guard actually
// drops a tab's own broadcast (the real defense; a self-echoing polyfill or a
// duplicated port would otherwise reprocess it). Two `createApp()` instances
// wired to one bus exchange invalidation signals exactly as two browser tabs
// would.

import type { BroadcastChannelPort } from '../../src/env.types.js';

export function fakeBroadcastBus(): (name: string) => BroadcastChannelPort {
  const byName = new Map<string, Set<BroadcastChannelPort>>();
  return (name: string): BroadcastChannelPort => {
    const set = byName.get(name) ?? new Set<BroadcastChannelPort>();
    byName.set(name, set);
    const port: BroadcastChannelPort = {
      onmessage: null,
      postMessage(message: unknown) {
        for (const other of set) {
          if (other.onmessage) other.onmessage({ data: message });
        }
      },
      close() { set.delete(port); },
    };
    set.add(port);
    return port;
  };
}
