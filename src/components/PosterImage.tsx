"use client";

import { useState } from "react";
import Image from "next/image";
import NoPoster from "@/components/NoPoster";

export default function PosterImage({
  posterPath,
  title,
  year,
  size = "w342",
  sizes,
  priority = false,
  className = "",
}: {
  posterPath: string | null;
  title: string;
  year?: number | null;
  size?: "w342" | "w780";
  sizes?: string;
  priority?: boolean;
  className?: string;
}) {
  const [errored, setErrored] = useState(false);
  const showFallback = !posterPath || errored;

  return (
    <div className={`relative overflow-hidden bg-bg-elevated ${className}`}>
      {showFallback ? (
        <NoPoster title={title} year={year} />
      ) : (
        <Image
          src={`/api/poster/${size}${posterPath}`}
          alt={`${title} poster`}
          fill
          sizes={sizes ?? "(min-width: 1280px) 180px, (min-width: 640px) 22vw, 42vw"}
          priority={priority}
          className="object-cover"
          onError={() => setErrored(true)}
        />
      )}
    </div>
  );
}
