class PresenceService {
  private readonly connectionCounts = new Map<string, number>();

  /** Returns true if this is the user's first connection (was offline before). */
  markConnected(userId: string): boolean {
    const count = this.connectionCounts.get(userId) ?? 0;
    this.connectionCounts.set(userId, count + 1);
    return count === 0;
  }

  /** Returns true if this was the user's last connection (now offline). */
  markDisconnected(userId: string): boolean {
    const count = this.connectionCounts.get(userId) ?? 0;
    const next = Math.max(0, count - 1);
    if (next === 0) {
      this.connectionCounts.delete(userId);
      return true;
    }
    this.connectionCounts.set(userId, next);
    return false;
  }

  isOnline(userId: string): boolean {
    return (this.connectionCounts.get(userId) ?? 0) > 0;
  }
}

export const presenceService = new PresenceService();
