import {
  WritableStreamWriter,
  WritableStreamDefaultWriter,
  WritableStreamDefaultWriterEnsureReadyPromiseRejected
} from "./writable_stream_writer";
import {defer, Defer} from "./defer";
import {
  SetUpWritableStreamDefaultControllerFromUnderlyingSink,
  WritableStramDefaultController, WritableStreamController
} from "./writable_stream_controller.ts";
import {SizeAlgorithm, StartAlgorithm} from "./readable_stream";
import {IsNonNegativeNumber, MakeSizeAlgorithmFromSizeFunction, ValidateAndNormalizeHighWaterMark} from "./misc";
import {Assert} from "./util";
import {
  AbortSteps, ErrorSteps,
  SetUpWritableStreamDefaultController,
  WritableStreamDefaultController
} from "./writable_stream_controller";

export type WriterAlgorithm = (chunk, controller: WritableStreamController) => Promise<any>;
export type CloseAlgorithm = () => Promise<any>
export type AbortAlgorithm = (reason) => Promise<any>

export class WritableStream {
  constructor(underlyingSink: {
    start?: StartAlgorithm,
    write?: WriterAlgorithm,
    close?: CloseAlgorithm,
    abort?: AbortAlgorithm,
    type: string
  }, strategy: {
    highWaterMark: number
    size: SizeAlgorithm
  }) {
    InitializeWritableStream(this);
    let {size, highWaterMark} = strategy;
    const {type} = underlyingSink;
    if (type !== void 0) {
      throw new RangeError("type is undefined")
    }
    const sizeAlgorithm = MakeSizeAlgorithmFromSizeFunction(size);
    if (highWaterMark === void 0) {
      highWaterMark = 1;
    }
    highWaterMark = ValidateAndNormalizeHighWaterMark(highWaterMark);
    SetUpWritableStreamDefaultControllerFromUnderlyingSink(this, underlyingSink, highWaterMark, sizeAlgorithm);
  }

  get locked() {
    if (!IsWritableStream(this)) {
      throw new TypeError("this is not writable stream")
    }
    return IsWritableStreamLocked(this)
  }

  async abort(reason) {
    if (!IsWritableStream(this)) {
      throw new TypeError("this is not writable stream")
    }
    if (IsWritableStreamLocked(this)) {
      throw new TypeError("stream locked")
    }
    return WritableStreamAbort(this, reason)
  }

  getWriter(): WritableStreamWriter {
    if (!IsWritableStream(this)) {
      throw new TypeError("this is not writable stream")
    }
    return AcquireWritableStreamDefaultWriter(this)
  }

  backpressure
  closeRequest: Defer<any>
  inFlightWriteRequest: Defer<any>
  inFlightCloseRequest: Defer<any>
  pendingAbortRequest: {
    promise: Defer<any>,
    reason,
    wasAlreadyErroring: boolean
  }
  state: "writable" | "closed" | "erroring" | "errored"
  storedError: Error
  writableStreamController: WritableStreamDefaultController;
  writer: WritableStreamDefaultWriter;
  writeRequests: Defer<any>[]
}

export function AcquireWritableStreamDefaultWriter(stream: WritableStream): WritableStreamWriter {
  return new WritableStreamDefaultWriter(stream)
}

export function CreateWritableStream(params: {
  startAlgorithm: StartAlgorithm,
  writeAlgorithm: WriterAlgorithm,
  closeAlgorithm: CloseAlgorithm,
  abortAlgorithm: AbortAlgorithm,
  highWaterMark?: number,
  sizeAlgorithm?: SizeAlgorithm
}) {
  let {startAlgorithm, writeAlgorithm, closeAlgorithm, abortAlgorithm, highWaterMark, sizeAlgorithm} = params;
  if (highWaterMark === void 0) {
    highWaterMark = 1
  }
  if (sizeAlgorithm === void 0) {
    sizeAlgorithm = () => 1
  }
  Assert(IsNonNegativeNumber(highWaterMark))
  const stream = Object.create(WritableStream.prototype);
  InitializeWritableStream(stream)
  const controller = Object.create(WritableStreamDefaultController.prototype);
  SetUpWritableStreamDefaultController({
    stream,
    controller,
    startAlgorithm,
    writeAlgorithm,
    closeAlgorithm,
    abortAlgorithm,
    highWaterMark,
    sizeAlgorithm
  })
}

export function InitializeWritableStream(stream: WritableStream) {
  stream.state = "writable"
  stream.storedError = void 0
  stream.writer = void 0
  stream.writableStreamController = void 0
  stream.inFlightCloseRequest = void 0
  stream.closeRequest = void 0
  stream.pendingAbortRequest = void 0
  stream.writeRequests = []
  stream.backpressure = false
}

export function IsWritableStream(x): x is WritableStream {
  return typeof x === "object" && x.hasOwnProperty("writableStreamController")
}

export function IsWritableStreamLocked(stream: WritableStream) {
  Assert(IsWritableStream(stream))
  return stream.writer !== void 0;

}

export async function WritableStreamAbort(stream: WritableStream, reason): Promise<any> {
  const {state} = stream;
  if (state === "closed" || state === "errored") {
    return void 0
  }
  if (stream.pendingAbortRequest !== void 0) {
    return stream.pendingAbortRequest.promise
  }
  Assert(stream.state === "writable" || stream.state === "erroring")
  let wasAlreadyErroring = false;
  if (state === "erroring") {
    wasAlreadyErroring = true;
    reason = void 0
  }
  const promise = defer()
  stream.pendingAbortRequest = {
    promise, reason, wasAlreadyErroring
  }
  if (!wasAlreadyErroring) {
    WritableStreamStartErroring(stream, reason)
  }
  return promise
}

export function WritableStreamAddWriteRequest(stream: WritableStream) {
  Assert(IsWritableStreamLocked(stream))
  Assert(stream.state === "writable")
  const promise = defer()
  stream.writeRequests.push(promise)
  return promise
}

export function WritableStreamDealWithRejection(stream: WritableStream, error) {
  const {state} = stream
  if (state === "writable") {
    WritableStreamStartErroring(stream, error)
    return
  }
  Assert(state === "erroring")
  WritableStreamFinishErroring(stream)
}

export function WritableStreamStartErroring(stream: WritableStream, reason) {
  Assert(stream.storedError === void 0)
  Assert(stream.state === "writable")
  const controller = stream.writableStreamController
  Assert(controller !== void 0)
  stream.state = "erroring"
  stream.storedError = reason
  const {writer} = stream
  if (writer !== void 0) {
    WritableStreamDefaultWriterEnsureReadyPromiseRejected(writer, reason)
  }
  if (!WritableStreamHasOperationMarkedInFlight(stream) && controller.started) {
    WritableStreamFinishErroring(stream)
  }
}

export function WritableStreamFinishErroring(stream: WritableStream) {
  Assert(stream.state === "erroring")
  Assert(!WritableStreamHasOperationMarkedInFlight(stream))
  stream.state = "errored"
  stream.writableStreamController[ErrorSteps]()
  const {storedError} = stream
  stream.writeRequests.forEach(p => p.reject(storedError))
  stream.writeRequests = []
  if (stream.pendingAbortRequest === void 0) {
    WritableStreamRejectCloseAndClosedPromiseIfNeeded(stream)
    return
  }
  const abortRequest = stream.pendingAbortRequest;
  stream.pendingAbortRequest = void 0
  if (abortRequest.wasAlreadyErroring) {
    abortRequest.promise.reject(storedError)
    WritableStreamRejectCloseAndClosedPromiseIfNeeded(stream)
    return
  }
  const promise = stream.writableStreamController[AbortSteps](abortRequest.reason)
  promise.then(() => {
    abortRequest.promise.resolve(void 0)
    WritableStreamRejectCloseAndClosedPromiseIfNeeded(stream)
  }).catch(r => {
    abortRequest.promise.reject(r)
    WritableStreamRejectCloseAndClosedPromiseIfNeeded(stream)
  })
}

export function WritableStreamFinishInFlightWrite(stream: WritableStream) {
  Assert(stream.inFlightWriteRequest !== void 0)
  stream.inFlightWriteRequest.resolve(void 0)
  stream.inFlightWriteRequest = void 0
}

export function WritableStreamFinishInFlightWriteWithError(stream: WritableStream, error) {
  Assert(stream.inFlightWriteRequest !== void 0)
  stream.inFlightWriteRequest.resolve(void 0)
  stream.inFlightWriteRequest = void 0
  Assert(stream.state === "writable" || stream.state === "erroring")
  WritableStreamDealWithRejection(stream, error)
}

export function WritableStreamFinishInFlightClose(stream: WritableStream) {
  Assert(stream.inFlightCloseRequest !== void 0)
  stream.inFlightCloseRequest.resolve(void 0)
  stream.inFlightCloseRequest = void 0
  const {state} = stream;
  Assert(stream.state === "writable" || stream.state === "erroring")
  if (state === "erroring") {
    stream.storedError = void 0
    if (stream.pendingAbortRequest !== void 0) {
      stream.pendingAbortRequest.promise.resolve(void 0)
      stream.pendingAbortRequest = void 0
    }
  }
  stream.state = "closed"
  const {writer} = stream
  if (writer !== void 0) {
    writer.closedPromise.resolve(void 0)
  }
  Assert(stream.pendingAbortRequest === void 0)
  Assert(stream.storedError === void 0)
}

export function WritableStreamFinishInFlightCloseWithError(stream: WritableStream, error) {
  Assert(stream.inFlightCloseRequest !== void 0)
  stream.inFlightCloseRequest.resolve(void 0)
  stream.inFlightCloseRequest = void 0
  Assert(stream.state === "writable" || stream.state === "erroring")
  if (stream.pendingAbortRequest !== void 0) {
    stream.pendingAbortRequest.promise.reject(error)
    stream.pendingAbortRequest = void 0
  }
  WritableStreamDealWithRejection(stream, error)

}

export function WritableStreamCloseQueuedOrInFlight(stream: WritableStream) {
  return !(stream.closeRequest === void 0 || stream.inFlightCloseRequest === void 0);
}

export function WritableStreamHasOperationMarkedInFlight(stream: WritableStream) {
  return !(stream.inFlightWriteRequest === void 0 && stream.inFlightCloseRequest === void 0);

}

export function WritableStreamMarkCloseRequestInFlight(stream: WritableStream) {
  Assert(stream.inFlightCloseRequest === void 0)
  Assert(stream.closeRequest !== void 0)
  stream.inFlightCloseRequest = stream.closeRequest
  stream.closeRequest = void 0
}

export function WritableStreamMarkFirstWriteRequestInFlight(stream: WritableStream) {
  Assert(stream.inFlightWriteRequest === void 0)
  Assert(stream.writeRequests.length > 0)
  const writerRequest = stream.writeRequests.shift()
  stream.inFlightWriteRequest = writerRequest
}

export function WritableStreamRejectCloseAndClosedPromiseIfNeeded(stream: WritableStream) {
  Assert(stream.state === "errored")
  if (stream.pendingAbortRequest !== void 0) {
    Assert(stream.inFlightCloseRequest !== void 0)
    stream.closeRequest.reject(stream.storedError)
    stream.closeRequest = void 0
  }
  const {writer} = stream
  if (writer !== void 0) {
    writer.closedPromise.reject(stream.storedError)
  }
}

export function WritableStreamUpdateBackpressure(stream: WritableStream, backpressure: boolean) {
  Assert(stream.state === "writable")
  Assert(!WritableStreamCloseQueuedOrInFlight(stream))
  const {writer} = stream
  if (writer !== void 0 && backpressure !== stream.backpressure) {
    if (backpressure) {
      writer.readyPromise = defer()
    } else {
      Assert(!backpressure)
      writer.readyPromise.resolve(void 0)
    }
  }
  stream.backpressure = backpressure
}