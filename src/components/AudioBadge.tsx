import SpecChip from "@/components/SpecChip";
import type { AudioBadgeInfo, ObjectAudio } from "@/lib/audio";

// A soundtrack's codec as a chip, and its object audio (Atmos, DTS:X) as a
// second one beside it rather than a relabel — see the note on
// AudioBadgeInfo.objectAudio. The channel layout (badge.sublabel) is the
// caller's to set beside these.
const OBJECT_LABELS: Record<ObjectAudio, string> = {
  atmos: "Dolby Atmos",
  dtsx: "DTS:X",
};

export default function AudioBadge({ badge }: { badge: AudioBadgeInfo }) {
  return (
    <>
      <SpecChip>{badge.label}</SpecChip>
      {badge.objectAudio && <SpecChip>{OBJECT_LABELS[badge.objectAudio]}</SpecChip>}
    </>
  );
}
