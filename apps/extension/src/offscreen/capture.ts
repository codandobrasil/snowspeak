import { SAMPLE_RATE, type Channel } from "@snowspeak/shared";
import type { CaptureCallbacks, ChannelCapture } from "./session-controller";

type WorkletMessage = { type: "frame"; pcm: ArrayBuffer } | { type: "level"; rms: number };

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

// "ended" só dispara quando a trilha termina por fora (aba fechada, compartilhamento encerrado);
// track.stop() chamado por nós não dispara o evento.
function watchEnded(stream: MediaStream, channel: Channel, cb: CaptureCallbacks): void {
  for (const track of stream.getAudioTracks()) {
    track.addEventListener("ended", () => cb.onEnded(channel), { once: true });
  }
}

async function createCapturePipe(stream: MediaStream, channel: Channel, cb: CaptureCallbacks): Promise<ChannelCapture> {
  // Contexto a 16 kHz: o Chrome reamostra o MediaStream na entrada.
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    await context.audioWorklet.addModule(chrome.runtime.getURL("capture-worklet.js"));
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, "snowspeak-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
    node.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
      const message = event.data;
      if (message.type === "frame") cb.onFrame(channel, message.pcm);
      else cb.onLevel(channel, message.rms);
    };
    // Saída muda até o destino: garante que o grafo seja processado.
    const mute = context.createGain();
    mute.gain.value = 0;
    source.connect(node);
    node.connect(mute);
    mute.connect(context.destination);

    return {
      stop() {
        node.port.onmessage = null;
        source.disconnect();
        void context.close();
      },
    };
  } catch (error) {
    void context.close();
    throw error;
  }
}

export async function captureTab(streamId: string, cb: CaptureCallbacks): Promise<ChannelCapture> {
  const constraints = {
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: false,
  } as unknown as MediaStreamConstraints;
  const stream = await navigator.mediaDevices.getUserMedia(constraints);

  let playback: AudioContext | null = null;
  try {
    // A captura silencia a aba: devolve o áudio aos alto-falantes num contexto com a taxa nativa.
    playback = new AudioContext();
    playback.createMediaStreamSource(stream).connect(playback.destination);
    const pipe = await createCapturePipe(stream, "them", cb);
    watchEnded(stream, "them", cb);
    const playbackContext = playback;
    return {
      stop() {
        pipe.stop();
        void playbackContext.close();
        stopTracks(stream);
      },
    };
  } catch (error) {
    void playback?.close();
    stopTracks(stream);
    throw error;
  }
}

export async function captureMic(cb: CaptureCallbacks): Promise<ChannelCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
  try {
    const pipe = await createCapturePipe(stream, "me", cb);
    watchEnded(stream, "me", cb);
    return {
      stop() {
        pipe.stop();
        stopTracks(stream);
      },
    };
  } catch (error) {
    stopTracks(stream);
    throw error;
  }
}
