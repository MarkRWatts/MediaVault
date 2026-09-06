// The signed-in person's avatar: User.image when one is set (nothing in
// this app sets it yet — BetterAuth keeps the column for a future picture
// upload or SSO-provided photo), otherwise their initials in a circle.
// Server-safe: no hooks, plain <img> (see next.config.ts for why not
// next/image). Modelled on jinglejotter.com's components/shell/user-avatar.

export function initialsFor(name?: string | null, email?: string | null): string {
  const source = (name ?? "").trim();
  if (source) {
    const words = source.split(/\s+/).filter(Boolean);
    const first = words[0]?.charAt(0) ?? "";
    const last = words.length > 1 ? words[words.length - 1].charAt(0) : "";
    return (first + last).toUpperCase();
  }
  const fromEmail = (email ?? "").trim().charAt(0).toUpperCase();
  return fromEmail || "?";
}

export function UserAvatar({
  name,
  email,
  image,
  size,
  className = "",
}: {
  name?: string | null;
  email?: string | null;
  image?: string | null;
  /** Rendered square, in px. */
  size: number;
  className?: string;
}) {
  const label = name?.trim() || email || "";
  if (image) {
    return (
      <img
        src={image}
        alt={label}
        width={size}
        height={size}
        className={`shrink-0 rounded-full border border-border-strong object-cover ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      className={`flex shrink-0 select-none items-center justify-center rounded-full border border-accent-border bg-accent-dim font-display font-semibold leading-none tracking-wide text-accent ${className}`}
    >
      {initialsFor(name, email)}
    </span>
  );
}
