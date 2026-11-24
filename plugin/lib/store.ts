import { reactive, watch } from 'vue';
import type { LayerKey } from './constants.ts';
import type { Units } from './units.ts';

const STORAGE_KEY = 'air-aware-settings-v2';

export interface Settings {
    layers: Record<LayerKey, boolean>;
    /** Obstacles shorter than this (ft AGL) are not drawn. */
    obstacleMinFt: number;
    /** Obstacle types that are drawn and listed; empty means every type. */
    obstacleTypes: string[];
    /** Draw TFRs and airspace as 3D volumes rather than flat outlines. */
    volumes: boolean;
    /** Hide TFRs that are scheduled but not yet in effect. */
    activeTfrOnly: boolean;
    /** Planner: required vertical separation from obstacles, ft. */
    separationFt: number;
    /** Planner: operating range, max distance from Home, ft. */
    radiusFt: number;
    /** Planner: distance held from the target, ft (0 = overhead). */
    standoffFt: number;
    /** Planner: half-width of the transit corridor, ft. */
    corridorFt: number;
    /** Planner: cruise speed, mph. */
    cruiseMph: number;
    /** Planner: flight endurance per battery, minutes. */
    enduranceMin: number;
    /** Display units. */
    units: Units;
}

export const DEFAULT_SETTINGS: Settings = {
    layers: {
        tfr: false,
        notams: false,
        airspace: false,
        sua: false,
        uasfm: false,
        nsufr: false,
        obstacles: false,
        metars: false,
        sfra: false
    },
    obstacleMinFt: 200,
    obstacleTypes: [],
    volumes: false,
    activeTfrOnly: false,
    separationFt: 100,
    radiusFt: 2640,
    standoffFt: 500,
    corridorFt: 250,
    cruiseMph: 25,
    enduranceMin: 25,
    units: 'imperial'
};

function load(): Settings {
    const base: Settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as Settings;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return base;
        const saved = JSON.parse(raw) as Partial<Settings>;
        return {
            ...base,
            ...saved,
            layers: { ...base.layers, ...(saved.layers || {}) }
        };
    } catch {
        return base;
    }
}

export type LayerStatus = {
    /** Words for the status line. */
    text: string;
    loading: boolean;
    error?: string;
    count?: number;
    updated?: string;
};

export interface DetailRow {
    label: string;
    value: string;
    href?: string;
}

export interface Detail {
    title: string;
    subtitle?: string;
    color?: string;
    rows: DetailRow[];
    text?: string;
}

export interface PlanObstacle {
    oas: string;
    type: string;
    lat: number;
    lon: number;
    aglFt: number;
    amslFt: number;
    /** Top of the obstacle relative to the takeoff point, when terrain is known. */
    topAboveTakeoffFt?: number;
    lighting: string;
    distanceFt: number;
    bearing: number;
}

export interface PlanUasCell {
    ceilingFt: number;
    airport: string;
}

export interface PlanResult {
    computedAt: string;
    terrain: 'map' | 'none';
    /** Where the ground elevation came from. */
    terrainSource?: string;
    /** Ground at Home, ft MSL (internal reference only). */
    homeGroundFt?: number;
    /** Ground at the target relative to Home, ft. */
    targetRelFt?: number;
    /** Highest / lowest ground in the flight area relative to Home, ft (+ above, - below). */
    riseFt?: number;
    dropFt?: number;
    samples: number;

    /** Home to target, ft, and the bearing from Home. */
    targetDistanceFt: number;
    targetBearing: number;
    /** Home to the standoff point, ft. */
    standoffDistanceFt: number;
    /** Furthest point of the flight area from Home, ft. */
    maxReachFt: number;
    /** Line of sight from the standoff point at altitude to the target, ft. */
    slantRangeFt?: number;
    /** Camera angle below level to see the target from the standoff point, degrees. */
    gimbalDeg?: number;
    /** One-way transit, minutes, and time on station after a 20% reserve. */
    transitMin?: number;
    onStationMin?: number;

    /** Altitude needed to clear the highest obstacle top plus separation, ft above Home. */
    obstacleNeedAgl?: number;
    /** Legal ceiling: the lower of 400 ft and the lowest grid over the flight area. */
    maxAltitudeAgl?: number;
    /** The most the plan may use: the legal ceiling, or higher only as far as an obstacle needs (no grid below 400 ft). */
    allowedMaxAgl?: number;
    /** What took the plan above the legal maximum, if anything. */
    raisedBy?: 'obstacle';
    /** The ceiling rule that set maxAltitudeAgl (400 ft or a grid value). */
    capFt: number;
    /** The altitude the plan uses, ft above Home. */
    altitudeAgl?: number;
    /** A Set My Own value was lowered to the legal maximum. */
    clamped?: boolean;

    /** UAS Facility Map cells overlapping the area, lowest first. */
    uasCells: PlanUasCell[];
    uasCeilingUsedFt?: number;
    obstacles: PlanObstacle[];
    obstaclesAbove: number;
    tfrs: string[];
    nsufr: string[];
    airspace: string[];
    sua: string[];
    notams: string[];
    warnings: string[];
}

export type Pick = 'home' | 'target' | false;

export interface PlanState {
    picking: Pick;
    home?: { lon: number; lat: number };
    target?: { lon: number; lat: number };
    mode: 'need' | 'given';
    /** Set My Own: altitude entered, ft above Home. */
    givenAltitudeAgl?: number;
    computing: boolean;
    result?: PlanResult;
}

export const state = reactive({
    settings: load(),
    status: {
        tfr: { text: 'Off', loading: false },
        notams: { text: 'Off', loading: false },
        airspace: { text: 'Off', loading: false },
        sua: { text: 'Off', loading: false },
        uasfm: { text: 'Off', loading: false },
        nsufr: { text: 'Off', loading: false },
        obstacles: { text: 'Off', loading: false },
        metars: { text: 'Off', loading: false },
        sfra: { text: 'Off', loading: false }
    } as Record<LayerKey, LayerStatus>,
    /** The pinned line: the UAS ceiling at the map center. */
    here: '' as string,
    details: [] as Detail[],
    plan: {
        picking: false,
        mode: 'need',
        computing: false
    } as PlanState,
    /** Bumped when a layer needs a reload (settings changed, manual refresh). */
    revision: 0
});

let watching = false;

export function persistSettings(): void {
    if (watching) return;
    watching = true;
    watch(() => state.settings, (s) => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
        } catch {
            // Private mode or blocked storage: the settings live for this session only.
        }
    }, { deep: true });
}
