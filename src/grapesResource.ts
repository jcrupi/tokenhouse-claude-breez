export interface GrapeRegistration {
  name: string;
  url: string;
  model?: string;
  repo?: string;
  branch?: string;
}

let cache: Promise<GrapeRegistration[]> | null = null;

/** Stable promise for `use()` — do not create a new promise per render. */
export function readGrapes(): Promise<GrapeRegistration[]> {
  if (!cache) {
    cache = fetch("/api/grapes")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<GrapeRegistration[]>;
      })
      .catch((e) => {
        cache = null;
        throw e;
      });
  }
  return cache;
}

export function invalidateGrapesCache(): void {
  cache = null;
}
