import { toolDefinitions, toolNames } from "@sezzlee/db-core";
import { z } from "zod";
/** Safe metadata adapter: the product API never imports SQL drivers or secrets. */
export { toolDefinitions, toolNames };
export const databaseToolDescriptors = toolNames.map((name) => ({
  name,
  description: toolDefinitions[name].description,
  inputSchema: z.toJSONSchema(toolDefinitions[name].inputSchema, {
    target: "draft-7",
  }),
  annotations: { ...toolDefinitions[name].annotations },
}));
