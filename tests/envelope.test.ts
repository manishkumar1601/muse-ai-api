import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildApplicationRequest,
  buildServiceFrame,
  buildServiceRequest,
  parseServiceFrame,
} from "../src/hatch/envelope.js";
import { SERVICE_DAEMON } from "../src/proto/types.js";

test("round-trip POST /chat/stream with JSON body", () => {
  const body = new TextEncoder().encode('{"message":"hi"}');
  const ar = buildApplicationRequest("POST", "/chat/stream", body, [["content-type", "application/json"]]);
  const sf = buildServiceFrame(1n, ar);
  const sr = buildServiceRequest(SERVICE_DAEMON, sf);
  assert.ok(sr.length > 0);
  const hex = Buffer.from(sr).toString("latin1");
  assert.ok(hex.includes("/chat/stream"), "ServiceRequest should contain path");
  assert.ok(hex.includes("application/json"), "ServiceRequest should contain content-type");
});

test("parsers decode round-tripped envelope back to field values", () => {
  const body = new TextEncoder().encode('{"ping":1}');
  const ar = buildApplicationRequest("POST", "/x", body, [["accept", "*/*"]]);
  const sf = buildServiceFrame(42n, ar);

  const decodedSF = parseServiceFrame(sf);
  assert.equal(Number(decodedSF.stream_id), 42);
  assert.ok(decodedSF.request);
  assert.equal(decodedSF.request!.verb, "POST");
  assert.equal(decodedSF.request!.path, "/x");
  assert.equal(decodedSF.request!.end_body, true);
});
