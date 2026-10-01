import type { StandardSchemaV1 } from "@standard-schema/spec";

export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "~standard" in value &&
    typeof (value as StandardSchemaV1)["~standard"]?.validate === "function"
  );
}

export function formatStandardSchemaIssues(
  issues: readonly StandardSchemaV1.Issue[],
): string[] {
  return issues.map((issue) => {
    if (!issue.path?.length) return issue.message;
    const path = issue.path
      .map((segment) => (typeof segment === "object" && "key" in segment ? segment.key : segment))
      .join(".");
    return `${path}: ${issue.message}`;
  });
}
