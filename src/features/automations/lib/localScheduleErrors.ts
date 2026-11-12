type RequestErrorCode = "updateTimeout" | "listTimeout" | "connectionChanged";

export class LocalScheduleRequestError extends Error {
  constructor(readonly code: RequestErrorCode) {
    super(code);
    this.name = "LocalScheduleRequestError";
  }
}
