import { z } from "zod";

const textBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const imageBlockSchema = z.object({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
});

const audioBlockSchema = z.object({
  type: z.literal("audio"),
  data: z.string(),
  mimeType: z.string(),
});

const resourceLinkBlockSchema = z.object({
  type: z.literal("resource_link"),
  uri: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
});

const embeddedResourceBlockSchema = z.object({
  type: z.literal("resource"),
  resource: z.looseObject({
    uri: z.string(),
    text: z.string().optional(),
    blob: z.string().optional(),
    mimeType: z.string().optional(),
  }),
});

export const toolContentBlockSchema = z.discriminatedUnion("type", [
  textBlockSchema,
  imageBlockSchema,
  audioBlockSchema,
  resourceLinkBlockSchema,
  embeddedResourceBlockSchema,
]);

export type ToolContentBlock = z.infer<typeof toolContentBlockSchema>;

/**
 * Guard: the envelope is loose and its `content` entries are `unknown`, so one
 * block this platform does not model cannot make a conforming server's whole
 * answer unreadable. The blocks are parsed one at a time in `readToolCallResult`
 * and the ones that fail are counted rather than thrown.
 */
export const toolCallResultSchema = z.looseObject({
  content: z.array(z.unknown()).optional(),
  structuredContent: z.looseObject({}).optional(),
  isError: z.boolean().optional(),
});

export interface ToolCallOutcome {
  readonly blocks: readonly ToolContentBlock[];
  readonly dropped: number;
  readonly isError: boolean;
  readonly structuredContent: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Reads what a `tools/call` returned.
 *
 * Guard: `isError` is carried, never turned into a throw. It is the server's own
 * account of why the call failed, and a throw would run that text through the
 * SDK's error formatting and lose it — leaving the model with nothing to correct.
 *
 * @param value the `result` member of the JSON-RPC frame
 * @returns the parsed outcome, or `undefined` when the envelope itself is not one
 */
export function readToolCallResult(
  value: unknown,
): ToolCallOutcome | undefined {
  const envelope = toolCallResultSchema.safeParse(value);
  if (!envelope.success) {
    return undefined;
  }

  const blocks: ToolContentBlock[] = [];
  let dropped = 0;
  for (const entry of envelope.data.content ?? []) {
    const block = toolContentBlockSchema.safeParse(entry);
    if (block.success) {
      blocks.push(block.data);
    } else {
      dropped += 1;
    }
  }

  return {
    blocks,
    dropped,
    isError: envelope.data.isError ?? false,
    structuredContent: envelope.data.structuredContent,
  };
}
