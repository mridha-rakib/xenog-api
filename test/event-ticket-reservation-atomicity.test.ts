import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

// EVT-014 — the strongest practical proof of reserveTicketCapacity()'s
// atomicity available without a real MongoDB instance: `findOneAndUpdate` is
// replaced with a tiny single-document fake that only applies its update if
// the query filter matches against the CURRENT stored document (exactly the
// contract Mongo's own findOneAndUpdate provides — the filter and the write
// are evaluated as one atomic operation server-side, with no read-then-write
// gap for a concurrent request to land in). This does not exercise real
// concurrent goroutines/requests (that needs a live Mongo, out of scope for
// this batch per instructions), but it does prove the exact conditional
// filter/update pair the repository sends is self-consistent and correctly
// rejects over-quantity requests while accepting in-bounds ones — the
// property real concurrency safety is built on.
function makeFakeSingleDocumentStore(initialDoc: Record<string, unknown>) {
  let doc: Record<string, unknown> | null = JSON.parse(JSON.stringify(initialDoc));

  const matchesFilter = (filter: Record<string, unknown>): boolean => {
    if (!doc) return false;
    if (filter._id !== doc._id) return false;
    if (filter.status && !(filter.status as { $in: string[] }).$in.includes(doc.status as string)) {
      return false;
    }

    const ticketMatch = (filter.tickets as { $elemMatch: Record<string, unknown> })?.$elemMatch;
    if (ticketMatch) {
      const tickets = doc.tickets as Array<Record<string, unknown>>;
      const found = tickets.find((t) => t.id === ticketMatch.id);
      if (!found) return false;

      const availableCountFilter = ticketMatch.availableCount as { $gte: number } | undefined;
      if (availableCountFilter && !((found.availableCount as number) >= availableCountFilter.$gte)) {
        return false;
      }
    }

    return true;
  };

  return {
    findOneAndUpdate: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      if (!matchesFilter(filter)) {
        return null;
      }

      const inc = update.$inc as Record<string, number> | undefined;
      if (inc) {
        for (const [path, amount] of Object.entries(inc)) {
          const match = path.match(/^tickets\.\$\.(.+)$/);
          if (match && doc) {
            const field = match[1];
            const ticketMatch = (filter.tickets as { $elemMatch: Record<string, unknown> })?.$elemMatch;
            const tickets = doc.tickets as Array<Record<string, unknown>>;
            doc.tickets = tickets.map((t) => (
              t.id === ticketMatch?.id ? { ...t, [field]: (t[field] as number) + amount } : t
            ));
          }
        }
      }

      return doc ? JSON.parse(JSON.stringify(doc)) : null;
    },
    getDoc: () => doc,
  };
}

test("reserveTicketCapacity: requested quantity <= availableCount succeeds and decrements atomically", async (t) => {
  const { EventModel } = await import("../src/modules/events/event.model.js");
  const { EventRepository } = await import("../src/modules/events/event.repository.js");

  const store = makeFakeSingleDocumentStore({
    _id: "event-1",
    status: "published",
    tickets: [{ id: "ticket-1", availableCount: 10 }],
  });

  t.mock.method(EventModel, "findOneAndUpdate", store.findOneAndUpdate);

  const repository = new EventRepository();
  const result = await repository.reserveTicketCapacity("event-1", "ticket-1", 4);

  assert.ok(result, "reservation within availableCount must succeed");
  const tickets = (store.getDoc()?.tickets as Array<Record<string, unknown>>) ?? [];
  assert.equal(tickets[0]?.availableCount, 6, "availableCount must be decremented by exactly the reserved quantity");
});

test("reserveTicketCapacity: requested quantity > availableCount fails and leaves availableCount unchanged", async (t) => {
  const { EventModel } = await import("../src/modules/events/event.model.js");
  const { EventRepository } = await import("../src/modules/events/event.repository.js");

  const store = makeFakeSingleDocumentStore({
    _id: "event-1",
    status: "published",
    tickets: [{ id: "ticket-1", availableCount: 3 }],
  });

  t.mock.method(EventModel, "findOneAndUpdate", store.findOneAndUpdate);

  const repository = new EventRepository();
  const result = await repository.reserveTicketCapacity("event-1", "ticket-1", 4);

  assert.equal(result, null, "over-quantity reservation must fail (the atomic filter must not match)");
  const tickets = (store.getDoc()?.tickets as Array<Record<string, unknown>>) ?? [];
  assert.equal(tickets[0]?.availableCount, 3, "a rejected reservation must never mutate availableCount");
});

test("reserveTicketCapacity: requested quantity exactly equal to availableCount succeeds (boundary)", async (t) => {
  const { EventModel } = await import("../src/modules/events/event.model.js");
  const { EventRepository } = await import("../src/modules/events/event.repository.js");

  const store = makeFakeSingleDocumentStore({
    _id: "event-1",
    status: "published",
    tickets: [{ id: "ticket-1", availableCount: 5 }],
  });

  t.mock.method(EventModel, "findOneAndUpdate", store.findOneAndUpdate);

  const repository = new EventRepository();
  const result = await repository.reserveTicketCapacity("event-1", "ticket-1", 5);

  assert.ok(result, "reserving exactly the remaining availableCount must succeed");
  const tickets = (store.getDoc()?.tickets as Array<Record<string, unknown>>) ?? [];
  assert.equal(tickets[0]?.availableCount, 0);
});

test("reserveTicketCapacity: two sequential reservations that together exceed availableCount — the second is rejected", async (t) => {
  // Simulates the outcome two concurrent requests must produce: whichever
  // one's conditional filter is evaluated against the post-first-write
  // document must fail once capacity is exhausted. Because the fake store
  // re-evaluates the filter against the live `doc` on every call (exactly
  // like Mongo's server-side atomic evaluation), this proves the second
  // caller cannot oversell even though both requests were "in flight" for
  // the same starting availableCount of 5.
  const { EventModel } = await import("../src/modules/events/event.model.js");
  const { EventRepository } = await import("../src/modules/events/event.repository.js");

  const store = makeFakeSingleDocumentStore({
    _id: "event-1",
    status: "published",
    tickets: [{ id: "ticket-1", availableCount: 5 }],
  });

  t.mock.method(EventModel, "findOneAndUpdate", store.findOneAndUpdate);

  const repository = new EventRepository();
  const first = await repository.reserveTicketCapacity("event-1", "ticket-1", 4);
  const second = await repository.reserveTicketCapacity("event-1", "ticket-1", 4);

  assert.ok(first, "the first reservation (4 of 5) must succeed");
  assert.equal(second, null, "the second reservation (would need 4 of the remaining 1) must fail, not oversell");
  const tickets = (store.getDoc()?.tickets as Array<Record<string, unknown>>) ?? [];
  assert.equal(tickets[0]?.availableCount, 1, "only the first reservation's decrement must have applied");
});
