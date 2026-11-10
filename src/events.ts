import type { endGOEventListener, endGOEventName } from './types.js';

/**
 * Zero-dependency asynchronous lifecycle event bus for endGO.
 */
export class endGOEventBus {
  private readonly listeners = new Map<endGOEventName, Set<endGOEventListener>>();

  /**
   * Registers a listener for the specified lifecycle event.
   */
  public on(event: endGOEventName, listener: endGOEventListener): void {
    let bucket = this.listeners.get(event);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(event, bucket);
    }
    bucket.add(listener);
  }

  /**
   * Unregisters a previously added listener for the specified event.
   * Returns `true` if the listener was found and removed.
   */
  public off(event: endGOEventName, listener: endGOEventListener): boolean {
    const bucket = this.listeners.get(event);
    if (!bucket) return false;

    const removed = bucket.delete(listener);
    if (bucket.size === 0) {
      this.listeners.delete(event);
    }
    return removed;
  }

  /**
   * Emits an event, awaiting each registered listener sequentially in registration order.
   */
  public async emit(event: endGOEventName, payload?: unknown): Promise<void> {
    const bucket = this.listeners.get(event);
    if (!bucket || bucket.size === 0) return;

    for (const listener of [...bucket]) {
      await listener(payload);
    }
  }
}
