// utils/evRouting.ts
// -----------------------------------------------------------------------------
// Shared utilities for EV‐routing logic: distance calculation, branch proximity,
// and best-branch selection.  Designed for **TypeScript** in a Next.js project.
// -----------------------------------------------------------------------------

import { Readable } from "stream";
import csvParser from "csv-parser";
import polyline from "@mapbox/polyline";

/* -------------------------------------------------------------------------- */
/*  SHARED TYPES & HELPERS                                                    */
/* -------------------------------------------------------------------------- */

type Point = { lat: number; lng: number };

/** Convert a CSV cell that looks like "['A','B']" into string[]. */
function parseStringArray(cell: string | undefined): string[] {
  if (!cell) return [];
  try {
    return JSON.parse(cell.replace(/'/g, '"')) as string[];
  } catch {
    return [];
  }
}

/** Format a Date (or ISO string) as YYYY-MM-DD (local timezone). */
function toLocalDate(date: string | Date): string {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Read a CSV (accessible via URL) into an array of typed rows. */
async function readCsv<T>(url: string): Promise<T[]> {
  // 1) Fetch CSV text from the public/data folder
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();

  // 2) Convert text into a Readable stream, then pipe into csv-parser
  const rows: T[] = [];
  const textStream = Readable.from([text]);

  await new Promise<void>((resolve, reject) => {
    textStream
      .pipe(csvParser())
      .on("data", (row) => {
        rows.push(row as T);
      })
      .on("end", () => {
        resolve();
      })
      .on("error", (err) => {
        reject(err);
      });
  });

  return rows;
}

/* -------------------------------------------------------------------------- */
/*  1. DISTANCE FORMULA                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Haversine distance (metres) between two lat/lng points.
 */
export function getDistance(p1: Point, p2: Point): number {
  const R = 6_371_000; // Earth radius (metres)
  const φ1 = (p1.lat * Math.PI) / 180;
  const φ2 = (p2.lat * Math.PI) / 180;
  const Δφ = ((p2.lat - p1.lat) * Math.PI) / 180;
  const Δλ = ((p2.lng - p1.lng) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/* -------------------------------------------------------------------------- */
/*  2. FIND NEARBY BRANCHES ALONG A POLYLINE                                  */
/* -------------------------------------------------------------------------- */

interface BranchRow {
  Name: string;
  Lat: string;
  Lng: string;
  cars?: string; // optional here – only needed by the caller that filters EVs
}

export interface NearbyBranchResult {
  Name: string;
  distanceToRoute_meters: number;
  minDistanceLocation: Point;
}

/**
 * Get all branches whose lateral distance to the encoded route does not exceed
 * `DISTANCE_THRESHOLD` (metres), and whose along‐route distance from the
 * starting point is at most the total route length (start→end).
 *
 * NOTE: `branches` must already be loaded (via readCsv) before calling this.
 */
export async function findNearbyBranchesFromPolyline(
  DISTANCE_THRESHOLD: number,
  encoded: string,
  branches: BranchRow[]
): Promise<NearbyBranchResult[]> {
  // 1. Decode polyline → array of points
  const decoded: Point[] = polyline
    .decode(encoded)
    .map(([lat, lng]) => ({ lat, lng }));

  if (decoded.length < 2) {
    return [];
  }

  // 2. Determine start and end points
  const startPoint: Point = decoded[0];
  const endPoint: Point = decoded[decoded.length - 1];
  const distStartToEnd: number = getDistance(startPoint, endPoint);

  // 3. Evaluate each branch
  return branches
    .map((branch) => {
      const coords: Point = {
        lat: parseFloat(branch.Lat),
        lng: parseFloat(branch.Lng),
      };
      if (Number.isNaN(coords.lat) || Number.isNaN(coords.lng)) {
        return null;
      }

      // 3a. Compute along-route distance (start → branch)
      const distStartToBranch = getDistance(startPoint, coords);
      // If “beyond” the end of route, skip
      if (distStartToBranch > distStartToEnd * 0.6) {
        return null;
      }

      // 3b. Compute lateral (minimum) distance from the route
      let minDist = Infinity;
      let minLoc: Point | null = null;
      for (const pt of decoded) {
        const d = getDistance(pt, coords);
        if (d < minDist) {
          minDist = d;
          minLoc = pt;
        }
      }

      // 3c. If lateral distance exceeds threshold, skip
      if (minDist > DISTANCE_THRESHOLD) {
        return null;
      }

      return {
        Name: branch.Name,
        distanceToRoute_meters: minDist,
        minDistanceLocation: minLoc!,
      } satisfies NearbyBranchResult;
    })
    .filter((x): x is NearbyBranchResult => x !== null);
}

/* -------------------------------------------------------------------------- */
/*  3. PICK BEST BRANCH WITH AVAILABLE HIGH-RANGE EV                          */
/* -------------------------------------------------------------------------- */

interface CarRow {
  id: string;
  type: string;
  range_km: string;
  trips_ids: string;
}

interface TripRow {
  car_id: string;
  departure_time?: string;
  arrival_time?: string;
}

export interface BestBranchResult extends NearbyBranchResult {
  branch: string; // same as Name, kept for clarity
  lat: number;
  lng: number;
  ev_id: string;
  distanceToMinLocation_meters: number;
  distanceRatio: number;
}

/**
 * Locate the *best* branch along the user’s route that has an *available* EV
 * whose range exceeds `RANGE_THRESHOLD` (km).
 */
export async function getBestBranchWithAvailableEV(
  DISTANCE_THRESHOLD: number,
  RANGE_THRESHOLD: number,
  TIME: Date | string,
  encoded: string
): Promise<BestBranchResult | null> {
  /* ------------------------------------------------------------------------ */
  /*  1. Load CSVs in parallel                                                */
  /* ------------------------------------------------------------------------ */
  const baseURL =
    process.env.NEXT_PUBLIC_SITE_URL ||
    "https://hackathon-next-rosy.vercel.app";

  const [branches, cars, trips] = await Promise.all([
    readCsv<BranchRow>(
      `${baseURL}/data/branch_vehicle_allocation_with_cars.csv`
    ),
    readCsv<CarRow>(`${baseURL}/data/cars.csv`),
    readCsv<TripRow>(`${baseURL}/data/trips.csv`),
  ]);

  /* ------------------------------------------------------------------------ */
  /*  2. Nearby branches w/ distance metrics (using updated findNearby...)   */
  /* ------------------------------------------------------------------------ */
  const nearbyBranches = await findNearbyBranchesFromPolyline(
    DISTANCE_THRESHOLD,
    encoded,
    branches
  );
  const nearbyMap = new Map(nearbyBranches.map((b) => [b.Name, b]));

  /* ------------------------------------------------------------------------ */
  /*  3. Filter branches that have EVs                                        */
  /* ------------------------------------------------------------------------ */
  const branchesWithEVs = branches
    .filter((branch) => {
      // parseStringArray returns an array of car IDs like ["E123", "G456", ...]
      const carIds = parseStringArray(branch.cars);
      const hasEv = carIds.some((id) => id.trim().startsWith("E"));
      return nearbyMap.has(branch.Name) && hasEv;
    })
    .map((branch) => {
      const nearbyInfo = nearbyMap.get(branch.Name)!;
      return {
        branch: branch.Name,
        lat: parseFloat(branch.Lat),
        lng: parseFloat(branch.Lng),
        distanceToRoute_meters: nearbyInfo.distanceToRoute_meters,
        minDistanceLocation: nearbyInfo.minDistanceLocation,
        electric_car_ids: parseStringArray(branch.cars).filter((id) =>
          id.trim().startsWith("E")
        ),
      };
    });

  /* ------------------------------------------------------------------------ */
  /*  4. Index EVs that meet range requirement                                */
  /* ------------------------------------------------------------------------ */
  const highRangeEvMap = new Map<string, CarRow & { trips: string[] }>();
  cars.forEach((car) => {
    if (car.type === "electric" && parseFloat(car.range_km) > RANGE_THRESHOLD) {
      highRangeEvMap.set(car.id.trim(), {
        ...car,
        trips: parseStringArray(car.trips_ids),
      });
    }
  });

  /* ------------------------------------------------------------------------ */
  /*  5. Build candidate list (branch × EV)                                   */
  /* ------------------------------------------------------------------------ */
  const candidates: {
    branch: string;
    lat: number;
    lng: number;
    distanceToRoute_meters: number;
    minDistanceLocation: Point;
    ev_id: string;
    trip_ids: string[];
  }[] = [];

  branchesWithEVs.forEach((b) => {
    b.electric_car_ids.forEach((ev) => {
      const car = highRangeEvMap.get(ev.trim());
      if (car) {
        candidates.push({
          branch: b.branch,
          lat: b.lat,
          lng: b.lng,
          distanceToRoute_meters: b.distanceToRoute_meters,
          minDistanceLocation: b.minDistanceLocation,
          ev_id: ev.trim(),
          trip_ids: car.trips,
        });
      }
    });
  });

  /* ------------------------------------------------------------------------ */
  /*  6. Remove candidates booked on the specified date                       */
  /* ------------------------------------------------------------------------ */
  const bookedMap = new Map<string, string[]>();
  trips.forEach((trip) => {
    const id = trip.car_id?.trim();
    const timeStr = trip.departure_time?.trim() || trip.arrival_time?.trim();
    if (!id || !timeStr || Number.isNaN(Date.parse(timeStr))) return;
    const d = toLocalDate(timeStr);
    if (!bookedMap.has(id)) bookedMap.set(id, []);
    bookedMap.get(id)!.push(d);
  });

  const desiredDate = toLocalDate(TIME);
  const freeCandidates = candidates.filter(
    (c) => !(bookedMap.get(c.ev_id) || []).includes(desiredDate)
  );
  if (freeCandidates.length === 0) return null;

  /* ------------------------------------------------------------------------ */
  /*  7. Score and pick the best                                              */
  /* ------------------------------------------------------------------------ */
  const scored = freeCandidates.map((c) => {
    const distToMin = getDistance(
      { lat: c.lat, lng: c.lng },
      c.minDistanceLocation
    );
    return {
      ...c,
      distanceToMinLocation_meters: distToMin,
      distanceRatio: c.distanceToRoute_meters / distToMin,
    } as unknown as BestBranchResult;
  });

  return scored.reduce((best, cur) =>
    cur.distanceRatio < best.distanceRatio ? cur : best
  );
}
