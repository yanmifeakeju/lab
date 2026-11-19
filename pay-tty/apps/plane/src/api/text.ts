import { Common } from "@pay-tty/core/common"
import { Schema, SchemaTransformation } from "effect"

// Request text is trimmed before its checks, so surrounding whitespace never
// counts toward a length or makes blank text look filled in.

/** Text up to `max` characters once trimmed; blank is allowed. */
export const trimmedText = (max: number) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.Trimmed.check(
        Schema.isMaxLength(max).annotate({ expected: `a value with a length of at most ${max}` }),
      ),
      SchemaTransformation.trim(),
    ),
  )

/** One line of 1 to `max` characters once trimmed. */
export const lineOfText = (max: number) =>
  Schema.String.check(
    Schema.isPattern(new RegExp(".*\\S.*")).annotate({ expected: "a string containing non-whitespace" }),
  ).pipe(
    Schema.decodeTo(
      Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(max), Common.isOneLine),
      SchemaTransformation.trim(),
    ),
  )
