# Air Aware

A CloudTAK plugin for crews working under or in the air. It answers two questions: what is in the column of air I am in, and what am I allowed to do here. It is a port of the takwerx [AirAware ATAK plugin](https://github.com/takwerx/air-aware). It reads the same published data packs and FAA feeds, draws them on CloudTAK's map, and adds a UAS flight planner.

**Minimum CloudTAK: v13.124.0**. Built and verified against CloudTAK v13.124.0 (commit 5cb43c9, 2026-11-20). There is no upper limit, and newer CloudTAK versions are expected to work. Please report breakage as an issue.

## What it does

Nine layers, each switched on or off on its own:

| Layer | What you see | Source |
|---|---|---|
| **TFR** | FAA Temporary Flight Restrictions. Red when in effect, amber when scheduled. Optionally drawn as 3D volumes from floor to ceiling. | tfr.faa.gov list and XNOTAM detail documents |
| **NOTAMs** | Drone operations, parachute drops, unlit towers, cranes, closed runways. Colored by kind, with the FAA text as issued. Zoom 7+. | FAA NOTAM Management Service, via the takwerx relay (republished every few minutes) |
| **Airspace** | Class A–E. Each published shelf is drawn separately, in sectional colors (B/D blue, C/E magenta, Class E from 1,200 ft AGL blue). Zoom 6+. | FAA AIS airspace, takwerx pack |
| **Special Use** | Prohibited, Restricted, Warning and Alert areas, and MOAs, with hours (continuous or activated by NOTAM). Zoom 5+. | FAA AIS airspace, takwerx pack |
| **UAS Ceilings** | The FAA UAS Facility Map grid, colored from 0 ft (red) to 400 ft (green). A pinned line states the ceiling at the map center. Zoom 9+. | FAA UASFM, takwerx pack |
| **UAS No-Fly** | National Security UAS Flight Restrictions: bases, labs, dams and nuclear sites, surface to 400 ft AGL. The details include the FAA point of contact. | FAA NSUFR, takwerx pack |
| **Obstacles** | Digital Obstacle File towers, wires, turbines and stacks, labelled with height AGL and top MSL. You can filter by height and type. Zoom 9+. | FAA DOF, takwerx pack |
| **METARs** | Flight-category dots: VFR green, MVFR blue, IFR red, LIFR magenta, as published (never derived). Zoom 6+. | aviationweather.gov |
| **Special Flight Rules Airspace** | SFRAs and special air traffic rules areas (Washington DC, Grand Canyon, New York Hudson/East River corridor, Luke AFB, Niagara Falls, Alaska and Florida terminal areas). Wide-dashed sectional blue with blue labels. Zoom 5+. | FAA AIS airspace (type SATA), via the server route |

Clicking anything on the map opens its details in a floating pane. A CoT marker drawn on top takes the click instead.

**UAS Flight Planner** tab. It walks you through the plan one step at a time, and everything recalculates as you change it. Every height is in ft above Home, the way the drone's altimeter reads it:
1. **Home / Takeoff Point**: click the map. The step disappears once Home is set.
2. **Target / Area Of Interest**: click the map, or use **Set Home As Target** to work over the takeoff point. The step disappears once the target is set; **Clear Plan** starts over.
3. **Mission**: max distance from operator (¼, ½, ¾, 1, 1½ mi or custom), target standoff distance (overhead, 250 ft, 500 ft, 1000 ft, ¼ mi or custom) and corridor buffer each side of the track (100, 250, 500, 1000 ft or custom). The flight area is the buffered corridor from Home to the standoff point plus a ring around the target. Shows the target's distance and bearing, the gimbal angle and slant range from the standoff point at your altitude, the furthest point from Home (warns past your range), transit time and time on station from cruise speed and battery endurance (20% reserve).
4. **Altitude**: **Recommend** uses the legal ceiling: the lower of 400 ft and the lowest UAS grid ceiling overlapping the flight area (a 100 ft and a 200 ft cell means 100 ft). **Set My Own** is lowered to that ceiling. A grid below 400 ft is never exceeded; where there is none, a taller obstacle (top plus your clearance) can raise the ceiling above 400 ft, only as far as it needs. Terrain does not change the altitude.
5. **Flight Area Check**: UAS grid cells are drawn across the whole range; everything else only where it overlaps the flight area: UAS grid cells, obstacles (flagged when they reach your altitude plus clearance), TFRs, UAS No-Fly areas, airspace (Class A left out), special use airspace and NOTAMs.

Home is drawn as an ICS helispot (H in a circle) and the target as a hostile diamond. **Clear Plan** is at the bottom of the planner and in the Air Aware header while a plan is up.

While a plan is up, the map shows only the hazards that overlap the flight area, whatever the Layers switches say. Clear the plan to browse the layers again.

Distances in miles also show feet (for example 0.62 mi / 3,274 ft). **Settings → Units** switches the panel between Imperial (default) and Metric (km / m, m, km/h). Published records in the details pane (TFR and airspace limits, obstacle heights) stay in the feet they were published in.

Settings (layers, obstacle filters, planner numbers) are stored per browser.

## How to use

1. Open the CloudTAK main menu and choose **Air Aware**.
2. In **Layers**, switch on what you need. Each layer's status line says what it is showing and what it is *not* showing (for example, zoom gates or unreachable sources). A quiet map is not an empty sky.
3. Click a feature to read its details.
4. The planner reads ground elevation from CloudTAK's terrain (for obstacle tops relative to Home, the gimbal angle and the terrain readout), with 3D terrain on or off. It tries the terrain (raster-dem) overlay on the map first, then the server's **Default Terrain** (Admin → Config → Map, for example as set by the Terrain Data Downloader plugin), then MapLibre's 3D terrain. Where none of these has data, it says so.

### Differences from the ATAK plugin

- No offline tile store. CloudTAK's API server caches the data in memory instead (manifests for hours, NOTAMs for 3 minutes, TFRs for 5 minutes, METARs for 5 minutes).
- The planner uses a Home-to-target corridor and target ring and works in ft above Home. Drawn-polygon plan areas, "make a geofence from a restriction", and the LAANC / DroneZone / Flight Service links are not included.
- Terrain comes from CloudTAK's terrain (DEM overlay or the server's Default Terrain), not ATAK's elevation data.
- 3D volumes start at the map's ground plane and are not corrected for terrain. Read the published numbers on the details page.

## TAK Portal Marketplace

### Configuration required

1. **API image rebuild**: the plugin ships a server route (`server/plugin-air-aware.ts` → `api/stateless/routes/`). TAK Portal installs it through the catalog `routes` field, and CloudTAK's API image must be rebuilt for it to load. The route is the only part of CloudTAK that contacts the outside sources, so **no CSP change and no Plugin Proxy whitelist is needed**.
2. **Outbound HTTPS from the CloudTAK API container** must be able to reach:
   - `https://mapdepot.takwerx.org` (airspace, obstacle, UAS Facility Map, NSUFR and NOTAM packs)
   - `https://tfr.faa.gov` (TFR list and details)
   - `https://services6.arcgis.com` (FAA AIS Special Flight Rules Airspace)
   - `https://aviationweather.gov` (METARs)

   No action is needed if the server already has normal internet egress.
3. After install: **Settings → Refresh App** in CloudTAK (a normal browser refresh is not enough).

For the planner's ground readouts, CloudTAK needs terrain data: either a **Default Terrain** set under Admin → Config → Map (for example by the Terrain Data Downloader plugin), or a terrain overlay that users add themselves. Without one, the planner still sets the altitude from the grid but cannot place obstacle tops relative to Home.

### Catalog entry
```json
{
  "id": "air-aware",
  "name": "Air Aware",
  "description": "TFRs, NOTAMs, airspace, UAS ceilings, UAS no-fly zones, obstacles, METARs and a UAS flight planner.",
  "repo": "https://github.com/ValleyTacticalSolutions/cloudtak-plugin-air-aware.git",
  "ref": "main",
  "added": "2026-11-20",
  "maintainer": "ValleyTacticalSolutions",
  "web": { "source": "plugin", "dest": "air-aware" },
  "routes": { "source": "server" },
  "exclude": ["test", "docs", "**/*.md"],
  "detect": ["api/web/plugins/air-aware/index.ts", "app/plugins/air-aware/index.ts"],
  "additionalActions": [
    {
      "title": "Allow outbound HTTPS from the CloudTAK API",
      "text": "Air Aware's server route fetches public FAA and takwerx data from the API container.",
      "instructions": [
        "Make sure the CloudTAK API container can reach mapdepot.takwerx.org, tfr.faa.gov and aviationweather.gov over HTTPS.",
        "No CSP or Plugin Proxy changes are needed: the browser only talks to CloudTAK's own /api/plugin/air-aware routes.",
        "After install, have users run Settings -> Refresh App in CloudTAK."
      ],
      "snippet": "curl -sI https://mapdepot.takwerx.org/airaware/nsufr/nsufr.json https://tfr.faa.gov/tfrapi/exportTfrList https://aviationweather.gov/api/data/metar?ids=KDEN"
    }
  ]
}
```
<!-- Requires CloudTAK v13.124.0 or newer (catalog has no version field; this note is for reviewers). -->

To list it: submit the repo URL through TAK Portal's CloudTAK Marketplace plugin request form, or open an issue/PR on ValleyTacticalSolutions/TAK-Portal adding the entry to `catalog/cloudtak-plugins.json`.

## Manual install (without TAK Portal)

```bash
CT=/path/to/CloudTAK
mkdir -p "$CT/app/plugins/air-aware"
cp -a plugin/. "$CT/app/plugins/air-aware/"
cp server/plugin-air-aware.ts "$CT/api/stateless/routes/"
```
Then rebuild the CloudTAK API image, and run **Settings → Refresh App** in CloudTAK.

## Server routes

All routes require a signed-in CloudTAK user. None of them accepts a URL from the client: every upstream address is built from validated path segments.

| Route | Upstream |
|---|---|
| `GET /api/plugin/air-aware/pack/:pack/manifest` | `mapdepot.takwerx.org/airaware/<pack>/<pack>.json` |
| `GET /api/plugin/air-aware/pack/:pack/tile/:key` | `…/<pack>/tiles/<lat>_<lon>.json.gz` (unpacked server-side) |
| `GET /api/plugin/air-aware/pack/:pack/file/:file` | `…/airspace/wide.json.gz`, `…/nsufr/nsufr.json.gz` |
| `GET /api/plugin/air-aware/tfr` | `tfr.faa.gov/tfrapi/exportTfrList` |
| `GET /api/plugin/air-aware/tfr/:id` | `tfr.faa.gov/download/detail_<id>.xml` |
| `GET /api/plugin/air-aware/metar?south&west&north&east` | `aviationweather.gov/api/data/metar` |

## Core imports

- `../../src/components/CloudTAK/util/MenuTemplate.vue` (sidebar page frame)
- `../../../src/std.ts` (`std`, authenticated calls to CloudTAK's API)
- Server: `../../common/auth.js`, `../config.js`

## Development

The plugin is compiled inside CloudTAK. To check it against the latest CloudTAK `main` (ESLint, `vue-tsc`, Vite build, API oxlint and `tsc`):

```bash
bash verify-cloudtak.sh . air-aware
```

## License

AGPL-3.0-or-later, the same license as the AirAware ATAK plugin it is ported from. The data packs are published by takwerx, and the underlying data is from the FAA and aviationweather.gov.
