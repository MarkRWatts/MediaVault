// Re-export so call sites can import the hook without the provider module
// name — `import { usePlayer } from "@/components/player/usePlayer"`.
export { usePlayer, type PlayerContextValue } from "./PlayerProvider";
