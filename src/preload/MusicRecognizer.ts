import { ipcRenderer } from "electron";
import Emittery from "emittery";

async function getDesktopAudioStream() {
  // Since getDisplayMedia() requires a video track, if this option is set to false the promise will reject with a TypeError.
  // https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia#video
  const stream = await navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: true,
  });
  // close video tracks
  stream.getVideoTracks().forEach((track) => track.stop());
  return stream;
}

type MatchWindowMessage = {
  type: "match-window";
  audioData: ArrayBuffer;
  duration: number;
  final: boolean;
  frames: number;
  interval: number;
  sampleRate: number;
  times: number;
};

type NetworkFetchResponse = {
  blob?: string;
  status?: number;
};

export type MusicRecognizeResult = {
  code: number;
  duration: number;
  httpmsg: string | object;
  recordtime: number;
  responsetime: number;
  sessionId: string;
  times: number;
};

type RecognitionState = {
  stream: MediaStream | null;
  ctx: AudioContext | null;
  source: MediaStreamAudioSourceNode | null;
  recorder: AudioWorkletNode | null;
  sessionId: string;
  recordtime: number;
  pendingMatch: Promise<void>;
  done: Promise<MusicRecognizeResult | null>;
  resolveDone: (result: MusicRecognizeResult | null) => void;
};

export type MusicRecognizerEvents = {
  result: MusicRecognizeResult;
};

function isMatchWindowMessage(data: unknown): data is MatchWindowMessage {
  if (!data || typeof data !== "object") return false;
  const maybeMessage = data as Partial<MatchWindowMessage>;
  return (
    maybeMessage.type === "match-window" &&
    maybeMessage.audioData instanceof ArrayBuffer &&
    typeof maybeMessage.duration === "number" &&
    typeof maybeMessage.final === "boolean" &&
    typeof maybeMessage.times === "number"
  );
}

function createRecognitionState(): RecognitionState {
  let resolveDone: (result: MusicRecognizeResult | null) => void;
  const done = new Promise<MusicRecognizeResult | null>((resolve) => {
    resolveDone = resolve;
  });

  return {
    stream: null,
    ctx: null,
    source: null,
    recorder: null,
    sessionId: crypto.randomUUID().toUpperCase(),
    recordtime: Date.now(),
    pendingMatch: Promise.resolve(),
    done,
    resolveDone: resolveDone!,
  };
}

export default class MusicRecognizer extends Emittery<MusicRecognizerEvents> {
  sampleRate = 8000;
  duration = 15;
  interval = 3;

  private state: RecognitionState | null = null;

  async start(): Promise<MusicRecognizeResult | null> {
    if (this.state) {
      throw new Error("Recording is in progress.");
    }

    const state = createRecognitionState();
    this.state = state;

    try {
      const stream = await getDesktopAudioStream();
      if (this.state !== state) {
        stream.getTracks().forEach((track) => track.stop());
        return await state.done;
      }
      state.stream = stream;

      const ctx = new AudioContext({
        sampleRate: this.sampleRate,
      });
      state.ctx = ctx;

      await ctx.audioWorklet.addModule("audio://worklet/music-recorder.js");
      if (this.state !== state) return await state.done;

      const source = ctx.createMediaStreamSource(stream);
      state.source = source;

      const recorder = new AudioWorkletNode(ctx, "music-recorder", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: "explicit",
        processorOptions: {
          duration: this.duration,
          interval: this.interval,
          sampleRate: this.sampleRate,
        },
      });
      state.recorder = recorder;

      recorder.port.onmessage = (event: MessageEvent<unknown>) => {
        if (!isMatchWindowMessage(event.data)) return;
        const message = event.data;
        state.pendingMatch = state.pendingMatch
          .then(() => this.match(state, message))
          .catch((err) => this.fail(state, err));
      };

      source.connect(recorder);

      if (ctx.state === "suspended") {
        await ctx.resume();
      }
      if (this.state !== state) return await state.done;

      return await state.done;
    } catch (err) {
      if (this.state === state) {
        this.fail(state, err);
      }
      return await state.done;
    } finally {
      this.cleanup(state);
    }
  }

  stop() {
    if (!this.state) return;
    this.finish(this.state);
  }

  private async match(state: RecognitionState, message: MatchWindowMessage) {
    if (this.state !== state) return;

    const rawdata = await ipcRenderer.invoke(
      "afp.generateFP",
      message.audioData
    );
    if (this.state !== state) return;

    const payload = new URLSearchParams({
      algorithmCode: "shazam_v2",
      duration: message.duration.toString(),
      rawdata,
      sessionId: state.sessionId,
      decrypt: "1",
      from: "pc_back_discern",
      times: message.times.toString(),
    }).toString();

    const [res] = (await ipcRenderer.invoke("channel.call", "network.fetch", {
      url: `https://interfacepc.music.163.com/api/music/audio/match?${payload}`,
      method: "GET",
      body: "",
      retryCount: 1,
    })) as [NetworkFetchResponse];

    if (this.state !== state) return;

    const responsetime = Date.now();
    let code = res.status === 200 ? 0 : (res.status ?? 0);
    const httpmsg = res.blob || "{}";
    let hasMatch = false;

    try {
      const body = JSON.parse(httpmsg);
      if (body.code === 200 && body.data?.result) {
        hasMatch = true;
      }
    } catch (e) {
      console.error(e);
      code = -101;
    }

    if (hasMatch || message.final) {
      this.finish(state, {
        code,
        duration: message.duration,
        httpmsg,
        recordtime: state.recordtime,
        responsetime,
        sessionId: state.sessionId,
        times: message.times,
      });
    }
  }

  private fail(state: RecognitionState, err: unknown) {
    if (this.state !== state) return;
    console.error(err);

    this.finish(state, {
      code: -100,
      duration: 0,
      httpmsg: {},
      recordtime: state.recordtime,
      responsetime: Date.now(),
      sessionId: state.sessionId,
      times: 0,
    });
  }

  private finish(
    state: RecognitionState,
    result: MusicRecognizeResult | null = null
  ) {
    if (this.state !== state) return;
    if (result) void this.emit("result", result).catch(console.error);
    this.cleanup(state);
    this.state = null;
    state.resolveDone(result);
  }

  private cleanup(state: RecognitionState) {
    try {
      if (state.recorder) {
        state.recorder.port.onmessage = null;
        state.recorder.disconnect();
      }
      state.source?.disconnect();
      state.stream?.getTracks().forEach((track) => track.stop());
      void state.ctx?.close();
    } catch (err) {
      console.error(err);
    }

    state.recorder = null;
    state.source = null;
    state.stream = null;
    state.ctx = null;
  }
}
