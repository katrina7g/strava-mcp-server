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
  /** Used by tests to build synthetic FIT inputs; the server only decodes. */
  export class Encoder {
    writeMesg(message: Record<string, unknown> & { mesgNum: number }): Encoder;
    close(): Uint8Array;
  }
  export class Decoder {
    constructor(stream: Stream);
    isFIT(): boolean;
    read(): { messages: { recordMesgs?: Record<string, unknown>[]; lapMesgs?: Record<string, unknown>[]; activityMesgs?: Record<string, unknown>[] }; errors: Error[] };
  }
}
