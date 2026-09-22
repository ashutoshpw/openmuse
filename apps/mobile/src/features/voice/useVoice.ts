import { useCallback, useEffect, useRef, useState } from "react";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import {
  mediaDevices,
  RTCPeerConnection,
  RTCSessionDescription,
  type MediaStream,
  type RTCPeerConnection as PeerConnection,
} from "react-native-webrtc";
import type { OpenMuseApi } from "../../data/api";

function createPeerConnection() {
  return new RTCPeerConnection({ iceServers: [] });
}

export type VoiceState =
  | "idle"
  | "requesting-permission"
  | "connecting"
  | "listening"
  | "recording"
  | "stopping"
  | "error";

type VoiceScope = {
  isCurrent: () => boolean;
};

type VoiceOptions = {
  api: OpenMuseApi | null;
  scope?: VoiceScope | null;
  workspaceId?: string;
  conversationId?: string;
};

function isScopeCurrent(scope: VoiceScope | null | undefined): boolean {
  return scope?.isCurrent() ?? true;
}

function stopTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export function useLiveVoice({ api, scope, workspaceId, conversationId }: VoiceOptions) {
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"webrtc" | "recorded">("webrtc");
  const mountedRef = useRef(false);
  const runRef = useRef(0);
  const operationRef = useRef<AbortController | null>(null);
  const peerRef = useRef<PeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const closeMedia = useCallback(() => {
    peerRef.current?.close();
    peerRef.current = null;
    stopTracks(streamRef.current);
    streamRef.current = null;
  }, []);

  const invalidate = useCallback(() => {
    runRef.current += 1;
    operationRef.current?.abort("voice scope changed");
    operationRef.current = null;
    closeMedia();
  }, [closeMedia]);

  const canCommit = useCallback(
    (run: number, controller?: AbortController) =>
      mountedRef.current &&
      isScopeCurrent(scope) &&
      runRef.current === run &&
      !controller?.signal.aborted,
    [scope],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      invalidate();
    };
  }, [invalidate]);

  useEffect(() => () => invalidate(), [invalidate, scope]);

  const stop = useCallback(async () => {
    const shouldCommit = mountedRef.current && isScopeCurrent(scope);
    invalidate();
    if (!shouldCommit) return;
    setState("stopping");
    setState("idle");
  }, [invalidate, scope]);

  const start = useCallback(async () => {
    if (!api) {
      if (mountedRef.current && isScopeCurrent(scope)) {
        setError("Connect to an OpenMuse server before starting live voice.");
        setState("error");
      }
      return;
    }
    if (!mountedRef.current || !isScopeCurrent(scope)) return;

    invalidate();
    const run = runRef.current;
    const controller = new AbortController();
    operationRef.current = controller;
    let stream: MediaStream | null = null;
    let peer: PeerConnection | null = null;
    const current = () => canCommit(run, controller);
    const closeOperation = () => {
      peer?.close();
      if (peerRef.current === peer) peerRef.current = null;
      stopTracks(stream);
      if (streamRef.current === stream) streamRef.current = null;
    };

    setError(null);
    setState("requesting-permission");
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!current()) {
        closeOperation();
        return;
      }
      if (!permission.granted) throw new Error("Microphone permission was denied.");
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      if (!current()) return;
      stream = await mediaDevices.getUserMedia({ audio: true, video: false });
      if (!current()) {
        stopTracks(stream);
        return;
      }
      streamRef.current = stream;
      peer = createPeerConnection();
      if (!current()) {
        closeOperation();
        return;
      }
      peerRef.current = peer;
      stream.getTracks().forEach((track) => peer?.addTrack(track, stream!));
      const offer = await peer.createOffer({});
      if (!current()) {
        closeOperation();
        return;
      }
      await peer.setLocalDescription(offer);
      if (!current()) {
        closeOperation();
        return;
      }
      setState("connecting");
      const answer = await api.createRealtimeVoiceSession(
        {
          offer: offer.sdp ?? "",
          workspaceId,
          conversationId,
        },
        controller.signal,
      );
      if (!current()) {
        closeOperation();
        return;
      }
      const answerSdp =
        typeof answer === "object" && answer !== null && "sdp" in answer
          ? String((answer as { sdp?: unknown }).sdp ?? "")
          : "";
      if (!answerSdp) throw new Error("The voice session did not return an SDP answer.");
      await peer.setRemoteDescription(
        new RTCSessionDescription({ type: "answer", sdp: answerSdp }),
      );
      if (!current()) {
        closeOperation();
        return;
      }
      setState("listening");
    } catch (cause: unknown) {
      closeOperation();
      if (!current()) return;
      setError(cause instanceof Error ? cause.message : "Unable to start live voice.");
      setState("error");
    } finally {
      if (operationRef.current === controller) operationRef.current = null;
    }
  }, [api, canCommit, conversationId, invalidate, scope, workspaceId]);

  return {
    mode,
    setMode,
    state,
    error,
    isActive: state === "connecting" || state === "listening",
    start,
    stop,
  };
}

export function useRecordedVoice({ api, scope, workspaceId, conversationId }: VoiceOptions) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder);
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const runRef = useRef(0);
  const operationRef = useRef<AbortController | null>(null);
  const recordingRef = useRef(false);

  const invalidate = useCallback(() => {
    runRef.current += 1;
    operationRef.current?.abort("voice scope changed");
    operationRef.current = null;
    if (recordingRef.current) {
      recordingRef.current = false;
      void Promise.resolve(recorder.stop()).catch(() => undefined);
    }
  }, [recorder]);

  const canCommit = useCallback(
    (run: number, controller?: AbortController) =>
      mountedRef.current &&
      isScopeCurrent(scope) &&
      runRef.current === run &&
      !controller?.signal.aborted,
    [scope],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      invalidate();
    };
  }, [invalidate]);

  useEffect(() => () => invalidate(), [invalidate, scope]);

  const start = useCallback(async () => {
    if (!api) {
      if (mountedRef.current && isScopeCurrent(scope)) {
        setError("Connect to an OpenMuse server before recording a voice note.");
        setState("error");
      }
      return;
    }
    if (!mountedRef.current || !isScopeCurrent(scope)) return;

    invalidate();
    const run = runRef.current;
    const controller = new AbortController();
    operationRef.current = controller;
    const current = () => canCommit(run, controller);
    setError(null);
    setState("requesting-permission");
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!current()) return;
      if (!permission.granted) throw new Error("Microphone permission was denied.");
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      if (!current()) return;
      await recorder.prepareToRecordAsync();
      if (!current()) return;
      recorder.record();
      recordingRef.current = true;
      setState("recording");
    } catch (cause: unknown) {
      if (!current()) return;
      setState("error");
      setError(cause instanceof Error ? cause.message : "Unable to record audio.");
    } finally {
      if (operationRef.current === controller) operationRef.current = null;
    }
  }, [api, canCommit, invalidate, recorder, scope]);

  const stop = useCallback(async () => {
    if (!recordingRef.current) return;
    const currentApi = api;
    if (!currentApi || !mountedRef.current || !isScopeCurrent(scope)) {
      invalidate();
      return;
    }
    invalidate();
    const run = runRef.current;
    const controller = new AbortController();
    operationRef.current = controller;
    const current = () => canCommit(run, controller);
    recordingRef.current = false;
    setState("stopping");
    try {
      await recorder.stop();
      if (!current()) return;
      const uri = recorder.uri;
      if (uri) {
        // Scope invalidation can abort this request, but cannot undo a server
        // mutation that was already dispatched before the invalidation.
        await currentApi.uploadVoiceRecording(
          {
            uri,
            mimeType: "audio/m4a",
            workspaceId,
            conversationId,
          },
          controller.signal,
        );
      }
      if (!current()) return;
      setState("idle");
    } catch (cause: unknown) {
      if (!current()) return;
      setState("error");
      setError(cause instanceof Error ? cause.message : "Unable to upload the recording.");
    } finally {
      if (operationRef.current === controller) operationRef.current = null;
    }
  }, [api, canCommit, conversationId, invalidate, recorder, scope, workspaceId]);

  return {
    state,
    error,
    durationMillis: recorderState.durationMillis,
    isActive: recorderState.isRecording,
    start,
    stop,
  };
}
