// Public entry for the goosectl feature. Keep this navigation-only so session
// windows cannot reach the bridge/lifecycle/command registry through AppShell.
export {
  type ArchiveChatWithCleanupOptions,
  type AppNavigationPrimitives,
  useRegisterAppNavigationController,
} from "@/features/goosectl/navigation";
export {
  type AppContext,
  type AppNavigationController,
  type CommandFailureReason,
  type CommandOutcome,
  getAppNavigationController,
} from "@/features/goosectl/navigation";
