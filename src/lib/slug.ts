/** URL-safe slug + short random suffix for uniqueness. BetterAuth's
 *  organization.slug is required by the organization plugin's
 *  create-organization endpoint but isn't exposed anywhere in this app's UI
 *  — this just satisfies the constraint. Ported as-is from
 *  jinglejotter.com's lib/slug.ts. */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base || "household"}-${suffix}`;
}
