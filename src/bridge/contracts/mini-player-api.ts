import type {
  MiniPlayerPlayInfo,
  MiniPlayerPlayState,
  MiniPlayerListData,
  MiniPlayerFullState,
  MiniPlayerStyle,
  MiniPlayerShowVolumeRequest,
  MiniPlayerLikeMark,
  MiniPlayerTogetherStatus,
} from "$sharedTypes/mini-player";

export interface MiniPlayerContract {
  events: {
    playInfoUpdate(callback: (info: MiniPlayerPlayInfo | null) => void): void;
    coverUpdate(callback: (url: string | null) => void): void;
    likeUpdate(callback: (liked: MiniPlayerLikeMark) => void): void;
    favourUpdate(callback: (favourited: boolean) => void): void;
    muteUpdate(callback: (muted: boolean) => void): void;
    playStateUpdate(callback: (state: MiniPlayerPlayState) => void): void;
    listUpdate(callback: (data: MiniPlayerListData) => void): void;
    togetherStatusUpdate(
      callback: (status: MiniPlayerTogetherStatus) => void
    ): void;
    showVolume(callback: (data: MiniPlayerShowVolumeRequest) => void): void;
    styleUpdate(callback: (style: MiniPlayerStyle | null) => void): void;
    setFont(callback: (font: string | null) => void): void;
  };

  requestFullUpdate(): Promise<MiniPlayerFullState>;
  dragWindow(): Promise<void>;
  fireCall(cmd: string, ...args: unknown[]): Promise<void>;
}
