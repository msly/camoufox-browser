import { z } from "zod";
import type { Command, ParseResult, Response } from "./types.js";

const commandSchema = z
  .object({
    id: z.string(),
    action: z.string()
  })
  .passthrough();

export function parseCommand(input: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(input);
  } catch {
    return { success: false, error: "Invalid JSON" };
  }

  const id =
    typeof json === "object" && json !== null && "id" in json
      ? String((json as { id: unknown }).id)
      : undefined;

  const result = commandSchema.safeParse(json);
  if (!result.success) {
    const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");
    return { success: false, error: `Validation error: ${errors}`, id };
  }

  return { success: true, command: result.data as Command };
}

export function successResponse<T>(id: string, data: T): Response<T> {
  return { id, success: true, data };
}

export function errorResponse(id: string, error: string): Response {
  return { id, success: false, error };
}

/**
 * Serialize a response to JSON string.
 * Replaces lone Unicode surrogates with U+FFFD to avoid serde_json parse errors.
 */
function sanitizeUtf16(input: string): string {
  // Fast path: most strings contain no surrogate code units.
  if (!/[\uD800-\uDFFF]/.test(input)) return input;

  // Replace lone high/low surrogates. Valid surrogate pairs are preserved.
  // Ref: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/toWellFormed
  return input.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD"
  );
}

export function serializeResponse(response: Response): string {
  return JSON.stringify(response, (_key, value) =>
    typeof value === "string" ? sanitizeUtf16(value) : value
  );
}
