import SpecChip from "@/components/SpecChip";
import type { AudioBadgeInfo, ObjectAudio } from "@/lib/audio";

// A soundtrack as one chip — codec and layout together, "Dolby TrueHD 7.1",
// "AAC 5.1" — and its object audio (Atmos, DTS:X) as a second one beside it
// rather than a relabel (see the note on AudioBadgeInfo.objectAudio). The
// object chip carries no layout of its own: Atmos rides on the 7.1 track,
// it isn't a second 7.1 mix.
const OBJECT_LABELS: Record<ObjectAudio, string> = {
  atmos: "Dolby Atmos",
  dtsx: "DTS:X",
};

export default function AudioBadge({ badge }: { badge: AudioBadgeInfo }) {
  return (
    <>
      <SpecChip>{badge.sublabel ? `${badge.label} ${badge.sublabel}` : badge.label}</SpecChip>
      {badge.objectAudio && <SpecChip>{OBJECT_LABELS[badge.objectAudio]}</SpecChip>}
    </>
  );
}
