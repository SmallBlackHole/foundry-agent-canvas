import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { listenLoopbackServer } from "../src/server-utils.mjs";

test("retained loopback servers do not extend the provider lifetime", async () => {
    class FakeServer extends EventEmitter {
        constructor() {
            super();
            this.unrefCalls = 0;
        }

        listen(port, host, callback) {
            assert.equal(port, 0);
            assert.equal(host, "127.0.0.1");
            callback();
        }

        unref() {
            this.unrefCalls += 1;
        }

        address() {
            return { address: "127.0.0.1", family: "IPv4", port: 43123 };
        }
    }

    const server = new FakeServer();
    assert.equal(await listenLoopbackServer(server), 43123);
    assert.equal(server.unrefCalls, 1);
    assert.equal(server.listenerCount("error"), 0);
});
