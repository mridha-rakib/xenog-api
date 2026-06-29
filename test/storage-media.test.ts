import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import test from "node:test";
import express from "express";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

interface MockStorageObject {
  body: Readable;
  contentLength?: number;
  contentRange?: string;
  contentType?: string;
}

interface MockStorageService {
  getObject: (key: string, range?: string, abortSignal?: AbortSignal) => Promise<MockStorageObject>;
}

const createStorageServer = async (storageService: MockStorageService) => {
  const [{ StorageController }, { errorHandler }] = await Promise.all([
    import("../src/modules/storage/storage.controller.js"),
    import("../src/core/errors/error-handler.js"),
  ]);
  const app = express();
  const controller = new StorageController(storageService as never);

  app.get("/storage/file/:filename", (req, res, next) => {
    void controller.streamFile(req, res).catch(next);
  });
  app.use(errorHandler);

  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
};

test("storage file endpoint streams an image response", async () => {
  const image = Buffer.from("image-bytes");
  const server = await createStorageServer({
    async getObject(key) {
      assert.equal(key, "images/avatar.png");
      return {
        body: Readable.from(image),
        contentLength: image.length,
        contentType: "image/png",
      };
    },
  });

  try {
    const response = await fetch(`${server.baseUrl}/storage/file/avatar.png?key=images%2Favatar.png`);
    const body = Buffer.from(await response.arrayBuffer());

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("content-length"), String(image.length));
    assert.deepEqual(body, image);
  } finally {
    await server.close();
  }
});

test("storage file endpoint returns 206 for a valid video range request", async () => {
  const chunk = Buffer.from("0123");
  const server = await createStorageServer({
    async getObject(key, range) {
      assert.equal(key, "videos/story.mp4");
      assert.equal(range, "bytes=0-3");
      return {
        body: Readable.from(chunk),
        contentLength: chunk.length,
        contentRange: "bytes 0-3/10",
        contentType: "video/mp4",
      };
    },
  });

  try {
    const response = await fetch(`${server.baseUrl}/storage/file/story.mp4?key=videos%2Fstory.mp4`, {
      headers: {
        Range: "bytes=0-3",
      },
    });
    const body = Buffer.from(await response.arrayBuffer());

    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 0-3/10");
    assert.equal(response.headers.get("content-length"), String(chunk.length));
    assert.deepEqual(body, chunk);
  } finally {
    await server.close();
  }
});

test("storage file endpoint does not abort a slow successful GET when the request body closes", async () => {
  class SlowSuccessfulStream extends Readable {
    private remainingChunks = 4;
    private timer?: NodeJS.Timeout;

    public override _read(): void {
      if (this.timer) {
        return;
      }

      this.timer = setTimeout(() => {
        this.timer = undefined;

        if (this.remainingChunks <= 0) {
          this.push(null);
          return;
        }

        this.remainingChunks -= 1;
        this.push(Buffer.from("chunk"));

        if (this.remainingChunks <= 0) {
          this.push(null);
        }
      }, 10);
    }

    public override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
      if (this.timer) {
        clearTimeout(this.timer);
      }

      callback(error);
    }
  }

  const server = await createStorageServer({
    async getObject() {
      return {
        body: new SlowSuccessfulStream(),
        contentLength: 20,
        contentType: "image/png",
      };
    },
  });

  try {
    const response = await fetch(`${server.baseUrl}/storage/file/slow.png?key=images%2Fslow.png`);
    const body = Buffer.from(await response.arrayBuffer());

    assert.equal(response.status, 200);
    assert.equal(body.length, 20);
  } finally {
    await server.close();
  }
});

test("storage file endpoint returns 416 for an invalid range request without opening S3", async () => {
  let getObjectCalls = 0;
  const server = await createStorageServer({
    async getObject() {
      getObjectCalls += 1;
      return {
        body: Readable.from(Buffer.from("unused")),
      };
    },
  });

  try {
    const response = await fetch(`${server.baseUrl}/storage/file/story.mp4?key=videos%2Fstory.mp4`, {
      headers: {
        Range: "bytes=0-3,4-7",
      },
    });

    assert.equal(response.status, 416);
    assert.equal(getObjectCalls, 0);
  } finally {
    await server.close();
  }
});

test("storage file endpoint maps a missing S3 object to 404", async () => {
  const server = await createStorageServer({
    async getObject() {
      const error = new Error("NoSuchKey") as Error & {
        $metadata: { httpStatusCode: number };
      };
      error.name = "NoSuchKey";
      error.$metadata = { httpStatusCode: 404 };
      throw error;
    },
  });

  try {
    const response = await fetch(`${server.baseUrl}/storage/file/missing.png?key=images%2Fmissing.png`);
    const body = (await response.json()) as { message: string; statusCode: number; success: boolean };

    assert.equal(response.status, 404);
    assert.equal(body.success, false);
    assert.equal(body.statusCode, 404);
  } finally {
    await server.close();
  }
});

test("storage file endpoint maps S3 service failures to 503", async () => {
  const server = await createStorageServer({
    async getObject() {
      const error = new Error("SlowDown") as Error & {
        $metadata: { httpStatusCode: number };
      };
      error.name = "SlowDown";
      error.$metadata = { httpStatusCode: 503 };
      throw error;
    },
  });

  try {
    const response = await fetch(`${server.baseUrl}/storage/file/story.mp4?key=videos%2Fstory.mp4`);
    const body = (await response.json()) as { message: string; statusCode: number; success: boolean };

    assert.equal(response.status, 503);
    assert.equal(body.success, false);
    assert.equal(body.statusCode, 503);
  } finally {
    await server.close();
  }
});

test("storage file endpoint handles repeated video range requests without 504", async () => {
  const chunk = Buffer.from("seek");
  const server = await createStorageServer({
    async getObject(_key, range) {
      assert.equal(range, "bytes=0-3");
      return {
        body: Readable.from(chunk),
        contentLength: chunk.length,
        contentRange: "bytes 0-3/100",
        contentType: "video/mp4",
      };
    },
  });

  try {
    const responses = await Promise.all(
      Array.from({ length: 30 }, () =>
        fetch(`${server.baseUrl}/storage/file/story.mp4?key=videos%2Fstory.mp4`, {
          headers: {
            Range: "bytes=0-3",
          },
        }),
      ),
    );

    for (const response of responses) {
      assert.equal(response.status, 206);
      assert.notEqual(response.status, 504);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), chunk);
    }
  } finally {
    await server.close();
  }
});

test("storage file endpoint aborts and destroys the S3 stream when the client cancels", async () => {
  let capturedAbortSignal: AbortSignal | undefined;
  let streamDestroyed = false;

  class SlowStream extends Readable {
    private timer?: NodeJS.Timeout;

    public override _read(): void {
      if (this.timer) {
        return;
      }

      this.push(Buffer.from("start"));
      this.timer = setInterval(() => {
        this.push(Buffer.from("more"));
      }, 25);
    }

    public override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
      streamDestroyed = true;

      if (this.timer) {
        clearInterval(this.timer);
      }

      callback(error);
    }
  }

  const server = await createStorageServer({
    async getObject(_key, _range, abortSignal) {
      capturedAbortSignal = abortSignal;
      return {
        body: new SlowStream(),
        contentType: "video/mp4",
      };
    },
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const request = http.get(`${server.baseUrl}/storage/file/story.mp4?key=videos%2Fstory.mp4`, (response) => {
        response.once("data", () => {
          request.destroy();
          setTimeout(resolve, 100);
        });
      });

      request.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "ECONNRESET") {
          reject(error);
        }
      });
      request.setTimeout(1_000, () => {
        request.destroy(new Error("request timed out"));
        reject(new Error("request timed out"));
      });
    });

    assert.equal(capturedAbortSignal?.aborted, true);
    assert.equal(streamDestroyed, true);
  } finally {
    await server.close();
  }
});
