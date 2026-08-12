# Holographic agent card

The component uses the browser's WebGL API and React. It has no additional
runtime dependency. The foil phase advances only in response to pointer motion,
and the card honors `prefers-reduced-motion`.

```tsx
import {
  agentShareCardArtworks,
  HolographicAgentCard,
} from "@/features/agents/ui/share-card";

const artwork = agentShareCardArtworks[0];

export function Example() {
  return (
    <div className="w-80 [perspective:1200px]">
      <HolographicAgentCard src={artwork.src} alt={`${artwork.name} agent card`} />
    </div>
  );
}
```

Pass `holographicCardPresets.polishedAlloy` through the `settings` prop for the
metallic finish. The default is the restrained rainbow-prism finish.
