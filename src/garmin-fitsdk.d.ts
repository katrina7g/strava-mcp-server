/**
 * Garmin's package currently publishes runtime exports from src/index.js but
 * declaration re-exports that point at a generated types-only directory.
 * Keep this intentionally narrow shim until the package aligns its entrypoint
 * declarations with the ESM runtime surface.
 */
declare module "@garmin/fitsdk" {
  export class Stream {
    static fromBuffer(buffer: Uint8Array): Stream;
  }
  export class Decoder {
    constructor(stream: Stream);
    isFIT(): boolean;
    read(): { messages: { recordMesgs?: Record<string, unknown>[]; lapMesgs?: Record<string, unknown>[] }; errors: Error[] };
  }
}
