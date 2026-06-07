export enum NcaeType {
  /** JSON effect parameters. */
  Json = 1,
  /** WAV impulse response (convolution data). */
  Wav = 2,
}

export interface NcaeHeader {
  /** Raw payload size as declared in the file (before decompression). */
  payloadSize: number;
  /** Type flag. */
  type: NcaeType;
}

export interface Ncae {
  header: NcaeHeader;
  /**
   * Decompressed payload.
   * - Type 1 (JSON): the raw JSON string.
   * - Type 2 (WAV): a Buffer containing the RIFF/WAVE data.
   */
  payload: string | Uint8Array;
}
