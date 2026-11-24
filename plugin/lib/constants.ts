export const DEST = 'air-aware';
export const ROUTE_PATH = 'plugin-air-aware';
export const ROUTE_NAME = 'home-menu-plugin-air-aware';
export const MENU_KEY = 'air-aware';
export const FLOAT_UID = 'air-aware-details';
export const PREFIX = 'air-aware';
export const API = '/api/plugin/air-aware';

export type LayerKey = 'tfr' | 'notams' | 'airspace' | 'sua' | 'uasfm' | 'nsufr' | 'obstacles' | 'metars' | 'sfra';

export const LAYERS: Array<{ key: LayerKey; label: string; description: string; minZoom: number }> = [
    { key: 'tfr', label: 'TFR', description: 'FAA Temporary Flight Restrictions: red in effect, amber scheduled', minZoom: 0 },
    { key: 'notams', label: 'NOTAMs', description: 'Drone ops, parachute drops, unlit towers, cranes, closed runways', minZoom: 7 },
    { key: 'airspace', label: 'Airspace', description: 'Class A to E, one shelf per published step, sectional colors', minZoom: 6 },
    { key: 'sua', label: 'Special Use', description: 'Prohibited, Restricted, Warning, Alert areas and MOAs', minZoom: 5 },
    { key: 'uasfm', label: 'UAS Ceilings', description: 'FAA UAS Facility Map: max altitude without further authorization', minZoom: 9 },
    { key: 'nsufr', label: 'UAS No-Fly', description: 'National Security UAS Flight Restrictions, surface to 400 ft AGL', minZoom: 0 },
    { key: 'obstacles', label: 'Obstacles', description: 'FAA Digital Obstacle File: towers, wires, turbines, stacks', minZoom: 9 },
    { key: 'metars', label: 'METARs', description: 'Flight category: VFR green, MVFR blue, IFR red, LIFR magenta', minZoom: 6 },
    { key: 'sfra', label: 'Special Flight Rules Airspace', description: 'SFRAs and special air traffic rules areas (DC, Grand Canyon, NY Hudson corridor), sectional blue', minZoom: 5 }
];

export const COLORS = {
    tfrActive: '#e01b24',
    tfrScheduled: '#ffb300',
    classA: '#78909c',
    classB: '#1565c0',
    classC: '#b5126a',
    classD: '#42a5f5',
    classE: '#e05297',
    classE1200: '#5c86c8',
    classOther: '#9e9e9e',
    sfra: '#2c5aa0',
    prohibited: '#d32f2f',
    restricted: '#f4511e',
    warning: '#fb8c00',
    alert: '#ffb300',
    moa: '#8e24aa',
    nsufrFull: '#d32f2f',
    nsufrPart: '#ef6c00',
    nsufrPending: '#9e9e9e',
    obstacle: '#ffb300',
    vfr: '#3ddc61',
    mvfr: '#2196f3',
    ifr: '#e01b24',
    lifr: '#d500f9',
    unknown: '#9e9e9e',
    notamAirspace: '#ff6d00',
    notamObstacle: '#ffb300',
    notamAirfield: '#4fc3f7',
    notamNavigation: '#b0bec5',
    notamOther: '#9e9e9e',
    plan: '#00bcd4',
    target: '#ff5252',
    island: '#e01b24'
};

export function uasColor(ceilingFt: number): string {
    if (ceilingFt <= 0) return '#d32f2f';
    if (ceilingFt <= 100) return '#f4511e';
    if (ceilingFt <= 200) return '#ffb300';
    if (ceilingFt <= 300) return '#c0ca33';
    return '#43a047';
}

export const LINKS = {
    tfrDetail: 'https://tfr.faa.gov/tfr3/?page=detail_',
    uasData: 'https://www.faa.gov/uas/programs_partnerships/data_exchange'
};
