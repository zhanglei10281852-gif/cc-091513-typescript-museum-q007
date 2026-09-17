import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { CONSENT_STATES, DATA_SOURCES, EXPIRY_ACTIONS } from "../src/domain/types.js";

/** 代码枚举必须与 reference/domain.json 公开目录保持一致。 */
test("领域枚举与 reference/domain.json 同步", () => {
  const reference = JSON.parse(readFileSync(new URL("../../reference/domain.json", import.meta.url), "utf8")) as {
    consent_states: string[];
    data_sources: string[];
    expiry_actions: string[];
  };
  assert.deepEqual([...CONSENT_STATES], reference.consent_states);
  assert.deepEqual([...DATA_SOURCES], reference.data_sources);
  assert.deepEqual([...EXPIRY_ACTIONS], reference.expiry_actions);
});
