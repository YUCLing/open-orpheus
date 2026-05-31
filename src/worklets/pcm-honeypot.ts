/// <reference types="@types/audioworklet" />

const PACKET_FRAMES = 3200; // 3200 stereo frames * 2ch * 2B = 12800 bytes
const PACKET_BYTES = PACKET_FRAMES * 2 * 2;

class PcmHoneypotProcessor extends AudioWorkletProcessor {
  private _buf: ArrayBuffer;
  private _dv: DataView;
  private _off: number;
  private _frames: number;

  constructor() {
    super();
    this._buf = new ArrayBuffer(PACKET_BYTES);
    this._dv = new DataView(this._buf);
    this._off = 0;
    this._frames = 0;

    this.port.onmessage = (e: MessageEvent) => {
      if (e.data === "reset") {
        this._buf = new ArrayBuffer(PACKET_BYTES);
        this._dv = new DataView(this._buf);
        this._off = 0;
        this._frames = 0;
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || !input.length || !input[0]) return true;

    const len = input[0].length;

    // Convert float -> stereo interleaved int16 LE
    for (let i = 0; i < len; i++) {
      const l = input[0][i];
      const r = input.length > 1 ? input[1][i] : l;
      this._dv.setInt16(this._off, (l < 0 ? l * 0x8000 : l * 0x7fff) | 0, true);
      this._off += 2;
      this._dv.setInt16(this._off, (r < 0 ? r * 0x8000 : r * 0x7fff) | 0, true);
      this._off += 2;

      if (this._off >= PACKET_BYTES) {
        const pts = Math.round(
          ((this._frames + i + 1 - PACKET_FRAMES) / sampleRate) * 1000
        );
        this.port.postMessage({ data: this._buf, pts }, [this._buf]);
        this._buf = new ArrayBuffer(PACKET_BYTES);
        this._dv = new DataView(this._buf);
        this._off = 0;
      }
    }

    this._frames += len;
    return true;
  }
}

registerProcessor("pcm-honeypot", PcmHoneypotProcessor);
