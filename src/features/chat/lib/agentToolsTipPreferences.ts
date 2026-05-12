import { useCallback, useEffect, useState } from "react";

const AGENT_TOOLS_TIPS_STORAGE_KEY = "goose:agent-tools-tips-enabled";
const AGENT_TOOLS_TIPS_CHANGED_EVENT = "goose:agent-tools-tips-changed";

export function getAgentToolsTipsEnabled(): boolean {
  try {
    return localStorage.getItem(AGENT_TOOLS_TIPS_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setAgentToolsTipsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(AGENT_TOOLS_TIPS_STORAGE_KEY, String(enabled));
  } catch {
    // localStorage can be unavailable in restricted contexts.
  }
  window.dispatchEvent(
    new CustomEvent(AGENT_TOOLS_TIPS_CHANGED_EVENT, { detail: { enabled } }),
  );
}

export function useAgentToolsTipsPreference() {
  const [enabled, setEnabledState] = useState(getAgentToolsTipsEnabled);

  useEffect(() => {
    const handleChange = () => setEnabledState(getAgentToolsTipsEnabled());
    window.addEventListener(AGENT_TOOLS_TIPS_CHANGED_EVENT, handleChange);
    window.addEventListener("storage", handleChange);
    return () => {
      window.removeEventListener(AGENT_TOOLS_TIPS_CHANGED_EVENT, handleChange);
      window.removeEventListener("storage", handleChange);
    };
  }, []);

  const setEnabled = useCallback((nextEnabled: boolean) => {
    setAgentToolsTipsEnabled(nextEnabled);
  }, []);

  return { enabled, setEnabled };
}
