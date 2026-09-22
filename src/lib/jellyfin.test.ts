// The Jellyfin sync, end to end, against a REAL isolated SQLite database and
// a stubbed Jellyfin server — same pattern as queries-film-shows.test.ts.
// Written after the outage a second movies library caused: a Concerts folder
// is naturally added as its own "movies" library, the sync read only the
// first one, matched none of the 284 film versions, and then its own sweep
// cleared every jellyfinId it had — no film could play. The claims here
// ("every film still matches when Concerts sorts first", "a pass that
// matched nothing keeps its ids") are claims about what a whole sync does to
// real rows, which is exactly where that bug lived.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTempTestDb } from "@/lib/test-temp-db";
import type { PrismaClient as PrismaClientType } from "@/generated/prisma/client";

let testPrisma: PrismaClientType;
let cleanupDb: () => Promise<void>;

vi.mock("@/lib/db", () => ({
  get prisma() {
    return testPrisma;
  },
}));

const { doJellyfinSync, shouldClearStaleIds } = await import("@/lib/jellyfin");

const realFetch = globalThis.fetch;

// --- the stub server -------------------------------------------------------

type JellyfinItemType = "Movie" | "Episode" | "Video";

interface StubItem {
  Id: string;
  Name: string;
  Path?: string;
  type: JellyfinItemType;
}

interface StubLibrary {
  Id: string;
  Name: string;
  CollectionType?: string;
  items: StubItem[];
}

let requestedUrls: string[] = [];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** Serve canned /Library/MediaFolders, /Items and /Library/Refresh responses
 *  for the given libraries. Items are returned only to a request naming
 *  their own library and their own type, exactly as the real server does. */
function stubJellyfin(libraries: StubLibrary[]): void {
  requestedUrls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    requestedUrls.push(url.toString());

    if (url.pathname === "/Library/Refresh") return new Response(null, { status: 204 });

    if (url.pathname === "/Library/MediaFolders") {
      return jsonResponse({
        Items: libraries.map(({ Id, Name, CollectionType }) => ({ Id, Name, CollectionType })),
      });
    }

    if (url.pathname === "/Items") {
      const parentId = url.searchParams.get("ParentId");
      const wantedType = url.searchParams.get("IncludeItemTypes");
      const library = libraries.find((l) => l.Id === parentId);
      const items = (library?.items ?? [])
        .filter((i) => i.type === wantedType)
        .map(({ Id, Name, Path }) => ({ Id, Name, Path }));
      return jsonResponse({ Items: items });
    }

    throw new Error(`stub: unexpected request to ${url.pathname}`);
  }) as typeof fetch;
}

/** The /Items request the movies pass made, for asserting its query. */
function movieItemsUrl(libraryId: string): URL {
  const found = requestedUrls
    .map((u) => new URL(u))
    .find((u) => u.pathname === "/Items" && u.searchParams.get("ParentId") === libraryId);
  if (!found) throw new Error(`no /Items request for library ${libraryId}`);
  return found;
}

function movieItem(id: string, name: string, path: string): StubItem {
  return { Id: id, Name: name, Path: path, type: "Movie" };
}

// --- seeding ---------------------------------------------------------------

let nextId = 0;

async function seedVersion(
  filePath: string,
  opts: { kind?: "FILM" | "CONCERT"; jellyfinId?: string | null } = {},
): Promise<number> {
  const id = ++nextId;
  const film = await testPrisma.film.create({
    data: { title: `Film ${id}`, sortTitle: `film ${id}`, kind: opts.kind ?? "FILM", owned: true },
  });
  const version = await testPrisma.version.create({
    data: {
      filmId: film.id,
      filePath,
      fileName: filePath.split("/").pop()!,
      jellyfinId: opts.jellyfinId ?? null,
    },
  });
  return version.id;
}

async function jellyfinIdOf(versionId: number): Promise<string | null> {
  const row = await testPrisma.version.findUniqueOrThrow({ where: { id: versionId } });
  return row.jellyfinId;
}

async function runSync(): Promise<{ log: string[]; message: string }> {
  const run = await testPrisma.scanRun.create({ data: { kind: "JELLYFIN", status: "RUNNING" } });
  await doJellyfinSync(run.id);
  const finished = await testPrisma.scanRun.findUniqueOrThrow({ where: { id: run.id } });
  return { log: JSON.parse(finished.log ?? "[]") as string[], message: finished.message ?? "" };
}

beforeAll(async () => {
  const db = await createTempTestDb();
  testPrisma = db.prisma;
  cleanupDb = db.cleanup;
  process.env.JELLYFIN_URL = "http://jellyfin.test";
  process.env.JELLYFIN_API_KEY = "test-key";
  // The prefixes stay at their defaults (/media/Movies/, /media/Concerts/…),
  // so a stray value in the developer's own .env can't steer these tests.
  delete process.env.JELLYFIN_MOVIES_PREFIX;
  delete process.env.JELLYFIN_TV_PREFIX;
  delete process.env.JELLYFIN_CONCERTS_PREFIX;
  delete process.env.ADULT_JELLYFIN_FOLDER_ID;
});

afterEach(async () => {
  await testPrisma.version.deleteMany();
  await testPrisma.film.deleteMany();
  await testPrisma.scene.deleteMany();
  await testPrisma.scanRun.deleteMany();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await cleanupDb?.();
});

describe("doJellyfinSync", () => {
  it("matches every film when a second movies library sorts first", async () => {
    // The production order: the Concerts library came back ahead of Movies,
    // and reading only Items[0] left all 284 films unmatched and swept.
    stubJellyfin([
      {
        Id: "lib-concerts",
        Name: "Concerts",
        CollectionType: "movies",
        items: [movieItem("jf-c1", "Pulse", "/media/Concerts/Pink Floyd - Pulse (1995)/pulse.mkv")],
      },
      {
        Id: "lib-movies",
        Name: "Movies",
        CollectionType: "movies",
        items: [
          movieItem("jf-m1", "Alien", "/media/Movies/Alien (1979)/alien.mkv"),
          movieItem("jf-m2", "Heat", "/media/Movies/Heat (1995)/heat.mkv"),
        ],
      },
    ]);

    const alien = await seedVersion("Alien (1979)/alien.mkv");
    const heat = await seedVersion("Heat (1995)/heat.mkv");
    const pulse = await seedVersion("Pink Floyd - Pulse (1995)/pulse.mkv", { kind: "CONCERT" });

    const { log, message } = await runSync();

    expect(await jellyfinIdOf(alien)).toBe("jf-m1");
    expect(await jellyfinIdOf(heat)).toBe("jf-m2");
    expect(await jellyfinIdOf(pulse)).toBe("jf-c1");
    expect(log).toContain("Matched 2 of 2 MediaVault versions to Jellyfin items");
    expect(log).toContain("Matched 1 of 1 MediaVault concert(s) to Jellyfin items");
    expect(message).toContain("Matched 2/2 movie version(s)");
  });

  it("matches films with a single movies library", async () => {
    stubJellyfin([
      {
        Id: "lib-movies",
        Name: "Movies",
        CollectionType: "movies",
        items: [movieItem("jf-m1", "Alien", "/media/Movies/Alien (1979)/alien.mkv")],
      },
    ]);

    const alien = await seedVersion("Alien (1979)/alien.mkv");

    const { log } = await runSync();

    expect(await jellyfinIdOf(alien)).toBe("jf-m1");
    expect(log).toContain("Matched 1 of 1 MediaVault versions to Jellyfin items");
  });

  it("asks Jellyfin not to collapse box sets", async () => {
    // Without CollapseBoxSetItems=false every movie in a collection comes
    // back as the BoxSet it belongs to, so Alien, Bourne, Bond and the rest
    // silently never match. This assertion is the only thing standing
    // between that bug and its return.
    stubJellyfin([{ Id: "lib-movies", Name: "Movies", CollectionType: "movies", items: [] }]);

    await runSync();

    expect(movieItemsUrl("lib-movies").searchParams.get("CollapseBoxSetItems")).toBe("false");
  });

  it("ignores items outside every prefix instead of reporting them unmatched", async () => {
    stubJellyfin([
      {
        Id: "lib-movies",
        Name: "Movies",
        CollectionType: "movies",
        items: [
          movieItem("jf-m1", "Alien", "/media/Movies/Alien (1979)/alien.mkv"),
          // A box set, should the server still send one, and a stray item
          // from a share MediaVault doesn't index.
          movieItem("jf-box", "Alien Collection", "/config/data/collections/Alien Collection [boxset]"),
          movieItem("jf-other", "Home Video", "/media/Other/holiday.mkv"),
        ],
      },
    ]);

    const alien = await seedVersion("Alien (1979)/alien.mkv");

    const { log } = await runSync();

    expect(await jellyfinIdOf(alien)).toBe("jf-m1");
    expect(log.join("\n")).not.toContain("Unmatched in Jellyfin");
    expect(log.join("\n")).not.toContain("boxset");
  });

  it("matches NFD-normalized MediaVault paths against Jellyfin's NFC ones", async () => {
    const nfc = "Léon (1994)/leon.mkv".normalize("NFC");
    const nfd = "Léon (1994)/leon.mkv".normalize("NFD");
    expect(nfd).not.toBe(nfc); // guard the fixture itself

    stubJellyfin([
      {
        Id: "lib-movies",
        Name: "Movies",
        CollectionType: "movies",
        items: [movieItem("jf-m1", "Léon", `/media/Movies/${nfc}`)],
      },
    ]);

    const leon = await seedVersion(nfd);

    await runSync();

    expect(await jellyfinIdOf(leon)).toBe("jf-m1");
  });

  it("clears a stale jellyfinId when the file has gone from Jellyfin", async () => {
    stubJellyfin([
      {
        Id: "lib-movies",
        Name: "Movies",
        CollectionType: "movies",
        items: [movieItem("jf-m1", "Alien", "/media/Movies/Alien (1979)/alien.mkv")],
      },
    ]);

    const alien = await seedVersion("Alien (1979)/alien.mkv", { jellyfinId: "jf-m1" });
    const gone = await seedVersion("Heat (1995)/heat.mkv", { jellyfinId: "jf-old" });

    const { log } = await runSync();

    expect(await jellyfinIdOf(alien)).toBe("jf-m1");
    expect(await jellyfinIdOf(gone)).toBeNull();
    expect(log.join("\n")).toContain("Unmatched in MediaVault (1)");
  });

  it("keeps every id when a pass matches nothing at all", async () => {
    // The destructive half of the outage: a fetch that came back wrong, not
    // a library anyone emptied.
    stubJellyfin([{ Id: "lib-movies", Name: "Movies", CollectionType: "movies", items: [] }]);

    const ids: number[] = [];
    for (let i = 0; i < 12; i++) {
      ids.push(await seedVersion(`Film ${i}/film.mkv`, { jellyfinId: `jf-${i}` }));
    }

    const { log, message } = await runSync();

    for (const id of ids) expect(await jellyfinIdOf(id)).not.toBeNull();
    expect(log.join("\n")).toContain("Kept 12 existing Jellyfin id(s) on 12 film version(s)");
    expect(message).toContain("kept existing ids after a pass matched nothing");
  });

  it("still clears ids for a small library that matches nothing", async () => {
    stubJellyfin([{ Id: "lib-movies", Name: "Movies", CollectionType: "movies", items: [] }]);

    const a = await seedVersion("Film A/a.mkv", { jellyfinId: "jf-a" });
    const b = await seedVersion("Film B/b.mkv", { jellyfinId: "jf-b" });

    const { log, message } = await runSync();

    expect(await jellyfinIdOf(a)).toBeNull();
    expect(await jellyfinIdOf(b)).toBeNull();
    expect(log.join("\n")).not.toContain("Kept");
    expect(message).not.toContain("kept existing ids");
  });

  it("fails the run when no movies library exists at all", async () => {
    stubJellyfin([{ Id: "lib-tv", Name: "TV", CollectionType: "tvshows", items: [] }]);

    const run = await testPrisma.scanRun.create({ data: { kind: "JELLYFIN", status: "RUNNING" } });
    await expect(doJellyfinSync(run.id)).rejects.toThrow(/CollectionType "movies"/);
  });
});

describe("shouldClearStaleIds", () => {
  it("sweeps whenever the pass matched something", () => {
    expect(shouldClearStaleIds(1, 500)).toBe(true);
    expect(shouldClearStaleIds(283, 284)).toBe(true);
  });

  it("sweeps an empty or small library that matched nothing", () => {
    expect(shouldClearStaleIds(0, 0)).toBe(true);
    expect(shouldClearStaleIds(0, 9)).toBe(true);
  });

  it("refuses to sweep a real number of rows that matched nothing", () => {
    expect(shouldClearStaleIds(0, 10)).toBe(false);
    expect(shouldClearStaleIds(0, 284)).toBe(false);
  });
});
