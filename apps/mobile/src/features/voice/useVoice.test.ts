import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { OpenMuseApi } from "../../data/api";
import { currentPromise } from "../../data/current";
import { useLiveVoice, useRecordedVoice } from "./useVoice";

jest.mock("expo-audio", () => ({
  AudioModule: { requestRecordingPermissionsAsync: jest.fn() },
  RecordingPresets: { HIGH_QUALITY: "high-quality" },
  setAudioModeAsync: jest.fn(),
  useAudioRecorder: jest.fn(),
  useAudioRecorderState: jest.fn(),
}));

jest.mock("react-native-webrtc", () => ({
  mediaDevices: { getUserMedia: jest.fn() },
  RTCPeerConnection: jest.fn(),
  RTCSessionDescription: jest.fn((value: unknown) => value),
}));

jest.mock("react-native", () => ({
  Platform: {
    OS: "ios",
    select: (values: Record<string, unknown>) => values.ios ?? values.default,
  },
  StyleSheet: { flatten: (style: unknown) => style },
}));

const { AudioModule, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } =
  jest.requireMock("expo-audio") as {
    AudioModule: { requestRecordingPermissionsAsync: ReturnType<typeof jest.fn> };
    setAudioModeAsync: ReturnType<typeof jest.fn>;
    useAudioRecorder: ReturnType<typeof jest.fn>;
    useAudioRecorderState: ReturnType<typeof jest.fn>;
  };
const { mediaDevices, RTCPeerConnection } = jest.requireMock("react-native-webrtc") as {
  mediaDevices: { getUserMedia: ReturnType<typeof jest.fn> };
  RTCPeerConnection: ReturnType<typeof jest.fn>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("voice scope fencing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AudioModule.requestRecordingPermissionsAsync.mockResolvedValue({ granted: true });
    setAudioModeAsync.mockResolvedValue(undefined);
    useAudioRecorderState.mockReturnValue({ durationMillis: 0, isRecording: false });
  });

  it("aborts a live voice mutation and closes media after unmount", async () => {
    const track = { stop: jest.fn() };
    const peer = {
      addTrack: jest.fn(),
      close: jest.fn(),
      createOffer: jest.fn().mockResolvedValue({ type: "offer", sdp: "offer-sdp" }),
      setLocalDescription: jest.fn().mockResolvedValue(undefined),
      setRemoteDescription: jest.fn().mockResolvedValue(undefined),
    };
    const stream = { getTracks: () => [track] };
    const answer = deferred<{ sdp: string }>();
    let signal: AbortSignal | undefined;
    mediaDevices.getUserMedia.mockResolvedValue(stream);
    RTCPeerConnection.mockImplementation(() => peer);
    const api = {
      createRealtimeVoiceSession: jest.fn((_input: unknown, nextSignal: AbortSignal) => {
        signal = nextSignal;
        return answer.promise;
      }),
    } as unknown as OpenMuseApi;
    const scope = currentPromise(Promise.resolve(api));
    const hook = await renderHook(() =>
      useLiveVoice({ api, scope, workspaceId: "workspace-a", conversationId: "conversation-a" }),
    );

    let startPromise!: Promise<void>;
    await act(async () => {
      startPromise = hook.result.current.start();
    });
    await waitFor(() => expect(api.createRealtimeVoiceSession).toHaveBeenCalled());

    scope.invalidate();
    await act(async () => {
      hook.unmount();
    });
    expect(signal?.aborted).toBe(true);
    expect(peer.close).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();

    answer.resolve({ sdp: "late-answer" });
    await act(async () => {
      await startPromise;
    });
  });

  it("does not start recording after permission resolves for an unmounted scope", async () => {
    const permission = deferred<{ granted: boolean }>();
    AudioModule.requestRecordingPermissionsAsync.mockReturnValue(permission.promise);
    const recorder = {
      prepareToRecordAsync: jest.fn().mockResolvedValue(undefined),
      record: jest.fn(),
      stop: jest.fn().mockResolvedValue(undefined),
      uri: "file:///recording.m4a",
    };
    useAudioRecorder.mockReturnValue(recorder);
    const api = {
      uploadVoiceRecording: jest.fn(),
    } as unknown as OpenMuseApi;
    const scope = currentPromise(Promise.resolve(api));
    const hook = await renderHook(() => useRecordedVoice({ api, scope }));

    let startPromise!: Promise<void>;
    await act(async () => {
      startPromise = hook.result.current.start();
      await Promise.resolve();
    });
    await act(async () => {
      hook.unmount();
    });
    permission.resolve({ granted: true });
    await startPromise;

    expect(recorder.prepareToRecordAsync).not.toHaveBeenCalled();
    expect(recorder.record).not.toHaveBeenCalled();
    expect(api.uploadVoiceRecording).not.toHaveBeenCalled();
  });
});
