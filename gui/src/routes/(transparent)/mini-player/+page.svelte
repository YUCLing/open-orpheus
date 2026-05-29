<script lang="ts">
  import { onMount } from "svelte";

  import * as Popover from "$lib/components/ui/popover";
  import { Slider } from "$lib/components/ui/slider";

  import { inputRegionAttachment } from "$lib/inputRegion";

  import { getBridge } from "$lib/bridge";

  import IconButton from "$lib/components/IconButton.svelte";

  import type { MiniPlayerContract } from "$bridge/contracts/mini-player-api";
  import type {
    MiniPlayerLikeMark,
    MiniPlayerFullState,
    MiniPlayerPlayInfo,
    MiniPlayerPlayState,
    MiniPlayerListData,
    MiniPlayerStyle,
    MiniPlayerTogetherStatus,
  } from "$sharedTypes/mini-player";
  import type { Lyrics } from "$sharedTypes/lyrics";
  import { lyricsBridgeEmitter, getLyrics } from "$lib/lyrics";
  import LyricsComponent from "./Lyrics.svelte";

  const api = getBridge<MiniPlayerContract>("miniPlayer");

  let playInfo = $state<MiniPlayerPlayInfo | null>(null);
  let coverUrl = $state<string | null>(null);
  let likeMark = $state<MiniPlayerLikeMark>(0);
  let favour = $state(false);
  let mute = $state(false);
  let playState = $state<MiniPlayerPlayState>({ playing: false });
  let listData = $state<MiniPlayerListData>({ items: [], currentPlay: null });
  let togetherStatus = $state<MiniPlayerTogetherStatus>({
    status: "alone",
    self: { avatarUrl: "" },
    other: { avatarUrl: "" },
  });
  let style = $state<MiniPlayerStyle | null>(null);

  let lyrics = $state<Lyrics | null>(null);
  let currentTime = $state(0);

  function applyFullState(state: MiniPlayerFullState) {
    playInfo = state.playInfo;
    coverUrl = state.coverUrl;
    likeMark = state.likeMark;
    favour = state.favour;
    mute = state.mute;
    playState = state.playState;
    listData = { items: state.listItems, currentPlay: state.currentPlay };
    togetherStatus = state.togetherStatus;
    style = state.style;
  }

  onMount(() => {
    api.events.playInfoUpdate((info) => {
      playInfo = info;
    });
    api.events.coverUpdate((url) => {
      coverUrl = url;
    });
    api.events.likeUpdate((liked) => {
      likeMark = liked;
    });
    api.events.favourUpdate((favourited) => {
      favour = favourited;
    });
    api.events.muteUpdate((muted) => {
      mute = muted;
    });
    api.events.playStateUpdate((state) => {
      playState = state;
    });
    api.events.listUpdate((data) => {
      listData = data;
    });
    api.events.togetherStatusUpdate((status) => {
      togetherStatus = status;
    });
    api.events.showVolume((data) => {
      volume = data[0] * 100;
      showVolumeBar = true;
    });
    api.events.styleUpdate((newStyle) => {
      style = newStyle;
    });
    api.events.fullStateUpdate(applyFullState);

    api.requestFullUpdate().then((v) => {
      applyFullState(v);
    });

    lyrics = getLyrics()?.regular ?? null;

    lyricsBridgeEmitter.on("lyricsupdate", (e) => {
      lyrics = e.data?.regular ?? null;
    });

    lyricsBridgeEmitter.on("raf", (e) => {
      currentTime = e.data.time;
    });
  });

  let showList = $state(false);
  let showVolumeBar = $state(false);
  let showSongInfo = $state(false);
  let volume = $state(100);
  let volumeButtonEl: HTMLElement | undefined = $state(undefined);

  function noPropagation(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
  }
</script>

<Popover.Root bind:open={showVolumeBar}>
  <Popover.Content
    class="max-w-36"
    customAnchor={volumeButtonEl}
    {@attach inputRegionAttachment}
  >
    <Slider
      type="single"
      bind:value={
        () => volume,
        (v) => (
          (volume = v),
          api.fireCall("player.onminivolumechange", volume / 100)
        )
      }
      min={0}
      max={100}
      step={1}
    />
  </Popover.Content>
</Popover.Root>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="flex h-12.5 items-center gap-2"
  style:background={style?.background}
  onmousedown={(e) => {
    if (e.button != 0) return; // Only left button
    e.preventDefault();
    api.dragWindow();
  }}
  oncontextmenu={(e) => {
    e.preventDefault();
    api.fireCall("player.oncontextmenu");
  }}
  {@attach inputRegionAttachment}
>
  <button
    class="cursor-pointer"
    onmousedown={noPropagation}
    onclick={() => api.fireCall("player.onrequestchangetomain", "")}
  >
    {#if togetherStatus.status === "alone"}
      <img
        src={coverUrl ?? "gui://skin2/mini/album/default.png"}
        alt="Cover"
        class="size-12.5"
      />
    {:else}
      <div class="flex px-2">
        <div class="size-8 overflow-hidden rounded-full">
          <img src={togetherStatus.self.avatarUrl} alt="Self" />
        </div>
        <div
          class="size-8 overflow-hidden rounded-full {togetherStatus.status ===
          'waiting'
            ? 'relative ml-1'
            : '-ml-1'}"
        >
          {#if togetherStatus.status === "waiting"}
            <div
              class="absolute top-0 right-0 bottom-0 left-0 flex items-center justify-center bg-black/50"
            >
              <img
                class="w-6"
                src="gui://skin2/mini/together/loading.webp"
                alt="Waiting"
              />
            </div>
          {/if}
          <img
            src={togetherStatus.other.avatarUrl ||
              "gui://skin2/mini/together/default.png"}
            alt="Other"
          />
        </div>
      </div>
    {/if}
  </button>
  <div
    class="group relative flex flex-1 items-center justify-center gap-2"
    onmouseenter={() => (showSongInfo = true)}
    onmouseleave={() => (showSongInfo = false)}
  >
    {#if lyrics || playInfo}
      <div
        class="absolute top-0 right-0 bottom-0 left-0 z-10 flex flex-col justify-center text-center text-sm whitespace-nowrap group-hover:hidden"
        style:background={style?.background}
      >
        {#if lyrics}
          <LyricsComponent
            {lyrics}
            time={currentTime}
            style="color: {style?.lrcColor ?? 'black'};"
          />
        {:else if playInfo}
          <p
            class="overflow-hidden text-ellipsis"
            style:color={style?.titleColor}
          >
            {playInfo.songName}
          </p>
          <p
            class="overflow-hidden text-ellipsis"
            style:color={style?.artistColor}
          >
            {playInfo.artistName}
          </p>
        {/if}
      </div>
    {/if}
    <IconButton
      class="size-6 cursor-pointer"
      imgClass="size-full"
      images={style?.prevButton}
      onmousedown={noPropagation}
      onclick={() => api.fireCall("player.onaction", "prev", "miniPlayer")}
    />
    <IconButton
      class="size-10 cursor-pointer"
      imgClass="size-full"
      images={playState.playing ? style?.pauseButton : style?.playButton}
      onmousedown={noPropagation}
      onclick={() =>
        api.fireCall(
          "player.onaction",
          playState.playing ? "pause" : "play",
          "miniPlayer"
        )}
    />
    <IconButton
      class="size-6 cursor-pointer"
      imgClass="size-full"
      images={style?.nextButton}
      onmousedown={noPropagation}
      onclick={() => api.fireCall("player.onaction", "next", "miniPlayer")}
    />
  </div>
  {#if likeMark < 2}
    <IconButton
      class="size-6 cursor-pointer"
      imgClass="size-full"
      images={likeMark === 1 ? style?.lovedButton : style?.loveButton}
      onmousedown={noPropagation}
      onclick={() => api.fireCall("player.onlikeclick", "normal")}
    />
  {:else}
    <IconButton
      class="size-6 cursor-pointer"
      imgClass="size-full"
      images={favour ? style?.favouredButton : style?.favourButton}
      onmousedown={noPropagation}
      onclick={() => api.fireCall("player.onfavour", favour ? 0 : 1)}
    />
  {/if}
  <IconButton
    bind:element={volumeButtonEl}
    class="size-6 cursor-pointer"
    imgClass="size-full mt-px"
    images={mute ? style?.volumeMutedButton : style?.volumeButton}
    onmousedown={noPropagation}
    onclick={() =>
      showVolumeBar
        ? (showVolumeBar = false)
        : api.fireCall("player.onaction", "volume", "miniPlayer")}
  />
  <IconButton
    class="size-4 cursor-pointer"
    imgClass="size-full mt-0.5"
    images={style?.listButton}
    onmousedown={noPropagation}
    onclick={() => (showList = !showList)}
  />
  <div class="flex h-full flex-col gap-0.5 p-1">
    <IconButton
      class="size-2.5 cursor-pointer"
      imgClass="size-full"
      images={style?.closeButton}
      onmousedown={noPropagation}
      onclick={() => api.fireCall("player.onrequestclose", "")}
    />
    <IconButton
      class="size-2.5 cursor-pointer"
      imgClass="size-full"
      images={style?.toWebButton}
      onmousedown={noPropagation}
      onclick={() => api.fireCall("player.onrequestchangetomain", "")}
    />
  </div>
</div>
{#if playInfo}
  <div class="h-0" class:invisible={!showSongInfo || !lyrics || showList}>
    <div
      class="mx-auto w-[98%] overflow-hidden rounded-b-xs py-0.5 text-center text-sm whitespace-nowrap"
      style:background={style?.list.background}
      style:color={style?.titleColor}
    >
      {playInfo.songName}<span style:color={style?.artistColor}
        >&nbsp;-&nbsp;{playInfo.artistName}</span
      >
    </div>
  </div>
{/if}
<div
  class="playlist invisible h-85 overflow-y-auto"
  style:background={style?.list.background}
  style:--scrollbar-bg={style?.list.background}
  style:--scrollbar-thumb={style?.list.scrollBar}
  class:visible={showList}
  {@attach showList && inputRegionAttachment}
>
  {#if listData.items.length > 0}
    <ul
      class="text-xs"
      style:--item-bg={style?.list.itemBackground}
      style:--hover-bg={style?.list.hoverBackground}
      style:--selected-bg={style?.list.selectedBackground}
      style:--playing-bg={style?.list.playingBackground}
      style:color={style?.list.color}
      style:--hover-color={style?.list.hoverColor}
      style:--selected-color={style?.list.selectedColor}
    >
      {#each listData.items as item (item.id)}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <li
          tabindex="0"
          class="flex h-8.5 items-center gap-2 px-2 select-none even:bg-(--item-bg) hover:bg-(--hover-bg) focus:bg-(--selected-bg){item.id ===
          listData.currentPlay
            ? ' bg-(--playing-bg)!'
            : ''} group/list-item hover:text-(--hover-color) focus:text-(--selected-color)"
          ondblclick={() => api.fireCall("player.onrequestplay", item.id)}
          oncontextmenu={() => api.fireCall("player.onmenu", item.id)}
        >
          {#if item.id === listData.currentPlay}
            <IconButton
              images={playState.playing
                ? style?.list.playButton
                : style?.list.pauseButton}
              imgClass="size-4"
            />
          {:else}
            <div class="flex size-4 items-center justify-center"></div>
          {/if}
          <p class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
            {item.title}
          </p>
          {#if item.program === 1}
            <IconButton
              class="group-hover/list-item:hidden"
              images={style?.list.radioIcon}
            />
            <IconButton
              class="hidden group-hover/list-item:block"
              images={style?.list.radioHoverIcon}
            />
          {/if}
        </li>
      {/each}
      {#if listData.items.length < 10}
        {#each { length: 10 - listData.items.length }, i (i)}
          <li class="h-8.5 even:bg-(--item-bg) hover:bg-(--hover-bg)"></li>
        {/each}
      {/if}
    </ul>
  {/if}
</div>

<style lang="scss">
  .playlist::-webkit-scrollbar {
    width: 8px;
  }
  .playlist::-webkit-scrollbar-thumb {
    background: var(--scrollbar-thumb);
    border-radius: 4px;
  }
</style>
