import assert from "node:assert";

import { truncate } from "./string-utils.mjs";

assert.strictEqual(truncate("cat", 5), "cat");
assert.strictEqual(truncate("hello", 5), "hello");
assert.strictEqual(truncate("hello world", 5), "hello...");
