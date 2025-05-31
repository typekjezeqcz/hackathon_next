import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import polyline from "@mapbox/polyline";

// 🔌 your own helper – adjust path if needed
import { getBestBranchWithAvailableEV } from "@/components/functions/filtering/branches_with_el_cars";
import { BestBranchResult } from "@/components/functions/filtering/branches_with_el_cars";

export const runtime = "nodejs";

/* -------------------------------------------------------------------------- */
/*  CONSTANTS (tweak if needed)                                               */
/* -------------------------------------------------------------------------- */

const DISTANCE_THRESHOLD = 1_000; // metres – branch must be within this of route
const RANGE_THRESHOLD = 100; // km – minimum EV range
const TRIP_DATE = new Date().toISOString().slice(0, 10); // YYYY-MM-DD today

/* -------------------------------------------------------------------------- */
/*  HELPERS                                                                   */
/* -------------------------------------------------------------------------- */

interface LatLng {
  lat: number;
  lng: number;
}

/** Call Google Routes API for a simple point-to-point drive polyline. */
interface LatLng {
  lat: number;
  lng: number;
}

type VehicleType = "EV" | "Gas" | "Mix";

async function getDriveRoute(
  origin: LatLng,
  destination: LatLng,
  apiKey: string,
  vehicleType: VehicleType
) {
  const body = {
    origin: {
      location: { latLng: { latitude: origin.lat, longitude: origin.lng } },
    },
    destination: {
      location: {
        latLng: { latitude: destination.lat, longitude: destination.lng },
      },
    },
    travelMode: "DRIVE",
    computeAlternativeRoutes: false,
    routeModifiers: {
      avoidTolls: false,
      avoidHighways: false,
      avoidFerries: false,
    },
    languageCode: "en-US",
    units: "METRIC",
  };

  const res = await fetch(
    "https://routes.googleapis.com/directions/v2:computeRoutes",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "routes.*",
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    throw new Error(await res.text());
  }

  const json = await res.json();

  // Attach the vehicleType to the response for downstream use
  return {
    vehicleType,
    ...json,
  };
}

/** Merge two encoded polylines, dropping the duplicate branch coordinate. */
function mergeEncodedPolylines(encodeA: string, encodeB: string): string {
  const ptsA = polyline.decode(encodeA);
  const ptsB = polyline.decode(encodeB);
  // remove first point of B to avoid duplicate at branch
  const merged = [...ptsA, ...ptsB.slice(1)];
  return polyline.encode(merged);
}

/* -------------------------------------------------------------------------- */
/*  ROUTE HANDLER                                                             */
/* -------------------------------------------------------------------------- */

export async function POST(req: NextRequest) {
  try {
    const { origin, destination, arrivalTime, departureTime } =
      await req.json();
    if (!origin || !destination) {
      return NextResponse.json({ error: "Missing coords" }, { status: 400 });
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "API key missing" }, { status: 500 });
    }

    /* -------------------------------------------------------------- */
    /* 1) Initial A→B route to figure out polyline & potential branch  */
    /* -------------------------------------------------------------- */

    const rawAB = await getDriveRoute(origin, destination, apiKey, "Mix");
    const encodedAB = rawAB.routes?.[0]?.polyline?.encodedPolyline;
    if (!encodedAB) throw new Error("Google returned no polyline.");

    /* -------------------------------------------------------------- */
    /* 2) Pick best branch along that polyline                         */
    /* -------------------------------------------------------------- */

    const bestBranch: BestBranchResult | null =
      await getBestBranchWithAvailableEV(
        DISTANCE_THRESHOLD,
        RANGE_THRESHOLD,
        TRIP_DATE, // you could pass arrivalTime if it better matches your needs
        encodedAB
      );

    if (!bestBranch) {
      // no branch – just return the direct route
      return NextResponse.json({ mergedEncoded: encodedAB, branch: null });
    }

    const branchCoord = { lat: bestBranch.lat, lng: bestBranch.lng };

    /* -------------------------------------------------------------- */
    /* 3) Fetch A→branch and branch→B drive legs                       */
    /* -------------------------------------------------------------- */

    const [rawToBranch, rawToDest, rawBackToBranch, rawBackToOrigin] =
      await Promise.all([
        getDriveRoute(origin, branchCoord, apiKey, "Gas"),
        getDriveRoute(branchCoord, destination, apiKey, "EV"),
        getDriveRoute(destination, branchCoord, apiKey, "EV"),
        getDriveRoute(branchCoord, origin, apiKey, "Gas"),
      ]);

    const encToBranch = rawToBranch.routes?.[0]?.polyline?.encodedPolyline;
    const encToDest = rawToDest.routes?.[0]?.polyline?.encodedPolyline;

    if (!encToBranch || !encToDest) {
      throw new Error("Missing polylines for legs.");
    }

    /* -------------------------------------------------------------- */
    /* 4) Merge polylines A→branch→B                                   */
    /* -------------------------------------------------------------- */

    const mergedEncoded = mergeEncodedPolylines(encToBranch, encToDest);

    /* optional: dump for debug */
    const dir = path.join(process.cwd(), "data");
    // await fs.mkdir(dir, { recursive: true });
    // await fs.writeFile(
    //   path.join(dir, "merged_trip.json"),
    //   JSON.stringify(
    //     { origin, destination, bestBranch, mergedEncoded },
    //     null,
    //     2
    //   )
    // );

    return NextResponse.json({
      mergedEncoded,
      branch: bestBranch,
      routes: {
        toBranch: rawToBranch,
        toDest: rawToDest,
        backToBranch: rawBackToBranch,
        backToOrigin: rawBackToOrigin,
      },
    });
  } catch (err: any) {
    console.error("/api/plan-trip:", err);
    return NextResponse.json(
      { error: String(err?.message ?? err) },
      { status: 500 }
    );
  }
}
