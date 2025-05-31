// components/functions/merging/merge_trip.ts

import path from "path";
import { readFile } from "fs/promises";
import polyline from "@mapbox/polyline";

// Import the shared helper for calling Google’s computeRoutes API
import {
  getDriveRoute,
  LatLng,
  DriveRouteResponse,
} from "../drive/getDriveRoute";

// Your existing EV‐branch‐filtering logic
import { getBestBranchWithAvailableEV } from "../filtering/branches_with_el_cars";
import { BestBranchResult } from "../filtering/branches_with_el_cars";

export const DISTANCE_THRESHOLD = 1_000; // metres – adjust as needed
export const RANGE_THRESHOLD = 100; // km – adjust as needed

/**
 * Read the previously‐saved A→B route from data/drive_route.json. That JSON
 * was written by your /api/drive/route handler (or wherever you run getDriveRoute first).
 */
async function getRouteInfo(filePath: string) {
  const raw = await readFile(filePath, "utf-8");
  const route = JSON.parse(raw);

  return {
    // Google’s v2 response may have .routes[0].polyline or .overview_polyline, depending on fieldMask.
    // Here we assume the JSON has “.routes[0].polyline.encodedPolyline” (if you used fieldMask "routes.polyline").
    encodedPolyline:
      route.routes?.[0]?.polyline?.encodedPolyline ??
      route.routes?.[0]?.overview_polyline?.encodedPolyline,
    startLocation:
      route.routes[0].legs[0].start_location ??
      route.routes[0].legs[0].start_location,
    endLocation:
      route.routes[0].legs[0].end_location ??
      route.routes[0].legs[0].end_location,
  };
}

export interface LegInfo {
  encodedPolyline: string;
  distanceMeters: number;
  durationSeconds: number;
  startLocation: LatLng;
  endLocation: LatLng;
}

/**
 * planTripWithBestBranch:
 * 1) Loads the stored A→B route (drive_route.json) to get its polyline + endpoints.
 * 2) Finds the best branch along that route using getBestBranchWithAvailableEV.
 * 3) If no branch is found, returns branch:null and all legs null.
 * 4) Otherwise, calls getDriveRoute(...) three times:
 *    - A → branch
 *    - branch → B
 *    - B → branch (return)
 * 5) Extracts encodedPolyline / distance / duration / startLocation / endLocation from each response.
 * 6) Returns an object containing branch + the three LegInfo objects.
 */
export async function planTripWithBestBranch(): Promise<{
  branch: BestBranchResult | null;
  legToBranch: LegInfo | null;
  legBranchToDest: LegInfo | null;
  legDestToBranch: LegInfo | null;
}> {
  try {
    // 1) Read the stored route from data/drive_route.json
    const driveRoutePath = path.resolve(
      process.cwd(),
      "data",
      "drive_route.json"
    );
    const { encodedPolyline, startLocation, endLocation } = await getRouteInfo(
      driveRoutePath
    );

    // 2) Find the best branch along that polyline
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const bestBranch = await getBestBranchWithAvailableEV(
      DISTANCE_THRESHOLD,
      RANGE_THRESHOLD,
      today,
      encodedPolyline
    );

    if (!bestBranch) {
      // No suitable branch found
      return {
        branch: null,
        legToBranch: null,
        legBranchToDest: null,
        legDestToBranch: null,
      };
    }

    // 3) Build coords for the branch and for the final destination
    const branchCoord: LatLng = { lat: bestBranch.lat, lng: bestBranch.lng };
    const DESTINATION: LatLng = {
      lat: Number(endLocation.lat ?? endLocation.latitude),
      lng: Number(endLocation.lng ?? endLocation.longitude),
    };

    // 4a) A → branch
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) throw new Error("Missing GOOGLE_MAPS_API_KEY");

    const routeToBranch: DriveRouteResponse = await getDriveRoute(
      { lat: startLocation.lat, lng: startLocation.lng },
      branchCoord,
      apiKey
    );
    const leg1 = routeToBranch.routes[0].legs[0];
    const encodedToBranch =
      routeToBranch.routes[0].polyline?.encodedPolyline ??
      routeToBranch.routes[0].overview_polyline?.encodedPolyline;
    const legToBranch: LegInfo = {
      encodedPolyline: encodedToBranch!,
      distanceMeters: leg1.distance.value,
      durationSeconds: leg1.duration.value,
      startLocation: {
        lat: leg1.start_location.lat,
        lng: leg1.start_location.lng,
      },
      endLocation: { lat: leg1.end_location.lat, lng: leg1.end_location.lng },
    };

    // 4b) branch → destination
    const routeBranchToDest: DriveRouteResponse = await getDriveRoute(
      branchCoord,
      DESTINATION,
      apiKey
    );
    const leg2 = routeBranchToDest.routes[0].legs[0];
    const encodedBranchToDest =
      routeBranchToDest.routes[0].polyline?.encodedPolyline ??
      routeBranchToDest.routes[0].overview_polyline?.encodedPolyline;
    const legBranchToDest: LegInfo = {
      encodedPolyline: encodedBranchToDest!,
      distanceMeters: leg2.distance.value,
      durationSeconds: leg2.duration.value,
      startLocation: {
        lat: leg2.start_location.lat,
        lng: leg2.start_location.lng,
      },
      endLocation: { lat: leg2.end_location.lat, lng: leg2.end_location.lng },
    };

    // 4c) destination → branch (return trip)
    const routeDestToBranch: DriveRouteResponse = await getDriveRoute(
      DESTINATION,
      branchCoord,
      apiKey
    );
    const leg3 = routeDestToBranch.routes[0].legs[0];
    const encodedDestToBranch =
      routeDestToBranch.routes[0].polyline?.encodedPolyline ??
      routeDestToBranch.routes[0].overview_polyline?.encodedPolyline;
    const legDestToBranch: LegInfo = {
      encodedPolyline: encodedDestToBranch!,
      distanceMeters: leg3.distance.value,
      durationSeconds: leg3.duration.value,
      startLocation: {
        lat: leg3.start_location.lat,
        lng: leg3.start_location.lng,
      },
      endLocation: { lat: leg3.end_location.lat, lng: leg3.end_location.lng },
    };

    return {
      branch: bestBranch,
      legToBranch,
      legBranchToDest,
      legDestToBranch,
    };
  } catch (err) {
    console.error("planTripWithBestBranch error:", err);
    throw err;
  }
}
