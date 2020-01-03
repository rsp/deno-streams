import { assertEquals, test } from "https://deno.land/std@v0.28.1/testing/mod.ts";
import { WritableStream } from "./writable_stream.ts";
import "./writable_stream_controller.ts"
import "./writable_stream_writer.ts"
import { ReadableStream } from "./readable_stream.ts";

test(async function testWritableStream() {
  const src = [0, 1, 2, 3, 4, 5];
  let i = 0;
  const chunks = [];
  const readable = new ReadableStream({
    pull: controller => {
      controller.enqueue(src[i]);
      i++;
      if (i >= src.length) {
        controller.close();
      }
    }
  });
  const writable = new WritableStream({
    write: chunk => {
      chunks.push(chunk);
    }
  });
  await readable.pipeTo(writable);
  assertEquals(chunks, src);
  assertEquals(readable.state, "closed");
  assertEquals(writable.state, "closed");
});

test(async function testWritableStreamError() {
  const chunks = [];
  const readable = new ReadableStream({
    pull: controller => {
      controller.error("error");
    }
  });
  const writable = new WritableStream({
    write: chunk => {
      chunks.push(chunk);
    }
  });
  await readable.pipeTo(writable);
  assertEquals(readable.state, "errored");
  assertEquals(writable.state, "errored");
});
