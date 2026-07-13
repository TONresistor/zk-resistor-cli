import {
  confirm as inquirerConfirm,
  input as inquirerInput,
  password as inquirerPassword,
  select as inquirerSelect,
} from "@inquirer/prompts";
import pc from "picocolors";

const CANCELLED = Symbol("cancelled");

interface TextOptions {
  message: string;
  placeholder?: string;
  defaultValue?: string;
  initialValue?: string;
  validate?: (value: string) => string | void;
}

interface PasswordOptions {
  message: string;
  mask?: string;
  validate?: (value: string) => string | void;
}

interface ConfirmOptions {
  message: string;
  initialValue?: boolean;
}

type SelectValue = string | number | boolean;

interface SelectOption<Value extends SelectValue> {
  value: Value;
  label?: string;
  hint?: string;
}

interface SelectOptions<Value extends SelectValue> {
  message: string;
  options: readonly SelectOption<Value>[];
  initialValue?: Value;
  maxItems?: number;
}

export async function text(options: TextOptions): Promise<string | symbol> {
  const fallback = options.initialValue ?? options.defaultValue ?? options.placeholder;
  return runPrompt(() => inquirerInput({
    message: options.message,
    ...(fallback === undefined ? {} : { default: fallback }),
    ...(options.validate === undefined
      ? {}
      : { validate: (value: string) => options.validate?.(value) ?? true }),
  }));
}

export async function password(options: PasswordOptions): Promise<string | symbol> {
  return runPrompt(() => inquirerPassword({
    message: options.message,
    mask: options.mask ?? "*",
    ...(options.validate === undefined
      ? {}
      : { validate: (value: string) => options.validate?.(value) ?? true }),
  }));
}

export async function confirm(options: ConfirmOptions): Promise<boolean | symbol> {
  return runPrompt(() => inquirerConfirm({
    message: options.message,
    default: options.initialValue ?? false,
  }));
}

export async function select<Value extends SelectValue>(
  options: SelectOptions<Value>,
): Promise<Value | symbol> {
  return runPrompt(() => inquirerSelect({
    message: options.message,
    choices: options.options.map((option) => ({
      value: option.value,
      name: option.label ?? String(option.value),
      ...(option.hint === undefined ? {} : { description: option.hint }),
    })),
    ...(options.initialValue === undefined ? {} : { default: options.initialValue }),
    ...(options.maxItems === undefined ? {} : { pageSize: options.maxItems }),
    loop: false,
  }));
}

export function isCancel(value: unknown): value is symbol {
  return value === CANCELLED;
}

export function intro(title: string): void {
  console.log(`\n${pc.cyan(pc.bold(title))}\n`);
}

export function outro(message: string): void {
  console.log(`\n${pc.green("OK")} ${message}\n`);
}

export function note(message = "", title?: string): void {
  if (title !== undefined) console.log(`\n${pc.bold(title)}`);
  console.log(message.split("\n").map((line) => `  ${line}`).join("\n"));
  console.log();
}

export const log = {
  message: (message = "") => console.log(message),
  info: (message: string) => console.log(`${pc.cyan("i")} ${message}`),
  success: (message: string) => console.log(`${pc.green("OK")} ${message}`),
  step: (message: string) => console.log(`${pc.dim("-")} ${message}`),
  warn: (message: string) => console.warn(`${pc.yellow("!")} ${message}`),
  warning: (message: string) => console.warn(`${pc.yellow("!")} ${message}`),
  error: (message: string) => console.error(`${pc.red("x")} ${message}`),
};

async function runPrompt<T>(prompt: () => Promise<T>): Promise<T | symbol> {
  try {
    return await prompt();
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") return CANCELLED;
    throw error;
  }
}
