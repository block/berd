import { getClient } from "@/shared/api/acpConnection";
import type { GooseExtension, GooseExtensionEntry } from "@aaif/goose-sdk";
import type { ExtensionConfig, ExtensionEntry } from "../types";

function envArrayToRecord(
  env?: Array<{ name: string; value: string }>,
): Record<string, string> | undefined {
  if (!env?.length) return undefined;
  return Object.fromEntries(env.map(({ name, value }) => [name, value]));
}

function headersArrayToRecord(
  headers?: Array<{ name: string; value: string }>,
): Record<string, string> | undefined {
  if (!headers?.length) return undefined;
  return Object.fromEntries(headers.map(({ name, value }) => [name, value]));
}

function recordToArray(
  record?: Record<string, string>,
): Array<{ name: string; value: string }> {
  return Object.entries(record ?? {}).map(([name, value]) => ({ name, value }));
}

function toExtensionEntry(entry: GooseExtensionEntry): ExtensionEntry {
  const { extension } = entry;
  const extensionName =
    extension.type === "mcp" ? extension.server.name : extension.name;
  const configKey = entry.configKey ?? extensionName;
  const description = extension.description ?? "";

  if (extension.type === "mcp") {
    if ("command" in extension.server) {
      const envs = envArrayToRecord(extension.server.env);

      return {
        type: "stdio",
        name: extension.server.name,
        description,
        cmd: extension.server.command,
        args: extension.server.args,
        ...(envs ? { envs } : {}),
        ...(extension.envKeys?.length ? { env_keys: extension.envKeys } : {}),
        ...(extension.timeout != null ? { timeout: extension.timeout } : {}),
        ...(extension.bundled != null ? { bundled: extension.bundled } : {}),
        config_key: configKey,
        enabled: entry.enabled,
      };
    }

    if (extension.server.type === "sse") {
      return {
        type: "sse",
        name: extension.server.name,
        description,
        uri: extension.server.url,
        ...(extension.bundled != null ? { bundled: extension.bundled } : {}),
        config_key: configKey,
        enabled: entry.enabled,
      };
    }

    const headers = headersArrayToRecord(extension.server.headers);

    return {
      type: "streamable_http",
      name: extension.server.name,
      description,
      uri: extension.server.url,
      ...(headers ? { headers } : {}),
      ...(extension.envKeys?.length ? { env_keys: extension.envKeys } : {}),
      ...(extension.socket != null ? { socket: extension.socket } : {}),
      ...(extension.timeout != null ? { timeout: extension.timeout } : {}),
      ...(extension.bundled != null ? { bundled: extension.bundled } : {}),
      config_key: configKey,
      enabled: entry.enabled,
    };
  }

  return {
    type: extension.type,
    name: extension.name,
    description,
    ...(extension.display_name != null
      ? { display_name: extension.display_name }
      : {}),
    ...("timeout" in extension && extension.timeout != null
      ? { timeout: extension.timeout }
      : {}),
    ...(extension.bundled != null ? { bundled: extension.bundled } : {}),
    config_key: configKey,
    enabled: entry.enabled,
  };
}

function toGooseExtension(extensionConfig: ExtensionConfig): GooseExtension {
  if (extensionConfig.type === "stdio") {
    return {
      type: "mcp",
      description: extensionConfig.description,
      envKeys: extensionConfig.env_keys,
      server: {
        name: extensionConfig.name,
        command: extensionConfig.cmd,
        args: extensionConfig.args,
        env: recordToArray(extensionConfig.envs),
      },
      timeout: extensionConfig.timeout,
      bundled: extensionConfig.bundled,
    };
  }

  if (extensionConfig.type === "streamable_http") {
    return {
      type: "mcp",
      description: extensionConfig.description,
      envKeys: extensionConfig.env_keys,
      server: {
        type: "http",
        name: extensionConfig.name,
        url: extensionConfig.uri,
        headers: recordToArray(extensionConfig.headers),
      },
      socket: extensionConfig.socket,
      timeout: extensionConfig.timeout,
      bundled: extensionConfig.bundled,
    };
  }

  return extensionConfig as GooseExtension;
}

export async function listExtensions(): Promise<ExtensionEntry[]> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableConfigExtensionsList({});
  return response.extensions.map(toExtensionEntry);
}

export async function addExtension(
  name: string,
  extensionConfig: ExtensionConfig,
  enabled = false,
): Promise<void> {
  const client = await getClient();
  await client.goose.GooseUnstableConfigExtensionsAdd({
    extension: toGooseExtension({ ...extensionConfig, name }),
    enabled,
  });
}

export async function removeExtension(configKey: string): Promise<void> {
  const client = await getClient();
  await client.goose.GooseUnstableConfigExtensionsRemove({ configKey });
}

export async function toggleExtension(
  configKey: string,
  enabled: boolean,
): Promise<void> {
  const client = await getClient();
  await client.goose.GooseUnstableConfigExtensionsSetEnabled({
    configKey,
    enabled,
  });
}
