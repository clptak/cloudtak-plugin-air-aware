import { std } from '../../../src/std.ts';
import { API } from './constants.ts';
import { fromListRow, parseDetail, validNotamId, type Tfr, type TfrListRow } from './tfr.ts';

export type PackName = 'airspace' | 'obstacles' | 'uasfm' | 'nsufr' | 'notams';

export interface Manifest {
    cycle?: string;
    built?: string;
    credit?: string;
    tile_degrees?: number;
    tiles?: Record<string, { sha256?: string; count?: number }>;
    fields?: string[];
}

interface Timed<T> { at: number; value: T }

const MANIFEST_TTL: Record<PackName, number> = {
    airspace: 6 * 3600_000,
    obstacles: 6 * 3600_000,
    uasfm: 6 * 3600_000,
    nsufr: 3600_000,
    notams: 3 * 60_000
};

const manifests = new Map<PackName, Timed<Manifest>>();
const tiles = new Map<string, Timed<unknown>>();
const MAX_TILES = 160;

export async function manifest(pack: PackName): Promise<Manifest> {
    const hit = manifests.get(pack);
    if (hit && Date.now() - hit.at < MANIFEST_TTL[pack]) return hit.value;
    try {
        const value = await std(`${API}/pack/${pack}/manifest`) as Manifest;
        manifests.set(pack, { at: Date.now(), value });
        return value;
    } catch (err) {
        if (hit) return hit.value;
        throw err;
    }
}

/** Tile keys (SW corner, floored to the tile size) a bbox touches that the manifest knows. */
export function keysFor(m: Manifest, south: number, west: number, north: number, east: number, max = 24): string[] {
    const step = Math.min(10, Math.max(1, m.tile_degrees || 2));
    const floor = (v: number): number => Math.floor(v / step) * step;
    const known = m.tiles || {};
    const keys: string[] = [];
    const clampLat = (v: number): number => Math.max(-90, Math.min(89.999, v));
    const clampLon = (v: number): number => Math.max(-180, Math.min(179.999, v));
    for (let lat = floor(clampLat(south)); lat <= floor(clampLat(north)); lat += step) {
        for (let lon = floor(clampLon(west)); lon <= floor(clampLon(east)); lon += step) {
            const key = `${lat}_${lon}`;
            if (known[key]) keys.push(key);
            if (keys.length >= max) return keys;
        }
    }
    return keys;
}

/**
 * One tile. Re-fetched only when the manifest names a different sha256 for it, so a pan
 * back over somewhere already seen costs nothing.
 */
export async function tile<T>(pack: PackName, key: string, m: Manifest): Promise<T> {
    const sha = m.tiles?.[key]?.sha256 || m.cycle || '';
    const id = `${pack}/${key}/${sha}`;
    const hit = tiles.get(id);
    if (hit) {
        tiles.delete(id);
        tiles.set(id, hit);
        return hit.value as T;
    }
    const value = await std(`${API}/pack/${pack}/tile/${key}`) as T;
    tiles.set(id, { at: Date.now(), value });
    while (tiles.size > MAX_TILES) {
        const oldest = tiles.keys().next();
        if (oldest.done) break;
        tiles.delete(oldest.value);
    }
    return value;
}

export async function packFile<T>(pack: PackName, file: string, m: Manifest): Promise<T> {
    const id = `${pack}/file/${file}/${m.cycle || m.built || ''}`;
    const hit = tiles.get(id);
    if (hit) return hit.value as T;
    const value = await std(`${API}/pack/${pack}/file/${file}`) as T;
    tiles.set(id, { at: Date.now(), value });
    return value;
}

/** Run jobs with a fixed concurrency. */
export async function pool<T, R>(items: T[], limit: number, job: (item: T) => Promise<R>): Promise<Array<R | undefined>> {
    const out: Array<R | undefined> = new Array(items.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < items.length) {
            const i = next++;
            try {
                out[i] = await job(items[i]);
            } catch {
                out[i] = undefined;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

const tfrDetails = new Map<string, Timed<Tfr>>();
let tfrList: Timed<Tfr[]> | undefined;

/** The national TFR list with every detail document parsed. */
export async function loadTfrs(): Promise<{ tfrs: Tfr[]; failed: number }> {
    if (tfrList && Date.now() - tfrList.at < 5 * 60_000) return { tfrs: tfrList.value, failed: 0 };

    const rows = await std(`${API}/tfr`) as TfrListRow[];
    const list = (Array.isArray(rows) ? rows : []).map(fromListRow).filter((t) => validNotamId(t.notamId));
    let failed = 0;
    await pool(list, 6, async (t) => {
        const hit = tfrDetails.get(t.notamId);
        if (hit && Date.now() - hit.at < 10 * 60_000) {
            Object.assign(t, { ...hit.value, ...{ type: t.type, description: t.description } });
            return;
        }
        try {
            const res = await std(`${API}/tfr/${t.notamId.replace('/', '_')}`) as { xml: string };
            parseDetail(res.xml, t);
            tfrDetails.set(t.notamId, { at: Date.now(), value: t });
        } catch {
            failed++;
            if (hit) Object.assign(t, hit.value);
        }
    });
    tfrList = { at: Date.now(), value: list };
    return { tfrs: list, failed };
}

export interface MetarRow {
    icaoId: string;
    name?: string;
    lat: number;
    lon: number;
    fltCat?: string;
    rawOb?: string;
    reportTime?: string;
    temp?: number;
    dewp?: number;
    wdir?: number | string;
    wspd?: number;
    wgst?: number;
    visib?: number | string;
    altim?: number;
    cover?: string;
    clouds?: Array<{ cover: string; base: number | null }>;
}

export async function loadMetars(south: number, west: number, north: number, east: number): Promise<MetarRow[]> {
    const q = new URLSearchParams({
        south: south.toFixed(3),
        west: west.toFixed(3),
        north: north.toFixed(3),
        east: east.toFixed(3)
    });
    const rows = await std(`${API}/metar?${q.toString()}`) as MetarRow[];
    return Array.isArray(rows) ? rows : [];
}

export interface SfraFeature {
    attributes: Record<string, string | number | null>;
    geometry?: { rings?: number[][][] };
}

let sfraCache: Timed<SfraFeature[]> | undefined;

/** Every Special Flight Rules / Special Air Traffic Rules area (FAA AIS airspace, TYPE SATA). */
export async function loadSfra(): Promise<SfraFeature[]> {
    if (sfraCache && Date.now() - sfraCache.at < 6 * 3600_000) return sfraCache.value;
    try {
        const res = await std(`${API}/sfra`) as { features?: SfraFeature[] };
        const value = Array.isArray(res?.features) ? res.features : [];
        sfraCache = { at: Date.now(), value };
        return value;
    } catch (err) {
        if (sfraCache) return sfraCache.value;
        throw err;
    }
}
