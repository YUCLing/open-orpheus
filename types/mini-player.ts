import type { BtnImages } from "./dui";

export enum MiniPlayerLikeMark {
  Unliked = 0,
  Liked = 1,
  UseFavour = 2,
}

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
  program: null | 1;
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

export interface MiniPlayerTogetherUser {
  avatarUrl: string;
}

export interface MiniPlayerTogetherStatus {
  status: "alone" | "waiting" | "togetherOwner" | "together";
  self: MiniPlayerTogetherUser;
  other: MiniPlayerTogetherUser;
}

export interface MiniPlayerFullState {
  playInfo: MiniPlayerPlayInfo | null;
  coverUrl: string | null;
  likeMark: MiniPlayerLikeMark;
  favour: boolean;
  mute: boolean;
  currentPlay: string | null;
  playState: MiniPlayerPlayState;
  listItems: MiniPlayerListElement[];
  togetherStatus: MiniPlayerTogetherStatus;
  style: MiniPlayerStyle | null;
}

export interface MiniPlayerStyle {
  background: string;

  lrcColor: string;

  titleColor: string;
  artistColor: string;

  prevButton: BtnImages;
  playButton: BtnImages;
  pauseButton: BtnImages;
  nextButton: BtnImages;

  loveButton: BtnImages;
  lovedButton: BtnImages;

  favourButton: BtnImages;
  favouredButton: BtnImages;

  volumeButton: BtnImages;
  volumeMutedButton: BtnImages;

  listButton: BtnImages;

  closeButton: BtnImages;
  toWebButton: BtnImages;

  list: {
    background: string;
    itemBackground: string;
    hoverBackground: string;
    selectedBackground: string;
    playingBackground: string;
    scrollBar: string;

    color: string;
    hoverColor: string;
    selectedColor: string;

    playButton: BtnImages;
    pauseButton: BtnImages;

    radioIcon: BtnImages;
    radioHoverIcon: BtnImages;
  };
}

export type MiniPlayerShowVolumeRequest = [number, boolean];
