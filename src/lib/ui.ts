import * as p from "./prompts.js";
import pc from "picocolors";

export const colors = pc;

export const log = p.log;

export const ui = {
  intro: p.intro,
  outro: p.outro,
  note: (body: string, title?: string) => p.note(body, title),
  log: p.log,
};
