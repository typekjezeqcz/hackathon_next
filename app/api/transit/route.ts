// app/api/transit/route.ts

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { origin, destination, departureTime } = await req.json();

  if (!origin || !destination) {
    // You can choose to return null here as well,
    // but this example still returns a 400 for missing coords.
    return NextResponse.json({ error: "Missing coords" }, { status: 400 });
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    // Similarly, you could return null, but this still returns a 500 if your key is missing.
    return NextResponse.json({ error: "API key missing" }, { status: 500 });
  }

  const body = {
    origin: {
      location: { latLng: { latitude: origin.lat, longitude: origin.lng } },
    },
    destination: {
      location: {
        latLng: { latitude: destination.lat, longitude: destination.lng },
      },
    },
    travelMode: "TRANSIT",
    computeAlternativeRoutes: true,
    transitPreferences: {
      routingPreference: "LESS_WALKING",
      allowedTravelModes: ["BUS", "SUBWAY", "TRAIN", "LIGHT_RAIL", "RAIL"],
    },
    departureTime: departureTime || new Date().toISOString(),
    languageCode: "en-US",
    units: "METRIC",
  };

  try {
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
      // Instead of returning a Next.js error status, return `null`
      return NextResponse.json(null);
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    // Any network/connection error (e.g. “failed to fetch”) will land here
    return NextResponse.json(null);
  }
}
