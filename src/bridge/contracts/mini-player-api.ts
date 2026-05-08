export interface MiniPlayerPlayInfo {
  albumId: string;
  albumName: string;
  artistName: string;
  playId: string;
  songName: string;
  songType: string;
  url: string;
}

export interface MiniPlayerPlayState {
  playing: boolean;
}

export interface MiniPlayerListElement {
  id: string;
  from: string;
  title: string;
  track_id: string;
  program: null;
  mv: string;
  album: string;
  artist: string;
  alias: string;
  cloud: 0 | 1;
}

export interface MiniPlayerListData {
  items: MiniPlayerListElement[];
  currentPlay: string | null;
}

export interface MiniPlayerFullState {
  playInfo: MiniPlayerPlayInfo | null;
  coverUrl: string | null;
  likeMark: boolean;
  currentPlay: string | null;
  playState: MiniPlayerPlayState;
  listItems: MiniPlayerListElement[];
}

export type MiniPlayerShowVolumeRequest = [number, boolean];

export interface MiniPlayerContract {
  events: {
    fullStateUpdate(callback: (state: MiniPlayerFullState) => void): void;
    playInfoUpdate(callback: (info: MiniPlayerPlayInfo | null) => void): void;
    coverUpdate(callback: (url: string | null) => void): void;
    likeUpdate(callback: (liked: boolean) => void): void;
    playStateUpdate(callback: (state: MiniPlayerPlayState) => void): void;
    listUpdate(callback: (data: MiniPlayerListData) => void): void;
    showVolume(callback: (data: MiniPlayerShowVolumeRequest) => void): void;
  };

  requestFullUpdate(): Promise<MiniPlayerFullState>;
  dragWindow(): Promise<void>;
  fireCall(cmd: string, ...args: unknown[]): Promise<void>;
}
