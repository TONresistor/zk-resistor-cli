import { defineCommand } from "citty";
import list from "./list.js";
import info from "./info.js";

export default defineCommand({
  meta: {
    name: "pools",
    description: "Browse deployed pools.",
  },
  subCommands: { list, info },
});
