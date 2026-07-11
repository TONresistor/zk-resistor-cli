import { defineCommand } from "citty";
import newCmd from "./new.js";
import importCmd from "./import.js";
import list from "./list.js";
import show from "./show.js";
import remove from "./remove.js";
import exportMnemonic from "./export-mnemonic.js";
import sign from "./sign.js";

export default defineCommand({
  meta: {
    name: "wallet",
    description: "Manage encrypted local wallets.",
  },
  subCommands: {
    new: newCmd,
    import: importCmd,
    list,
    show,
    remove,
    "export-mnemonic": exportMnemonic,
    sign,
  },
});
