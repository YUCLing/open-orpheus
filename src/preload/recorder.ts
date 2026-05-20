export let recCtx: {
  id: string;
  stream: MediaStream;
  audioCtx: AudioContext;
  processor: ScriptProcessorNode;
  source: MediaStreamAudioSourceNode;
  gainNode: GainNode;
  buffer: Float32Array;
  getOffset: () => number;
} | null = null;

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

export async function startContinuousRecord(id: string) {
  if (recCtx) stopContinuousRecord(recCtx.id);

  const stream = await getDesktopAudioStream();

  const sampleRate = 8000;
  const audioCtx = new AudioContext({ sampleRate });
  const source = audioCtx.createMediaStreamSource(stream);

  const maxSamples = sampleRate * 15;
  const buffer = new Float32Array(maxSamples);
  let offset = 0;

  const processor = audioCtx.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (e) => {
    const inputData = e.inputBuffer.getChannelData(0);
    const space = maxSamples - offset;
    if (space > 0) {
      buffer.set(
        inputData.subarray(0, Math.min(inputData.length, space)),
        offset
      );
      offset += inputData.length;
    }
  };

  const gainNode = audioCtx.createGain();
  gainNode.gain.value = 0;
  source.connect(processor);
  processor.connect(gainNode);
  gainNode.connect(audioCtx.destination);

  recCtx = {
    id,
    stream,
    audioCtx,
    processor,
    source,
    gainNode,
    buffer,
    getOffset: () => offset,
  };
}

export function stopContinuousRecord(id?: string) {
  if (!recCtx) return;
  if (id && recCtx.id !== id) return;
  try {
    recCtx.processor.disconnect();
    recCtx.source.disconnect();
    recCtx.stream.getAudioTracks().forEach((t) => t.stop());
    recCtx.audioCtx.close();
  } catch (e) {
    console.error(e);
  }
  recCtx = null;
}
