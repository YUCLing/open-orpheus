<script lang="ts">
  import { onMount } from "svelte";
  import Lyrics from "$lib/components/Lyrics.svelte";
  import type { LyricStyleConfig } from "$sharedTypes/desktop-lyrics";
  import type {
    LyricLine,
    LyricsSloganUpdateEvent,
    LyricsStore,
    LyricsUpdateEvent,
  } from "$sharedTypes/lyrics";
  import IconButton from "$lib/components/IconButton.svelte";
  import { cn } from "$lib/utils";
  import { getBridge } from "$lib/bridge";
  import type { DesktopLyricsContract } from "$bridge/contracts/desktop-lyrics-api";
  import { inputRegionAttachment } from "$lib/inputRegion";
  import LyricsSynchronizer, { type RAFEvent } from "$lib/lyrics";

  const api = getBridge<DesktopLyricsContract>("desktopLyrics");

  let lyrics: LyricLine[] | null = $state(null);
  let translateLyrics: LyricLine[] | null = $state(null);
  let romaLyrics: LyricLine[] | null = $state(null);
  let slogan: string | null = $state(null);
  let currentTime = $state(0);
  let playing = $state(false);
  let locked = $state(false);
  let secondaryLyrics = $derived.by(() => {
    if (lyricStyle.showTranslate === "translate") return translateLyrics;
    if (lyricStyle.showTranslate === "roman") return romaLyrics;
    return null;
  });

  const items: ([string, string, string] | [string, string, string, true])[] =
    $derived([
      ["home", "detail", "打开详情页"],
      ["poffset", "offset_forward", "向前偏移歌词 0.5 秒"], // TODO: In what situations offsets will be locked
      ["moffset", "offset_back", "向后偏移歌词 0.5 秒"],
      ["prev", "playprev", "播放上一首"],
      [playing ? "topause" : "toplay", "play_pause", playing ? "暂停" : "播放"],
      ["next", "playnext", "播放下一首"],
      ["setting", "setting", "设置"],
      ["lock", "lock", "锁定桌面歌词"],
      ["close", "close", "关闭桌面歌词"],
    ]);

  const defaultStyle: LyricStyleConfig = {
    fontFamily: "sans-serif",
    fontSize: 36,
    fontWeight: "normal",
    textAlign: ["center", "center"],
    lineMode: false,
    vertical: false,
    colorNotPlayedTop: "#ffffff",
    colorNotPlayedBottom: "#cccccc",
    colorPlayedTop: "#00ff88",
    colorPlayedBottom: "#00cc66",
    outlineColorNotPlayed: "transparent",
    outlineColorPlayed: "transparent",
    dropShadow: "0 2px 4px rgba(0,0,0,0.5)",
    showProgress: true,
    offset: 0,
    showTranslate: "translate",
  };

  let lyricStyle: LyricStyleConfig = $state({ ...defaultStyle });

  // svelte-ignore state_referenced_locally
  let previousVertical = lyricStyle.vertical;
  $effect(() => {
    if (lyricStyle.vertical !== previousVertical) {
      previousVertical = lyricStyle.vertical;
      api.changeOrientation();
    }
  });

  onMount(() => {
    api.events.styleUpdate((data) => {
      lyricStyle = { ...lyricStyle, ...data };
    });

    api.events.setLocked((isLocked) => {
      locked = isLocked;
    });

    api.requestFullUpdate();

    const synchronizer = new LyricsSynchronizer();

    const updateLyrics = (store: LyricsStore | null) => {
      if (!store) {
        lyrics = translateLyrics = romaLyrics = null;
        return;
      }
      lyrics = store.regular;
      translateLyrics = store.translate ?? null;
      romaLyrics = store.roma ?? null;
    };

    updateLyrics(synchronizer.lyrics);

    slogan = synchronizer.slogan;
    currentTime = synchronizer.time;
    playing = synchronizer.playState;

    // TODO: ESLint says it's undefined
    type EventListener = () => void;

    synchronizer.addEventListener("lyricsupdate", ((e: LyricsUpdateEvent) => {
      updateLyrics(e.detail);
    }) as EventListener);

    synchronizer.addEventListener("sloganupdate", ((
      e: LyricsSloganUpdateEvent
    ) => {
      slogan = e.detail;
    }) as EventListener);

    synchronizer.addEventListener("raf", ((e: RAFEvent) => {
      currentTime = e.detail.time * 1000;
      playing = e.detail.playState;
    }) as EventListener);

    synchronizer.setRAFEnabled(true);

    return () => {
      synchronizer.setRAFEnabled(false);
    };
  });

  function onDrag() {
    if (locked) return;
    api.dragWindow();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class={cn(
    "group flex h-screen w-screen items-center justify-evenly overflow-hidden rounded-lg p-2 select-none",
    !locked && "hover:bg-black/40"
  )}
  class:cursor-grab={!locked}
  class:flex-col={!lyricStyle.vertical}
  onmousedown={onDrag}
>
  <div
    class="flex justify-center gap-2 {api.platform === 'linux' && locked
      ? 'opacity-25 group-hover:opacity-100'
      : 'invisible group-hover:visible'}{lyricStyle.vertical
      ? ' flex-col'
      : ''}"
  >
    {#if locked}
      <button
        class="size-12 cursor-pointer"
        onclick={() => api.performAction("unlock")}
        title="解锁桌面歌词"
        {@attach inputRegionAttachment}
        ><img
          src="gui://skin/lrc/desk_icn_unlock.png"
          alt="解锁桌面歌词"
        /></button
      >
    {:else}
      {#each items as [icon, action, title, disabled] (action)}
        <IconButton
          normal={`gui://skin/lrc/${icon}_normal.svg`}
          hover={`gui://skin/lrc/${icon}_over.svg`}
          active={`gui://skin/lrc/${icon}_push.svg`}
          disable={`gui://skin/lrc/${icon}_dis.svg`}
          {disabled}
          onmousedown={(e) => {
            e.stopPropagation();
          }}
          onclick={() => api.performAction(action)}
          class="cursor-pointer"
          imgClass="size-6"
          {title}
        />
      {/each}
    {/if}
  </div>
  <Lyrics
    {lyrics}
    {secondaryLyrics}
    {currentTime}
    {lyricStyle}
    {slogan}
    class={lyricStyle.vertical ? "h-full" : "w-full"}
  />
</div>
