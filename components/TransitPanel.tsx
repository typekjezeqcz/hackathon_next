import React from "react";

type RouteResponse = any; // or a more specific type if you have one

function TransitPanel({ title, data }: { title: string; data: RouteResponse }) {
  const leg = data?.routes?.[0]?.legs?.[0];
  if (!leg) return null;

  const steps: any[] = leg.steps ?? [];
  const segments: any[] = leg.stepsOverview?.multiModalSegments ?? [];

  /* ---- build rows from segments ---- */
  type Row = {
    mode: string;
    meters: number;
    secs: number;
    label?: string;
  };

  const rows: Row[] = segments.map((seg: any) => {
    let meters = 0;
    let secs = 0;

    for (let i = seg.stepStartIndex; i <= seg.stepEndIndex; i++) {
      const st = steps[i] || {};
      meters += st.distanceMeters || 0;
      // staticDuration is a string like "300s", so strip non-digits:
      secs += Number(String(st.staticDuration || "0").replace(/[^\d]/g, ""));
    }

    return {
      mode: seg.travelMode, // e.g. "BUS", "RAIL", "WALK", etc.
      meters,
      secs,
      label: seg.navigationInstruction?.instructions,
    };
  });

  /* ---- helpers ---- */
  const fmtDist = (m: number) =>
    m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`;
  const fmtDur = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return h ? `${h} h ${m} min` : `${m} min`;
  };

  return (
    <div className="border p-4 rounded bg-gray-50">
      <h3 className="text-lg font-medium mb-2">{title}</h3>
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className="text-left">Mode</th>
            <th className="text-left">Distance</th>
            <th className="text-left">Duration</th>
            <th className="text-left">Instruction</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            // Determine the “Instruction” cell value:
            // If this is the last row AND row.label is missing → “Your destination”
            // Else if row.label exists → use it
            // Otherwise → “—”
            const isLast = idx === rows.length - 1;
            let instructionText: string;
            if (isLast && !row.label) {
              instructionText = "Your destination";
            } else if (row.label) {
              instructionText = row.label;
            } else {
              instructionText = "—";
            }

            return (
              <tr key={idx} className="border-t">
                <td className="py-1">{row.mode}</td>
                <td className="py-1">{fmtDist(row.meters)}</td>
                <td className="py-1">{fmtDur(row.secs)}</td>
                <td className="py-1">{instructionText}</td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="py-2 text-center text-gray-500">
                No segments available
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default TransitPanel;
