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

type VoiceOptions = {
  api: OpenMuseApi | null;
  workspaceId?: string;
  conversationId?: string;
};

export function useLiveVoice({ api, workspaceId, conversationId }: VoiceOptions) {
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"webrtc" | "recorded">("webrtc");
  const peerRef = useRef<PeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stop = useCallback(async () => {
    setState("stopping");
    peerRef.current?.close();
    peerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setState("idle");
  }, []);

  const start = useCallback(async () => {
    if (!api) {
      setError("Connect to an OpenMuse server before starting live voice.");
      setState("error");
      return;
    }
    setError(null);
    setState("requesting-permission");
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) throw new Error("Microphone permission was denied.");
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;
      const peer = createPeerConnection();
      peerRef.current = peer;
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
      const offer = await peer.createOffer({});
      await peer.setLocalDescription(offer);
      setState("connecting");
      const answer = await api.createRealtimeVoiceSession({
        offer: offer.sdp ?? "",
        workspaceId,
        conversationId,
      });
      const answerSdp =
        typeof answer === "object" && answer !== null && "sdp" in answer
          ? String((answer as { sdp?: unknown }).sdp ?? "")
          : "";
      if (!answerSdp) throw new Error("The voice session did not return an SDP answer.");
      await peer.setRemoteDescription(
        new RTCSessionDescription({ type: "answer", sdp: answerSdp }),
      );
      setState("listening");
    } catch (cause: unknown) {
      await stop();
      setError(cause instanceof Error ? cause.message : "Unable to start live voice.");
      setState("error");
    }
  }, [api, conversationId, stop, workspaceId]);

  useEffect(
    () => () => {
      peerRef.current?.close();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

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

export function useRecordedVoice({ api, workspaceId, conversationId }: VoiceOptions) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder);
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    if (!api) {
      setError("Connect to an OpenMuse server before recording a voice note.");
      setState("error");
      return;
    }
    setError(null);
    setState("requesting-permission");
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) throw new Error("Microphone permission was denied.");
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setState("recording");
    } catch (cause: unknown) {
      setState("error");
      setError(cause instanceof Error ? cause.message : "Unable to record audio.");
    }
  }, [api, recorder]);

  const stop = useCallback(async () => {
    if (!recorderState.isRecording) return;
    if (!api) {
      setState("error");
      setError("Connect to an OpenMuse server before uploading the recording.");
      return;
    }
    setState("stopping");
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (uri) {
        await api.uploadVoiceRecording({
          uri,
          mimeType: "audio/m4a",
          workspaceId,
          conversationId,
        });
      }
      setState("idle");
    } catch (cause: unknown) {
      setState("error");
      setError(cause instanceof Error ? cause.message : "Unable to upload the recording.");
    }
  }, [api, conversationId, recorder, recorderState.isRecording, workspaceId]);

  return {
    state,
    error,
    durationMillis: recorderState.durationMillis,
    isActive: recorderState.isRecording,
    start,
    stop,
  };
}
