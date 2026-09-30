import { isMemorySupported } from "../lib/memoryAvailability";
import { Button } from "@/shared/ui/button";
import { revealInFileManager } from "@/shared/lib/fileManager";

/** Reveal the encrypted store folder, not an editable plaintext document. */
export function StorePathLink({
  path,
  label,
}: {
  /** The real path to reveal. */
  path: string;
  /** How it reads on screen, usually ~-relative. */
  label: string;
}) {
  return (
    <Button
      type="button"
      variant="link"
      size="xs"
      onClick={() => {
        if (!isMemorySupported()) return;
        void revealInFileManager(path).catch(() => {});
      }}
    >
      {label}
    </Button>
  );
}
