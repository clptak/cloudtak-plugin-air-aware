import type {
    Map as MLMap,
    MapMouseEvent,
    GeoJSONSource,
    LayerSpecification,
    ExpressionSpecification,
    FilterSpecification
} from 'maplibre-gl';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { watch, type WatchStopHandle } from 'vue';
import { COLORS, LAYERS, LINKS, PREFIX, uasColor, type LayerKey } from './constants.ts';
import { state, type Detail, type DetailRow } from './store.ts';
import { keysFor, loadMetars, loadSfra, loadTfrs, manifest, packFile, tile, type Manifest, type MetarRow } from './data.ts';
import { circle, emptyCollection, esriRings, fmtTime, M_PER_FT } from './geo.ts';
import { tfrActive, vertText, type Tfr } from './tfr.ts';
import { planShape } from './planner.ts';
import { fmtH } from './units.ts';

const SRC = (k: string): string => `${PREFIX}-${k}`;
const LYR = (k: string, part: string): string => `${PREFIX}-${k}-${part}`;
const FONT = ['Open Sans Bold'];

const SOURCES = ['tfr', 'notams', 'airspace', 'sua', 'uasfm', 'nsufr', 'obstacles', 'metars', 'sfra', 'planhaz', 'plan', 'islands'] as const;

/** Layers that answer a click, in priority order. */
const CLICKABLE: string[] = [
    LYR('planhaz', 'circle'),
    LYR('planhaz', 'fill'),
    LYR('metars', 'circle'),
    LYR('obstacles', 'circle'),
    LYR('notams', 'circle'),
    LYR('notams', 'fill'),
    LYR('nsufr', 'fill'),
    LYR('tfr', 'fill'),
    LYR('tfr', 'ext'),
    LYR('uasfm', 'fill'),
    LYR('sua', 'fill'),
    LYR('sua', 'ext'),
    LYR('airspace', 'fill'),
    LYR('airspace', 'ext'),
    LYR('sfra', 'fill'),
    LYR('sfra', 'ext')
];

interface EsriFeature {
    attributes: Record<string, string | number | null>;
    geometry?: { rings?: number[][][] };
}

interface UasTile {
    airports: string[];
    cells: Array<[number, number, number, number]>;
}

interface NotamRow {
    id: string;
    n?: string;
    c?: string;
    k?: string;
    loc?: string;
    icao?: string;
    lat?: number;
    lon?: number;
    s?: string;
    e?: string;
    est?: string;
    t?: string;
    ty?: string;
    u?: string;
    p?: number[][][];
}

interface NsufrFeature {
    id: string;
    status: string;
    attributes: Record<string, string | number | null>;
    geometry?: { rings?: number[][][] };
}

export type ObstacleRow = [string, string, number, number, number, number, string, string, number, string, string];

/** A view or plan bounding box. */
export interface Box {
    s: number;
    w: number;
    n: number;
    e: number;
    zoom: number;
    center: [number, number];
}

type Remember = (d: Detail) => string;

export type PlanHazardKind = 'tfr' | 'nsufr' | 'airspace' | 'sua' | 'notams';

export class AirAwareLayers {
    map: MLMap;
    onDetails: () => void;

    /** Click details per layer, swapped whole when the layer's data is replaced. */
    private details = new Map<string, Map<string, Detail>>();
    private seq = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private generation: Record<string, number> = {};
    private stops: WatchStopHandle[] = [];
    private refreshInterval: ReturnType<typeof setInterval> | undefined;
    private active = false;

    /** UAS cells the view has loaded, for the "here" line and the planner. */
    uasCells = new Map<string, { ceiling: number; airport: string }>();
    /** Obstacles the view has loaded (all heights), for the planner. */
    obstacles = new Map<string, ObstacleRow>();

    private readonly onMove = (): void => this.schedule();
    private readonly onClick = (e: MapMouseEvent): void => this.click(e);
    private readonly onStyle = (): void => this.ensure();

    constructor(map: MLMap, onDetails: () => void) {
        this.map = map;
        this.onDetails = onDetails;
    }

    start(): void {
        if (this.active) return;
        this.active = true;
        this.ensure();
        this.map.on('moveend', this.onMove);
        this.map.on('click', this.onClick);
        this.map.on('styledata', this.onStyle);

        this.stops.push(watch(() => ({ ...state.settings.layers }), () => {
            this.applyVisibility();
            this.schedule(0);
        }, { deep: true }));
        this.stops.push(watch(() => [
            state.settings.obstacleMinFt,
            state.settings.obstacleTypes.join(','),
            state.settings.activeTfrOnly,
            state.settings.units,
            state.revision
        ], () => this.schedule(0)));
        this.stops.push(watch(() => state.settings.volumes, () => this.applyVisibility()));
        // While a flight plan is up, only the planner's overlapping hazards are drawn.
        this.stops.push(watch(planActive, () => this.applyVisibility()));

        // NOTAMs and METARs change all day; TFRs every few minutes.
        this.refreshInterval = setInterval(() => this.schedule(0), 3 * 60_000);
        this.schedule(0);
    }

    stop(): void {
        if (!this.active) return;
        this.active = false;
        if (this.timer) clearTimeout(this.timer);
        if (this.refreshInterval) clearInterval(this.refreshInterval);
        this.timer = undefined;
        this.refreshInterval = undefined;
        for (const s of this.stops) s();
        this.stops = [];
        this.map.off('moveend', this.onMove);
        this.map.off('click', this.onClick);
        this.map.off('styledata', this.onStyle);
        this.removeAll();
        for (const l of LAYERS) state.status[l.key] = { text: 'Off', loading: false };
        state.here = '';
    }

    // ---- map style plumbing ----

    private beforeId(): string | undefined {
        // Keep the air picture under CloudTAK's own CoT markers (overlay id -1).
        const layers = this.map.getStyle()?.layers || [];
        const cot = layers.find((l) => String(l.id).startsWith('-1'));
        return cot ? cot.id : undefined;
    }

    /** Add sources and layers if they are missing, e.g. after a basemap change. */
    ensure(): void {
        if (!this.active) return;
        let style;
        try {
            style = this.map.getStyle();
        } catch {
            return;
        }
        if (!style) return;
        this.ensureIcons();
        if (this.map.getSource(SRC('plan')) && this.map.getLayer(LYR('plan', 'line'))) return;
        this.removeAll();
        for (const s of SOURCES) {
            this.map.addSource(SRC(s), { type: 'geojson', data: emptyCollection() });
        }
        const before = this.beforeId();
        for (const spec of this.specs()) this.map.addLayer(spec, before);
        this.setData('plan', planShape());
        this.applyVisibility();
        this.schedule(0);
    }

    private removeAll(): void {
        let style;
        try {
            style = this.map.getStyle();
        } catch {
            return;
        }
        if (!style) return;
        for (const l of style.layers || []) {
            if (String(l.id).startsWith(PREFIX + '-')) this.map.removeLayer(l.id);
        }
        for (const s of SOURCES) {
            if (this.map.getSource(SRC(s))) this.map.removeSource(SRC(s));
        }
    }

    private specs(): LayerSpecification[] {
        const fill = (k: string, opacity: number | ExpressionSpecification = 0.15, filter?: FilterSpecification): LayerSpecification => ({
            id: LYR(k, 'fill'), type: 'fill', source: SRC(k),
            ...(filter ? { filter } : {}),
            paint: { 'fill-color': ['get', 'color'], 'fill-opacity': opacity }
        });
        const line = (k: string, width: number | ExpressionSpecification = 1.5, dash?: number[], filter?: FilterSpecification): LayerSpecification => ({
            id: LYR(k, 'line'), type: 'line', source: SRC(k),
            ...(filter ? { filter } : {}),
            paint: { 'line-color': ['get', 'color'], 'line-width': width, ...(dash ? { 'line-dasharray': dash } : {}) }
        });
        const ext = (k: string): LayerSpecification => ({
            id: LYR(k, 'ext'), type: 'fill-extrusion', source: SRC(k),
            paint: {
                'fill-extrusion-color': ['get', 'color'],
                'fill-extrusion-base': ['coalesce', ['get', 'baseM'], 0],
                'fill-extrusion-height': ['coalesce', ['get', 'topM'], 0],
                'fill-extrusion-opacity': 0.35
            }
        });
        const label = (k: string, minzoom: number, size = 11, extra: Record<string, unknown> = {}): LayerSpecification => ({
            id: LYR(k, 'label'), type: 'symbol', source: SRC(k), minzoom,
            layout: {
                'text-field': ['get', 'label'],
                'text-font': FONT,
                'text-size': size,
                'text-allow-overlap': false,
                'symbol-placement': 'point',
                ...extra
            },
            paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.85)', 'text-halo-width': 1.5 }
        } as LayerSpecification);
        const dot = (k: string, radius: number | ExpressionSpecification, filter?: FilterSpecification): LayerSpecification => ({
            id: LYR(k, 'circle'), type: 'circle', source: SRC(k),
            ...(filter ? { filter } : {}),
            paint: {
                'circle-color': ['get', 'color'],
                'circle-radius': radius,
                'circle-stroke-color': '#000000',
                'circle-stroke-width': 1,
                'circle-opacity': ['coalesce', ['get', 'opacity'], 1]
            }
        });
        const polys: FilterSpecification = ['==', ['geometry-type'], 'Polygon'];
        const points: FilterSpecification = ['==', ['geometry-type'], 'Point'];

        return [
            fill('airspace', 0.06), line('airspace', 1.2), ext('airspace'), label('airspace', 9, 10),
            fill('sua', 0.08), line('sua', 1.5, [3, 2]), ext('sua'), label('sua', 7, 10),
            fill('uasfm', ['case', ['<=', ['get', 'ceiling'], 0], 0.35, 0.22]),
            line('uasfm', 0.4),
            label('uasfm', 12, 10),
            fill('nsufr', 0.25), line('nsufr', 2), label('nsufr', 9, 11),
            fill('tfr', 0.22), line('tfr', 2.5), ext('tfr'), label('tfr', 6, 12),
            fill('notams', 0.18, polys), line('notams', 1.5, undefined, polys),
            dot('notams', ['interpolate', ['linear'], ['zoom'], 7, 3, 12, 6], points),
            label('notams', 11, 10, { 'text-offset': [0, 1.2], 'text-anchor': 'top' }),
            dot('obstacles', ['interpolate', ['linear'], ['zoom'], 9, 2.5, 14, 6]),
            label('obstacles', 11, 10, { 'text-offset': [0, 1.0], 'text-anchor': 'top' }),
            dot('metars', 7),
            label('metars', 6, 11, { 'text-offset': [0, 1.3], 'text-anchor': 'top' }),
            // Special Flight Rules Airspace: sectional style, a wide-dashed blue boundary with
            // blue text, over a barely tinted fill.
            fill('sfra', 0.04), line('sfra', 2.2, [6, 3]), ext('sfra'),
            {
                ...label('sfra', 6, 10),
                paint: { 'text-color': COLORS.sfra, 'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 1.5 }
            } as LayerSpecification,
            {
                id: LYR('planhaz', 'fill'), type: 'fill', source: SRC('planhaz'), filter: polys,
                paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['coalesce', ['get', 'fillOpacity'], 0.2] }
            },
            line('planhaz', 1.5, undefined, polys),
            dot('planhaz', ['interpolate', ['linear'], ['zoom'], 9, 3, 14, 6], points),
            label('planhaz', 10, 10, { 'text-offset': [0, 1.0], 'text-anchor': 'top' }),
            {
                id: LYR('islands', 'circle'), type: 'circle', source: SRC('islands'),
                paint: {
                    'circle-color': ['get', 'color'],
                    'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 10, 2, 16, 40],
                    'circle-opacity': 0.4,
                    'circle-blur': 0.6
                }
            },
            {
                id: LYR('plan', 'fill'), type: 'fill', source: SRC('plan'),
                filter: ['all', polys, ['!', ['to-boolean', ['get', 'ring']]]],
                paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.08 }
            },
            {
                id: LYR('plan', 'line'), type: 'line', source: SRC('plan'),
                filter: ['all', ['!=', ['geometry-type'], 'Point'], ['!', ['to-boolean', ['get', 'ring']]]],
                paint: { 'line-color': ['get', 'color'], 'line-width': 2.5 }
            },
            {
                id: LYR('plan', 'ring'), type: 'line', source: SRC('plan'),
                filter: ['to-boolean', ['get', 'ring']],
                paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-dasharray': [3, 2] }
            },
            {
                id: LYR('plan', 'point'), type: 'circle', source: SRC('plan'),
                filter: ['all', points, ['!', ['has', 'icon']]],
                paint: { 'circle-color': ['get', 'color'], 'circle-radius': ['coalesce', ['get', 'radius'], 8], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 }
            },
            {
                id: LYR('plan', 'icon'), type: 'symbol', source: SRC('plan'),
                filter: ['all', points, ['has', 'icon']],
                layout: {
                    'icon-image': ['get', 'icon'],
                    'icon-allow-overlap': true,
                    'icon-ignore-placement': true,
                    'text-field': ['get', 'label'],
                    'text-font': FONT,
                    'text-size': 12,
                    'text-offset': [0, 1.6],
                    'text-anchor': 'top',
                    'text-optional': true
                },
                paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.85)', 'text-halo-width': 1.5 }
            } as LayerSpecification,
            {
                ...label('plan', 8, 12, { 'text-offset': [0, 1.0], 'text-anchor': 'top' }),
                filter: ['!', ['has', 'icon']]
            } as LayerSpecification
        ];
    }

    /** Home and target symbols, redrawn after a basemap change drops them. */
    private ensureIcons(): void {
        for (const [name, draw] of Object.entries(ICONS)) {
            if (this.map.hasImage(name)) continue;
            const img = draw();
            if (img) this.map.addImage(name, img, { pixelRatio: 2 });
        }
    }

    applyVisibility(): void {
        if (!this.map.getSource(SRC('plan'))) return;
        const vol = state.settings.volumes;
        const planning = planActive();
        const set = (id: string, on: boolean): void => {
            if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
        };
        for (const l of LAYERS) {
            const on = state.settings.layers[l.key] && !planning;
            for (const part of ['fill', 'line', 'label', 'circle']) set(LYR(l.key, part), on);
            set(LYR(l.key, 'ext'), on && vol);
            if (['tfr', 'airspace', 'sua', 'sfra'].includes(l.key)) set(LYR(l.key, 'fill'), on && !vol);
        }
    }

    private setData(k: string, fc: FeatureCollection): void {
        const src = this.map.getSource(SRC(k)) as GeoJSONSource | undefined;
        if (src) src.setData(fc);
    }

    private store(bag: Map<string, Detail>, d: Detail): string {
        const id = `aa${++this.seq}`;
        bag.set(id, d);
        return id;
    }

    private lookup(id: string): Detail | undefined {
        for (const m of this.details.values()) {
            const d = m.get(id);
            if (d) return d;
        }
        return undefined;
    }

    /** Public hooks for the planner's own sources. */
    setPlan(fc: FeatureCollection): void {
        this.setData('plan', fc);
    }

    /** Overlapping hazards for the plan, with the details their clicks open. */
    setPlanHazards(fc: FeatureCollection, bag?: Map<string, Detail>): void {
        this.setData('planhaz', fc);
        if (bag) this.details.set('planhaz', bag);
        else this.details.delete('planhaz');
    }

    /** File a detail for a planner feature into the bag it will be committed with. */
    planDetail(bag: Map<string, Detail>, d: Detail): string {
        return this.store(bag, d);
    }

    /**
     * TFRs, No-Fly areas, airspace, special use and NOTAMs for a box, whatever the
     * layer switches say. A source that cannot be read comes back as null.
     */
    async loadForPlan(box: Box, bag: Map<string, Detail>): Promise<Record<PlanHazardKind, Feature[] | null>> {
        const rem: Remember = (d) => this.store(bag, d);
        const grab = (p: Promise<{ fc: FeatureCollection }>): Promise<Feature[] | null> => p.then((r) => r.fc.features).catch(() => null);
        const [tfr, nsufr, airspace, sua, notams] = await Promise.all([
            grab(this.loadTfr(rem)),
            grab(this.loadNsufr(rem)),
            grab(this.loadAirspace(box, false, rem)),
            grab(this.loadAirspace(box, true, rem)),
            grab(this.loadNotams(box, rem))
        ]);
        return { tfr, nsufr, airspace, sua, notams };
    }

    setIslands(fc: FeatureCollection): void {
        this.setData('islands', fc);
    }

    // ---- refresh ----

    schedule(delay = 400): void {
        if (!this.active) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.refresh();
        }, delay);
    }

    private bounds(): Box {
        const b = this.map.getBounds();
        const c = this.map.getCenter();
        return {
            s: Math.max(-85, b.getSouth()),
            w: Math.max(-180, b.getWest()),
            n: Math.min(85, b.getNorth()),
            e: Math.min(180, b.getEast()),
            zoom: this.map.getZoom(),
            center: [c.lng, c.lat]
        };
    }

    async refresh(): Promise<void> {
        if (!this.active) return;
        this.ensure();
        const jobs: Array<Promise<void>> = [];
        for (const l of LAYERS) {
            if (!state.settings.layers[l.key]) {
                state.status[l.key] = { text: 'Off', loading: false };
                this.setData(l.key, emptyCollection());
                continue;
            }
            jobs.push(this.run(l.key, l.minZoom));
        }
        await Promise.all(jobs);
        this.updateHere();
    }

    private async run(key: LayerKey, minZoom: number): Promise<void> {
        const gen = (this.generation[key] || 0) + 1;
        this.generation[key] = gen;
        const view = this.bounds();
        if (view.zoom < minZoom) {
            this.setData(key, emptyCollection());
            this.details.delete(key);
            state.status[key] = { text: `Zoom in to see ${LAYERS.find((l) => l.key === key)?.label} (zoom ${minZoom}+)`, loading: false };
            return;
        }
        const prev = state.status[key];
        state.status[key] = { ...prev, loading: true, error: undefined };
        try {
            let fc: FeatureCollection;
            let text: string;
            const bag = new Map<string, Detail>();
            const rem: Remember = (d) => this.store(bag, d);
            switch (key) {
                case 'tfr': ({ fc, text } = await this.loadTfr(rem)); break;
                case 'notams': ({ fc, text } = await this.loadNotams(view, rem)); break;
                case 'airspace': ({ fc, text } = await this.loadAirspace(view, false, rem)); break;
                case 'sua': ({ fc, text } = await this.loadAirspace(view, true, rem)); break;
                case 'uasfm': ({ fc, text } = await this.loadUas(view)); break;
                case 'nsufr': ({ fc, text } = await this.loadNsufr(rem)); break;
                case 'obstacles': ({ fc, text } = await this.loadObstacles(view, rem)); break;
                case 'metars': ({ fc, text } = await this.loadMetar(view, rem)); break;
                case 'sfra': ({ fc, text } = await this.loadSfra(view, rem)); break;
            }
            if (this.generation[key] !== gen || !this.active) return;
            this.setData(key, fc);
            this.details.set(key, bag);
            state.status[key] = { text, loading: false, count: fc.features.length, updated: new Date().toISOString() };
        } catch (err) {
            if (this.generation[key] !== gen) return;
            // A failed fetch never empties the map: what is drawn stays drawn.
            state.status[key] = {
                text: prev.count ? `${prev.text} (refresh failed)` : 'Could not reach the source',
                loading: false,
                error: err instanceof Error ? err.message : String(err),
                count: prev.count,
                updated: prev.updated
            };
        }
    }

    // ---- TFR ----

    private async loadTfr(rem: Remember): Promise<{ fc: FeatureCollection; text: string }> {
        const { tfrs, failed } = await loadTfrs();
        const features: Feature[] = [];
        let active = 0, scheduled = 0;
        const now = Date.now();
        for (const t of tfrs) {
            if (!t.detailLoaded) continue;
            for (const a of t.areas) {
                const on = tfrActive(t, a, now);
                if (!on && state.settings.activeTfrOnly) continue;
                let geom: Geometry | null = null;
                if (a.ring.length >= 3) {
                    const ring = a.ring.map((p) => [p[0], p[1]]);
                    const f = ring[0], l = ring[ring.length - 1];
                    if (f[0] !== l[0] || f[1] !== l[1]) ring.push([f[0], f[1]]);
                    geom = { type: 'Polygon', coordinates: [ring] };
                } else if (a.center && a.radiusNm > 0) {
                    geom = circle(a.center, a.radiusNm * 1852);
                }
                if (!geom) continue;
                if (on) active++; else scheduled++;
                const color = on ? COLORS.tfrActive : COLORS.tfrScheduled;
                const id = rem(this.tfrDetail(t, a, on, color));
                features.push({
                    type: 'Feature',
                    geometry: geom,
                    properties: {
                        aaid: id,
                        color,
                        label: `${t.type} ${t.notamId}\n${vertText(a.floor)} – ${vertText(a.ceiling)}`,
                        baseM: a.floor.surface ? 0 : a.floor.feet * M_PER_FT,
                        topM: (a.ceiling.present ? a.ceiling.feet : 18000) * M_PER_FT,
                        name: `TFR ${t.notamId} ${a.name}`
                    }
                });
            }
        }
        const text = `${active} in effect, ${scheduled} scheduled (${tfrs.length} national)` + (failed ? `, ${failed} details unreachable` : '');
        return { fc: { type: 'FeatureCollection', features }, text };
    }

    private tfrDetail(t: Tfr, a: Tfr['areas'][number], on: boolean, color: string): Detail {
        const rows: DetailRow[] = [
            { label: 'Status', value: on ? 'In effect' : 'Scheduled' },
            { label: 'Type', value: t.type },
            { label: 'Area', value: a.name || '—' },
            { label: 'Floor', value: vertText(a.floor) },
            { label: 'Ceiling', value: vertText(a.ceiling) },
            { label: 'Effective', value: fmtTime(a.effectiveMs || t.effectiveMs) + (t.windowApproximate ? ' (approx.)' : '') },
            { label: 'Expires', value: fmtTime(a.expireMs || t.expireMs) },
            { label: 'Facility', value: t.facility },
            { label: 'Location', value: [t.city, t.stateName || t.state].filter(Boolean).join(', ') || t.description },
            { label: 'FAA page', value: 'tfr.faa.gov', href: LINKS.tfrDetail + t.notamId.replace('/', '_') }
        ];
        if (a.radiusNm) rows.splice(3, 0, { label: 'Radius', value: `${a.radiusNm.toFixed(1)} NM` });
        return { title: `TFR ${t.notamId}`, subtitle: t.description, color, rows, text: t.notamText };
    }

    // ---- NOTAMs ----

    private async loadNotams(v: Box, rem: Remember): Promise<{ fc: FeatureCollection; text: string }> {
        const m = await manifest('notams');
        const keys = keysFor(m, v.s, v.w, v.n, v.e);
        const tiles = await Promise.all(keys.map((k) => tile<{ notams: NotamRow[] }>('notams', k, m).catch(() => null)));
        const seen = new Set<string>();
        const features: Feature[] = [];
        const now = Date.now();
        for (const t of tiles) {
            for (const n of t?.notams || []) {
                if (seen.has(n.id)) continue;
                seen.add(n.id);
                const kind = n.k || 'other';
                const color = notamColor(kind);
                const start = n.s ? Date.parse(n.s) : 0;
                const activeNow = !start || start <= now;
                const id = rem({
                    title: `NOTAM ${n.n || n.id}`,
                    subtitle: `${n.icao || n.loc || ''} · ${kindName(kind)}`,
                    color,
                    rows: [
                        { label: 'Kind', value: kindName(kind) },
                        { label: 'Location', value: n.icao || n.loc || '—' },
                        { label: 'Class', value: n.c || '—' },
                        { label: 'Starts', value: fmtTime(n.s) },
                        { label: 'Ends', value: fmtTime(n.e) + (n.est ? ' (estimated)' : '') },
                        { label: 'Issued', value: fmtTime(n.u) }
                    ],
                    text: n.t
                });
                const props = { aaid: id, color, opacity: activeNow ? 1 : 0.5, label: n.n || '' };
                if (Array.isArray(n.p) && n.p.length) {
                    features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: n.p }, properties: props });
                }
                if (typeof n.lat === 'number' && typeof n.lon === 'number') {
                    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [n.lon, n.lat] }, properties: props });
                }
            }
        }
        const text = `${seen.size} NOTAMs in view` + (m.built ? ` · relay ${fmtTime(m.built)}` : '');
        return { fc: { type: 'FeatureCollection', features }, text };
    }

    // ---- Airspace / Special Use ----

    private async loadAirspace(v: Box, sua: boolean, rem: Remember): Promise<{ fc: FeatureCollection; text: string }> {
        const m = await manifest('airspace');
        const keys = keysFor(m, v.s, v.w, v.n, v.e);
        const [wide, ...tiles] = await Promise.all([
            packFile<{ features: EsriFeature[] }>('airspace', 'wide', m).catch(() => null),
            ...keys.map((k) => tile<{ features: EsriFeature[] }>('airspace', k, m).catch(() => null))
        ]);
        const seen = new Set<string>();
        const features: Feature[] = [];
        for (const t of [wide, ...tiles]) {
            for (const f of t?.features || []) {
                const a = f.attributes || {};
                const oid = String(a.OBJECTID ?? '');
                if (seen.has(oid)) continue;
                const isSua = a.TYPE_CODE !== 'CLASS';
                if (isSua !== sua) continue;
                const geom = f.geometry?.rings ? esriRings(f.geometry.rings) : null;
                if (!geom) continue;
                seen.add(oid);
                const color = sua ? suaColor(String(a.TYPE_CODE || '')) : classColor(a);
                const lower = esriVert(a, 'LOWER');
                const upper = esriVert(a, 'UPPER');
                const name = String(a.NAME_TXT || '').trim();
                const cls = String(a.CLASS_CODE || '').trim();
                const local = String(a.LOCALTYPE_TXT || '').replace(/_/g, ' ');
                const id = rem({
                    title: name || local,
                    subtitle: sua ? local : `Class ${cls}${local && local !== `CLASS ${cls}` ? ` (${local})` : ''}`,
                    color,
                    rows: [
                        { label: 'Type', value: local || String(a.TYPE_CODE || '') },
                        { label: 'Floor', value: lower.text },
                        { label: 'Ceiling', value: upper.text },
                        ...(sua ? [{ label: 'Hours', value: workHours(String(a.WORKHR_CODE || '')) }] : []),
                        ...(a.IDENT_TXT ? [{ label: 'Ident', value: String(a.IDENT_TXT) }] : [])
                    ]
                });
                features.push({
                    type: 'Feature',
                    geometry: geom,
                    properties: {
                        aaid: id,
                        color,
                        label: sua ? `${name}\n${lower.short}–${upper.short}` : `${cls} ${upper.short}/${lower.short}`,
                        baseM: lower.ft * M_PER_FT,
                        topM: upper.ft * M_PER_FT,
                        name: name || local,
                        cls
                    }
                });
            }
        }
        const text = `${features.length} ${sua ? 'special use areas' : 'airspace shelves'} in view` + (m.cycle ? ` · cycle ${m.cycle}` : '');
        return { fc: { type: 'FeatureCollection', features }, text };
    }

    // ---- Special Flight Rules Airspace ----

    private async loadSfra(v: Box, rem: Remember): Promise<{ fc: FeatureCollection; text: string }> {
        const all = await loadSfra();
        const features: Feature[] = [];
        for (const f of all) {
            const a = f.attributes || {};
            const geom = f.geometry?.rings ? esriRings(f.geometry.rings) : null;
            if (!geom) continue;
            // The whole national set is small; keep only what touches the view.
            let w = 180, e = -180, s = 90, n = -90;
            for (const ring of f.geometry?.rings || []) {
                for (const [x, y] of ring) {
                    if (x < w) w = x;
                    if (x > e) e = x;
                    if (y < s) s = y;
                    if (y > n) n = y;
                }
            }
            if (e < v.w || w > v.e || n < v.s || s > v.n) continue;
            const lower = esriVert(a, 'LOWER');
            const upper = esriVert(a, 'UPPER');
            const name = String(a.NAME_TXT || '').trim();
            const id = rem({
                title: name,
                subtitle: 'Special Flight Rules / Special Air Traffic Rules',
                color: COLORS.sfra,
                rows: [
                    { label: 'Floor', value: lower.text },
                    { label: 'Ceiling', value: upper.text },
                    { label: 'Hours', value: workHours(String(a.WORKHR_CODE || '')) },
                    ...(a.REMARKS_TXT ? [{ label: 'Remarks', value: String(a.REMARKS_TXT) }] : [])
                ]
            });
            features.push({
                type: 'Feature',
                geometry: geom,
                properties: {
                    aaid: id,
                    color: COLORS.sfra,
                    label: name,
                    baseM: lower.ft * M_PER_FT,
                    topM: upper.ft * M_PER_FT,
                    name
                }
            });
        }
        return { fc: { type: 'FeatureCollection', features }, text: `${features.length} special flight rules areas in view` };
    }

    // ---- UAS Facility Map ----

    private async loadUas(v: Box): Promise<{ fc: FeatureCollection; text: string }> {
        const m = await manifest('uasfm');
        const per = 120;
        const keys = keysFor(m, v.s, v.w, v.n, v.e, 9);
        const tiles = await Promise.all(keys.map((k) => tile<UasTile>('uasfm', k, m).catch(() => null)));
        const features: Feature[] = [];
        const size = 1 / per;
        const pad = 0.05;
        for (const t of tiles) {
            if (!t) continue;
            for (const c of t.cells || []) {
                const [li, lo, ceiling, ai] = c;
                const lat = li / per, lon = lo / per;
                const ap = airportName(t.airports?.[ai]);
                this.uasCells.set(`${li}_${lo}`, { ceiling, airport: ap });
                if (lat + size < v.s - pad || lat > v.n + pad || lon + size < v.w - pad || lon > v.e + pad) continue;
                const color = uasColor(ceiling);
                features.push({
                    type: 'Feature',
                    geometry: { type: 'Polygon', coordinates: [[[lon, lat], [lon + size, lat], [lon + size, lat + size], [lon, lat + size], [lon, lat]]] },
                    properties: { kind: 'uasfm', ceiling, airport: ap, color, label: String(ceiling) }
                });
            }
        }
        // Keep the cell index bounded.
        if (this.uasCells.size > 400_000) this.uasCells.clear();
        const text = `${features.length.toLocaleString('en-US')} grid cells in view` + (m.cycle ? ` · cycle ${m.cycle}` : '');
        return { fc: { type: 'FeatureCollection', features }, text };
    }

    updateHere(): void {
        if (!state.settings.layers.uasfm) {
            state.here = '';
            return;
        }
        const c = this.map.getCenter();
        const cell = this.uasCells.get(`${Math.floor(c.lat * 120)}_${Math.floor(c.lng * 120)}`);
        if (this.map.getZoom() < 9) {
            state.here = 'Zoom in to read the UAS ceiling at the map center';
        } else if (cell) {
            state.here = cell.ceiling <= 0
                ? `Map Center: UAS ceiling 0 — authorization required to fly at all (${cell.airport})`
                : `Map Center: UAS ceiling ${fmtH(cell.ceiling)} AGL without further authorization (${cell.airport})`;
        } else {
            state.here = 'Map Center: not on the UAS Facility Map — no LAANC grid here (check airspace class)';
        }
    }

    uasAt(lon: number, lat: number): { ceiling: number; airport: string } | undefined {
        return this.uasCells.get(`${Math.floor(lat * 120)}_${Math.floor(lon * 120)}`);
    }

    // ---- NSUFR ----

    private async loadNsufr(rem: Remember): Promise<{ fc: FeatureCollection; text: string }> {
        const m = await manifest('nsufr');
        const pack = await packFile<{ features: NsufrFeature[] }>('nsufr', 'nsufr', m);
        const features: Feature[] = [];
        for (const f of pack.features || []) {
            const geom = f.geometry?.rings ? esriRings(f.geometry.rings) : null;
            if (!geom) continue;
            const a = f.attributes || {};
            const color = f.status === 'part-time' ? COLORS.nsufrPart : f.status === 'pending' ? COLORS.nsufrPending : COLORS.nsufrFull;
            const facility = String(a.Facility || a.Base || 'Restricted facility');
            const rows: DetailRow[] = [{ label: 'Status', value: f.status }];
            for (const [k, val] of Object.entries(a)) {
                if (val === null || val === '' || k === 'OBJECTID' || k.startsWith('Shape')) continue;
                rows.push({ label: k.replace(/_/g, ' '), value: String(val) });
            }
            const id = rem({ title: facility, subtitle: 'National Security UAS Flight Restriction', color, rows });
            features.push({ type: 'Feature', geometry: geom, properties: { aaid: id, color, label: facility, name: facility } });
        }
        const text = `${features.length.toLocaleString('en-US')} restricted facilities nationally` + (m.cycle ? ` · cycle ${m.cycle}` : '');
        return { fc: { type: 'FeatureCollection', features }, text };
    }

    // ---- Obstacles ----

    private async loadObstacles(v: Box, rem: Remember): Promise<{ fc: FeatureCollection; text: string }> {
        const m = await manifest('obstacles');
        const keys = keysFor(m, v.s, v.w, v.n, v.e, 9);
        const tiles = await Promise.all(keys.map((k) => tile<{ obstacles: ObstacleRow[] }>('obstacles', k, m).catch(() => null)));
        const min = state.settings.obstacleMinFt;
        const types = new Set(state.settings.obstacleTypes);
        const features: Feature[] = [];
        let hidden = 0;
        for (const t of tiles) {
            for (const o of t?.obstacles || []) {
                const [oas, type, lat, lon, agl, , lighting] = o;
                this.obstacles.set(oas, o);
                if (lat < v.s || lat > v.n || lon < v.w || lon > v.e) continue;
                if (agl < min || (types.size && !types.has(type))) {
                    hidden++;
                    continue;
                }
                const id = rem(obstacleDetail(o));
                features.push({
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [lon, lat] },
                    properties: { aaid: id, color: COLORS.obstacle, label: `${agl}' AGL`, agl, lighting }
                });
                if (features.length >= 20_000) break;
            }
        }
        if (this.obstacles.size > 300_000) this.obstacles.clear();
        let text = `${features.length.toLocaleString('en-US')} obstacles ${fmtH(min)}+ in view`;
        if (hidden) text += ` · ${hidden.toLocaleString('en-US')} shorter or filtered`;
        if (features.length >= 20_000) text += ' · list trimmed, zoom in';
        return { fc: { type: 'FeatureCollection', features }, text };
    }

    // ---- METARs ----

    private async loadMetar(v: Box, rem: Remember): Promise<{ fc: FeatureCollection; text: string }> {
        // aviationweather.gov answers a bounded box; keep it centered on the view.
        const halfLat = Math.min(5, (v.n - v.s) / 2 + 0.2);
        const halfLon = Math.min(7, (v.e - v.w) / 2 + 0.2);
        const rows = await loadMetars(
            Math.max(-85, v.center[1] - halfLat), Math.max(-180, v.center[0] - halfLon),
            Math.min(85, v.center[1] + halfLat), Math.min(180, v.center[0] + halfLon)
        );
        const features: Feature[] = rows.filter((r) => typeof r.lat === 'number' && typeof r.lon === 'number').map((r) => {
            const color = metarColor(r.fltCat);
            return {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
                properties: { aaid: rem(metarDetail(r, color)), color, label: `${r.icaoId} ${r.fltCat || ''}`.trim() }
            };
        });
        return { fc: { type: 'FeatureCollection', features }, text: `${features.length} stations reporting` };
    }

    // ---- Clicks ----

    private click(e: MapMouseEvent): void {
        const pick = state.plan.picking;
        if (pick) {
            state.plan[pick] = { lon: e.lngLat.lng, lat: e.lngLat.lat };
            // Guided flow: after Home, go straight on to the target unless one is already set.
            if (pick === 'home' && !state.plan.target) {
                state.plan.picking = 'target';
            } else {
                state.plan.picking = false;
                this.map.getCanvas().style.cursor = '';
            }
            return;
        }
        const layers = CLICKABLE.filter((id) => this.map.getLayer(id) && this.map.getLayoutProperty(id, 'visibility') !== 'none');
        if (!layers.length) return;
        // Top-most first: a CoT marker drawn over the air picture owns the click.
        try {
            for (const f of this.map.queryRenderedFeatures(e.point)) {
                if (isCotPoint(f)) return;
                if (String(f.layer?.id || '').startsWith(`${PREFIX}-`)) break;
            }
        } catch {
            // Style mid-change: fall through to our own layers.
        }
        const hits = this.map.queryRenderedFeatures(e.point, { layers });
        const out: Detail[] = [];
        const seen = new Set<string>();
        for (const h of hits) {
            const p = h.properties || {};
            if (p.kind === 'uasfm') {
                const key = `uas:${p.ceiling}:${p.airport}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({
                    title: `UAS ceiling ${p.ceiling} ft AGL`,
                    subtitle: 'FAA UAS Facility Map',
                    color: String(p.color),
                    rows: [
                        { label: 'Ceiling', value: Number(p.ceiling) <= 0 ? '0 ft — no automatic authorization' : `${p.ceiling} ft AGL` },
                        { label: 'Airport', value: String(p.airport || '—') },
                        { label: 'Cell', value: `${e.lngLat.lat.toFixed(4)}, ${e.lngLat.lng.toFixed(4)}` }
                    ],
                    text: 'The highest altitude (ft AGL) LAANC can authorize automatically in this grid square. Above it, or where it is 0, you need a further FAA authorization.'
                });
                continue;
            }
            const id = String(p.aaid || '');
            if (!id || seen.has(id)) continue;
            seen.add(id);
            const d = this.lookup(id);
            if (d) out.push(d);
            if (out.length >= 12) break;
        }
        if (!out.length) return;
        state.details = out;
        this.onDetails();
    }

}

// ---- helpers ----

export const ICON_HOME = `${PREFIX}-helispot`;
export const ICON_TARGET = `${PREFIX}-hostile`;

function canvas(size: number): { ctx: CanvasRenderingContext2D; done: () => ImageData } | null {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    return { ctx, done: () => ctx.getImageData(0, 0, size, size) };
}

const ICONS: Record<string, () => ImageData | null> = {
    // ICS helispot: a bold H in a circle.
    [ICON_HOME]: () => {
        const k = canvas(64);
        if (!k) return null;
        const { ctx } = k;
        ctx.beginPath();
        ctx.arc(32, 32, 27, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 5;
        ctx.strokeStyle = '#000000';
        ctx.stroke();
        ctx.fillStyle = '#000000';
        ctx.fillRect(20, 17, 7, 30);
        ctx.fillRect(37, 17, 7, 30);
        ctx.fillRect(20, 29, 24, 6);
        return k.done();
    },
    // MIL-STD-2525 hostile frame: a red diamond.
    [ICON_TARGET]: () => {
        const k = canvas(64);
        if (!k) return null;
        const { ctx } = k;
        ctx.beginPath();
        ctx.moveTo(32, 4);
        ctx.lineTo(60, 32);
        ctx.lineTo(32, 60);
        ctx.lineTo(4, 32);
        ctx.closePath();
        ctx.fillStyle = '#ff8080';
        ctx.fill();
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#000000';
        ctx.stroke();
        return k.done();
    }
};

/** CloudTAK point CoTs: `{overlayId}`, `{overlayId}-icon|-course|-group|-text-point`. */
const COT_POINT_LAYER = /^-?\d+(?:-icon|-course|-group|-text-point)?$/;

function isCotPoint(f: { layer?: { id?: string; type?: string }; geometry?: { type?: string } | null }): boolean {
    const id = f.layer?.id ?? '';
    if (!COT_POINT_LAYER.test(id)) return false;
    if (/(?:-icon|-course|-group|-text-point)$/.test(id)) return true;
    // A bare overlay id is also used for raster layers. Only a point marker counts.
    return f.geometry?.type === 'Point' && (f.layer?.type === 'circle' || f.layer?.type === 'symbol');
}

/** A flight plan is up once both Home and the target are set. */
export function planActive(): boolean {
    return Boolean(state.plan.home && state.plan.target);
}

function notamColor(kind: string): string {
    switch (kind) {
        case 'airspace': return COLORS.notamAirspace;
        case 'obstacle': return COLORS.notamObstacle;
        case 'airfield': return COLORS.notamAirfield;
        case 'navigation': return COLORS.notamNavigation;
        default: return COLORS.notamOther;
    }
}

export function kindName(kind: string): string {
    switch (kind) {
        case 'airspace': return 'Airspace activity';
        case 'obstacle': return 'Obstacle';
        case 'airfield': return 'Airfield';
        case 'navigation': return 'Navigation / procedures';
        default: return 'Other';
    }
}

function classColor(a: Record<string, string | number | null>): string {
    const cls = String(a.CLASS_CODE || '').trim();
    switch (cls) {
        case 'A': return COLORS.classA;
        case 'B': return COLORS.classB;
        case 'C': return COLORS.classC;
        case 'D': return COLORS.classD;
        case 'E': {
            const floor = Number(a.DISTVERTLOWER_VAL || 0);
            const agl = String(a.DISTVERTLOWER_CODE || '') === 'SFC' && String(a.DISTVERTLOWER_UOM || 'FT') === 'FT';
            return agl && floor >= 1200 ? COLORS.classE1200 : COLORS.classE;
        }
        default: return COLORS.classOther;
    }
}

function suaColor(type: string): string {
    switch (type) {
        case 'P': return COLORS.prohibited;
        case 'R': return COLORS.restricted;
        case 'W': return COLORS.warning;
        case 'A': return COLORS.alert;
        case 'MOA': return COLORS.moa;
        default: return COLORS.classOther;
    }
}

function workHours(code: string): string {
    if (code === 'H24') return 'Continuous';
    if (code === 'NOTAM') return 'Activated by NOTAM';
    if (code === 'RMK' || !code) return 'See remarks / chart (may be activated by NOTAM)';
    return code;
}

function esriVert(a: Record<string, string | number | null>, which: 'LOWER' | 'UPPER'): { text: string; short: string; ft: number } {
    const val = a[`DISTVERT${which}_VAL`];
    const uom = String(a[`DISTVERT${which}_UOM`] || 'FT');
    const code = String(a[`DISTVERT${which}_CODE`] || '');
    const n = Number(val ?? 0);
    if (uom === 'FL') return { text: `FL${n}`, short: `FL${n}`, ft: n * 100 };
    const ft = uom === 'M' ? n / M_PER_FT : n;
    if (which === 'LOWER' && n === 0 && (code === 'SFC' || !code)) return { text: 'Surface', short: 'SFC', ft: 0 };
    if (which === 'UPPER' && (n === -9998 || code === 'UNL')) return { text: 'Unlimited', short: 'UNL', ft: 60000 };
    const ref = code === 'SFC' ? 'AGL' : 'MSL';
    return { text: `${Math.round(ft).toLocaleString('en-US')} ft ${ref}`, short: String(Math.round(ft / 100)), ft };
}

export function airportName(s: string | undefined): string {
    if (!s) return '—';
    const [id, name] = s.split('|');
    return name ? `${id} ${name}` : id;
}

export function obstacleDetail(o: ObstacleRow): Detail {
    const [oas, type, lat, lon, agl, , lighting, verified, quantity, city, st] = o;
    return {
        title: `${type} ${agl} ft AGL`,
        subtitle: [city, st].filter(Boolean).join(', '),
        color: COLORS.obstacle,
        rows: [
            { label: 'Height', value: `${agl.toLocaleString('en-US')} ft AGL` },
            { label: 'Lighting', value: lightingName(lighting) },
            { label: 'Verified', value: verified === 'O' ? 'Verified' : verified === 'U' ? 'Unverified' : verified },
            { label: 'Quantity', value: String(quantity) },
            { label: 'Position', value: `${lat.toFixed(5)}, ${lon.toFixed(5)}` },
            { label: 'OAS number', value: oas }
        ]
    };
}

export function lightingName(code: string): string {
    switch (code) {
        case 'R': return 'Red';
        case 'D': return 'Medium intensity white strobe + red';
        case 'H': return 'High intensity white strobe';
        case 'M': return 'Medium intensity white strobe';
        case 'S': return 'High intensity white strobe + red';
        case 'F': return 'Flood';
        case 'C': return 'Dual medium catenary';
        case 'W': return 'Synchronized red (wind turbine)';
        case 'L': return 'Lighted (type unknown)';
        case 'N': return 'None';
        case 'U': return 'Unknown';
        default: return code || 'Unknown';
    }
}

function metarColor(cat: string | undefined): string {
    switch ((cat || '').toUpperCase()) {
        case 'VFR': return COLORS.vfr;
        case 'MVFR': return COLORS.mvfr;
        case 'IFR': return COLORS.ifr;
        case 'LIFR': return COLORS.lifr;
        default: return COLORS.unknown;
    }
}

function metarDetail(r: MetarRow, color: string): Detail {
    const clouds = (r.clouds || []).map((c) => c.base !== null && c.base !== undefined ? `${c.cover} ${c.base}` : c.cover).join(', ') || r.cover || '—';
    const wind = r.wspd === undefined ? '—'
        : `${r.wdir ?? 'VRB'}° ${r.wspd} kt${r.wgst ? ` gusting ${r.wgst}` : ''}`;
    return {
        title: `${r.icaoId} · ${r.fltCat || 'no category'}`,
        subtitle: r.name,
        color,
        rows: [
            { label: 'Category', value: r.fltCat || 'Not published' },
            { label: 'Observed', value: fmtTime(r.reportTime) },
            { label: 'Wind', value: wind },
            { label: 'Visibility', value: r.visib !== undefined ? `${r.visib} SM` : '—' },
            { label: 'Clouds', value: clouds },
            { label: 'Temp / Dew', value: r.temp !== undefined ? `${r.temp}°C / ${r.dewp ?? '—'}°C` : '—' },
            { label: 'Altimeter', value: r.altim !== undefined ? `${(r.altim * 0.02953).toFixed(2)} inHg` : '—' }
        ],
        text: r.rawOb
    };
}

export type { Manifest };
