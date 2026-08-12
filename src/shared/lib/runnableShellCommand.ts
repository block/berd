export const RUNNABLE_SHELL_LANGUAGES = [
  "bash",
  "bat",
  "batch",
  "cmd",
  "fish",
  "nu",
  "nushell",
  "powershell",
  "ps1",
  "pwsh",
  "sh",
  "shell",
  "shellscript",
  "zsh",
] as const;

const SHELL_LANGUAGES = new Set<string>(RUNNABLE_SHELL_LANGUAGES);

function normalizeLanguage(language: string): string {
  return language.trim().toLowerCase();
}

export function isRunnableShellLanguage(language: string): boolean {
  return SHELL_LANGUAGES.has(normalizeLanguage(language));
}

export function normalizeRunnableShellCommand(code: string): string {
  return code.replace(/\r\n/g, "\n").trim();
}
