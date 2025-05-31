// types/mapbox__polyline.d.ts
declare module "@mapbox/polyline" {
  export function decode(s: string): [number, number][];
  export function encode(coords: [number, number][]): string;
}
