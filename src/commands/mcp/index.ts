import { defineCommand } from "citty";
import serve from "./serve.js";

export default defineCommand({
  meta: {
    name: "mcp",
    description: "Model Context Protocol server — exposes ZKResistor tools to AI agents.",
  },
  subCommands: { serve },
});
