// app/api/transit/route.ts

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { origin, destination, departureTime } = await req.json();

  if (!origin || !destination) {
    return NextResponse.json({ error: "Missing coords" }, { status: 400 });
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
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
    const errText = await res.text();
    return NextResponse.json({ error: errText }, { status: res.status });
  }

  const data = await res.json();

  // Simply return the Google Routes response—do not attempt to write to /var/task/data
  return NextResponse.json(data);
}
