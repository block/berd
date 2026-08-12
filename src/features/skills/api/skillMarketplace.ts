import { invoke } from "@tauri-apps/api/core";
import { emitSkillsChanged } from "../lib/skillsEvents";
import { isDesktopRuntime } from "./skills";

/**
 * A skill available in the remote Block catalog, as surfaced by the
 * `sq agents skills` CLI via the Tauri backend. Distinct from `SkillInfo`
 * (installed skills) — these are discovery results the user can install.
 */
export interface RemoteSkill {
  name: string;
  description: string;
  roles: string[];
  references: string[];
  author: string | null;
  status: string | null;
  /** Whether this skill is already installed locally. */
  installed: boolean;
}

interface RemoteSkillCatalog {
  skills: RemoteSkill[];
}

export interface SkillCliStatus {
  available: boolean;
  version: string | null;
}

/**
 * Whether the `sq agents skills` CLI is available. Used to decide between the
 * marketplace UI and an "install the CLI" empty state.
 */
export async function getSkillCliStatus(): Promise<SkillCliStatus> {
  if (!isDesktopRuntime()) {
    return { available: false, version: null };
  }
  return invoke<SkillCliStatus>("skill_cli_status");
}

/** List the remote skill catalog, annotated with local install state. */
export async function listRemoteSkills(): Promise<RemoteSkill[]> {
  if (!isDesktopRuntime()) {
    return [];
  }
  const catalog = await invoke<RemoteSkillCatalog>("list_remote_skills");
  return catalog.skills;
}

/** Fetch the full SKILL.md for a remote skill (detail preview). */
export async function showRemoteSkill(name: string): Promise<string> {
  return invoke<string>("show_remote_skill", { name });
}

export interface InstallRemoteSkillOptions {
  /**
   * When set, install into this project directory (`--project`) rather than
   * globally. Pass the active project's working directory.
   */
  projectDir?: string | null;
}

/**
 * Install a remote skill globally, or into a project when `projectDir` is set.
 * Emits a skills-changed event so installed-skill views refresh.
 */
export async function installRemoteSkill(
  name: string,
  options: InstallRemoteSkillOptions = {},
): Promise<string> {
  const output = await invoke<string>("install_remote_skill", {
    request: {
      name,
      projectDir: options.projectDir ?? null,
    },
  });
  emitSkillsChanged();
  return output;
}
