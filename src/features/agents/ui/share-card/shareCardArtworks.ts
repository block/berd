import baseCard1Url from "@/features/agents/assets/share-card/card-base-1.png";
import baseCard2Url from "@/features/agents/assets/share-card/card-base-2.png";
import baseCard3Url from "@/features/agents/assets/share-card/card-base-3.png";
import baseCard4Url from "@/features/agents/assets/share-card/card-base-4.png";
import blorpieCardUrl from "@/features/agents/assets/share-card/card-blorpie.png";
import blockyCardUrl from "@/features/agents/assets/share-card/card-blocky.png";
import jellorbinaCardUrl from "@/features/agents/assets/share-card/card-jellorbina.png";
import palmettoCardUrl from "@/features/agents/assets/share-card/card-palmetto.png";

export const agentShareCardBases = [
  baseCard1Url,
  baseCard2Url,
  baseCard3Url,
  baseCard4Url,
] as const;

export const agentShareCardArtworks = [
  { id: "blocky", name: "Blocky", src: blockyCardUrl },
  { id: "jellorbina", name: "Jellorbina", src: jellorbinaCardUrl },
  { id: "palmetto", name: "Palmetto", src: palmettoCardUrl },
  { id: "blorpie", name: "Blorpie", src: blorpieCardUrl },
] as const;

export type AgentShareCardId = (typeof agentShareCardArtworks)[number]["id"];
