"use client";

import {
  GoogleMap,
  Marker,
  Polyline,
  useJsApiLoader,
} from "@react-google-maps/api";
import { decode } from "@mapbox/polyline";
import { useEffect, useMemo } from "react";

/* --------------------------------------------- */
/* Public type so TripForm can build the payload */
/* --------------------------------------------- */
export type PolyRoute = {
  encoded: string;
  vehicleType?: "EV" | "Gas" | "Mix";
  color?: string; // optional override
  label?: string;
  origin?: google.maps.LatLngLiteral;
  destination?: google.maps.LatLngLiteral;
  branch?: {
    lat: number;
    lng: number;
    // We no longer rely on branch.label for display; instead we hard‐code "Car Swap for EV"
    label?: string;
  };
};

/* --------------------------------------------- */

type Props = { routes: PolyRoute[] };

export default function RouteMap({ routes }: Props) {
  const { isLoaded } = useJsApiLoader({
    id: "gmap",
    googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY_PLACES!,
    libraries: ["geometry"],
    language: "cs",
    region: "CZ",
  });

  /* Decode once whenever `routes` changes */
  const paths = useMemo(
    () =>
      routes.map((r) => ({
        ...r,
        path: decode(r.encoded).map(([lat, lng]: [number, number]) => ({
          lat,
          lng,
        })),
      })),
    [routes]
  );

  useEffect(() => {
    console.log("raw routes →", routes);
    console.log("decoded paths →", paths);
  }, [routes, paths]);

  if (!isLoaded) return null;

  /* ---------------- center & origin position ---------------- */
  const startPos: google.maps.LatLngLiteral | undefined =
    paths[0]?.origin ?? paths[0]?.path[0];

  /* ---------------- figure out “true” end-of-branch→dest leg ---------------- */
  let endPos: google.maps.LatLngLiteral | undefined = undefined;

  // 1) Find the index of the first route that has a branch
  const branchIndex = paths.findIndex((p) => !!p.branch);

  if (
    branchIndex !== -1 && // there is a route with branch
    branchIndex + 1 < paths.length // AND there is a “next” route after that
  ) {
    const nextLeg = paths[branchIndex + 1];
    // If nextLeg has an explicit destination coordinate, use it:
    if (nextLeg.destination) {
      endPos = nextLeg.destination;
    } else {
      // Otherwise fall back to the last decoded point of that next leg:
      endPos = nextLeg.path[nextLeg.path.length - 1];
    }
  } else {
    // Fallback: no branch or branch is last segment → use last route’s endpoint
    const last = paths[paths.length - 1];
    if (last.destination) {
      endPos = last.destination;
    } else {
      endPos = last.path[last.path.length - 1];
    }
  }

  /* ---------------- very rough “center of map” fallback ---------------- */
  const centre: google.maps.LatLngLiteral = startPos ?? {
    lat: 49.8175,
    lng: 15.47296,
  }; // geographic centre of the Czech Republic

  /* ---------------- helper to pick polyline color (with console logs) ---------------- */
  function pickColor(p: PolyRoute, index: number): string {
    if (p.color) {
      return p.color;
    }
    switch (p.vehicleType) {
      case "Gas":
        return "red";
      case "EV":
        return "green";
      default:
        return "green";
    }
  }

  /* ---------------- render everything ---------------- */
  return (
    <div>
      {/* Title above the map */}
      <div className="text-lg text-black mb-2">For a Return trip</div>
      {/* The map itself */}
      <GoogleMap
        mapContainerStyle={{ width: "100%", height: "400px" }}
        center={centre}
        zoom={7}
        options={{ mapTypeControl: false, streetViewControl: false }}
      >
        {paths.map((p, i) => (
          <Polyline
            key={i}
            path={p.path}
            options={{
              strokeColor: pickColor(p, i),
              strokeOpacity: 0.9,
              strokeWeight: 4,
            }}
          />
        ))}

        {/* Origin marker (“Start & Finish”) */}
        {startPos && (
          <Marker
            position={startPos}
            icon={{
              url: "https://maps.google.com/mapfiles/ms/icons/red-dot.png",
              scaledSize: new window.google.maps.Size(32, 32),
              labelOrigin: new window.google.maps.Point(16, -8),
            }}
            label={{
              text: "Start & Finish",
              color: "#000000",
              fontSize: "12px",
              fontWeight: "bold",
            }}
            title="Start & Finish"
          />
        )}

        {/* Destination marker (“Destination”) */}
        {endPos && (
          <Marker
            position={endPos}
            icon={{
              url: "https://maps.google.com/mapfiles/ms/icons/blue-dot.png",
              scaledSize: new window.google.maps.Size(32, 32),
              labelOrigin: new window.google.maps.Point(16, -8),
            }}
            label={{
              text: "Destination",
              color: "#000000",
              fontSize: "12px",
              fontWeight: "bold",
            }}
            title="Destination"
          />
        )}

        {/* Branch marker(s): “Car Swap for EV” */}
        {paths.map((p, i) =>
          p.branch ? (
            <Marker
              key={`branch-${i}`}
              position={{ lat: p.branch.lat, lng: p.branch.lng }}
              icon={{
                url: "https://pngimg.com/d/skoda_PNG12329.png",
                scaledSize: new window.google.maps.Size(75, 40),
                labelOrigin: new window.google.maps.Point(37.5, -8),
              }}
              label={{
                text: "Car Swap for EV",
                color: "#000000",
                fontSize: "12px",
                fontWeight: "bold",
              }}
              title="Car Swap for EV"
            />
          ) : null
        )}
      </GoogleMap>
    </div>
  );
}
