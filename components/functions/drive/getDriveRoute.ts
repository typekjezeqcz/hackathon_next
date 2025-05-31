// components/functions/drive/getDriveRoute.ts

export interface LatLng {
  lat: number;
  lng: number;
}

export interface DriveRouteResponse {
  routes: Array<{
    polyline?: { encodedPolyline: string };
    overview_polyline?: { encodedPolyline: string };
    legs: Array<{
      distance: { value: number; text: string };
      duration: { value: number; text: string };
      start_location: { lat: number; lng: number };
      end_location: { lat: number; lng: number };
    }>;
  }>;
}

/**
 * Directly call Google Routes API v2 (computeRoutes) for a single DRIVING leg.
 * Returns the raw JSON response (typed as DriveRouteResponse).
 *
 * @param origin    { lat, lng }
 * @param destination { lat, lng }
 * @param apiKey    Your Google Maps / Routes API key
 */
export async function getDriveRoute(
  origin: LatLng,
  destination: LatLng,
  apiKey: string
): Promise<DriveRouteResponse> {
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
        // Request the entire routes.* subtree
        "X-Goog-FieldMask": "routes.*",
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google Routes API error: ${errText}`);
  }

  const data = (await res.json()) as DriveRouteResponse;
  return data;
}
