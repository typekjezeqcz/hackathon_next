"use client";

import { useEffect, useRef, useState } from "react";
import Script from "next/script";
import RouteMap, { PolyRoute } from "./map/RouteMap";
import polyline from "@mapbox/polyline";
import TransitPanel from "./TransitPanel";
/* -------------------------------------------------------------------------- */
/*  GLOBALS                                                                   */
/* -------------------------------------------------------------------------- */

declare global {
  interface Window {
    initAutocomplete: () => void;
    google: typeof google;
  }
}

/* -------------------------------------------------------------------------- */
/*  TYPES                                                                     */
/* -------------------------------------------------------------------------- */

type Coord = { lat: number; lng: number };
type RouteResponse = any; // full JSON – we only cherry-pick

interface Leg {
  distanceMeters: number;
  duration: string; // e.g. "2524s"
}

interface PolylineObject {
  encodedPolyline: string;
  polylineDetails?: Record<string, unknown>;
  routeLabels?: string[];
  viewport?: {
    low: { latitude: number; longitude: number };
    high: { latitude: number; longitude: number };
  };
  warnings?: string[];
}

interface SegmentRoute {
  legs: Leg[];
  staticDuration?: string;
  distanceMeters?: number;
  duration?: string;
  polyline: PolylineObject;
}

interface SegmentDetail {
  vehicleType: "EV" | "Gas" | "Mix";
  routes?: SegmentRoute[];
}

interface PlanTripResponse {
  mergedEncoded: string;
  branch?: { Name: string; lat: number; lng: number } | null;
  routes?: {
    [key: string]: SegmentDetail;
  };
}

/* -------------------------------------------------------------------------- */
/*  CONSTANTS FOR EMISSIONS & COST                                             */
/* -------------------------------------------------------------------------- */

const EMISSION_RATE_KG_PER_KM: Record<"Gas" | "EV" | "Mix", number> = {
  Gas: 0.192,
  EV: 0,
  Mix: 0.125,
};

const COST_PER_KM_CZK: Record<"Gas" | "EV" | "Mix", number> = {
  Gas: 2.4,
  EV: 0.5,
  Mix: 1.75,
};

/* -------------------------------------------------------------------------- */
/*  COMPONENT                                                                 */
/* -------------------------------------------------------------------------- */

export default function TripForm() {
  /* refs for origin/destination inputs */
  const originRef = useRef<HTMLInputElement>(null);
  const destRef = useRef<HTMLInputElement>(null);

  /* refs for optional datetime inputs */
  const arriveRef = useRef<HTMLInputElement>(null);
  const departRef = useRef<HTMLInputElement>(null);

  /* map + route state */

  const [thereTransit, setThereTransit] = useState<RouteResponse>();
  const [backTransit, setBackTransit] = useState<RouteResponse>();
  const [polyRoutes, setPolyRoutes] = useState<PolyRoute[]>([]);
  const [loading, setLoading] = useState(false);

  /* 
    routeMeta now also includes:
      - totalEmissions: number (in kg CO₂)
      - totalCost: number (in CZK)
  */
  const [routeMeta, setRouteMeta] = useState<
    Record<
      "EV" | "Gas" | "Mix",
      {
        totalDistance: number; // in meters
        totalDuration: number; // in seconds
        totalEmissions: number; // in kg CO₂
        totalCost: number; // in CZK
      }
    >
  >({
    EV: { totalDistance: 0, totalDuration: 0, totalEmissions: 0, totalCost: 0 },
    Gas: {
      totalDistance: 0,
      totalDuration: 0,
      totalEmissions: 0,
      totalCost: 0,
    },
    Mix: {
      totalDistance: 0,
      totalDuration: 0,
      totalEmissions: 0,
      totalCost: 0,
    },
  });

  const [coordA, setCoordA] = useState<Coord | null>(null);
  const [coordB, setCoordB] = useState<Coord | null>(null);

  /* Four potential segments; each may be a PolyRoute or null */
  const [segmentRoutes, setSegmentRoutes] = useState<{
    toBranch: PolyRoute | null;
    toDest: PolyRoute | null;
    backToBranch: PolyRoute | null;
    backToOrigin: PolyRoute | null;
  }>({
    toBranch: null,
    toDest: null,
    backToBranch: null,
    backToOrigin: null,
  });

  /* ───────────────────────── Google Autocomplete wiring ─────────────────── */
  function initAutocomplete() {
    if (!window.google || !originRef.current || !destRef.current) return;

    const opts: google.maps.places.AutocompleteOptions = {
      componentRestrictions: { country: "cz" },
      fields: ["geometry"],
    };

    const acA = new window.google.maps.places.Autocomplete(
      originRef.current,
      opts
    );
    const acB = new window.google.maps.places.Autocomplete(
      destRef.current,
      opts
    );

    acA.addListener("place_changed", () => {
      const loc = acA.getPlace().geometry?.location;
      if (loc) setCoordA({ lat: loc.lat(), lng: loc.lng() });
    });
    acB.addListener("place_changed", () => {
      const loc = acB.getPlace().geometry?.location;
      if (loc) setCoordB({ lat: loc.lat(), lng: loc.lng() });
    });
  }

  /* ───────────────────────── main click handler ─────────────────────── */
  async function handleClick() {
    // 1) Make sure both coords are selected
    if (!coordA || !coordB) {
      alert("Please select both origin and destination.");
      return;
    }

    // 2) Grab optional times
    const arrivalTime = arriveRef.current?.value || undefined;
    const departureTime = departRef.current?.value || undefined;
    const isoDeparture =
      departureTime !== undefined
        ? new Date(departureTime).toISOString()
        : new Date().toISOString();
    setLoading(true);

    // Reset any previous state
    setPolyRoutes([]);
    setSegmentRoutes({
      toBranch: null,
      toDest: null,
      backToBranch: null,
      backToOrigin: null,
    });
    setRouteMeta({
      EV: {
        totalDistance: 0,
        totalDuration: 0,
        totalEmissions: 0,
        totalCost: 0,
      },
      Gas: {
        totalDistance: 0,
        totalDuration: 0,
        totalEmissions: 0,
        totalCost: 0,
      },
      Mix: {
        totalDistance: 0,
        totalDuration: 0,
        totalEmissions: 0,
        totalCost: 0,
      },
    });

    try {
      const res: PlanTripResponse = await fetchJSON("/api/plan-trip", {
        origin: coordA,
        destination: coordB,
        arrivalTime,
        departureTime,
      });

      const leg1 = { origin: coordA, destination: coordB, arrivalTime };
      /* leg 2  (B ➜ A, DEPARTURE constraint) */
      const leg2 = { origin: coordB, destination: coordA, isoDeparture };

      const [t1, t2] = await Promise.all([
        fetchJSON("/api/transit", leg1),
        fetchJSON("/api/transit", leg2),
      ]);

      setThereTransit(t1);
      setBackTransit(t2);

      if (!res.routes) {
        // Instead of throwing an error, show a friendly warning:
        alert(
          "The destination is too short for routing. Please choose different destination."
        );
        setLoading(false);
        return; // stop further processing
      }

      /***************************************************************************/
      /*** STEP A:  Extract each “raw” segment’s encodedPolyline from          ****/
      /***         routes[0].polyline.encodedPolyline.                       ****/
      /***************************************************************************/
      const {
        toBranch: rawToBranch,
        toDest: rawToDest,
        backToBranch: rawBackToBranch,
        backToOrigin: rawBackToOrigin,
      } = res.routes;

      function extractEncoded(seg?: SegmentDetail): string | null {
        if (
          seg?.routes &&
          Array.isArray(seg.routes) &&
          seg.routes.length > 0 &&
          seg.routes[0].polyline &&
          typeof seg.routes[0].polyline.encodedPolyline === "string" &&
          seg.routes[0].polyline.encodedPolyline.length > 0
        ) {
          return seg.routes[0].polyline.encodedPolyline;
        }
        return null;
      }

      const toBranchEncoded = extractEncoded(rawToBranch);
      const toDestEncoded = extractEncoded(rawToDest);
      const backToBranchEncoded = extractEncoded(rawBackToBranch);
      const backToOriginEncoded = extractEncoded(rawBackToOrigin);

      const newSegments: typeof segmentRoutes = {
        toBranch: toBranchEncoded
          ? {
              encoded: toBranchEncoded,
              origin: coordA,
              destination: { lat: res.branch!.lat, lng: res.branch!.lng },
              label: "To Branch",
              branch: {
                lat: res.branch!.lat,
                lng: res.branch!.lng,
                label: "Car Swap Here",
              },
              vehicleType: rawToBranch.vehicleType, // ← add this
            }
          : null,

        toDest: toDestEncoded
          ? {
              encoded: toDestEncoded,
              origin: { lat: res.branch!.lat, lng: res.branch!.lng },
              destination: coordB,
              label: "Branch → Dest",
              vehicleType: rawToDest.vehicleType, // ← add this
            }
          : null,

        backToBranch: backToBranchEncoded
          ? {
              encoded: backToBranchEncoded,
              origin: coordB,
              destination: { lat: res.branch!.lat, lng: res.branch!.lng },
              label: "Dest → Branch",
              vehicleType: rawBackToBranch.vehicleType, // ← add this
            }
          : null,

        backToOrigin: backToOriginEncoded
          ? {
              encoded: backToOriginEncoded,
              origin: { lat: res.branch!.lat, lng: res.branch!.lng },
              destination: coordA,
              label: "Branch → Origin",
              vehicleType: rawBackToOrigin.vehicleType, // ← add this
            }
          : null,
      };

      setSegmentRoutes(newSegments);

      /************************************************************/
      /*** STEP B:  Build “mainPoly” exactly as before (merged). ***/
      /************************************************************/
      const merged = res.mergedEncoded;
      if (!merged) {
        throw new Error("No merged route returned.");
      }
      const mainPoly: PolyRoute = {
        encoded: merged,
        origin: coordA,
        destination: coordB,
        label: "Drive (via branch)",
      };

      /************************************************************/
      /*** STEP C:  Recompute emissions/cost exactly as before   ***/
      /************************************************************/
      if (res.routes) {
        const summary: typeof routeMeta = {
          EV: {
            totalDistance: 0,
            totalDuration: 0,
            totalEmissions: 0,
            totalCost: 0,
          },
          Gas: {
            totalDistance: 0,
            totalDuration: 0,
            totalEmissions: 0,
            totalCost: 0,
          },
          Mix: {
            totalDistance: 0,
            totalDuration: 0,
            totalEmissions: 0,
            totalCost: 0,
          },
        };

        for (const key in res.routes) {
          const segment = (res.routes as any)[key] as SegmentDetail;
          const vehicle = segment.vehicleType as "EV" | "Gas" | "Mix";
          const legs = segment.routes?.flatMap((r) => r.legs || []) ?? [];

          for (const leg of legs) {
            const distMeters = leg.distanceMeters || 0;
            summary[vehicle].totalDistance += distMeters;

            const durationSec =
              parseInt(leg.duration.replace("s", ""), 10) || 0;
            summary[vehicle].totalDuration += durationSec;

            const distKm = distMeters / 1000;
            summary[vehicle].totalEmissions +=
              distKm * EMISSION_RATE_KG_PER_KM[vehicle];
            summary[vehicle].totalCost += distKm * COST_PER_KM_CZK[vehicle];
          }
        }

        for (const v of ["EV", "Gas", "Mix"] as const) {
          summary[v].totalEmissions = parseFloat(
            summary[v].totalEmissions.toFixed(2)
          );
          summary[v].totalCost = parseFloat(summary[v].totalCost.toFixed(2));
        }

        setRouteMeta(summary);
      }

      /************************************************************/
      /*** STEP D:  Finally, push both “mainPoly” + segments     ***/
      /************************************************************/

      // 1) Put the “merged” route at index 0
      // 2) Then put any of the 4 individual segments after it (if non‐null)
      const allRoutes: PolyRoute[] = [
        mainPoly,
        newSegments.toBranch,
        newSegments.toDest,
        newSegments.backToBranch,
        newSegments.backToOrigin,
      ].filter((r): r is PolyRoute => r !== null);

      setPolyRoutes(allRoutes);
    } catch (err) {
      console.error("❌ fetchJSON threw an error:", err);
      alert("Routing failed — check console for details.");
    } finally {
      setLoading(false);
    }
  }

  /* register initAutocomplete only once */
  useEffect(() => {
    window.initAutocomplete = initAutocomplete;
  }, []);

  /* ---------------------------------------------------------------------- */
  /*  RENDER                                                                */
  /* ---------------------------------------------------------------------- */

  return (
    <div className="max-w-5xl mx-auto py-10 px-4">
      <Script
        src={`https://maps.googleapis.com/maps/api/js?key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY_PLACES}&libraries=places&language=en&region=CZ&callback=initAutocomplete`}
        strategy="afterInteractive"
      />

      <h2 className="text-2xl font-semibold mb-6">Route planner (EV branch)</h2>

      <div className="space-y-4">
        <input
          ref={originRef}
          className="w-full border rounded px-3 py-2"
          placeholder="Origin"
          autoComplete="off"
        />
        <input
          ref={destRef}
          className="w-full border rounded px-3 py-2"
          placeholder="Destination"
          autoComplete="off"
        />

        <div className="grid md:grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm font-medium">Arrival (optional)</span>
            <input
              ref={arriveRef}
              type="datetime-local"
              className="w-full border rounded px-3 py-2"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Departure (optional)</span>
            <input
              ref={departRef}
              type="datetime-local"
              className="w-full border rounded px-3 py-2"
            />
          </label>
        </div>

        <button
          onClick={handleClick}
          className="bg-blue-600 hover:bg-blue-700 text-white rounded px-4 py-2"
          type="button"
        >
          {loading ? "Loading…" : "Compute route"}
        </button>
      </div>

      {/* ─────────── Render ONE map, combining all non‐null segments ─────────── */}
      {polyRoutes.length > 0 && (
        <div className="mt-10">
          <RouteMap routes={polyRoutes} />
        </div>
      )}

      {/* ─────────── EV vs Gas comparison as before ─────────── */}
      {/* ─────────── EV vs Gas comparison as before, plus “Saved” row ─────────── */}
      <div className="mt-6 space-y-4 text-sm text-gray-800">
        {/*
    Compute baseline (all‐Gas) cost/emissions and compare to actual mixed.
  */}
        {(() => {
          // 1) Sum the distances (in meters) that were actually driven by EV and Gas
          const totalDistanceMeters =
            routeMeta.Gas.totalDistance + routeMeta.EV.totalDistance;

          // Convert to kilometers:
          const totalDistanceKm = totalDistanceMeters / 1000;

          // 2) Baseline “all‐Gas” cost and emissions
          const baselineCost = parseFloat(
            (totalDistanceKm * COST_PER_KM_CZK["Gas"]).toFixed(2)
          ); // in CZK
          const baselineEmissions = parseFloat(
            (totalDistanceKm * EMISSION_RATE_KG_PER_KM["Gas"]).toFixed(2)
          ); // in kg CO₂

          // 3) Actual mixed cost/emissions (sum of EV + Gas segments)
          const actualCost =
            parseFloat(routeMeta.Gas.totalCost.toFixed(2)) +
            parseFloat(routeMeta.EV.totalCost.toFixed(2));
          const actualEmissions =
            parseFloat(routeMeta.Gas.totalEmissions.toFixed(2)) +
            parseFloat(routeMeta.EV.totalEmissions.toFixed(2));

          // 4) Savings = Baseline − Actual (round to two decimals)
          const savedCost = parseFloat((baselineCost - actualCost).toFixed(2));
          const savedEmissions = parseFloat(
            (baselineEmissions - actualEmissions).toFixed(2)
          );

          if (savedCost > 0 || savedEmissions > 0) {
            return (
              <div className="border p-3 rounded bg-green-50">
                <strong>Saved</strong> – {savedEmissions} kg CO₂, {savedCost}{" "}
                CZK
              </div>
            );
          } else {
            return null;
          }
        })()}

        {(["EV", "Gas"] as const).map((type) => {
          const meta = routeMeta[type];
          const distKm = Math.round(meta.totalDistance / 1000);
          const durMin = Math.round(meta.totalDuration / 60);
          const emissions = meta.totalEmissions; // in kg CO₂
          const cost = meta.totalCost; // in CZK

          if (
            meta.totalDistance === 0 &&
            meta.totalDuration === 0 &&
            meta.totalEmissions === 0 &&
            meta.totalCost === 0
          ) {
            return null;
          }

          return (
            <div key={type} className="border p-3 rounded">
              <strong>{type}</strong> – {distKm} km, {durMin} min
              <br />
              Emissions: {emissions} kg CO₂
              <br />
              Operating cost: {cost} CZK
            </div>
          );
        })}
      </div>
      {(thereTransit || backTransit) && (
        <div className="mt-10 grid md:grid-cols-2 gap-8 text-sm">
          {thereTransit && <TransitPanel title="MHD A→B" data={thereTransit} />}
          {backTransit && <TransitPanel title="MHD B→A" data={backTransit} />}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  HELPERS                                                                   */
/* -------------------------------------------------------------------------- */
async function fetchJSON(url: string, body: object) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
