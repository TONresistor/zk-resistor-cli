import { defineCommand } from "citty";
import create from "./create.js";
import createTon from "./create-ton.js";
import activate from "./activate.js";

export default defineCommand({
  meta: {
    name: "pool",
    description: "Create and activate pools.",
  },
  subCommands: {
    create,
    "create-ton": createTon,
    activate,
  },
});
