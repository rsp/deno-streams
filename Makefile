.PHONY: test
test:
	deno test --allow-env --allow-write --allow-net readable_stream_test.ts
	deno test --allow-env --allow-write --allow-net writable_stream_test.ts