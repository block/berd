import React from "react";
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { mockIPC } from "@tauri-apps/api/mocks";
import settings from "@/shared/i18n/locales/en/settings.json";
import "@/shared/styles/globals.css";
import { SettingsPane } from "@/shared/ui/SettingsPage";
import { MeSettings } from "../ui/MeSettings";
const documents = new Map([
  [
    "/fixture/.me/me.md",
    "# Me\n\n## Preferences\n\n- Keep explanations brief.\n",
  ],
  ["/fixture/.me/topics/travel.md", "# Travel\n\n- Prefer aisle seats.\n"],
]);
const calls: Array<{ cmd: string; args: unknown }> = [];
Object.assign(window, { memoryFixture: { calls, documents } });
mockIPC((cmd, payload) => {
  const args = payload as { path: string; contents: string };
  calls.push({ cmd, args });
  switch (cmd) {
    case "get_home_dir":
      return "/fixture";
    case "path_exists":
      return documents.has(args.path) || args.path.endsWith("/topics");
    case "read_memory_text_file":
      return { path: args.path, contents: documents.get(args.path) ?? "" };
    case "list_memory_documents":
      return [...documents].map(([path, contents]) => ({
        path,
        contents,
        fileName: path.split("/").at(-1),
      }));
    case "read_memory_policy":
      return { enabled: true };
    case "write_memory_policy":
    case "initialize_memory_store":
    case "resolve_memory_proposal":
      return;
    case "create_memory_text_file":
    case "write_memory_text_file":
    case "save_reviewed_memory_document":
      documents.set(args.path, args.contents);
      return;
    case "import_memory_markdown":
      return "# Me\n\n- Imported for review only.\n";
    case "export_memory_markdown":
      return "/fixture-export/me.md";
    default:
      throw new Error(`Unexpected fixture IPC: ${cmd}`);
  }
});
await i18n.use(initReactI18next).init({
  lng: "en",
  resources: { en: { settings } },
  interpolation: { escapeValue: false },
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <React.StrictMode>
    <div style={{ height: "100vh" }}>
      <SettingsPane>
        <MeSettings />
      </SettingsPane>
    </div>
  </React.StrictMode>,
);
