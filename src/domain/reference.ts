import { readFileSync } from "node:fs";

import { DEFAULT_DOMAIN_REFERENCE, type DomainReference } from "./constants.js";

/**
 * 从 reference/domain.json 加载公开枚举（同意状态、数据来源、到期动作）。
 * 文件缺失或字段异常时回退到内置默认值。
 */
export function loadDomainReference(
  path: string = process.env.REFERENCE_FILE ?? "reference/domain.json",
): DomainReference {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return {
      consentStates: toStringArray(raw["consent_states"], DEFAULT_DOMAIN_REFERENCE.consentStates),
      dataSources: toStringArray(raw["data_sources"], DEFAULT_DOMAIN_REFERENCE.dataSources),
      expiryActions: toStringArray(raw["expiry_actions"], DEFAULT_DOMAIN_REFERENCE.expiryActions),
    };
  } catch {
    return DEFAULT_DOMAIN_REFERENCE;
  }
}

function toStringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string")) {
    return value as string[];
  }
  return fallback;
}
