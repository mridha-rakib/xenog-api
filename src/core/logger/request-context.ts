import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContextData {
  requestId: string;
}

const requestContext = new AsyncLocalStorage<RequestContextData>();

export class RequestContext {
  public static run<T>(data: RequestContextData, callback: () => T): T {
    return requestContext.run(data, callback);
  }

  public static get(): RequestContextData | undefined {
    return requestContext.getStore();
  }

  public static getRequestId(): string | undefined {
    return requestContext.getStore()?.requestId;
  }
}
