import { defineCommand } from "citty";
import recover from "./recover.js";

export default defineCommand({
  meta: {
    name: "deposits",
    description: "Recover encrypted local deposit journals.",
  },
  subCommands: { recover },
});
